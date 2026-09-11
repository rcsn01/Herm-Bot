import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { JsonRpcSocket } from "./json-rpc.js";
import { durableWrite } from "./state.js";

const STATE_VERSION = 1;
const DELIVERED_LIMIT = 2048;
const SESSION_LIMIT = 256;
const DEFAULT_MAX_OBSERVERS = 64;
const DEFAULT_RECONCILE_BUFFER_LIMIT = 2048;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, limit = 512) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function sequence(event) {
  return typeof event?.seq === "number" && Number.isFinite(event.seq) ? event.seq : 0;
}

function runtimeId(value) {
  if (!object(value)) return "";
  return boundedString(value.session_id || value.runtime_session_id || value.id, 256);
}

function sessionMetadata(value) {
  const info = object(value?.info) ? value.info : {};
  return {
    storedSessionId: boundedString(
      value?.stored_session_id || value?.session_key || info.stored_session_id,
    ),
    profile: boundedString(value?.profile || info.profile, 128),
  };
}

function mergeMetadata(current, next) {
  return {
    storedSessionId: next.storedSessionId || current.storedSessionId || "",
    profile: next.profile || current.profile || "",
  };
}

function validateAppUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("HERMES_WEB_PUSH_APP_URL must be an HTTPS URL without credentials");
  }
  return url.href.replace(/\/$/, "");
}

function initialState() {
  return { version: STATE_VERSION, epoch: null, sessions: {}, delivered: [] };
}

function validateState(value) {
  if (
    !object(value) || value.version !== STATE_VERSION ||
    !(value.epoch === null || typeof value.epoch === "string") ||
    !object(value.sessions) || !Array.isArray(value.delivered)
  ) {
    throw new Error("completion bridge state is invalid");
  }
  return value;
}

export class CompletionBridgeState {
  constructor(filePath) {
    this.filePath = filePath;
    this.value = undefined;
    this.mutation = Promise.resolve();
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      this.value = validateState(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.value = initialState();
      await durableWrite(this.filePath, this.value);
    }
  }

  snapshot() {
    return structuredClone(this.value);
  }

  hasDelivered(key) {
    return this.value.delivered.includes(key);
  }

  async mutate(change) {
    const operation = this.mutation.then(async () => {
      const next = change(this.value);
      if (next === this.value) return;
      await durableWrite(this.filePath, next);
      this.value = next;
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }

  async adoptEpoch(epoch) {
    if (!epoch) return;
    await this.mutate((current) => {
      if (current.epoch === epoch) return current;
      if (current.epoch === null) return { ...current, epoch };
      return { ...initialState(), epoch };
    });
  }

  async rememberSession(sessionId, metadata = {}) {
    await this.mutate((current) => {
      const previous = current.sessions[sessionId] ?? {};
      const next = {
        initialized: previous.initialized === true,
        lastSeen: Number.isFinite(previous.lastSeen) ? previous.lastSeen : 0,
        storedSessionId: metadata.storedSessionId || previous.storedSessionId || "",
        profile: metadata.profile || previous.profile || "",
        touchedAt: Date.now(),
      };
      if (
        previous.storedSessionId === next.storedSessionId &&
        previous.profile === next.profile &&
        Number.isFinite(previous.touchedAt) && Date.now() - previous.touchedAt < 60_000
      ) {
        return current;
      }
      let sessions = { ...current.sessions, [sessionId]: next };
      const entries = Object.entries(sessions);
      if (entries.length > SESSION_LIMIT) {
        entries.sort((left, right) => (right[1].touchedAt ?? 0) - (left[1].touchedAt ?? 0));
        sessions = Object.fromEntries(entries.slice(0, SESSION_LIMIT));
      }
      return { ...current, sessions };
    });
  }

  async advance(sessionId, lastSeen, metadata = {}) {
    await this.mutate((current) => {
      const previous = current.sessions[sessionId] ?? {};
      const nextSeen = Math.max(previous.lastSeen ?? 0, lastSeen || 0);
      const nextStored = metadata.storedSessionId || previous.storedSessionId || "";
      const nextProfile = metadata.profile || previous.profile || "";
      if (
        previous.initialized === true && previous.lastSeen === nextSeen &&
        previous.storedSessionId === nextStored && previous.profile === nextProfile
      ) return current;
      return {
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...previous,
            initialized: true,
            lastSeen: nextSeen,
            storedSessionId: nextStored,
            profile: nextProfile,
            touchedAt: Date.now(),
          },
        },
      };
    });
  }

  async forgetSession(sessionId) {
    await this.mutate((current) => {
      if (!current.sessions[sessionId]) return current;
      const sessions = { ...current.sessions };
      delete sessions[sessionId];
      return { ...current, sessions };
    });
  }

  async markDelivered(sessionId, lastSeen, key, metadata = {}) {
    await this.mutate((current) => {
      const previous = current.sessions[sessionId] ?? {};
      const delivered = current.delivered.includes(key)
        ? current.delivered
        : [...current.delivered, key].slice(-DELIVERED_LIMIT);
      return {
        ...current,
        delivered,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...previous,
            initialized: true,
            lastSeen: Math.max(previous.lastSeen ?? 0, lastSeen || 0),
            storedSessionId: metadata.storedSessionId || previous.storedSessionId || "",
            profile: metadata.profile || previous.profile || "",
            touchedAt: Date.now(),
          },
        },
      };
    });
  }
}

