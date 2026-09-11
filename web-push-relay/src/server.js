import http from "node:http";
import path from "node:path";
import process from "node:process";
import webPush from "web-push";
import { createHandler, notifyAll } from "./app.js";
import { CompletionBridgeState, HermesCompletionBridge } from "./completion-bridge.js";
import { HermesAuthenticator } from "./hermes-auth.js";
import { RelayState } from "./state.js";

const port = Number(process.env.PORT ?? "8080");
const dataDirectory = process.env.DATA_DIR ?? "/data";
const appUrl = process.env.HERMES_WEB_PUSH_APP_URL ?? "";
const vapidSubject = process.env.HERMES_WEB_PUSH_SUBJECT || appUrl;
const bridgeEnabled = (process.env.HERMES_COMPLETION_BRIDGE_ENABLED ?? "true") !== "false";
const gateway = process.env.HERMES_GATEWAY || process.env.HERMES_URL || "";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}
function integerSetting(name, fallback, minimum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

const state = new RelayState(
  path.join(dataDirectory, "state.json"),
  () => webPush.generateVAPIDKeys(),
);
await state.initialize();

const vapid = state.vapid;
webPush.setVapidDetails(vapidSubject, vapid.publicKey, vapid.privateKey);

let completionBridge;
if (bridgeEnabled) {
  if (!gateway) throw new Error("HERMES_GATEWAY is required when the completion bridge is enabled");
  const bridgeState = new CompletionBridgeState(path.join(dataDirectory, "completion-bridge.json"));
  await bridgeState.initialize();
  const authenticator = new HermesAuthenticator({
    gateway,
    token: process.env.HERMES_BRIDGE_TOKEN,
    username: process.env.HERMES_BRIDGE_USERNAME,
    password: process.env.HERMES_BRIDGE_PASSWORD,
    provider: process.env.HERMES_BRIDGE_AUTH_PROVIDER || "password",
  });
  completionBridge = new HermesCompletionBridge({
    appUrl,
    authenticator,
    state: bridgeState,
    deliver: async (notification) => {
      const result = await notifyAll({ state, push: webPush, notification });
      if (result.failed > 0) {
        throw new Error(`Web Push failed for ${result.failed} subscription(s)`);
      }
      return result;
    },
    pollIntervalMs: integerSetting("HERMES_BRIDGE_POLL_INTERVAL_MS", "1000", 250),
    reconnectMinMs: integerSetting("HERMES_BRIDGE_RECONNECT_MIN_MS", "1000", 250),
    reconnectMaxMs: integerSetting("HERMES_BRIDGE_RECONNECT_MAX_MS", "30000", 250),
    onError: (error) => console.error(`Hermes completion bridge: ${error.message}`),
  });
}

const server = http.createServer(createHandler({ state, push: webPush }));
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.listen(port, "0.0.0.0", () => {
  console.log(`Hermes web push relay listening on port ${port}`);
  completionBridge?.start();
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  const deadline = new Promise((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([completionBridge?.stop(), deadline]);
  server.closeAllConnections();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
