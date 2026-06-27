import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildAuthorizationRequest,
  claimsToProfile,
  emailVerifiedFlag,
  issuerMatcher,
  validateIdTokenClaims,
  type IdTokenClaims
} from "./oidc.js";
import type { ProviderConfig } from "./config.js";

const now = Date.UTC(2026, 0, 1);
const baseClaims: IdTokenClaims = {
  iss: "https://accounts.google.com",
  aud: "client-123",
  sub: "subject-abc",
  exp: Math.floor(now / 1000) + 3600,
  iat: Math.floor(now / 1000) - 10,
  nonce: "nonce-xyz",
  email: "user@example.com",
  email_verified: true
};

function validate(overrides: Partial<IdTokenClaims>, opts?: Partial<Parameters<typeof validateIdTokenClaims>[1]>) {
  return validateIdTokenClaims(
    { ...baseClaims, ...overrides },
    { issuer: "https://accounts.google.com", clientId: "client-123", nonce: "nonce-xyz", now, ...opts }
  );
}

test("valid ID token claims pass", () => {
  assert.deepEqual(validate({}), { ok: true });
});

test("issuer must match", () => {
  assert.deepEqual(validate({ iss: "https://evil.example" }), { ok: false, reason: "issuer_mismatch" });
  assert.deepEqual(validate({ iss: undefined }), { ok: false, reason: "missing_issuer" });
});

test("audience must include the client id (string or array)", () => {
  assert.deepEqual(validate({ aud: "wrong" }), { ok: false, reason: "audience_mismatch" });
  assert.deepEqual(validate({ aud: ["other", "client-123"] }), { ok: true });
});

test("expired or future tokens are rejected", () => {
  assert.deepEqual(validate({ exp: Math.floor(now / 1000) - 3600 }), { ok: false, reason: "expired" });
  assert.deepEqual(validate({ iat: Math.floor(now / 1000) + 3600 }), { ok: false, reason: "issued_in_future" });
});

test("subject is required", () => {
  assert.deepEqual(validate({ sub: undefined }), { ok: false, reason: "missing_subject" });
});

test("nonce must match the request nonce", () => {
  assert.deepEqual(validate({ nonce: "different" }), { ok: false, reason: "nonce_mismatch" });
  assert.deepEqual(validate({ nonce: undefined }), { ok: false, reason: "nonce_mismatch" });
});

test("only explicitly-unverified emails are rejected", () => {
  assert.deepEqual(validate({ email_verified: false }), { ok: false, reason: "email_unverified" });
  assert.deepEqual(validate({ email_verified: "false" }), { ok: false, reason: "email_unverified" });
  // Absent email_verified is allowed (some providers omit it).
  assert.deepEqual(validate({ email_verified: undefined }), { ok: true });
});

test("Microsoft 'common' issuer predicate accepts tenant-specific issuers", () => {
  const microsoft: ProviderConfig = {
    provider: "microsoft",
    clientId: "ms-client",
    clientSecret: "secret",
    issuer: "https://login.microsoftonline.com/common/v2.0",
    scopes: ["openid"],
    tenant: "common"
  };
  const matcher = issuerMatcher(microsoft);
  assert.equal(typeof matcher, "function");
  const tenantIssuer = "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0";
  assert.deepEqual(
    validateIdTokenClaims(
      { ...baseClaims, iss: tenantIssuer, aud: "ms-client" },
      { issuer: matcher, clientId: "ms-client", nonce: "nonce-xyz", now }
    ),
    { ok: true }
  );
  assert.deepEqual(
    validateIdTokenClaims(
      { ...baseClaims, iss: "https://evil.example/abc/v2.0", aud: "ms-client" },
      { issuer: matcher, clientId: "ms-client", nonce: "nonce-xyz", now }
    ),
    { ok: false, reason: "issuer_mismatch" }
  );
});

test("buildAuthorizationRequest emits PKCE S256, state and nonce", () => {
  const request = buildAuthorizationRequest({
    discovery: { authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth" },
    clientId: "client-123",
    redirectUri: "https://app.example/auth/google/callback",
    scopes: ["openid", "email", "profile"]
  });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.example/auth/google/callback");
  assert.equal(url.searchParams.get("state"), request.state);
  assert.equal(url.searchParams.get("nonce"), request.nonce);
  // The challenge in the URL must be the S256 hash of the returned verifier.
  const expectedChallenge = crypto.createHash("sha256").update(request.codeVerifier).digest("base64url");
  assert.equal(url.searchParams.get("code_challenge"), expectedChallenge);
});

test("claimsToProfile maps standard claims and email verification", () => {
  assert.equal(emailVerifiedFlag(true), true);
  assert.equal(emailVerifiedFlag("true"), true);
  assert.equal(emailVerifiedFlag(undefined), false);
  const profile = claimsToProfile("google", { ...baseClaims, name: "Ada", picture: "https://img/a.png" });
  assert.equal(profile.provider, "google");
  assert.equal(profile.subject, "subject-abc");
  assert.equal(profile.email, "user@example.com");
  assert.equal(profile.emailVerified, true);
  assert.equal(profile.displayName, "Ada");
  assert.equal(profile.avatarUrl, "https://img/a.png");
});
