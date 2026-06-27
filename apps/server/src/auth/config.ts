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
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const enabled = bool(env.AUTH_ENABLED, false);
  const appBaseUrl = trimSlash(env.APP_BASE_URL || env.PUBLIC_BASE_URL || "http://localhost:3009");
  const tenant = env.MICROSOFT_TENANT || "common";

  const providers: Partial<Record<Provider, ProviderConfig>> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      provider: "google",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      issuer: "https://accounts.google.com",
      scopes: ["openid", "email", "profile"]
    };
  }
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
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
    providers
  };
}

export function redirectUri(config: AuthConfig, provider: Provider): string {
  return `${config.appBaseUrl}/auth/${provider}/callback`;
}
