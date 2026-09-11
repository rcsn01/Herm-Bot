function gatewayURL(value) {
  const raw = value.trim();
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("HERMES_GATEWAY must be an HTTP URL without embedded credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("HERMES_GATEWAY must not contain a path, query, or fragment");
  }
  return url;
}

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values
    .map((value) => value.split(";", 1)[0])
    .filter((value) => value.includes("="))
    .join("; ");
}

async function jsonResponse(response, action) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Hermes returned a non-JSON response during ${action}`);
  }
  if (!response.ok) {
    const detail = typeof body?.detail === "string" ? `: ${body.detail}` : "";
    throw new Error(`Hermes returned HTTP ${response.status} during ${action}${detail}`);
  }
  return body;
}

export class HermesAuthenticator {
  constructor({ gateway, token = "", username = "", password = "", provider = "password", fetchImpl = globalThis.fetch }) {
    this.baseUrl = gatewayURL(gateway);
    this.token = token.trim();
    this.username = username;
    this.password = password;
    this.provider = provider;
    this.fetchImpl = fetchImpl;
    this.cookie = "";
    this.loginPromise = undefined;

    const hasPasswordCredentials = Boolean(username && password);
    if (!this.token && !hasPasswordCredentials) {
      throw new Error("Set HERMES_BRIDGE_TOKEN or both HERMES_BRIDGE_USERNAME and HERMES_BRIDGE_PASSWORD");
    }
  }

  async webSocketURL(profile = "default") {
    const url = new URL("/api/ws", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("profile", profile);

    if (this.token) {
      url.searchParams.set("token", this.token);
      return url.toString();
    }

    await this.#login();
    const response = await this.fetchImpl(new URL("/api/auth/ws-ticket", this.baseUrl), {
      method: "POST",
      headers: { Cookie: this.cookie },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      this.cookie = "";
      this.loginPromise = undefined;
    }
    const body = await jsonResponse(response, "WebSocket ticket creation");
    if (typeof body.ticket !== "string" || !body.ticket) {
      throw new Error("Hermes returned an invalid WebSocket ticket");
    }
    url.searchParams.set("ticket", body.ticket);
    return url.toString();
  }

  async #login() {
    if (this.cookie) return;
    if (!this.loginPromise) {
      this.loginPromise = this.#performLogin().catch((error) => {
        this.loginPromise = undefined;
        throw error;
      });
    }
    await this.loginPromise;
  }

  async #performLogin() {
    const response = await this.fetchImpl(new URL("/auth/password-login", this.baseUrl), {
      method: "POST",
      body: JSON.stringify({
        provider: this.provider,
        username: this.username,
        password: this.password,
      }),
      headers: { "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await jsonResponse(response, "password login");
    const cookie = cookieHeader(response);
    if (!cookie) throw new Error("Hermes password login did not set a session cookie");
    this.cookie = cookie;
  }
}
