import assert from "node:assert/strict";
import test from "node:test";
import { browserAuthenticator, ownerFromIdentity, ownedNotification } from "../src/ownership.js";
const identity = { org_id: "", user_id: "user", provider: "password" };
test("completion links include explicit default profile and opaque owner provenance", () => {
  const value = ownedNotification({ url: '/session/abc', body: 'preview' }, 'https://mobile.example', 'a'.repeat(64));
  const url = new URL(value.url, 'https://mobile.example');
  assert.equal(url.searchParams.get('profile'), '');
  assert.equal(url.searchParams.get('push_owner'), 'a'.repeat(64));
  assert.equal(new URL(ownedNotification({ url: '/session/abc?profile=work' }, 'https://mobile.example', 'owner').url, 'https://mobile.example').searchParams.get('profile'), 'work');
  assert.throws(() => ownedNotification({ url: 'https://evil.example/' }, 'https://mobile.example', 'owner'));
});

test("only stable verified identities produce namespace-scoped opaque owners", () => {
  assert.equal(ownerFromIdentity({}, "gateway"), null);
  assert.equal(ownerFromIdentity({ org_id: "", user_id: "user" }, "gateway"), null);
  assert.match(ownerFromIdentity(identity, "gateway"), /^[a-f0-9]{64}$/);
  assert.notEqual(ownerFromIdentity(identity, "a"), ownerFromIdentity(identity, "b"));
});
test("browser identity ignores forged owners and forwards only supported credentials to fixed upstream", async () => {
  let call;
  const authenticate = browserAuthenticator({ gateway: "https://gateway.example", fetchImpl: async (...args) => { call = args; return new Response(JSON.stringify(identity)); } });
  const result = await authenticate({ headers: { cookie: "session=value", "x-hermes-session-token": "token", "x-owner": "evil", authorization: "evil" } });
  assert.equal(result, ownerFromIdentity(identity, "https://gateway.example"));
  assert.equal(call[0].href, "https://gateway.example/api/auth/me");
  assert.deepEqual(call[1].headers, { Cookie: "session=value", "X-Hermes-Session-Token": "token" });
  assert.equal(call[1].redirect, "error");
  await assert.rejects(authenticate({ headers: {} }), /sign_in_required/);
});
test("unsupported and malformed identity fail closed with no upstream error detail", async () => {
  for (const response of [new Response("secret", { status: 404 }), new Response("not json"), new Response("{}")]) {
    const authenticate = browserAuthenticator({ gateway: "https://gateway.example", fetchImpl: async () => response });
    await assert.rejects(authenticate({ headers: { cookie: "session=x" } }), /identity_unavailable/);
  }
});
