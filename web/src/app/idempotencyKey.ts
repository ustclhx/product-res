const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function uuidFromRandomValues(bytes: Uint8Array): string {
  const version = bytes[6];
  const variant = bytes[8];
  if (version === undefined || variant === undefined) {
    throw new TypeError("expected 16 random bytes");
  }
  bytes[6] = (version & 0x0f) | 0x40;
  bytes[8] = (variant & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Idempotency keys must work on HTTP public hosts, where `crypto.randomUUID` is absent. */
export function newIdempotencyKey(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  if (typeof webCrypto?.getRandomValues === "function") {
    return uuidFromRandomValues(webCrypto.getRandomValues(new Uint8Array(16)));
  }
  throw new TypeError("secure random is unavailable");
}

export function isIdempotencyKey(value: string): boolean {
  return UUID_V4.test(value);
}
