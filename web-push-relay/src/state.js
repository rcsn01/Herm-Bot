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
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      this.value = {
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

  listSubscriptions() {
    return this.value.subscriptions.map((subscription) => ({
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

  async upsert(subscription) {
    await this.mutate((current) => {
      const subscriptions = current.subscriptions.filter(
        (candidate) => candidate.endpoint !== subscription.endpoint,
      );
      subscriptions.push(subscription);
      return { ...current, subscriptions };
    });
  }

  async removeEndpoints(endpoints) {
    const removals = new Set(endpoints);
    let removed = 0;
    await this.mutate((current) => {
      const subscriptions = current.subscriptions.filter((subscription) => {
        if (removals.has(subscription.endpoint)) {
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
