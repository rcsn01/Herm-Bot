import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CompletionBridgeState, HermesCompletionBridge } from "../src/completion-bridge.js";
import { notifyAll } from "../src/app.js";

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-cron-push-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = new CompletionBridgeState(path.join(dir, "bridge.json"));
  await state.initialize();
  const sent = [];
  const errors = [];
  let jobs = [{ id: "daily-check", profile: "work", name: "Daily check", last_run_at: "2026-01-01T00:00:00Z", last_status: "ok" }];
  let polls = 0;
  const bridge = new HermesCompletionBridge({
    appUrl: "https://mobile.example",
    state,
    authenticator: { webSocketURL: async () => "ws://gateway.example/api/ws" },
    cronSource: async () => { polls++; return structuredClone(jobs); },
    cronPollIntervalMs: 5,
    pollIntervalMs: 5,
    reconnectMinMs: 5,
    reconnectMaxMs: 5,
    onError: error => errors.push(error),
    connectionFactory: () => ({
      connect: async () => {},
      request: async method => { assert.equal(method, "session.active_list"); return { sessions: [] }; },
      close() {},
    }),
    deliver: async notification => {
      const owner = "current-owner";
      return notifyAll({
        owner,
        state: { listSubscriptions: actualOwner => actualOwner === owner ? [{ endpoint: "https://web.push.apple.com/device", owner }] : [] },
        push: { sendNotification: async (_subscription, payload) => { sent.push(JSON.parse(payload)); } },
        notification,
      });
    },
    ...options,
  });
  t.after(() => bridge.stop());
  return { bridge, state: options.state ?? state, sent, errors, polls: () => polls, jobs: value => { jobs = value; } };
}

async function waitFor(check, message = "cron push did not arrive") {
  const deadline = Date.now() + 500;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("a named-profile cron completion reaches PWA push without any active chat session", async t => {
  const s = await setup(t);
  s.bridge.start();
  await waitFor(() => s.polls() >= 1, "bridge never reads cron completions");
  await waitFor(() => s.state.snapshot().cron);
  assert.equal(s.sent.length, 0, "historical runs must not be pushed on first start");
  s.jobs([{ id: "daily-check", profile: "work", name: "Daily check", last_run_at: new Date().toISOString(), last_status: "ok" }]);
  await waitFor(() => s.sent.length === 1);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(s.sent.length, 1, "repeated polling must not duplicate the same completion");
  assert.equal(s.sent[0].title, "Hermes: scheduled task finished");
  assert.match(s.sent[0].body, /Daily check/);
  assert.equal(s.sent[0].url, "https://mobile.example/");
  assert.match(s.sent[0].tag, /^hermes-cron-[a-f0-9]{32}$/);
  assert.deepEqual(s.errors, []);
});

test("same job IDs in different profiles do not share notification checkpoints", async t => {
  const s = await setup(t);
  const jobs = ["default", "work"].map(profile => ({ id: "copied-id", profile, name: "Check", last_run_at: null }));
  s.jobs(jobs);
  s.bridge.start();
  await waitFor(() => s.state.snapshot().cron);
  s.jobs(jobs.map(job => ({ ...job, last_run_at: new Date().toISOString(), last_status: "ok" })));
  await waitFor(() => s.sent.length === 2);
  assert.notEqual(s.sent[0].tag, s.sent[1].tag);
});

test("failed jobs and failures of other delivery targets have distinct notification wording", async t => {
  const s = await setup(t);
  s.bridge.start();
  await waitFor(() => s.state.snapshot().cron);
  const job = { id: "daily-check", profile: "work", name: "Check" };
  s.jobs([{ ...job, last_run_at: new Date().toISOString(), last_status: "error" }]);
  await waitFor(() => s.sent.length === 1);
  assert.equal(s.sent[0].title, "Hermes: scheduled task needs attention");
  s.jobs([{ ...job, last_run_at: new Date(Date.now() + 1000).toISOString(), last_status: "delivery_failed" }]);
  await waitFor(() => s.sent.length === 2);
  assert.equal(s.sent[1].title, "Hermes: scheduled task finished");
  assert.match(s.sent[1].body, /another delivery target failed/);
});

test("a failed push is retried without checkpointing the unsent completion", async t => {
  const sent = [];
  let attempts = 0;
  const s = await setup(t, { deliver: async notification => {
    if (++attempts === 1) throw new Error("temporary push failure");
    sent.push(notification);
  } });
  s.bridge.start();
  await waitFor(() => s.state.snapshot().cron);
  s.jobs([{ id: "daily-check", profile: "work", last_run_at: new Date().toISOString(), last_status: "ok" }]);
  await waitFor(() => sent.length === 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(attempts, 2);
  assert.equal(s.errors.length, 1);
});

test("a failed cron notification does not block notifications for other jobs", async t => {
  const delivered = [];
  const s = await setup(t, { deliver: async notification => {
    if (notification.body.startsWith("Broken")) throw new Error("temporary delivery failure");
    delivered.push(notification);
  } });
  const jobs = ["Broken", "Healthy"].map(name => ({ id: name, profile: "work", name, last_run_at: null }));
  s.jobs(jobs);
  s.bridge.start();
  await waitFor(() => s.state.snapshot().cron);
  s.jobs(jobs.map(job => ({ ...job, last_run_at: new Date().toISOString(), last_status: "ok" })));
  await waitFor(() => delivered.length === 1, "failed job blocked another cron notification");
  assert.match(delivered[0].body, /^Healthy/);
});

test("cron checkpoints survive gateway epoch changes and relay restart", async t => {
  const first = await setup(t);
  first.bridge.start();
  await waitFor(() => first.state.snapshot().cron);
  const job = { id: "daily-check", profile: "work", last_run_at: new Date().toISOString(), last_status: "ok" };
  first.jobs([job]);
  await waitFor(() => first.sent.length === 1);
  await first.bridge.stop();
  const cron = first.state.snapshot().cron;
  await first.state.adoptEpoch("old-gateway");
  await first.state.adoptEpoch("new-gateway");
  assert.deepEqual(first.state.snapshot().cron, cron);
  const reloaded = new CompletionBridgeState(first.state.filePath);
  await reloaded.initialize();
  const second = await setup(t, { state: reloaded });
  second.jobs([job]);
  second.bridge.start();
  await waitFor(() => second.polls() >= 3);
  assert.equal(second.sent.length, 0, "restart must not resend an already processed cron run");
  second.jobs([{ ...job, last_run_at: new Date(Date.now() + 1000).toISOString() }]);
  await waitFor(() => second.sent.length === 1);
});

test("late-discovered historical jobs and invalid responses do not generate notifications", async t => {
  const s = await setup(t);
  s.bridge.start();
  await waitFor(() => s.state.snapshot().cron);
  s.jobs({ jobs: [] });
  await waitFor(() => s.errors.length > 0);
  s.jobs([{ id: "imported-job", profile: "work", last_run_at: "2020-01-01T00:00:00Z", last_status: "ok" }]);
  const count = s.polls();
  await waitFor(() => s.polls() > count + 1);
  assert.equal(s.sent.length, 0);
  s.jobs([{ id: "imported-job", profile: "work", last_run_at: new Date(Date.now() + 1000).toISOString(), last_status: "ok" }]);
  await waitFor(() => s.sent.length === 1);
});