export class HermesCompletionBridge {
  constructor({
    appUrl,
    authenticator,
    state,
    deliver,
    connectionFactory = (url) => new JsonRpcSocket({ url }),
    pollIntervalMs = 1_000,
    reconnectMinMs = 1_000,
    reconnectMaxMs = 30_000,
    maxObservers = DEFAULT_MAX_OBSERVERS,
    reconcileBufferLimit = DEFAULT_RECONCILE_BUFFER_LIMIT,
    onError = () => {},
  }) {
    this.appUrl = validateAppUrl(appUrl);
    this.authenticator = authenticator;
    this.state = state;
    this.deliver = deliver;
    this.connectionFactory = connectionFactory;
    this.pollIntervalMs = pollIntervalMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.maxObservers = maxObservers;
    this.reconcileBufferLimit = reconcileBufferLimit;
    this.onError = onError;
    this.running = false;
    this.control = undefined;
    this.controlPromise = undefined;
    this.observers = new Map();
    this.observerLimitWarned = false;
    this.sleepWaiters = new Set();
    this.deliveryQueue = Promise.resolve();
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const [sessionId, value] of Object.entries(this.state.snapshot().sessions)) {
      this.#ensureObserver(sessionId, {
        storedSessionId: boundedString(value.storedSessionId),
        profile: boundedString(value.profile, 128),
      });
    }
    this.controlPromise = this.#controlLoop();
  }

  async stop() {
    this.running = false;
    this.control?.close();
    for (const observer of this.observers.values()) observer.connection?.close();
    for (const wake of this.sleepWaiters) wake();
    const observerPromises = [...this.observers.values()].map((observer) => observer.promise);
    await Promise.allSettled([this.controlPromise, ...observerPromises, this.deliveryQueue]);
    this.observers.clear();
  }

  async #controlLoop() {
    let delay = this.reconnectMinMs;
    while (this.running) {
      let connection;
      try {
        connection = await this.#connect();
        this.control = connection;
        delay = this.reconnectMinMs;
        while (this.running && this.control === connection) {
          const result = await connection.request("session.active_list");
          const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
          const activeIds = new Set();
          for (const item of sessions) {
            const sessionId = runtimeId(item);
            if (!sessionId) continue;
            activeIds.add(sessionId);
            const metadata = sessionMetadata(item);
            await this.state.rememberSession(sessionId, metadata);
            this.#ensureObserver(sessionId, metadata);
          }
          for (const [sessionId, observer] of this.observers) {
            if (activeIds.has(sessionId) || !observer.reconciled) continue;
            observer.stopped = true;
            observer.connection?.close();
            await this.state.forgetSession(sessionId);
          }
          await this.#sleep(this.pollIntervalMs);
        }
      } catch (error) {
        if (this.running) this.onError(error);
      } finally {
        if (this.control === connection) this.control = undefined;
        connection?.close();
      }
      if (this.running) {
        await this.#sleep(delay);
        delay = Math.min(delay * 2, this.reconnectMaxMs);
      }
    }
  }

  #ensureObserver(sessionId, metadata) {
    const existing = this.observers.get(sessionId);
    if (existing) {
      existing.metadata = mergeMetadata(existing.metadata, metadata);
      return;
    }
    if (this.observers.size >= this.maxObservers) {
      if (!this.observerLimitWarned) {
        this.observerLimitWarned = true;
        this.onError(new Error(`Hermes observer limit reached (${this.maxObservers})`));
      }
      return;
    }
    this.observerLimitWarned = false;
    const observer = {
      connection: undefined,
      metadata,
      promise: undefined,
      reconciled: false,
      stopped: false,
    };
    this.observers.set(sessionId, observer);
    observer.promise = this.#observerLoop(sessionId, observer);
  }

  async #observerLoop(sessionId, observer) {
    let delay = this.reconnectMinMs;
    while (this.running && !observer.stopped) {
      let connection;
      try {
        connection = await this.#connect();
        observer.connection = connection;
        const buffered = [];
        let bufferOverflow = false;
        let reconciling = true;
        const offEvent = connection.onEvent((event) => {
          if (event.session_id !== sessionId) return;
          if (reconciling) {
            if (buffered.length >= this.reconcileBufferLimit) {
              bufferOverflow = true;
              connection.close();
              return;
            }
            buffered.push(event);
            return;
          }
          this.#queueEvent(sessionId, observer, event, connection);
        });

        let known = this.state.snapshot().sessions[sessionId];
        if (!known?.initialized) {
          const baseline = await connection.request("session.events.since", {
            session_id: sessionId,
            last_seen: 0,
          });
          await this.state.adoptEpoch(boundedString(baseline?.epoch, 256));
          await this.state.advance(
            sessionId,
            Number.isFinite(baseline?.latest_seq) ? baseline.latest_seq : 0,
            observer.metadata,
          );
          known = this.state.snapshot().sessions[sessionId];
        }

        let attached = false;
        try {
          const activated = await connection.request("session.activate", {
            session_id: sessionId,
            omit_messages: true,
          });
          observer.metadata = mergeMetadata(observer.metadata, sessionMetadata(activated));
          await this.state.rememberSession(sessionId, observer.metadata);
          attached = true;
        } catch {
          // A session may finish while the bridge reconnects. Replay it below.
        }

        const replay = await connection.request("session.events.since", {
          session_id: sessionId,
          last_seen: known?.lastSeen ?? 0,
        });
        const previousEpoch = this.state.snapshot().epoch;
        const replayEpoch = boundedString(replay?.epoch, 256);
        await this.state.adoptEpoch(replayEpoch);
        if (previousEpoch && replayEpoch && previousEpoch !== replayEpoch) {
          observer.stopped = true;
          offEvent();
          connection.close();
          break;
        }
        if (bufferOverflow) throw new Error("Hermes reconciliation event buffer overflowed");
        const replayed = Array.isArray(replay?.events) ? replay.events : [];
        replayed.sort((left, right) => sequence(left) - sequence(right));
        for (const event of replayed) {
          await this.#queueEvent(sessionId, observer, event, connection);
        }
        buffered.sort((left, right) => sequence(left) - sequence(right));
        for (const event of buffered) {
          await this.#queueEvent(sessionId, observer, event, connection);
        }
        buffered.length = 0;
        reconciling = false;
        const latest = Number.isFinite(replay?.latest_seq) ? replay.latest_seq : 0;
        await this.state.advance(sessionId, latest, observer.metadata);
        observer.reconciled = true;

        if (!attached) {
          await this.state.forgetSession(sessionId);
          offEvent();
          connection.close();
          break;
        }

        delay = this.reconnectMinMs;
        await new Promise((resolve) => connection.onClose(resolve));
        offEvent();
      } catch (error) {
        if (this.running) this.onError(error);
      } finally {
        if (observer.connection === connection) observer.connection = undefined;
        connection?.close();
      }
      if (this.running && !observer.stopped) {
        await this.#sleep(delay);
        delay = Math.min(delay * 2, this.reconnectMaxMs);
      }
    }
    if (this.observers.get(sessionId) === observer) this.observers.delete(sessionId);
  }

  #queueEvent(sessionId, observer, event, connection) {
    const operation = this.deliveryQueue.then(() => this.#handleEvent(sessionId, observer, event));
    this.deliveryQueue = operation.catch((error) => {
      this.onError(error);
      connection.close();
    });
    return operation;
  }

  async #handleEvent(sessionId, observer, event) {
    if (event?.session_id && event.session_id !== sessionId) return;
    const seq = sequence(event);
    const known = this.state.snapshot().sessions[sessionId];
    if (seq && seq <= (known?.lastSeen ?? 0)) return;

    if (event.type === "session.info") {
      observer.metadata = mergeMetadata(observer.metadata, sessionMetadata(event.payload));
    }
    if (event.type !== "message.complete") return;

    const epoch = this.state.snapshot().epoch || "unknown";
    const payload = object(event.payload) ? event.payload : {};
    const turnId = boundedString(payload.turn_id || payload.message_id, 128);
    const key = `${epoch}:${sessionId}:${seq || turnId || "complete"}`;
    if (this.state.hasDelivered(key)) return;

    await this.deliver(this.#notification(sessionId, seq, turnId, observer.metadata, payload));
    await this.state.markDelivered(sessionId, seq, key, observer.metadata);
  }

  #notification(sessionId, seq, turnId, metadata, payload) {
    const failed = payload.failed === true || Boolean(payload.error);
    const interrupted = payload.interrupted === true || payload.cancelled === true;
    const status = failed
      ? { title: "Hermes: task failed", body: "A Hermes turn failed." }
      : interrupted
        ? { title: "Hermes: task stopped", body: "A Hermes turn was stopped." }
        : { title: "Hermes: task finished", body: "Your Hermes response is ready." };
    const storedSessionId = boundedString(metadata.storedSessionId);
    const url = new URL(storedSessionId
      ? `/session/${encodeURIComponent(storedSessionId)}`
      : "/", this.appUrl);
    if (storedSessionId && metadata.profile && metadata.profile !== "default") {
      url.searchParams.set("profile", metadata.profile);
    }
    const identity = `${sessionId}:${seq || turnId || "complete"}`;
    const tag = createHash("sha256").update(identity).digest("hex").slice(0, 32);
    return { ...status, url: url.toString(), tag: `hermes-turn-${tag}` };
  }

  async #connect() {
    const url = await this.authenticator.webSocketURL("default");
    const connection = this.connectionFactory(url);
    await connection.connect();
    return connection;
  }

  #sleep(delay) {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        this.sleepWaiters.delete(wake);
        resolve();
      };
      timer = setTimeout(wake, delay);
      this.sleepWaiters.add(wake);
    });
  }
}
