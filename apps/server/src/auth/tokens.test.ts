import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  generatePkcePair,
  generateSessionToken,
  hashToken,
  isValidSessionToken,
  safeEqualHex,
  signPayload,
  verifyPayload
} from "./tokens.js";

test("session tokens carry 256 bits of URL-safe entropy and are stored hashed", () => {
  const token = generateSessionToken();
  assert.equal(token.length, 43);
  assert.equal(isValidSessionToken(token), true);
  const hash = hashToken(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  // The raw token must never be recoverable from / equal to the stored hash.
  assert.equal(hash.includes(token), false);
  assert.notEqual(hash, token);
  // Hashing is deterministic.
  assert.equal(hashToken(token), hash);
});

test("isValidSessionToken rejects malformed tokens", () => {
  assert.equal(isValidSessionToken(""), false);
  assert.equal(isValidSessionToken("short"), false);
  assert.equal(isValidSessionToken("!".repeat(43)), false);
});

test("safeEqualHex compares hex digests safely", () => {
  const a = hashToken("a");
  assert.equal(safeEqualHex(a, a), true);
  assert.equal(safeEqualHex(a, hashToken("b")), false);
  assert.equal(safeEqualHex(a, "zz"), false);
});

test("signed payloads round-trip and reject tampering or wrong secret", () => {
  const secret = "test-secret";
  const signed = signPayload({ state: "abc", n: 1 }, secret);
  assert.deepEqual(verifyPayload(signed, secret), { state: "abc", n: 1 });
  assert.equal(verifyPayload(signed, "other-secret"), undefined);
  // Tamper with the body.
  const [body, sig] = signed.split(".");
  const tampered = `${Buffer.from('{"state":"evil"}').toString("base64url")}.${sig}`;
  assert.equal(verifyPayload(tampered, secret), undefined);
  assert.equal(verifyPayload(`${body}.deadbeef`, secret), undefined);
});

test("PKCE pair derives an S256 challenge from the verifier", () => {
  const { verifier, challenge } = generatePkcePair();
  const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
  assert.notEqual(verifier, challenge);
});
