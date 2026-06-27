import crypto from "node:crypto";

// Opaque session tokens: 256 bits of entropy, URL-safe, never stored raw.
// Only the SHA-256 hash is persisted (see sessions.token_hash). This matches the
// existing public-share token scheme in publicShares.ts for consistency.

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function isValidSessionToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

// Constant-time comparison for two hex digests of equal length.
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let bufferA: Buffer;
  let bufferB: Buffer;
  try {
    bufferA = Buffer.from(a, "hex");
    bufferB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (bufferA.length === 0 || bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

// HMAC-signed, short-lived payload used for the OAuth transaction cookie
// (carries state/nonce/PKCE verifier between /start and /callback). The payload
// is base64url(JSON) and the signature is HMAC-SHA256 over it. Not a JWT — we do
// not need third-party verification, only tamper resistance with SESSION_SECRET.

export function signPayload(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyPayload<T = Record<string, unknown>>(value: string, secret: string): T | undefined {
  if (typeof value !== "string") return undefined;
  const dot = value.indexOf(".");
  if (dot <= 0) return undefined;
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

// PKCE (RFC 7636) S256 challenge derivation.
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomUrlToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
