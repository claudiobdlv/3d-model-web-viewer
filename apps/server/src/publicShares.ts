import crypto from "node:crypto";

export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://modelbase.parametricstandards.com")
  .replace(/\/+$/, "");

export function generatePublicToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashPublicToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function isValidPublicToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function publicShareUrl(token: string): string {
  return `${PUBLIC_BASE_URL}/public/${token}`;
}
