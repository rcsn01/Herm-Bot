const MAX_ENDPOINT_LENGTH = 4096;
const MAX_TEXT_LENGTH = 4096;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new Error("invalid subscription key");
  }
  return Buffer.from(value, "base64url");
}

export function validateSubscription(value) {
  if (!isPlainObject(value)) {
    throw new Error("subscription must be an object");
  }

  let endpoint;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw new Error("invalid subscription endpoint");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    value.endpoint.length > MAX_ENDPOINT_LENGTH
  ) {
    throw new Error("invalid subscription endpoint");
  }

  if (!isPlainObject(value.keys)) {
    throw new Error("subscription keys are required");
  }
  const p256dh = decodeBase64Url(value.keys.p256dh);
  const auth = decodeBase64Url(value.keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) {
    throw new Error("invalid subscription key");
  }

  const expirationTime = value.expirationTime ?? null;
  if (
    expirationTime !== null &&
    (!Number.isFinite(expirationTime) || expirationTime <= Date.now())
  ) {
    throw new Error("invalid subscription expiration");
  }

  return {
    endpoint: endpoint.href,
    expirationTime,
    keys: {
      p256dh: value.keys.p256dh,
      auth: value.keys.auth,
    },
  };
}

export function validateEndpoint(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 1) {
    throw new Error("body must contain only endpoint");
  }
  let endpoint;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw new Error("invalid subscription endpoint");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    value.endpoint.length > MAX_ENDPOINT_LENGTH
  ) {
    throw new Error("invalid subscription endpoint");
  }
  return endpoint.href;
}

export function validateNotification(value) {
  if (!isPlainObject(value)) {
    throw new Error("notification must be an object");
  }

  const notification = {};
  for (const field of ["title", "body", "url", "tag"]) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      throw new Error(`${field} must be a string`);
    }
    if (fieldValue !== undefined && fieldValue.length > MAX_TEXT_LENGTH) {
      throw new Error(`${field} is too long`);
    }
    notification[field] = fieldValue ?? "";
  }

  if (notification.url) {
    let url;
    try {
      url = new URL(notification.url, "https://hermes.invalid");
    } catch {
      throw new Error("invalid notification URL");
    }
    if (!["https:", "http:"].includes(url.protocol)) {
      throw new Error("invalid notification URL");
    }
  }

  return notification;
}
