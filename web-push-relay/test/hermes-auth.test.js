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

test("authentication requires an existing Hermes credential", () => {
  assert.throws(
    () => new HermesAuthenticator({ gateway: "http://gateway.internal:9119" }),
    /HERMES_BRIDGE_TOKEN/,
  );
});
