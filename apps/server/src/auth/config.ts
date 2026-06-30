import type { Provider } from "./types.js";

// Feature-flagged accounts configuration. AUTH_ENABLED defaults to "false" so the
// existing legacy Basic-auth admin flow and all SQLite model flows are completely
// unchanged in production until accounts are explicitly turned on with real OAuth
// credentials configured. See docs/accounts-phase1.md.

export interface ProviderConfig {
  provider: Provider;
  clientId: string;
  clientSecret: string;
  // OIDC issuer used for discovery + base issuer for token validation.
  issuer: string;
  scopes: string[];
  // Microsoft only: tenant segment ("common", "organizations", or a tenant id).
  tenant?: string;
}

export interface AuthConfig {
  enabled: boolean;
  appBaseUrl: string;
  cookieName: string;
  sessionSecret: string;
  sessionTtlMs: number;
  secureCookies: boolean;
  sameSite: "lax" | "strict";
  databaseUrl?: string;
  providers: Partial<Record<Provider, ProviderConfig>>;
  // The provider allow-list (AUTH_PROVIDERS), independent of whether credentials
  // happen to be configured. Defaults to Google-only for this phase. Microsoft
  // code stays in the codebase but is excluded from `providers` (and therefore
  // not mounted/shown) unless explicitly added here. See docs/accounts-phase1.md
  // "Re-enabling Microsoft" for how to opt back in.
  allowedProviders: Provider[];
  // Admin email allow-list (AUTH_ALLOWED_EMAILS), lowercase-normalized. Only
  // verified emails in this list may create/log into the first admin workspace
  // while accounts are enabled. Empty means nothing is allowed (fail closed) —
  // index.ts requires this to be non-empty whenever AUTH_ENABLED=true.
  allowedAdminEmails: string[];
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isProvider(value: string): value is Provider {
  return value === "google" || value === "microsoft";
}

function parseAllowedProviders(value: string | undefined): Provider[] {
  // Default intended provider list for this phase is Google only.
  const raw = (value ?? "google").split(",").map((entry) => entry.trim().toLowerCase());
  const providers = raw.filter(isProvider);
  return providers.length ? [...new Set(providers)] : ["google"];
}

function parseAllowedEmails(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const enabled = bool(env.AUTH_ENABLED, false);
  const appBaseUrl = trimSlash(env.APP_BASE_URL || env.PUBLIC_BASE_URL || "http://localhost:3009");
  const tenant = env.MICROSOFT_TENANT || "common";
  const allowedProviders = parseAllowedProviders(env.AUTH_PROVIDERS);
  const allowedProviderSet = new Set(allowedProviders);

  const providers: Partial<Record<Provider, ProviderConfig>> = {};
  if (allowedProviderSet.has("google") && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      provider: "google",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      issuer: "https://accounts.google.com",
      scopes: ["openid", "email", "profile"]
    };
  }
  if (allowedProviderSet.has("microsoft") && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    providers.microsoft = {
      provider: "microsoft",
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      scopes: ["openid", "email", "profile"],
      tenant
    };
  }

  const sessionTtlDays = Number(env.SESSION_TTL_DAYS || "30");

  return {
    enabled,
    appBaseUrl,
    cookieName: env.SESSION_COOKIE_NAME || "modelbase_session",
    // SESSION_SECRET is required when enabled; loadAuthConfig stays pure and lets
    // the wiring layer (index.ts) fail loudly if it is missing while enabled.
    sessionSecret: env.SESSION_SECRET || "",
    sessionTtlMs: (Number.isFinite(sessionTtlDays) && sessionTtlDays > 0 ? sessionTtlDays : 30) * 24 * 60 * 60 * 1000,
    secureCookies: bool(env.SESSION_COOKIE_SECURE, env.NODE_ENV === "production"),
    sameSite: env.SESSION_COOKIE_SAMESITE === "strict" ? "strict" : "lax",
    databaseUrl: env.DATABASE_URL || undefined,
    providers,
    allowedProviders,
    allowedAdminEmails: parseAllowedEmails(env.AUTH_ALLOWED_EMAILS)
  };
}

export function redirectUri(config: AuthConfig, provider: Provider): string {
  return `${config.appBaseUrl}/auth/${provider}/callback`;
}
