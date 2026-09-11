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
          queueMicrotask(() => self.emit({
            type: "message.complete",
            session_id: "runtime-1",
            seq: 9,
            payload: { turn_id: "turn-9" },
          }));
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
  observer.emit({ type: "message.complete", session_id: "runtime-1", seq: 9, payload: { turn_id: "turn-9" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.stop();

  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    title: "Hermes: task finished",
    body: "Your Hermes response is ready.",
    url: "https://mobile.example/session/stored%2F1?profile=work",
    tag: delivered[0].tag,
  });
  assert.match(delivered[0].tag, /^hermes-turn-[a-f0-9]{32}$/);
  assert.equal(state.snapshot().sessions["runtime-1"].lastSeen, 9);
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
          latest_seq: 21,
          events: [{
            type: "message.complete",
            session_id: "runtime-old",
            seq: 21,
            payload: {},
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
  assert.equal(state.snapshot().sessions["runtime-old"], undefined);
  assert.equal(state.snapshot().delivered.length, 1);
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
