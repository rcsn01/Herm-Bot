const DELIVERY_CACHE_LIMIT = 1024;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, limit = 512) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export class HermesEventReceiver {
  constructor({ appUrl, deliver, onError = () => {} }) {
    const parsedAppUrl = new URL(appUrl);
    if (parsedAppUrl.protocol !== "https:") {
      throw new Error("HERMES_WEB_PUSH_APP_URL must use HTTPS");
    }
    this.appUrl = parsedAppUrl.href.replace(/\/$/, "");
    this.deliver = deliver;
    this.onError = onError;
    this.deliveryIds = new Set();
    this.deliveryQueue = Promise.resolve();
  }

  accept(value) {
    if (!object(value)) throw badRequest("webhook payload must be an object");
    if (value.hook_event_name !== "on_session_end") {
      throw badRequest("unsupported Hermes hook event");
    }
    const deliveryId = boundedString(value.delivery_id, 128);
    if (!deliveryId) throw badRequest("delivery_id is required");
    if (this.deliveryIds.has(deliveryId)) return { duplicate: true };
    this.deliveryIds.add(deliveryId);
    if (this.deliveryIds.size > DELIVERY_CACHE_LIMIT) {
      this.deliveryIds.delete(this.deliveryIds.values().next().value);
    }

    const sessionId = boundedString(value.session_id);
    const extra = object(value.extra) ? value.extra : {};
    const state = extra.failed
      ? { body: "A Hermes turn failed.", title: "Hermes — task failed" }
      : extra.interrupted
        ? { body: "A Hermes turn was stopped.", title: "Hermes — task stopped" }
        : { body: "Your Hermes response is ready.", title: "Hermes — task finished" };
    const sessionPath = sessionId
      ? `/session/${encodeURIComponent(sessionId)}`
      : "/";
    const notification = {
      ...state,
      url: `${this.appUrl}${sessionPath}`,
      tag: `hermes-turn-${boundedString(extra.turn_id, 100) || deliveryId}`,
    };

    const operation = this.deliveryQueue.then(() => this.deliver(notification));
    this.deliveryQueue = operation.catch((error) => this.onError(error));
    return { accepted: true };
  }
}
