import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeRole,
  authorizeModelAccess,
  authorizeUploadHandle,
  READ_ROLE,
  UPLOAD_ROLE,
  MUTATE_ROLE,
  type AuthAwareRequest
} from "./access.js";
import type { AuthContext, Membership, Organization, Role, User } from "./types.js";

// Build a minimal auth-aware request for a given workspace role.
function req(opts: {
  enabled: boolean;
  orgId?: string;
  userId?: string;
  role?: Role;
  status?: Membership["status"];
}): AuthAwareRequest {
  if (!opts.enabled) return { authEnabled: false };
  const user = { id: opts.userId ?? "user-1" } as User;
  const organization = { id: opts.orgId ?? "org-1" } as Organization;
  const membership = {
    organization_id: opts.orgId ?? "org-1",
    user_id: opts.userId ?? "user-1",
    role: opts.role ?? "owner",
    status: opts.status ?? "active"
  } as Membership;
  const auth = { user, organization, membership } as AuthContext;
  return { authEnabled: true, auth };
}

test("accounts disabled: helpers are pass-throughs (legacy single-tenant)", () => {
  const r = req({ enabled: false });
  assert.deepEqual(authorizeRole(r, MUTATE_ROLE), { ok: true });
  // Even a model owned by some org is allowed when scoping is off.
  assert.deepEqual(authorizeModelAccess(r, { organization_id: "org-x" }, MUTATE_ROLE), { ok: true });
  assert.deepEqual(authorizeUploadHandle(r, { organizationId: "org-x", createdByUserId: "u-x" }), { ok: true });
});

test("authorizeModelAccess: missing model is 404", () => {
  const r = req({ enabled: true, role: "owner" });
  assert.deepEqual(authorizeModelAccess(r, undefined, READ_ROLE), {
    ok: false,
    status: 404,
    error: "Model not found."
  });
});

test("authorizeModelAccess: cross-organization model is 404 (existence hidden)", () => {
  const r = req({ enabled: true, orgId: "org-A", role: "owner" });
  const result = authorizeModelAccess(r, { organization_id: "org-B" }, READ_ROLE);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 404);
});

test("authorizeModelAccess: same org but insufficient role is 403", () => {
  const r = req({ enabled: true, orgId: "org-A", role: "viewer" });
  const result = authorizeModelAccess(r, { organization_id: "org-A" }, MUTATE_ROLE);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 403);
});

test("authorizeModelAccess: same org and sufficient role passes", () => {
  const r = req({ enabled: true, orgId: "org-A", role: "admin" });
  assert.deepEqual(authorizeModelAccess(r, { organization_id: "org-A" }, MUTATE_ROLE), { ok: true });
});

test("authorizeModelAccess: viewer may read but not upload/mutate own-org model", () => {
  const r = req({ enabled: true, orgId: "org-A", role: "viewer" });
  assert.deepEqual(authorizeModelAccess(r, { organization_id: "org-A" }, READ_ROLE), { ok: true });
  assert.equal(authorizeModelAccess(r, { organization_id: "org-A" }, UPLOAD_ROLE).ok, false);
  assert.equal(authorizeModelAccess(r, { organization_id: "org-A" }, MUTATE_ROLE).ok, false);
});

test("authorizeModelAccess: inactive membership is 403", () => {
  const r = req({ enabled: true, orgId: "org-A", role: "owner", status: "suspended" });
  const result = authorizeModelAccess(r, { organization_id: "org-A" }, READ_ROLE);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 403);
});

test("authorizeRole enforces the workspace role threshold", () => {
  assert.equal(authorizeRole(req({ enabled: true, role: "viewer" }), UPLOAD_ROLE).ok, false);
  assert.deepEqual(authorizeRole(req({ enabled: true, role: "member" }), UPLOAD_ROLE), { ok: true });
  assert.deepEqual(authorizeRole(req({ enabled: true, role: "admin" }), MUTATE_ROLE), { ok: true });
});

test("authorizeUploadHandle: only the owning org+user may use a handle", () => {
  const r = req({ enabled: true, orgId: "org-A", userId: "user-1", role: "member" });
  assert.deepEqual(
    authorizeUploadHandle(r, { organizationId: "org-A", createdByUserId: "user-1" }),
    { ok: true }
  );
  // Wrong org.
  assert.equal(authorizeUploadHandle(r, { organizationId: "org-B", createdByUserId: "user-1" }).ok, false);
  // Wrong user (same org).
  assert.equal(authorizeUploadHandle(r, { organizationId: "org-A", createdByUserId: "user-2" }).ok, false);
});
