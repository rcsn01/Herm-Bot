import { validateDestination, validateEndpoint, validateSubscription } from "./validation.js";

export const MAX_BODY_BYTES = 32 * 1024;
const problem = (code, statusCode) => Object.assign(new Error(code), { statusCode });
function sendJson(response, statusCode, value, headers = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "X-Content-Type-Options": "nosniff", ...headers });
  response.end(body);
}
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw problem("body_too_large", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw problem("invalid_json", 400); }
}
function fields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw problem("invalid_body", 400);
}

async function deliver({ state, push, subscription, notification, owner }) {
  try {
    validateDestination(subscription.endpoint);
    // web-push uses node https.request, which does not follow redirects.
    await push.sendNotification(subscription, JSON.stringify(notification), { timeout: 10000, TTL: 60 });
    return "accepted";
  } catch (error) {
    if ([404, 410].includes(error.statusCode)) {
      await state.removeEndpoints([subscription.endpoint], owner, subscription.id);
      return "expired";
    }
    return "unknown";
  }
}

// Kept as the bridge entry point, but never broadcasts across owners.
export async function notifyAll({ state, push, notification, owner }) {
  if (!owner) return { sent: 0, removed: 0, failed: 0 };
  const subscriptions = state.listSubscriptions(owner);
  const results = await Promise.all(subscriptions.map(subscription => deliver({ state, push, subscription, notification, owner })));
  return { sent: results.filter(value => value === "accepted").length, removed: results.filter(value => value === "expired").length, failed: results.filter(value => value === "unknown").length };
}

export function createHandler({ state, push, authenticate = async () => { throw problem("identity_unavailable", 503); }, appOrigin, now = Date.now }) {
  const attempts = new Map();
  const cooldowns = new Map();
  let pending = 0;
  return async function handler(request, response) {
    const pathname = new URL(request.url, "http://relay.invalid").pathname;
    try {
      if (request.method === "GET" && pathname === "/healthz") return sendJson(response, 200, { status: "ok" });
      if (request.method === "GET" && pathname === "/v1/public-key") return sendJson(response, 200, { publicKey: state.publicKey, version: 2 });
      if (!["/v1/subscriptions", "/v1/status", "/v1/test"].includes(pathname)) throw problem("not_found", 404);
      if (!(pathname === "/v1/subscriptions" ? ["PUT", "DELETE"] : ["POST"]).includes(request.method)) throw problem("method_not_allowed", 405);
      if (!appOrigin || request.headers.origin !== appOrigin || !request.headers["content-type"]?.startsWith("application/json")) throw problem("invalid_origin_or_content_type", 403);
      if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) throw problem("body_too_large", 413);
      const owner = await authenticate(request);
      if (!owner) throw problem("identity_unavailable", 503);
      const body = await readJson(request);
      if (pathname === "/v1/status") {
        fields(body, ["endpoint"]);
        if (body.endpoint !== null && typeof body.endpoint !== "string") throw problem("invalid_body", 400);
        const endpoint = body.endpoint === null ? null : validateEndpoint(body);
        const binding = state.listSubscriptions(owner).find(item => item.endpoint === endpoint);
        return sendJson(response, 200, { version: 2, owner, registered: Boolean(binding), binding: binding?.id ?? null, bridge: "not_checked" });
      }
      if (pathname === "/v1/subscriptions") {
        if (request.method === "PUT") {
          fields(body, ["endpoint", "keys", "expirationTime"]);
          const binding = await state.upsert(validateSubscription(body), owner);
          return sendJson(response, 200, { ok: true, binding });
        }
        fields(body, ["endpoint", "binding"]);
        if (typeof body.binding !== "string" || !body.binding || body.binding.length > 100) throw problem("invalid_body", 400);
        const endpoint = validateEndpoint({ endpoint: body.endpoint });
        const removed = await state.removeEndpoints([endpoint], owner, body.binding);
        return sendJson(response, 200, { ok: true, removed });
      }
      fields(body, ["binding", "requestId"]);
      if (typeof body.binding !== "string" || !body.binding || body.binding.length > 100 || typeof body.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw problem("invalid_body", 400);
      const subscription = state.listSubscriptions(owner).find(item => item.id === body.binding);
      if (!subscription) throw problem("registration_missing", 409);
      for (const [key, attempt] of attempts) if (attempt.expires <= now()) attempts.delete(key);
      for (const [key, until] of cooldowns) if (until <= now()) cooldowns.delete(key);
      const key = `${owner}:${body.binding}:${body.requestId}`;
      if (attempts.has(key)) return sendJson(response, 200, await attempts.get(key).result);
      if (pending >= 4 || attempts.size >= 1000 || cooldowns.has(owner)) return sendJson(response, 429, { error: "test_cooldown", retryAfter: 30 }, { "Retry-After": "30" });
      cooldowns.set(owner, now() + 30000);
      pending += 1;
      const result = deliver({ state, push, subscription, owner, notification: { title: "Hermes notification test", body: "This device received a test notification.", url: "/", tag: "hermes-notification-test" } })
        .then(outcome => ({ outcome, retryAfter: 30 }))
        .finally(() => { pending -= 1; });
      attempts.set(key, { result, expires: now() + 600000 });
      return sendJson(response, 200, await result);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const statusCode = error.statusCode ?? (error.message?.startsWith("invalid") || error.message?.includes("required") || error.message?.includes("must ") ? 400 : 500);
      sendJson(response, statusCode, { error: statusCode >= 500 ? "identity_or_relay_unavailable" : error.message });
    }
  };
}
