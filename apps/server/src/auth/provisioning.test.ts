import assert from "node:assert/strict";
import test from "node:test";
import { MemoryAuthStore } from "./memoryStore.js";
import { AuthService } from "./service.js";
import type { ProviderProfile } from "./types.js";

// Proves new-account provisioning is transactional: user + identity +
// organization + owner membership + initial audit events succeed or fail as a
// unit, and concurrent signups for the same email do not create duplicates.

const profile: ProviderProfile = {
  provider: "google",
  issuer: "https://accounts.google.com",
  subject: "google-sub-tx",
  email: "ada@example.com",
  emailVerified: true,
  displayName: "Ada Lovelace",
  avatarUrl: null
};

function service(store: MemoryAuthStore) {
  return new AuthService(store, { sessionTtlMs: 30 * 24 * 60 * 60 * 1000 });
}

test("successful provisioning commits user, identity, workspace, membership, and audit trail", async () => {
  const store = new MemoryAuthStore();
  const result = await service(store).loginWithProvider(profile);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.created, true);

  const user = await store.getUserByEmail("ada@example.com");
  assert.ok(user);
  const identities = await store.listIdentitiesForUser(user!.id);
  assert.equal(identities.length, 1);
  const memberships = await store.listMembershipsForUser(user!.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, "owner");

  const events = store._auditEvents().map((e) => e.event_type);
  assert.ok(events.includes("user.created"));
  assert.ok(events.includes("organization.created"));
  assert.ok(events.includes("login.success"));
});

// A store that fails when creating the owner membership — the last write of the
// provisioning unit. With a transaction, the user/identity/organization created
// earlier in the unit must be rolled back, leaving the store empty.
class FailingMembershipStore extends MemoryAuthStore {
  async createMembership(): Promise<never> {
    throw new Error("boom_membership");
  }
}

test("partial failure mid-provisioning rolls back every write (no orphaned user/identity/org)", async () => {
  const store = new FailingMembershipStore();
  await assert.rejects(() => service(store).loginWithProvider(profile), /boom_membership/);

  // Nothing partially provisioned survived.
  assert.equal(await store.getUserByEmail("ada@example.com"), undefined);
  assert.equal(await store.getIdentity(profile.provider, profile.issuer, profile.subject), undefined);
  assert.equal(store._auditEvents().length, 0);
});

test("concurrent signups for the same email create exactly one account", async () => {
  const store = new MemoryAuthStore();
  const svc = service(store);
  const [a, b] = await Promise.all([svc.loginWithProvider(profile), svc.loginWithProvider(profile)]);

  // Both calls resolve successfully and converge on the same user/workspace.
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.user.id, b.user.id);
  assert.equal(a.organization.id, b.organization.id);
  // Exactly one of them actually created the account.
  assert.equal(a.created !== b.created, true);

  const user = await store.getUserByEmail("ada@example.com");
  assert.ok(user);
  assert.equal((await store.listIdentitiesForUser(user!.id)).length, 1);
  assert.equal((await store.listMembershipsForUser(user!.id)).length, 1);
});

test("unique-email constraint is enforced by the in-memory store", async () => {
  const store = new MemoryAuthStore();
  await store.createUser({ primaryEmail: "dup@example.com", displayName: null, avatarUrl: null });
  await assert.rejects(
    () => store.createUser({ primaryEmail: "DUP@example.com", displayName: null, avatarUrl: null }),
    /user_email_conflict/
  );
});
