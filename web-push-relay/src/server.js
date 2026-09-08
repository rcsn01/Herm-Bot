import http from "node:http";
import path from "node:path";
import process from "node:process";
import webPush from "web-push";
import { createHandler, notifyAll } from "./app.js";
import { HermesEventReceiver } from "./hermes-events.js";
import { RelayState } from "./state.js";

const port = Number(process.env.PORT ?? "8080");
const dataDirectory = process.env.DATA_DIR ?? "/data";
const token = process.env.HERMES_WEB_PUSH_TOKEN ?? "";
const appUrl = process.env.HERMES_WEB_PUSH_APP_URL ?? "";
const vapidSubject = process.env.HERMES_WEB_PUSH_SUBJECT || appUrl;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}
if (Buffer.byteLength(token, "utf8") < 32) {
  throw new Error("HERMES_WEB_PUSH_TOKEN must contain at least 32 bytes");
}

const state = new RelayState(
  path.join(dataDirectory, "state.json"),
  () => webPush.generateVAPIDKeys(),
);
await state.initialize();

const vapid = state.vapid;
webPush.setVapidDetails(vapidSubject, vapid.publicKey, vapid.privateKey);

const hermesEvents = new HermesEventReceiver({
  appUrl,
  deliver: (notification) => notifyAll({ state, push: webPush, notification }),
  onError: () => console.error("Hermes Web Push delivery failed"),
});

const server = http.createServer(
  createHandler({ state, push: webPush, token, hermesEvents }),
);
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.listen(port, "0.0.0.0", () => {
  console.log(`Hermes web push relay listening on port ${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
