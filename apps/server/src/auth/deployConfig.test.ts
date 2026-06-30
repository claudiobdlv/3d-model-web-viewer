import assert from "node:assert/strict";
import test from "node:test";
import { assertSecureProductionConfig, createAuthSubsystem } from "./index.js";
import type { AuthConfig } from "./config.js";

function baseConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    enabled: true,
    appBaseUrl: "https://example.test",
    cookieName: "modelbase_session",
    sessionSecret: "secret",
    sessionTtlMs: 1000,
    secureCookies: true,
    sameSite: "lax",
    providers: {},
    allowedProviders: ["google"],
    allowedAdminEmails: ["owner@example.test"],
    ...overrides
  };
}

test("AUTH_ENABLED=false starts with no Postgres/session/OIDC config", () => {
  // The disabled subsystem must construct without SESSION_SECRET, DATABASE_URL,
  // or any provider credentials (production-safe legacy default).
  const subsystem = createAuthSubsystem(baseConfig({ enabled: false, sessionSecret: "", secureCookies: false }));
  assert.equal(subsystem.enabled, false);
  assert.equal(subsystem.service, undefined);
});

test("AUTH_ENABLED=true requires a non-empty admin email allow-list", () => {
  assert.throws(
    () => createAuthSubsystem(baseConfig({ allowedAdminEmails: [] })),
    /AUTH_ENABLED=true requires AUTH_ALLOWED_EMAILS/i
  );
});

test("auth-enabled production fails closed on insecure session cookies", () => {
  assert.throws(
    () => assertSecureProductionConfig(baseConfig({ secureCookies: false }), { NODE_ENV: "production" } as NodeJS.ProcessEnv),
    /secure session cookies/i
  );
});

test("secure cookies in production pass", () => {
  assert.doesNotThrow(() =>
    assertSecureProductionConfig(baseConfig({ secureCookies: true }), { NODE_ENV: "production" } as NodeJS.ProcessEnv)
  );
});

test("documented insecure override is honoured in production", () => {
  assert.doesNotThrow(() =>
    assertSecureProductionConfig(
      baseConfig({ secureCookies: false }),
      { NODE_ENV: "production", ALLOW_INSECURE_SESSION: "true" } as NodeJS.ProcessEnv
    )
  );
});

test("non-production never enforces secure cookies", () => {
  assert.doesNotThrow(() =>
    assertSecureProductionConfig(baseConfig({ secureCookies: false }), { NODE_ENV: "test" } as NodeJS.ProcessEnv)
  );
});

test("AUTH_STORE=memory is rejected in production", () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevStore = process.env.AUTH_STORE;
  process.env.NODE_ENV = "production";
  process.env.AUTH_STORE = "memory";
  try {
    assert.throws(
      // secureCookies true so the cookie check passes; the memory-store guard must fire.
      () => createAuthSubsystem(baseConfig({ secureCookies: true, databaseUrl: undefined })),
      /AUTH_STORE=memory is not permitted in production/i
    );
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevStore === undefined) delete process.env.AUTH_STORE;
    else process.env.AUTH_STORE = prevStore;
  }
});
