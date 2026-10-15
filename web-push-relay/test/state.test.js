import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayState } from "../src/state.js";
const subscription = { endpoint: "https://fcm.googleapis.com/one", expirationTime: null, keys: { p256dh: "key", auth: "auth" } };
async function setup(t, legacy) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-push-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  if (legacy) await writeFile(file, JSON.stringify(legacy));
  const state = new RelayState(file, () => ({ publicKey: "public", privateKey: "private" }));
  await state.initialize();
  return { state, file };
}
test("persists keys, isolates owners and atomically replaces a binding", async t => {
  const { state, file } = await setup(t);
  const first = await state.upsert(subscription, "a");
  const second = await state.upsert(subscription, "a");
  assert.notEqual(first, second);
  assert.equal(state.listSubscriptions("b").length, 0);
  assert.equal(state.listSubscriptions().length, 0);
  await assert.rejects(state.upsert(subscription, "b"), /another_account/);
  assert.equal(await state.removeEndpoints([subscription.endpoint], "b"), 0);
  assert.equal(await state.removeEndpoints([subscription.endpoint], "a", first), 0);
  const restarted = new RelayState(file, () => { throw new Error("must retain VAPID"); });
  await restarted.initialize();
  assert.equal(restarted.publicKey, "public");
  assert.equal(restarted.listSubscriptions("a")[0].id, second);
  assert.equal(JSON.parse(await readFile(file)).version, 2);
  assert.equal(await state.removeEndpoints([subscription.endpoint], "a", second), 1);
});
test("legacy migration preserves VAPID and quarantines ownerless subscriptions", async t => {
  const { state, file } = await setup(t, { vapid: { publicKey: "old", privateKey: "secret" }, subscriptions: [subscription] });
  assert.equal(state.publicKey, "old");
  assert.deepEqual(state.listSubscriptions("a"), []);
  const stored = JSON.parse(await readFile(file));
  assert.equal(stored.subscriptions[0].owner, null);
  assert.equal(stored.vapid.privateKey, "secret");
  await state.upsert(subscription, "a");
  assert.equal(state.listSubscriptions("a").length, 1);
});
