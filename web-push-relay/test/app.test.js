import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import test from "node:test";
import {
  createHandler,
  hasValidBearer,
  hasValidSignature,
  MAX_BODY_BYTES,
} from "../src/app.js";

const token = "a".repeat(32);

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

test("bearer authentication compares exact token values", () => {
  assert.equal(hasValidBearer(`Bearer ${token}`, token), true);
  assert.equal(hasValidBearer(`Bearer ${token}x`, token), false);
  assert.equal(hasValidBearer(token, token), false);
});

test("Hermes event endpoint verifies the signed raw body", async () => {
  const state = createState();
  const accepted = [];
  const body = JSON.stringify({
    hook_event_name: "on_stream_end",
    delivery_id: "delivery-1",
  });
  const signature = `sha256=${createHmac("sha256", token).update(body).digest("hex")}`;
  assert.equal(hasValidSignature(signature, token, Buffer.from(body)), true);

  await withServer(
    createHandler({
      state,
      push: {},
      token,
      hermesEvents: { accept: (payload) => {
        accepted.push(payload);
        return { accepted: true };
      } },
    }),
    async (baseUrl) => {
      const rejected = await fetch(`${baseUrl}/v1/hermes-events`, {
        method: "POST",
        body,
        headers: { "x-hermes-signature-256": `sha256=${"0".repeat(64)}` },
      });
      assert.equal(rejected.status, 401);

      const response = await fetch(`${baseUrl}/v1/hermes-events`, {
        method: "POST",
        body,
        headers: { "x-hermes-signature-256": signature },
      });
      assert.equal(response.status, 202);
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0].delivery_id, "delivery-1");
    },
  );
});

test("notify requires bearer auth and prunes expired subscriptions", async () => {
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

  await withServer(createHandler({ state, push, token }), async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/v1/notify`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(payloads.length, 0);

    const response = await fetch(`${baseUrl}/v1/notify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Done",
        body: "The task finished",
        url: "/session/1",
        tag: "task",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sent: 1, removed: 2, failed: 0 });
    assert.equal(payloads.length, 3);
    assert.deepEqual(state.listSubscriptions().map((item) => item.endpoint), [
      "https://push.example.test/live",
    ]);
  });
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
  await withServer(createHandler({ state, push, token }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/notify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const result = await response.json();
    assert.equal(result.failed, 3);
    assert.equal(result.errors.length, 3);
    assert.deepEqual(result.errors[0], {
      statusCode: 403,
      code: "WEB_PUSH_REJECTED",
      body: "BadJwtToken",
    });
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak|secret/);
  });
});

test("rejects oversized bodies before handling them", async () => {
  const state = createState();
  await withServer(
    createHandler({ state, push: {}, token }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/subscriptions`, {
        method: "PUT",
        body: "x".repeat(MAX_BODY_BYTES + 1),
      });
      assert.equal(response.status, 413);
    },
  );
});
