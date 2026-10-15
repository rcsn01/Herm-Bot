import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createHandler, MAX_BODY_BYTES, notifyAll } from "../src/app.js";
const owner = "a".repeat(64);
const origin = "https://mobile.example";
function createState() {
  let subscriptions = ["live", "missing", "gone"].map(id => ({ id, owner, endpoint: `https://fcm.googleapis.com/${id}`, keys: {} }));
  subscriptions.push({ id: "other", owner: "b".repeat(64), endpoint: "https://fcm.googleapis.com/other", keys: {} });
  return { publicKey: "public-key", listSubscriptions: who => subscriptions.filter(row => row.owner === who), upsert: async () => "new-id",
    removeEndpoints: async (endpoints, who, id) => {
      const before = subscriptions.length;
      subscriptions = subscriptions.filter(row => !(row.owner === who && endpoints.includes(row.endpoint) && (!id || row.id === id)));
      return before - subscriptions.length;
    } };
}
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const options = (body, method = "POST") => ({ method, headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("completion delivery is owner-scoped and prunes only matching expired bindings", async () => {
  const state = createState();
  const seen = [];
  const result = await notifyAll({ state, owner, push: { sendNotification: async subscription => {
    seen.push(subscription.id);
    if (subscription.id !== "live") throw Object.assign(new Error("expired"), { statusCode: 410 });
  } }, notification: {} });
  assert.deepEqual(result, { sent: 1, removed: 2, failed: 0 });
  assert.deepEqual(seen, ["live", "missing", "gone"]);
  assert.equal(state.listSubscriptions("b".repeat(64)).length, 1);
});
test("missing owner never broadcasts and provider errors are not projected", async () => {
  const push = { sendNotification: async () => { throw Object.assign(new Error("secret"), { body: "endpoint-secret", statusCode: 403 }); } };
  assert.deepEqual(await notifyAll({ state: createState(), push, notification: {} }), { sent: 0, removed: 0, failed: 0 });
  assert.deepEqual(await notifyAll({ state: createState(), owner, push, notification: {} }), { sent: 0, removed: 0, failed: 3 });
});
test("status and test require identity and origin; oversized requests rejected", async () => {
  await withServer(createHandler({ state: createState(), push: {}, appOrigin: origin, authenticate: async () => { throw Object.assign(new Error("sign_in_required"), { statusCode: 401 }); } }), async base => {
    assert.equal((await fetch(`${base}/v1/status`, options({ endpoint: null }))).status, 401);
    assert.equal((await fetch(`${base}/v1/status`, { ...options({ endpoint: null }), headers: { Origin: "https://evil.example", "Content-Type": "application/json" } })).status, 403);
    assert.equal((await fetch(`${base}/v1/subscriptions`, { ...options({}, "PUT"), body: "x".repeat(MAX_BODY_BYTES + 1) })).status, 413);
  });
});
test("test targets one owned device, uses fixed content, deduplicates and throttles", async () => {
  const seen = [];
  const handler = createHandler({ state: createState(), push: { sendNotification: async (subscription, payload) => seen.push({ subscription, payload: JSON.parse(payload) }) }, authenticate: async () => owner, appOrigin: origin });
  await withServer(handler, async base => {
    const status = await (await fetch(`${base}/v1/status`, options({ endpoint: "https://fcm.googleapis.com/live" }))).json();
    assert.equal(status.registered, true);
    assert.equal(status.binding, "live");
    const body = { binding: "live", requestId: "request-1234567890" };
    const first = await fetch(`${base}/v1/test`, options(body));
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal((await first.json()).outcome, "accepted");
    await fetch(`${base}/v1/test`, options(body));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].payload, { title: "Hermes notification test", body: "This device received a test notification.", url: "/", tag: "hermes-notification-test" });
    assert.equal((await fetch(`${base}/v1/test`, options({ ...body, requestId: "different-1234567890" }))).status, 429);
    assert.equal((await fetch(`${base}/v1/test`, options({ ...body, binding: "other" }))).status, 409);
    assert.equal((await fetch(`${base}/v1/test`, options({ ...body, url: "https://127.0.0.1" }))).status, 400);
    assert.equal((await fetch(`${base}/v1/subscriptions`, options({ endpoint: 'https://fcm.googleapis.com/live', binding: '' }, 'DELETE'))).status, 400);
    assert.equal((await (await fetch(`${base}/v1/status`, options({ endpoint: "https://fcm.googleapis.com/other" }))).json()).registered, false);
  });
});
test("expired and failed tests return redacted outcomes", async () => {
  for (const [statusCode, outcome] of [[410, "expired"], [403, "unknown"]]) {
    const state = createState();
    await withServer(createHandler({ state, push: { sendNotification: async () => { throw Object.assign(new Error("secret"), { statusCode, body: "secret-endpoint" }); } }, authenticate: async () => owner, appOrigin: origin }), async base => {
      const response = await fetch(`${base}/v1/test`, options({ binding: "live", requestId: "request-1234567890" }));
      assert.deepEqual(await response.json(), { outcome, retryAfter: 30 });
      assert.equal(state.listSubscriptions(owner).some(row => row.id === "live"), outcome !== "expired");
    });
  }
});
