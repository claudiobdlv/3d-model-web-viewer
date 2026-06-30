import assert from "node:assert/strict";
import test from "node:test";
import { MemoryAuthStore } from "./memoryStore.js";
import { AuthService, DEFAULT_WORKSPACE_NAME } from "./service.js";
import { hashToken } from "./tokens.js";
import type { ProviderProfile } from "./types.js";

function makeService(ttlMs = 30 * 24 * 60 * 60 * 1000, allowedEmails?: string[]) {
  const store = new MemoryAuthStore();
  return { store, service: new AuthService(store, { sessionTtlMs: ttlMs, allowedEmails }) };
}

const googleProfile: ProviderProfile = {
  provider: "google",
  issuer: "https://accounts.google.com",
  subject: "google-sub-1",
  email: "Ada@Example.com",
  emailVerified: true,
  displayName: "Ada Lovelace",
  avatarUrl: null
};

test("new provider login creates user, Personal Workspace, and owner membership", async () => {
  const { service } = makeService();
  const result = await service.loginWithProvider(googleProfile);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.created, true);
  // Email is normalized to lowercase.
  assert.equal(result.user.primary_email, "ada@example.com");
  assert.equal(result.organization.name, DEFAULT_WORKSPACE_NAME);
  assert.equal(result.organization.owner_user_id, result.user.id);
  assert.equal(result.membership.role, "owner");
  assert.equal(result.membership.status, "active");
});

test("returning identity logs into the same user without creating a new one", async () => {
  const { service } = makeService();
  const first = await service.loginWithProvider(googleProfile);
  const second = await service.loginWithProvider(googleProfile);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.created, false);
  assert.equal(second.user.id, first.user.id);
  assert.equal(second.organization.id, first.organization.id);
});

test("a different provider with an existing email is NOT auto-merged", async () => {
  const { service } = makeService();
  await service.loginWithProvider(googleProfile);
  const result = await service.loginWithProvider({
    ...googleProfile,
    provider: "microsoft",
    issuer: "https://login.microsoftonline.com/common/v2.0",
    subject: "ms-sub-1"
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "account_exists_different_provider");
  assert.deepEqual(result.existingProviders, ["google"]);
});

test("logins without an email are rejected", async () => {
  const { service } = makeService();
  const result = await service.loginWithProvider({ ...googleProfile, email: null });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "no_email");
});

test("suspended/deleted users cannot log in", async () => {
  const { service, store } = makeService();
  const created = await service.loginWithProvider(googleProfile);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const user = await store.getUserById(created.user.id);
  assert.ok(user);
  user!.status = "suspended";
  const result = await service.loginWithProvider(googleProfile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "user_disabled");
});

test("sessions are stored hashed and resolve to a full auth context", async () => {
  const { service, store } = makeService();
  const login = await service.loginWithProvider(googleProfile);
  assert.equal(login.ok, true);
  if (!login.ok) return;

  const { token, session } = await service.createSession(login.user.id, {
    activeOrganizationId: login.organization.id,
    ipAddress: null,
    userAgent: null
  });
  // The DB stores only the hash, never the raw token.
  assert.equal(session.token_hash, hashToken(token));
  assert.notEqual(session.token_hash, token);
  assert.equal(await store.getSessionByHash(token), undefined);
  assert.ok(await store.getSessionByHash(hashToken(token)));

  const context = await service.resolveSession(token);
  assert.ok(context);
  assert.equal(context!.user.id, login.user.id);
  assert.equal(context!.organization?.id, login.organization.id);
  assert.equal(context!.membership?.role, "owner");

  // Wrong / malformed tokens never resolve.
  assert.equal(await service.resolveSession("not-a-real-token"), undefined);
});

test("expired sessions fail to resolve", async () => {
  const { service, store } = makeService(-1000); // already expired on creation
  const login = await service.loginWithProvider(googleProfile);
  assert.equal(login.ok, true);
  if (!login.ok) return;
  const { token } = await service.createSession(login.user.id, {
    activeOrganizationId: login.organization.id,
    ipAddress: null,
    userAgent: null
  });
  assert.equal(await service.resolveSession(token), undefined);
  // Confirm the failure was due to expiry (the hashed record still exists).
  assert.ok(await store.getSessionByHash(hashToken(token)));
});

test("an approved email in the admin allow-list can create and log into the account", async () => {
  const { service, store } = makeService(undefined, ["ada@example.com"]);
  const result = await service.loginWithProvider(googleProfile);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.created, true);
  assert.equal(result.user.primary_email, "ada@example.com");
  // Returning login for the same approved email also succeeds.
  const second = await service.loginWithProvider(googleProfile);
  assert.equal(second.ok, true);
  assert.ok(await store.getUserByEmail("ada@example.com"));
});

test("an email outside the admin allow-list is rejected and no user/workspace is created", async () => {
  const { service, store } = makeService(undefined, ["owner@example.com"]);
  const result = await service.loginWithProvider(googleProfile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "email_not_allowed");
  // No user, identity, or workspace was created for the rejected attempt.
  assert.equal(await store.getUserByEmail("ada@example.com"), undefined);
  assert.equal(await store.getIdentity(googleProfile.provider, googleProfile.issuer, googleProfile.subject), undefined);
});

test("admin allow-list is case-insensitive and trims whitespace", async () => {
  const { service } = makeService(undefined, [" Ada@Example.com "]);
  const result = await service.loginWithProvider(googleProfile);
  assert.equal(result.ok, true);
});

test("an empty admin allow-list does not restrict logins (legacy/no-op behavior)", async () => {
  const { service } = makeService(undefined, []);
  const result = await service.loginWithProvider(googleProfile);
  assert.equal(result.ok, true);
});

test("logout revokes the session so it no longer resolves", async () => {
  const { service } = makeService();
  const login = await service.loginWithProvider(googleProfile);
  assert.equal(login.ok, true);
  if (!login.ok) return;
  const { token } = await service.createSession(login.user.id, {
    activeOrganizationId: login.organization.id,
    ipAddress: null,
    userAgent: null
  });
  assert.ok(await service.resolveSession(token));
  await service.logout(token);
  assert.equal(await service.resolveSession(token), undefined);
});
