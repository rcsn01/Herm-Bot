import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayState } from "../src/state.js";

test("persists VAPID keys and atomically upserts subscriptions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-push-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "state.json");
  let generations = 0;
  const generate = () => {
    generations += 1;
    return { publicKey: "public", privateKey: "private" };
  };

  const state = new RelayState(statePath, generate);
  await state.initialize();
  await state.upsert({
    endpoint: "https://push.example.test/one",
    expirationTime: null,
    keys: { p256dh: "key-one", auth: "auth-one" },
  });
  await state.upsert({
    endpoint: "https://push.example.test/one",
    expirationTime: null,
    keys: { p256dh: "key-two", auth: "auth-two" },
  });

  const restarted = new RelayState(statePath, generate);
  await restarted.initialize();
  assert.equal(generations, 1);
  assert.equal(restarted.publicKey, "public");
  assert.deepEqual(restarted.listSubscriptions(), [
    {
      endpoint: "https://push.example.test/one",
      expirationTime: null,
      keys: { p256dh: "key-two", auth: "auth-two" },
    },
  ]);
  const storedContents = await readFile(statePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(storedContents));
});
