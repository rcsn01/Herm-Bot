import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export async function durableWrite(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(value)}\n`;
  let file;

  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(contents, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, filePath);

    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function validateStoredState(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.vapid?.publicKey !== "string" ||
    typeof value.vapid?.privateKey !== "string" ||
    !Array.isArray(value.subscriptions)
  ) {
    throw new Error("relay state is invalid");
  }
  return value;
}

export class RelayState {
  constructor(filePath, generateVapidKeys) {
    this.filePath = filePath;
    this.generateVapidKeys = generateVapidKeys;
    this.value = undefined;
    this.mutation = Promise.resolve();
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      this.value = validateStoredState(
        JSON.parse(await readFile(this.filePath, "utf8")),
      );
      if (this.value.version !== 2) {
        this.value = { ...this.value, version: 2, subscriptions: this.value.subscriptions.map(subscription => ({ ...subscription, owner: null, id: randomUUID() })) };
        await durableWrite(this.filePath, this.value);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      this.value = {
        version: 2,
        vapid: this.generateVapidKeys(),
        subscriptions: [],
      };
      await durableWrite(this.filePath, this.value);
    }
  }

  get publicKey() {
    return this.value.vapid.publicKey;
  }

  get vapid() {
    return { ...this.value.vapid };
  }

  listSubscriptions(owner) {
    return this.value.subscriptions.filter(subscription => owner && subscription.owner === owner).map((subscription) => ({
      ...subscription,
      keys: { ...subscription.keys },
    }));
  }

  async mutate(change) {
    const operation = this.mutation.then(async () => {
      const next = change(this.value);
      await durableWrite(this.filePath, next);
      this.value = next;
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }

  async upsert(subscription, owner) {
    if (!owner) throw Object.assign(new Error("identity_unavailable"), { statusCode: 503 });
    const id = randomUUID();
    await this.mutate((current) => {
      if (current.subscriptions.some(candidate => candidate.endpoint === subscription.endpoint && candidate.owner && candidate.owner !== owner)) {
        throw Object.assign(new Error("subscription_belongs_to_another_account"), { statusCode: 409 });
      }
      const subscriptions = current.subscriptions.filter(
        (candidate) => candidate.endpoint !== subscription.endpoint,
      );
      subscriptions.push({ ...subscription, owner, id });
      return { ...current, subscriptions };
    });
    return id;
  }

  async removeEndpoints(endpoints, owner, bindingId) {
    const removals = new Set(endpoints);
    let removed = 0;
    await this.mutate((current) => {
      const subscriptions = current.subscriptions.filter((subscription) => {
        if (owner && subscription.owner === owner && (bindingId === undefined || subscription.id === bindingId) && removals.has(subscription.endpoint)) {
          removed += 1;
          return false;
        }
        return true;
      });
      return { ...current, subscriptions };
    });
    return removed;
  }
}
