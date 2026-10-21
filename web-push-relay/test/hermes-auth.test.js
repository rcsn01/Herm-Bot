import assert from "node:assert/strict";
import test from "node:test";
import { HermesAuthenticator } from "../src/hermes-auth.js";

test("static-token authentication builds a profile-scoped WebSocket URL", async () => {
  const auth = new HermesAuthenticator({
    gateway: "gateway.internal:9119",
    token: "existing-hermes-token",
  });
  const url = new URL(await auth.webSocketURL("work"));
  assert.equal(url.href, "ws://gateway.internal:9119/api/ws?profile=work&token=existing-hermes-token");
});

test("password authentication logs in once and requests a fresh ticket per socket", async () => {
  const requests = [];
  let ticket = 0;
  const auth = new HermesAuthenticator({
    gateway: "https://gateway.example",
    username: "bridge-user",
    password: "bridge-password",
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), options });
      if (url.pathname === "/auth/password-login") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "set-cookie": "hermes_session=opaque; Path=/; HttpOnly" },
        });
      }
      ticket += 1;
      return Response.json({ ticket: `ticket-${ticket}` });
    },
  });

  const first = new URL(await auth.webSocketURL());
  const second = new URL(await auth.webSocketURL());
  assert.equal(first.href, "wss://gateway.example/api/ws?profile=default&ticket=ticket-1");
  assert.equal(second.searchParams.get("ticket"), "ticket-2");
  assert.equal(requests.filter(({ url }) => url.endsWith("/auth/password-login")).length, 1);
  assert.equal(requests[1].options.headers.Cookie, "hermes_session=opaque");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    provider: "password",
    username: "bridge-user",
    password: "bridge-password",
  });
});

test("cron polling is an authenticated read across profiles on the fixed gateway", async () => {
  const requests = [];
  const auth = new HermesAuthenticator({
    gateway: "https://gateway.example", token: "configured-token",
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), options });
      return Response.json([{ id: "job", profile: "work" }]);
    },
  });
  assert.deepEqual(await auth.cronJobs(), [{ id: "job", profile: "work" }]);
  assert.equal(requests[0].url, "https://gateway.example/api/cron/jobs?profile=all");
  assert.deepEqual(requests[0].options.headers, { "X-Hermes-Session-Token": "configured-token" });
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.method, undefined);
});

test("cron polling refreshes an expired password cookie once", async () => {
  let logins = 0;
  let reads = 0;
  const auth = new HermesAuthenticator({
    gateway: "https://gateway.example", username: "bridge", password: "password",
    fetchImpl: async (url, options) => {
      if (url.pathname === "/auth/password-login") {
        return Response.json({}, { headers: { "set-cookie": `session=${++logins}; Path=/; HttpOnly` } });
      }
      reads++;
      if (reads === 1) return Response.json({}, { status: 401 });
      assert.equal(options.headers.Cookie, "session=2");
      return Response.json([]);
    },
  });
  assert.deepEqual(await auth.cronJobs(), []);
  assert.equal(logins, 2);
  assert.equal(reads, 2);
});

test("invalid static credentials fail closed rather than falling back or looping", async () => {
  let reads = 0;
  const auth = new HermesAuthenticator({
    gateway: "https://gateway.example", token: "expired",
    fetchImpl: async () => { reads++; return Response.json({}, { status: 401 }); },
  });
  await assert.rejects(auth.cronJobs(), /HTTP 401/);
  assert.equal(reads, 1);
});

test("authentication requires an existing Hermes credential", () => {
  assert.throws(
    () => new HermesAuthenticator({ gateway: "http://gateway.internal:9119" }),
    /HERMES_BRIDGE_TOKEN/,
  );
});
