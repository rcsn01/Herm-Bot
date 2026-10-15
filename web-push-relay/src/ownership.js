import { createHash } from "node:crypto";

export function gatewayURL(value) {
  const url = new URL(value.includes("://") ? value : `http://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid fixed gateway");
  return url;
}

export function ownerFromIdentity(value, namespace) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { org_id: org, user_id: user, provider } = value;
  if (typeof org !== "string" || org.length > 512 || typeof user !== "string" || !user || user.length > 512) return null;
  if (!org && (typeof provider !== "string" || !provider || provider.length > 512)) return null;
  const principal = org ? [org, user] : ["local", provider, user];
  return createHash("sha256").update(JSON.stringify([namespace, principal])).digest("hex");
}

export function ownedNotification(notification, appUrl, owner) {
  const url = new URL(notification.url || "/", appUrl);
  if (url.origin !== new URL(appUrl).origin) throw new Error("Invalid notification origin");
  if (!url.searchParams.has("profile")) url.searchParams.set("profile", "");
  url.searchParams.set("push", "1");
  url.searchParams.set("push_owner", owner);
  return { ...notification, url: `${url.pathname}${url.search}` };
}

export function browserAuthenticator({ gateway, fetchImpl = fetch }) {
  const base = gatewayURL(gateway);
  return async request => {
    const headers = {};
    if (request.headers.cookie) headers.Cookie = request.headers.cookie;
    if (request.headers["x-hermes-session-token"]) headers["X-Hermes-Session-Token"] = request.headers["x-hermes-session-token"];
    if (!Object.keys(headers).length) throw Object.assign(new Error("sign_in_required"), { statusCode: 401 });
    let response;
    try {
      response = await fetchImpl(new URL("/api/auth/me", base), { headers, redirect: "error", signal: AbortSignal.timeout(10000) });
      if ([401, 403].includes(response.status)) throw Object.assign(new Error("sign_in_required"), { statusCode: response.status });
      if (!response.ok) throw new Error("identity_unavailable");
      const owner = ownerFromIdentity(await response.json(), base.origin);
      if (!owner) throw new Error("identity_unavailable");
      return owner;
    } catch (error) {
      if (error.statusCode) throw error;
      throw Object.assign(new Error("identity_unavailable"), { statusCode: 503 });
    }
  };
}
