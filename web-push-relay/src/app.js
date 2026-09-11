import { validateEndpoint, validateSubscription } from "./validation.js";

export const MAX_BODY_BYTES = 32 * 1024;

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers["content-length"]);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_BODY_BYTES
    ) {
      request.resume();
      reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
      return;
    }

    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !rejected) {
        rejected = true;
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

async function readJson(request) {
  try {
    return JSON.parse((await readBody(request)).toString("utf8"));
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error("invalid JSON"), { statusCode: 400 });
  }
}

export async function notifyAll({ state, push, notification }) {
  const payload = JSON.stringify(notification);
  const subscriptions = state.listSubscriptions();
  const results = await Promise.allSettled(
    subscriptions.map((subscription) => push.sendNotification(subscription, payload)),
  );

  const expired = [];
  const errors = [];
  let sent = 0;
  let failed = 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "fulfilled") {
      sent += 1;
      continue;
    }
    if ([404, 410].includes(result.reason?.statusCode)) {
      expired.push(subscriptions[index].endpoint);
    } else {
      failed += 1;
      errors.push({
        statusCode: Number.isInteger(result.reason?.statusCode)
          ? result.reason.statusCode
          : null,
        code: typeof result.reason?.code === "string"
          ? result.reason.code.slice(0, 80)
          : null,
        body: typeof result.reason?.body === "string"
          ? result.reason.body.slice(0, 256)
          : null,
      });
    }
  }
  if (expired.length > 0) {
    await state.removeEndpoints(expired);
  }
  const summary = { sent, removed: expired.length, failed };
  return errors.length > 0 ? { ...summary, errors } : summary;
}

export function createHandler({ state, push }) {
  return async function handler(request, response) {
    const pathname = new URL(request.url, "http://relay.invalid").pathname;

    try {
      if (request.method === "GET" && pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && pathname === "/v1/public-key") {
        sendJson(response, 200, { publicKey: state.publicKey });
        return;
      }
      if (request.method === "PUT" && pathname === "/v1/subscriptions") {
        const subscription = validateSubscription(await readJson(request));
        await state.upsert(subscription);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "DELETE" && pathname === "/v1/subscriptions") {
        const endpoint = validateEndpoint(await readJson(request));
        const removed = await state.removeEndpoints([endpoint]);
        sendJson(response, 200, { ok: true, removed });
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        return;
      }
      const statusCode = error.statusCode ?? (
        error instanceof SyntaxError || error.message?.startsWith("invalid") ||
        error.message?.includes("must ") || error.message?.includes("required") ||
        error.message?.includes("too long") || error.message?.includes("only endpoint")
          ? 400
          : 500
      );
      sendJson(response, statusCode, {
        error: statusCode >= 500 ? "internal error" : error.message,
      });
    }
  };
}
