import assert from "node:assert/strict";
import test from "node:test";
import {
  validateEndpoint,
  validateNotification,
  validateSubscription,
} from "../src/validation.js";

const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString(
  "base64url",
);
const auth = Buffer.alloc(16, 9).toString("base64url");

test("validates and canonicalizes a push subscription", () => {
  const subscription = validateSubscription({
    endpoint: "https://push.example.test/device",
    expirationTime: null,
    keys: { p256dh, auth },
    ignored: "not persisted",
  });

  assert.deepEqual(subscription, {
    endpoint: "https://push.example.test/device",
    expirationTime: null,
    keys: { p256dh, auth },
  });
});

test("rejects insecure endpoints and malformed keys", () => {
  assert.throws(
    () =>
      validateSubscription({
        endpoint: "http://push.example.test/device",
        keys: { p256dh, auth },
      }),
    /invalid subscription endpoint/,
  );
  assert.throws(
    () =>
      validateSubscription({
        endpoint: "https://push.example.test/device",
        keys: { p256dh: "short", auth },
      }),
    /invalid subscription key/,
  );
  assert.throws(
    () => validateEndpoint({ endpoint: "https://example.test", extra: true }),
    /only endpoint/,
  );
});

test("notification accepts same-origin paths but rejects active URL schemes", () => {
  assert.deepEqual(validateNotification({ title: "Ready", url: "/session/1" }), {
    title: "Ready",
    body: "",
    url: "/session/1",
    tag: "",
  });
  assert.throws(
    () => validateNotification({ url: "javascript:alert(1)" }),
    /invalid notification URL/,
  );
});
