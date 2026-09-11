import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  createHandler,
  MAX_BODY_BYTES,
  notifyAll,
} from "../src/app.js";

function createState() {
  const subscriptions = [
    { endpoint: "https://push.example.test/live", keys: {} },
    { endpoint: "https://push.example.test/missing", keys: {} },
    { endpoint: "https://push.example.test/gone", keys: {} },
  ];
  return {
    publicKey: "public-key",
    listSubscriptions: () => [...subscriptions],
    upsert: async () => {},
    removeEndpoints: async (endpoints) => {
      const before = subscriptions.length;
      for (const endpoint of endpoints) {
        const index = subscriptions.findIndex(
          (subscription) => subscription.endpoint === endpoint,
        );
        if (index >= 0) subscriptions.splice(index, 1);
      }
      return before - subscriptions.length;
    },
  };
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("notification delivery prunes expired subscriptions", async () => {
  const state = createState();
  const payloads = [];
  const push = {
    sendNotification: async (subscription, payload) => {
      payloads.push(JSON.parse(payload));
      if (subscription.endpoint.endsWith("/missing")) {
        throw Object.assign(new Error("missing"), { statusCode: 404 });
      }
      if (subscription.endpoint.endsWith("/gone")) {
        throw Object.assign(new Error("gone"), { statusCode: 410 });
      }
    },
  };

  const result = await notifyAll({
    state,
    push,
    notification: {
      title: "Done",
      body: "The task finished",
      url: "/session/1",
      tag: "task",
    },
  });
  assert.deepEqual(result, { sent: 1, removed: 2, failed: 0 });
  assert.equal(payloads.length, 3);
  assert.deepEqual(state.listSubscriptions().map((item) => item.endpoint), [
    "https://push.example.test/live",
  ]);
});

test("notify reports provider diagnostics without exposing subscriptions", async () => {
  const state = createState();
  const push = {
    sendNotification: async () => {
      throw Object.assign(new Error("provider rejected push"), {
        statusCode: 403,
        code: "WEB_PUSH_REJECTED",
        body: "BadJwtToken",
        endpoint: "https://must-not-leak.example/secret",
      });
    },
  };
  const result = await notifyAll({ state, push, notification: {} });
  assert.equal(result.failed, 3);
  assert.equal(result.errors.length, 3);
  assert.deepEqual(result.errors[0], {
    statusCode: 403,
    code: "WEB_PUSH_REJECTED",
    body: "BadJwtToken",
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|secret/);
});

test("rejects oversized bodies before handling them", async () => {
  const state = createState();
  await withServer(
    createHandler({ state, push: {} }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/subscriptions`, {
        method: "PUT",
        body: "x".repeat(MAX_BODY_BYTES + 1),
      });
      assert.equal(response.status, 413);
    },
  );
});
