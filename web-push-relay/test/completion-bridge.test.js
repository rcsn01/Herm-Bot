import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CompletionBridgeState, HermesCompletionBridge } from "../src/completion-bridge.js";

class FakeConnection {
  static OPEN = 1;

  constructor(handleRequest) {
    this.handleRequest = handleRequest;
    this.events = new Set();
    this.closes = new Set();
    this.closed = false;
  }

  async connect() {}

  request(method, params) {
    return this.handleRequest(this, method, params);
  }

  onEvent(handler) {
    this.events.add(handler);
    return () => this.events.delete(handler);
  }

  onClose(handler) {
    if (this.closed) {
      queueMicrotask(handler);
      return () => {};
    }
    this.closes.add(handler);
    return () => this.closes.delete(handler);
  }

  emit(event) {
    for (const handler of this.events) handler(event);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closes) handler();
  }
}

async function bridgeState(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-bridge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new CompletionBridgeState(path.join(directory, "state.json"));
  await state.initialize();
  return state;
}

async function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function deliverReplay(t, events, metadata = {}) {
  const state = await bridgeState(t);
  const session = {
    session_id: "runtime-preview",
    stored_session_id: "stored-preview",
    profile: "default",
    ...metadata,
  };
  await state.adoptEpoch("epoch-preview");
  await state.rememberSession(session.session_id, {
    storedSessionId: session.stored_session_id,
    profile: session.profile,
  });
  await state.advance(session.session_id, 0);
  const delivered = [];
  const bridge = new HermesCompletionBridge({
    appUrl: "https://mobile.example",
    authenticator: { webSocketURL: async () => "ws://gateway.example/api/ws" },
    state,
    deliver: async (notification) => delivered.push(notification),
    pollIntervalMs: 100,
    reconnectMinMs: 100,
    reconnectMaxMs: 100,
    connectionFactory: () => new FakeConnection(async (_self, method) => {
      if (method === "session.active_list") return { sessions: [session] };
      if (method === "session.activate") return session;
      if (method === "session.events.since") {
        return {
          epoch: "epoch-preview",
          latest_seq: Math.max(0, ...events.map((event) => event.seq ?? 0)),
          events,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    }),
  });

  bridge.start();
  const completions = events.filter((event) => event.type === "message.complete").length;
  await waitFor(() => delivered.length === completions);
  await bridge.stop();
  return delivered;
}

test("discovers a live session and sends one notification for a completed turn", async (t) => {
  const state = await bridgeState(t);
  const delivered = [];
  let observer;
  let replayCalls = 0;
  const connections = [];
  const bridge = new HermesCompletionBridge({
    appUrl: "https://mobile.example",
    authenticator: { webSocketURL: async () => "ws://gateway.example/api/ws" },
    state,
    deliver: async (notification) => delivered.push(notification),
    pollIntervalMs: 10,
    reconnectMinMs: 10,
    reconnectMaxMs: 10,
    connectionFactory: () => {
      const connection = new FakeConnection(async (self, method) => {
        if (method === "session.active_list") {
          return { sessions: [{ session_id: "runtime-1", stored_session_id: "stored/1", profile: "work" }] };
        }
        if (method === "session.activate") {
          observer = self;
          return { session_id: "runtime-1", stored_session_id: "stored/1", profile: "work" };
        }
        if (method === "session.events.since") {
          replayCalls += 1;
          if (replayCalls === 1) {
            return {
              epoch: "epoch-1",
              latest_seq: 8,
              events: [{
                type: "message.complete",
                session_id: "runtime-1",
                seq: 7,
                payload: { turn_id: "historical-turn" },
              }],
            };
          }
          queueMicrotask(() => {
            self.emit({ type: "message.start", session_id: "runtime-1", seq: 9, payload: {} });
            self.emit({
              type: "message.delta",
              session_id: "runtime-1",
              seq: 10,
              payload: { delta: "  The actual " },
            });
            self.emit({
              type: "message.delta",
              session_id: "runtime-1",
              seq: 11,
              payload: { text: "Hermes reply" },
            });
            self.emit({
              type: "reasoning.delta",
              session_id: "runtime-1",
              seq: 12,
              payload: { delta: "private reasoning" },
            });
            self.emit({
              type: "tool.result",
              session_id: "runtime-1",
              seq: 13,
              payload: { text: "tool output" },
            });
            self.emit({
              type: "message.complete",
              session_id: "runtime-1",
              seq: 14,
              payload: { turn_id: "turn-14", delta: ".  " },
            });
          });
          return { epoch: "epoch-1", latest_seq: 8, events: [] };
        }
        throw new Error(`unexpected method: ${method}`);
      });
      connections.push(connection);
      return connection;
    },
  });

  bridge.start();
  await waitFor(() => delivered.length === 1);
  observer.emit({ type: "message.delta", session_id: "runtime-1", seq: 10, payload: { delta: "duplicate" } });
  observer.emit({ type: "message.complete", session_id: "runtime-1", seq: 14, payload: { turn_id: "turn-14" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.stop();

  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    title: "Hermes: task finished",
    body: "The actual Hermes reply.",
    url: "https://mobile.example/session/stored%2F1?profile=work",
    tag: delivered[0].tag,
  });
  assert.match(delivered[0].tag, /^hermes-turn-[a-f0-9]{32}$/);
  assert.equal(state.snapshot().sessions["runtime-1"].lastSeen, 14);
  assert.ok(connections.length >= 2);
});

test("replays completion events for a session remembered before restart", async (t) => {
  const state = await bridgeState(t);
  await state.adoptEpoch("epoch-1");
  await state.rememberSession("runtime-old", {
    storedSessionId: "stored-old",
    profile: "default",
  });
  await state.advance("runtime-old", 20);
  const delivered = [];
  const bridge = new HermesCompletionBridge({
    appUrl: "https://mobile.example",
    authenticator: { webSocketURL: async () => "ws://gateway.example/api/ws" },
    state,
    deliver: async (notification) => delivered.push(notification),
    pollIntervalMs: 20,
    reconnectMinMs: 20,
    reconnectMaxMs: 20,
    connectionFactory: () => new FakeConnection(async (_self, method, params) => {
      if (method === "session.active_list") return { sessions: [] };
      if (method === "session.activate") throw new Error("session finalized");
      if (method === "session.events.since") {
        assert.equal(params.last_seen, 20);
        return {
          epoch: "epoch-1",
          latest_seq: 22,
          events: [{
            type: "message.delta",
            session_id: "runtime-old",
            seq: 21,
            payload: { delta: "Reply recovered " },
          }, {
            type: "message.complete",
            session_id: "runtime-old",
            seq: 22,
            payload: { delta: "from replay." },
          }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    }),
  });

  bridge.start();
  await waitFor(() => delivered.length === 1);
  await bridge.stop();

  assert.equal(delivered[0].url, "https://mobile.example/session/stored-old");
  assert.equal(delivered[0].body, "Reply recovered from replay.");
  assert.equal(state.snapshot().sessions["runtime-old"], undefined);
  assert.equal(state.snapshot().delivered.length, 1);
});

test("uses bounded response previews while preserving completion status", async (t) => {
  const delivered = await deliverReplay(t, [
    { type: "message.start", seq: 1, payload: {} },
    { type: "message.delta", seq: 2, payload: { delta: "  First line\n" } },
    { type: "reasoning.delta", seq: 3, payload: { delta: "private reasoning" } },
    { type: "tool.result", seq: 4, payload: { text: "tool output" } },
    { type: "message.complete", seq: 5, payload: { failed: true, delta: "**done**  " } },
    { type: "message.start", seq: 6, payload: {} },
    { type: "message.delta", seq: 7, payload: { text: "Stopped response" } },
    { type: "message.complete", seq: 8, payload: { interrupted: true } },
    { type: "message.start", seq: 9, payload: {} },
    { type: "message.delta", seq: 10, payload: { delta: { text: "invalid" }, text: "ignored" } },
    { type: "message.complete", seq: 11, payload: { error: "failed without response" } },
    { type: "message.start", seq: 12, payload: {} },
    { type: "message.delta", seq: 13, payload: { delta: "   " } },
    { type: "message.complete", seq: 14, payload: {} },
  ]);

  assert.deepEqual(delivered.map(({ title, body }) => ({ title, body })), [
    { title: "Hermes: task failed", body: "First line\n**done**" },
    { title: "Hermes: task stopped", body: "Stopped response" },
    { title: "Hermes: task failed", body: "A Hermes turn failed." },
    { title: "Hermes: task finished", body: "Your Hermes response is ready." },
  ]);
});

test("truncates a completion-only Unicode preview without splitting a surrogate pair", async (t) => {
  const response = `${"a".repeat(498)}😀tail`;
  const delivered = await deliverReplay(t, [{
    type: "message.complete",
    seq: 1,
    payload: { delta: response },
  }]);

  assert.equal(delivered[0].body, `${"a".repeat(498)}…`);
  assert.equal(delivered[0].body.length, 499);
  assert.equal(delivered[0].url, "https://mobile.example/session/stored-preview");
  assert.match(delivered[0].tag, /^hermes-turn-[a-f0-9]{32}$/);
});

test("keeps response previews isolated between sessions", async (t) => {
  const state = await bridgeState(t);
  await state.adoptEpoch("epoch-1");
  for (const id of ["one", "two"]) {
    await state.rememberSession(id, { storedSessionId: `stored-${id}`, profile: "default" });
    await state.advance(id, 0);
  }
  const delivered = [];
  const sessions = [
    { session_id: "one", stored_session_id: "stored-one", profile: "default" },
    { session_id: "two", stored_session_id: "stored-two", profile: "default" },
  ];
  const bridge = new HermesCompletionBridge({
    appUrl: "https://mobile.example",
    authenticator: { webSocketURL: async () => "ws://gateway.example/api/ws" },
    state,
    deliver: async (notification) => delivered.push(notification),
    pollIntervalMs: 100,
    reconnectMinMs: 100,
    reconnectMaxMs: 100,
    connectionFactory: () => new FakeConnection(async (_self, method, params) => {
      if (method === "session.active_list") return { sessions };
      if (method === "session.activate") return sessions.find((item) => item.session_id === params.session_id);
      if (method === "session.events.since") {
        return {
          epoch: "epoch-1",
          latest_seq: 2,
          events: [
            { type: "message.delta", session_id: params.session_id, seq: 1, payload: { delta: `${params.session_id} reply` } },
            { type: "message.complete", session_id: params.session_id, seq: 2, payload: {} },
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    }),
  });

  bridge.start();
  await waitFor(() => delivered.length === 2);
  await bridge.stop();

  assert.deepEqual(new Set(delivered.map(({ body }) => body)), new Set(["one reply", "two reply"]));
});

test("a replay epoch change discards stale watermarks", async (t) => {
  const state = await bridgeState(t);
  await state.adoptEpoch("old-epoch");
  await state.rememberSession("runtime-1", { storedSessionId: "stored-1" });
  await state.advance("runtime-1", 99);
  await state.adoptEpoch("new-epoch");
  assert.deepEqual(state.snapshot(), {
    version: 1,
    epoch: "new-epoch",
    sessions: {},
    delivered: [],
  });
});
