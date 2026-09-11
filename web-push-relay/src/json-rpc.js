const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function asError(value, fallback) {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : fallback);
}

export class JsonRpcSocket {
  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    connectTimeoutMs = 10_000,
  }) {
    if (typeof WebSocketImpl !== "function") {
      throw new Error("This Node.js runtime does not provide a WebSocket client");
    }
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.eventHandlers = new Set();
    this.closeHandlers = new Set();
    this.socket = undefined;
  }

  async connect() {
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;

    socket.addEventListener("message", (message) => this.#onMessage(message.data));
    socket.addEventListener("close", () => this.#onClose(new Error("Hermes WebSocket closed")));
    socket.addEventListener("error", () => {});

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error("Hermes WebSocket connection timed out"));
      }, this.connectTimeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Hermes WebSocket connection failed"));
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Hermes WebSocket closed during connection"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onClose(handler) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) {
      return Promise.reject(new Error("Hermes WebSocket is not connected"));
    }

    const id = `bridge-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes RPC timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error, `Hermes RPC failed: ${method}`));
      }
    });
  }

  close() {
    const socket = this.socket;
    if (!socket) return;
    this.socket = undefined;
    socket.close();
    const error = new Error("Hermes WebSocket closed");
    this.#rejectPending(error);
    for (const handler of this.closeHandlers) handler(error);
  }

  #onMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }

    if (frame.id !== undefined && frame.id !== null) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error) {
        pending.reject(new Error(frame.error.message || "Hermes RPC failed"));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    if (frame.method === "event" && frame.params?.type) {
      for (const handler of this.eventHandlers) handler(frame.params);
    }
  }

  #onClose(error) {
    if (!this.socket) return;
    this.socket = undefined;
    this.#rejectPending(error);
    for (const handler of this.closeHandlers) handler(error);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
