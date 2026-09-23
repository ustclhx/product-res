import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isIdempotencyKey, newIdempotencyKey } from "./idempotencyKey.ts";

const originalRandomUUID = globalThis.crypto.randomUUID;

afterEach(() => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: originalRandomUUID,
  });
});

test("newIdempotencyKey still works when randomUUID is missing", () => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  assert.equal(typeof globalThis.crypto.randomUUID, "undefined");
  const key = newIdempotencyKey();
  assert.equal(isIdempotencyKey(key), true);
});
