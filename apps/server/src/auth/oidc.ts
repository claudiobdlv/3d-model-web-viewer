import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { generatePkcePair, randomUrlToken } from "./tokens.js";
import type { ProviderConfig } from "./config.js";
import type { Provider, ProviderProfile } from "./types.js";

// OpenID Connect Authorization Code Flow with PKCE.
//
// The network-touching pieces (discovery, token exchange, JWKS verification) are
// kept thin so the *security-critical claim validation* lives in the pure,
// fully unit-tested validateIdTokenClaims() below.

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdTokenClaims extends JWTPayload {
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  preferred_username?: string;
}

export interface ClaimValidationOptions {
  // Either an exact issuer string or a predicate (Microsoft "common" returns a
  // tenant-specific issuer, so an exact match is not always possible).
  issuer: string | ((iss: string) => boolean);
  clientId: string;
  nonce: string;
  now?: number; // ms epoch, injectable for tests
  clockToleranceSec?: number;
}

export type ClaimValidationResult = { ok: true } | { ok: false; reason: string };

// Pure validation of decoded ID token claims. Verifies issuer, audience,
// expiry, nonce, subject presence, and rejects explicitly-unverified emails.
export function validateIdTokenClaims(
  claims: IdTokenClaims,
  options: ClaimValidationOptions
): ClaimValidationResult {
  const now = options.now ?? Date.now();
  const tolerance = (options.clockToleranceSec ?? 60) * 1000;

  const iss = claims.iss;
  if (typeof iss !== "string" || iss.length === 0) {
    return { ok: false, reason: "missing_issuer" };
  }
  const issuerOk = typeof options.issuer === "function" ? options.issuer(iss) : iss === options.issuer;
  if (!issuerOk) return { ok: false, reason: "issuer_mismatch" };

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(options.clientId)) return { ok: false, reason: "audience_mismatch" };

  if (typeof claims.exp !== "number" || claims.exp * 1000 + tolerance <= now) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.iat === "number" && claims.iat * 1000 - tolerance > now) {
    return { ok: false, reason: "issued_in_future" };
  }

  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return { ok: false, reason: "missing_subject" };
  }

  if (typeof claims.nonce !== "string" || claims.nonce !== options.nonce) {
    return { ok: false, reason: "nonce_mismatch" };
  }

  // email_verified may be absent (some Microsoft accounts omit it). Reject only
  // when a provider explicitly reports the email as unverified.
  if (isExplicitlyUnverified(claims.email_verified)) {
    return { ok: false, reason: "email_unverified" };
  }

  return { ok: true };
}

function isExplicitlyUnverified(value: boolean | string | undefined): boolean {
  if (value === false) return true;
  if (typeof value === "string") return value.toLowerCase() === "false";
  return false;
}

export function emailVerifiedFlag(value: boolean | string | undefined): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

// Build the issuer predicate for a provider. Microsoft "common"/"organizations"
// returns tenant-specific issuers of the form
// https://login.microsoftonline.com/<tenant-id>/v2.0.
export function issuerMatcher(config: ProviderConfig): string | ((iss: string) => boolean) {
  if (config.provider === "microsoft" && (config.tenant === "common" || config.tenant === "organizations")) {
    return (iss: string) => /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]+\/v2\.0$/i.test(iss);
  }
  return config.issuer;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export function buildAuthorizationRequest(input: {
  discovery: Pick<OidcDiscovery, "authorization_endpoint">;
  clientId: string;
  redirectUri: string;
  scopes: string[];
}): AuthorizationRequest {
  const state = randomUrlToken(24);
  const nonce = randomUrlToken(24);
  const { verifier, challenge } = generatePkcePair();
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(" "),
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account"
  });
  return {
    url: `${input.discovery.authorization_endpoint}?${params.toString()}`,
    state,
    nonce,
    codeVerifier: verifier
  };
}

// --- Network helpers (not unit-tested; exercised only in real OAuth flow) ---

const discoveryCache = new Map<string, { value: OidcDiscovery; expiresAt: number }>();

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`OIDC discovery failed for ${issuer} (${response.status}).`);
  }
  const value = (await response.json()) as OidcDiscovery;
  discoveryCache.set(issuer, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
  return value;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(jwksUri: string) {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

export async function exchangeCodeForTokens(input: {
  discovery: Pick<OidcDiscovery, "token_endpoint">;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id_token?: string; access_token?: string; [key: string]: unknown }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier
  });
  const response = await fetchImpl(input.discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString()
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}).`);
  }
  return (await response.json()) as { id_token?: string; access_token?: string };
}

// Verifies the ID token signature against the provider JWKS and validates claims.
export async function verifyAndProfile(input: {
  idToken: string;
  discovery: Pick<OidcDiscovery, "jwks_uri">;
  config: ProviderConfig;
  nonce: string;
}): Promise<ProviderProfile> {
  const jwks = getJwks(input.discovery.jwks_uri);
  const { payload } = await jwtVerify(input.idToken, jwks, {
    clockTolerance: 60
  });
  const claims = payload as IdTokenClaims;
  const validation = validateIdTokenClaims(claims, {
    issuer: issuerMatcher(input.config),
    clientId: input.config.clientId,
    nonce: input.nonce
  });
  if (!validation.ok) {
    throw new Error(`id_token_invalid:${validation.reason}`);
  }
  return claimsToProfile(input.config.provider, claims);
}

export function claimsToProfile(provider: Provider, claims: IdTokenClaims): ProviderProfile {
  const email = typeof claims.email === "string" ? claims.email : null;
  return {
    provider,
    issuer: typeof claims.iss === "string" ? claims.iss : "",
    subject: typeof claims.sub === "string" ? claims.sub : "",
    email,
    emailVerified: emailVerifiedFlag(claims.email_verified),
    displayName:
      (typeof claims.name === "string" && claims.name) ||
      (typeof claims.preferred_username === "string" && claims.preferred_username) ||
      null,
    avatarUrl: typeof claims.picture === "string" ? claims.picture : null
  };
}
