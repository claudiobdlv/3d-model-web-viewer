import assert from "node:assert/strict";
import test from "node:test";
import { MemoryAuthStore } from "./memoryStore.js";
import { AuthService } from "./service.js";
import type { ProviderProfile } from "./types.js";

// Verifies the audit trail records the security-relevant account events and
// never stores tokens, secrets, or raw cookies.

const profile: ProviderProfile = {
  provider: "google",
  issuer: "https://accounts.google.com",
  subject: "google-sub-audit",
  email: "ada@example.com",
  emailVerified: true,
  displayName: "Ada Lovelace",
  avatarUrl: null
};

function types(store: MemoryAuthStore): string[] {
  return store._auditEvents().map((e) => e.event_type);
}

test("login success is audited", async () => {
  const store = new MemoryAuthStore();
  const service = new AuthService(store, { sessionTtlMs: 1000 });
  const result = await service.loginWithProvider(profile);
  assert.equal(result.ok, true);
  assert.ok(types(store).includes("login.success"));
});

test("login denied by the email allow-list is audited and creates no account", async () => {
  const store = new MemoryAuthStore();
  const service = new AuthService(store, { sessionTtlMs: 1000, allowedEmails: ["owner@example.com"] });
  const result = await service.loginWithProvider(profile);
  assert.equal(result.ok, false);
  const rejected = store._auditEvents().find((e) => e.event_type === "login.rejected");
  assert.ok(rejected);
  assert.equal((rejected!.metadata as any).reason, "email_not_allowed");
  // The denied attempt is keyed to no user (fail-closed, no provisioning).
  assert.equal(rejected!.user_id, null);
});

test("logout records a session.revoked event", async () => {
  const store = new MemoryAuthStore();
  const service = new AuthService(store, { sessionTtlMs: 1000 });
  const login = await service.loginWithProvider(profile);
  assert.equal(login.ok, true);
  if (!login.ok) return;
  const { token } = await service.createSession(login.user.id, {
    activeOrganizationId: login.organization.id,
    ipAddress: null,
    userAgent: null
  });
  await service.logout(token);
  const revoked = store._auditEvents().find((e) => e.event_type === "session.revoked");
  assert.ok(revoked);
  assert.equal((revoked!.metadata as any).reason, "logout");
});

test("provider-unavailable attempts are audited without PII", async () => {
  const store = new MemoryAuthStore();
  const service = new AuthService(store, { sessionTtlMs: 1000 });
  await service.recordProviderUnavailable("microsoft", "start");
  const event = store._auditEvents().find((e) => e.event_type === "auth.provider_unavailable");
  assert.ok(event);
  assert.deepEqual(event!.metadata, { provider: "microsoft", phase: "start" });
});

test("no audit metadata contains tokens, secrets, or raw cookies", async () => {
  const store = new MemoryAuthStore();
  const service = new AuthService(store, { sessionTtlMs: 1000 });
  const login = await service.loginWithProvider(profile);
  assert.equal(login.ok, true);
  if (!login.ok) return;
  const { token } = await service.createSession(login.user.id, {
    activeOrganizationId: login.organization.id,
    ipAddress: null,
    userAgent: null
  });
  await service.logout(token);

  const serialized = JSON.stringify(store._auditEvents());
  assert.doesNotMatch(serialized.toLowerCase(), /secret|password|cookie|"token"|bearer/);
  // The raw session token never appears in any audit metadata.
  assert.equal(serialized.includes(token), false);
});
