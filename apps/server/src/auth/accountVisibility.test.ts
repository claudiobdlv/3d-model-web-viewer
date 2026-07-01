import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { ProviderProfile } from "./types.js";

// HTTP-level coverage for the Accounts UX + Security Visibility Pack 1
// additions: /api/me provider field, /api/sessions (+ revoke), and the
// admin-gated, org-scoped /api/audit-events log. Sessions are minted directly
// via the exported auth subsystem service (no live OAuth provider needed),
// exercising the exact cookie + middleware path a real login would use.

const ownerProfile: ProviderProfile = {
  provider: "google",
  issuer: "https://accounts.google.com",
  subject: "google-sub-visibility-owner",
  email: "owner@example.com",
  emailVerified: true,
  displayName: "Owner One",
  avatarUrl: null
};

test("account visibility: provider field, session list/revoke, org-scoped audit log", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-account-visibility-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_ENABLED = "true";
  process.env.AUTH_STORE = "memory";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.APP_BASE_URL = "http://127.0.0.1";
  process.env.AUTH_ALLOWED_EMAILS = "owner@example.com,member@example.com,otherorg@example.com";

  const { app, authSubsystem } = await import("./../server.js");
  const { db } = await import("./../db.js");
  const service = authSubsystem.service!;
  const cookieName = authSubsystem.config.cookieName;

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.AUTH_ENABLED;
    delete process.env.AUTH_STORE;
    delete process.env.SESSION_SECRET;
    delete process.env.AUTH_ALLOWED_EMAILS;
  });

  // --- /api/me includes the sign-in provider ---
  const loginOwner = await service.loginWithProvider(ownerProfile);
  assert.equal(loginOwner.ok, true);
  if (!loginOwner.ok) return;
  const sessionOwner1 = await service.createSession(loginOwner.user.id, {
    activeOrganizationId: loginOwner.organization.id,
    ipAddress: "203.0.113.5",
    userAgent: "TestAgent/1.0"
  });
  const cookieOwner1 = `${cookieName}=${sessionOwner1.token}`;

  const me = await fetch(`${origin}/api/me`, { headers: { cookie: cookieOwner1 } });
  assert.equal(me.status, 200);
  const meBody = (await me.json()) as { provider: string | null };
  assert.equal(meBody.provider, "google");

  // --- /api/sessions lists only this user's own sessions, no token/IP fields ---
  const sessionOwner2 = await service.createSession(loginOwner.user.id, {
    activeOrganizationId: loginOwner.organization.id,
    ipAddress: "203.0.113.9",
    userAgent: "AnotherAgent/2.0"
  });

  const sessionsRes = await fetch(`${origin}/api/sessions`, { headers: { cookie: cookieOwner1 } });
  assert.equal(sessionsRes.status, 200);
  const sessionsBody = (await sessionsRes.json()) as {
    sessions: Array<{ id: string; current: boolean; createdAt: string; lastUsedAt: string | null; userAgent: string | null }>;
  };
  assert.equal(sessionsBody.sessions.length, 2);
  const raw = JSON.stringify(sessionsBody);
  assert.doesNotMatch(raw, /203\.0\.113/); // no raw IPs
  assert.doesNotMatch(raw, /tokenHash|token_hash/i); // no token hashes
  assert.equal(raw.includes(sessionOwner1.token), false); // no raw session token
  assert.equal(raw.includes(sessionOwner2.token), false);
  const currentEntry = sessionsBody.sessions.find((s) => s.id === sessionOwner1.session.id);
  assert.equal(currentEntry?.current, true);
  const otherEntry = sessionsBody.sessions.find((s) => s.id === sessionOwner2.session.id);
  assert.equal(otherEntry?.current, false);

  // Revoking the current session via this endpoint is rejected (use logout).
  const revokeCurrent = await fetch(`${origin}/api/sessions/${sessionOwner1.session.id}/revoke`, {
    method: "POST",
    headers: { cookie: cookieOwner1 }
  });
  assert.equal(revokeCurrent.status, 400);

  // Revoking an unknown/foreign session id 404s without confirming ownership.
  const revokeUnknown = await fetch(`${origin}/api/sessions/does-not-exist/revoke`, {
    method: "POST",
    headers: { cookie: cookieOwner1 }
  });
  assert.equal(revokeUnknown.status, 404);

  // Revoking the other session succeeds, and it disappears from /api/models auth.
  const revokeOther = await fetch(`${origin}/api/sessions/${sessionOwner2.session.id}/revoke`, {
    method: "POST",
    headers: { cookie: cookieOwner1 }
  });
  assert.equal(revokeOther.status, 200);
  const afterRevoke = await fetch(`${origin}/api/models`, { headers: { cookie: `${cookieName}=${sessionOwner2.token}` } });
  assert.equal(afterRevoke.status, 401);

  // --- /api/audit-events requires an admin+ role and is org-scoped ---
  const loginMember = await service.loginWithProvider({
    ...ownerProfile,
    subject: "google-sub-visibility-member",
    email: "member@example.com"
  });
  assert.equal(loginMember.ok, true);
  if (!loginMember.ok) return;
  const sessionMember = await service.createSession(loginMember.user.id, {
    activeOrganizationId: loginMember.organization.id,
    ipAddress: null,
    userAgent: null
  });
  const cookieMember = `${cookieName}=${sessionMember.token}`;

  // A "viewer" member of the owner's own org is rejected by the role gate
  // (viewer < admin), proving this is a role check, not just an org-membership check.
  const loginViewer = await service.loginWithProvider({
    ...ownerProfile,
    subject: "google-sub-visibility-viewer",
    email: "otherorg@example.com"
  });
  assert.equal(loginViewer.ok, true);
  if (!loginViewer.ok) return;
  await authSubsystem.store!.createMembership({
    organizationId: loginOwner.organization.id,
    userId: loginViewer.user.id,
    role: "viewer"
  });
  const sessionViewer = await service.createSession(loginViewer.user.id, {
    activeOrganizationId: loginOwner.organization.id,
    ipAddress: null,
    userAgent: null
  });
  const auditViewer = await fetch(`${origin}/api/audit-events`, {
    headers: { cookie: `${cookieName}=${sessionViewer.token}` }
  });
  assert.equal(auditViewer.status, 403);

  // The owner (role "owner", rank above "admin") can read their org's audit log.
  const auditOwner = await fetch(`${origin}/api/audit-events`, { headers: { cookie: cookieOwner1 } });
  assert.equal(auditOwner.status, 200);
  const auditOwnerBody = (await auditOwner.json()) as {
    events: Array<{ id: string; type: string; createdAt: string; metadata: Record<string, unknown> | null }>;
  };
  assert.ok(auditOwnerBody.events.length > 0);
  assert.ok(auditOwnerBody.events.every((e) => typeof e.type === "string" && typeof e.createdAt === "string"));

  // A caller in a *different* organization only sees their own org's events,
  // never the owner's — proving org scoping, not just role gating.
  const auditMember = await fetch(`${origin}/api/audit-events`, { headers: { cookie: cookieMember } });
  assert.equal(auditMember.status, 200);
  const auditMemberBody = (await auditMember.json()) as { events: Array<{ metadata: Record<string, unknown> | null }> };
  // member's own org has its own login.success/user.created/organization.created events,
  // but none should reference the owner's org-only data (e.g. session ids from owner's org).
  const memberRaw = JSON.stringify(auditMemberBody);
  assert.equal(memberRaw.includes(sessionOwner1.session.id), false);
  assert.equal(memberRaw.includes(sessionOwner2.session.id), false);

  // No response anywhere leaks tokens, secrets, cookies, or raw IPs.
  const fullAuditRaw = JSON.stringify(auditOwnerBody).toLowerCase();
  assert.doesNotMatch(fullAuditRaw, /secret|password|"cookie"|bearer|203\.0\.113/);
  assert.equal(fullAuditRaw.includes(sessionOwner1.token.toLowerCase()), false);

  // Unauthenticated callers are rejected.
  const auditAnon = await fetch(`${origin}/api/audit-events`);
  assert.equal(auditAnon.status, 401);
  const sessionsAnon = await fetch(`${origin}/api/sessions`);
  assert.equal(sessionsAnon.status, 401);
});
