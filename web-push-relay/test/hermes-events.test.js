import assert from "node:assert/strict";
import test from "node:test";
import { HermesEventReceiver } from "../src/hermes-events.js";

function event(deliveryId, extra = {}) {
  return {
    hook_event_name: "on_session_end",
    delivery_id: deliveryId,
    session_id: "session/one",
    extra: { turn_id: `turn-${deliveryId}`, completed: true, ...extra },
  };
}

test("queues one notification for every completed turn", async () => {
  const delivered = [];
  const receiver = new HermesEventReceiver({
    appUrl: "https://mobile.example",
    deliver: async (notification) => delivered.push(notification),
  });

  receiver.accept(event("one"));
  receiver.accept(event("two"));
  await receiver.deliveryQueue;

  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered[0], {
    title: "Hermes — task finished",
    body: "Your Hermes response is ready.",
    url: "https://mobile.example/session/session%2Fone",
    tag: "hermes-turn-turn-one",
  });
});

test("labels failed and interrupted turns without dropping them", async () => {
  const delivered = [];
  const receiver = new HermesEventReceiver({
    appUrl: "https://mobile.example",
    deliver: async (notification) => delivered.push(notification),
  });

  receiver.accept(event("failed", { completed: false, failed: true }));
  receiver.accept(event("stopped", { completed: false, interrupted: true }));
  await receiver.deliveryQueue;

  assert.deepEqual(delivered.map(({ title }) => title), [
    "Hermes — task failed",
    "Hermes — task stopped",
  ]);
});

test("deduplicates webhook retries and rejects other hook events", async () => {
  const delivered = [];
  const receiver = new HermesEventReceiver({
    appUrl: "https://mobile.example",
    deliver: async (notification) => delivered.push(notification),
  });
  receiver.accept(event("same"));
  assert.deepEqual(receiver.accept(event("same")), { duplicate: true });
  await receiver.deliveryQueue;
  assert.equal(delivered.length, 1);
  assert.throws(
    () => receiver.accept({ ...event("other"), hook_event_name: "on_stream_end" }),
    /unsupported/,
  );
});

test("requires an HTTPS app origin", () => {
  assert.throws(
    () => new HermesEventReceiver({
      appUrl: "http://mobile.example",
      deliver: async () => {},
    }),
    /must use HTTPS/,
  );
});
