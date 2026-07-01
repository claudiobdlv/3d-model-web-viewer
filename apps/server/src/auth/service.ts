import type { AuthStore } from "./store.js";
import { generateSessionToken, hashToken, isValidSessionToken } from "./tokens.js";
import type {
  AuditEvent,
  AuthContext,
  Membership,
  Organization,
  Provider,
  ProviderProfile,
  Session,
  User
} from "./types.js";

export const DEFAULT_WORKSPACE_NAME = "Personal Workspace";

export type LoginResult =
  | { ok: true; user: User; organization: Organization; membership: Membership; created: boolean }
  | {
      ok: false;
      reason: "no_email" | "account_exists_different_provider" | "user_disabled" | "email_not_allowed";
      existingProviders?: string[];
    };

export interface SessionConfig {
  sessionTtlMs: number;
  // Admin email allow-list (lowercase-normalized). When non-empty, only a
  // verified email in this list may create or log into the admin workspace.
  // Enforced on every login (not just creation) so removing an email from the
  // list revokes access immediately. Empty/undefined means no emails are
  // permitted — index.ts requires this to be set whenever AUTH_ENABLED=true.
  allowedEmails?: Iterable<string>;
}

export class AuthService {
  private readonly allowedEmails: Set<string>;

  constructor(private readonly store: AuthStore, private readonly config: SessionConfig) {
    this.allowedEmails = new Set([...(config.allowedEmails ?? [])].map((email) => email.trim().toLowerCase()));
  }

  // Implements the Phase 1 account-collision rule:
  //  - existing identity -> log that user in
  //  - new identity, no user with that email -> create user + Personal Workspace + owner membership
  //  - new identity, but a user already owns that email -> DO NOT auto-merge; surface error
  async loginWithProvider(profile: ProviderProfile): Promise<LoginResult> {
    const email = profile.email ? profile.email.trim().toLowerCase() : "";

    // Admin email allow-list gate. Checked before any identity/user lookup so
    // an unapproved account never creates a user/workspace, and so revoking an
    // email from the allow-list blocks even a previously-approved returning
    // identity (defense in depth — identity is still keyed on
    // provider+issuer+subject, never email alone, once an account exists).
    if (this.allowedEmails.size > 0 && (!email || !this.allowedEmails.has(email))) {
      await this.store.recordAuditEvent({
        eventType: "login.rejected",
        userId: null,
        organizationId: null,
        metadata: { provider: profile.provider, reason: "email_not_allowed" }
      });
      return { ok: false, reason: "email_not_allowed" };
    }

    const existingIdentity = await this.store.getIdentity(profile.provider, profile.issuer, profile.subject);
    if (existingIdentity) {
      const user = await this.store.getUserById(existingIdentity.user_id);
      if (!user || user.status !== "active" || user.deleted_at) {
        await this.store.recordAuditEvent({
          eventType: "login.rejected",
          userId: user?.id ?? null,
          organizationId: null,
          metadata: { provider: profile.provider, reason: "user_disabled" }
        });
        return { ok: false, reason: "user_disabled" };
      }
      await this.store.markIdentityUsed(existingIdentity.id);
      await this.store.markUserLogin(user.id);
      const { organization, membership } = await this.ensurePersonalWorkspace(user);
      await this.store.recordAuditEvent({
        eventType: "login.success",
        userId: user.id,
        organizationId: organization.id,
        metadata: { provider: profile.provider, returning: true }
      });
      return { ok: true, user, organization, membership, created: false };
    }

    if (!email) {
      return { ok: false, reason: "no_email" };
    }

    const userWithEmail = await this.store.getUserByEmail(email);
    if (userWithEmail) {
      // A different provider (or none) already owns this email. Account linking
      // is Phase 2 — refuse to silently merge.
      const identities = await this.store.listIdentitiesForUser(userWithEmail.id);
      const existingProviders = [...new Set(identities.map((identity) => identity.provider))];
      await this.store.recordAuditEvent({
        eventType: "login.collision",
        userId: userWithEmail.id,
        organizationId: null,
        metadata: { attemptedProvider: profile.provider, existingProviders }
      });
      return { ok: false, reason: "account_exists_different_provider", existingProviders };
    }

    // Brand new account. Provision the user, their auth identity, the Personal
    // Workspace, the owner membership, and the initial audit trail as a single
    // unit of work: with the PostgreSQL store everything commits or rolls back
    // together (no orphaned user without a workspace, no identity pointing at a
    // half-created account); the in-memory store snapshots/restores to mirror
    // this for tests. If a concurrent signup wins the unique-email/identity
    // race, the transaction aborts and we re-resolve below instead of leaving
    // partial state behind.
    try {
      const provisioned = await this.store.transaction(async (tx) => {
        const user = await tx.createUser({
          primaryEmail: email,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl
        });
        await tx.recordAuditEvent({
          eventType: "user.created",
          userId: user.id,
          organizationId: null,
          metadata: { provider: profile.provider }
        });
        await tx.createIdentity({
          userId: user.id,
          provider: profile.provider,
          issuer: profile.issuer,
          subject: profile.subject,
          providerEmail: email,
          providerEmailVerified: profile.emailVerified,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl
        });
        const { organization, membership } = await this.ensurePersonalWorkspace(user, tx);
        await tx.markUserLogin(user.id);
        await tx.recordAuditEvent({
          eventType: "login.success",
          userId: user.id,
          organizationId: organization.id,
          metadata: { provider: profile.provider, returning: false }
        });
        return { user, organization, membership };
      });
      return { ok: true, ...provisioned, created: true };
    } catch (error) {
      // Provisioning rolled back. Distinguish a lost concurrency race (another
      // request created this identity or claimed the email first) from a
      // genuine infrastructure failure, which must propagate.
      const racedIdentity = await this.store.getIdentity(profile.provider, profile.issuer, profile.subject);
      if (racedIdentity) {
        const racedUser = await this.store.getUserById(racedIdentity.user_id);
        if (racedUser && racedUser.status === "active" && !racedUser.deleted_at) {
          const { organization, membership } = await this.ensurePersonalWorkspace(racedUser);
          await this.store.recordAuditEvent({
            eventType: "login.success",
            userId: racedUser.id,
            organizationId: organization.id,
            metadata: { provider: profile.provider, returning: true, raced: true }
          });
          return { ok: true, user: racedUser, organization, membership, created: false };
        }
      }
      const racedEmailUser = await this.store.getUserByEmail(email);
      if (racedEmailUser) {
        const identities = await this.store.listIdentitiesForUser(racedEmailUser.id);
        const existingProviders = [...new Set(identities.map((identity) => identity.provider))];
        return { ok: false, reason: "account_exists_different_provider", existingProviders };
      }
      throw error;
    }
  }

  // Ensures the user has at least one workspace they own. New users get a
  // "Personal Workspace" with role owner. `store` lets callers run this inside
  // a provisioning transaction (defaults to the long-lived store otherwise).
  async ensurePersonalWorkspace(
    user: User,
    store: AuthStore = this.store
  ): Promise<{ organization: Organization; membership: Membership }> {
    const memberships = await store.listMembershipsForUser(user.id);
    for (const membership of memberships) {
      const organization = await store.getOrganizationById(membership.organization_id);
      if (organization && !organization.deleted_at) {
        return { organization, membership };
      }
    }

    const slug = await this.allocateOrgSlug(user, store);
    const organization = await store.createOrganization({
      name: DEFAULT_WORKSPACE_NAME,
      slug,
      ownerUserId: user.id,
      plan: "free"
    });
    const membership = await store.createMembership({
      organizationId: organization.id,
      userId: user.id,
      role: "owner",
      status: "active"
    });
    await store.recordAuditEvent({
      eventType: "organization.created",
      userId: user.id,
      organizationId: organization.id,
      metadata: { name: DEFAULT_WORKSPACE_NAME }
    });
    return { organization, membership };
  }

  private async allocateOrgSlug(user: User, store: AuthStore = this.store): Promise<string> {
    const base =
      (user.primary_email.split("@")[0] || "workspace")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "workspace";
    let slug = base;
    let suffix = 2;
    // Bounded loop; appends a short random suffix if needed to avoid clashes.
    while (await store.organizationSlugExists(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
      if (suffix > 50) {
        slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
        break;
      }
    }
    return slug;
  }

  async createSession(
    userId: string,
    options: { activeOrganizationId: string | null; ipAddress: string | null; userAgent: string | null }
  ): Promise<{ token: string; session: Session }> {
    const token = generateSessionToken();
    const session = await this.store.createSession({
      userId,
      tokenHash: hashToken(token),
      activeOrganizationId: options.activeOrganizationId,
      expiresAt: new Date(Date.now() + this.config.sessionTtlMs),
      ipAddress: options.ipAddress,
      userAgent: options.userAgent
    });
    await this.store.recordAuditEvent({
      eventType: "session.created",
      userId,
      organizationId: options.activeOrganizationId,
      metadata: { sessionId: session.id }
    });
    return { token, session };
  }

  // Resolves a raw session cookie value to a full auth context, enforcing token
  // validity, revocation, expiry, and user status. Returns undefined on any
  // failure (caller treats as unauthenticated).
  async resolveSession(rawToken: string | undefined): Promise<AuthContext | undefined> {
    if (!rawToken || !isValidSessionToken(rawToken)) return undefined;
    const session = await this.store.getSessionByHash(hashToken(rawToken));
    if (!session) return undefined;
    if (session.revoked_at) return undefined;
    if (new Date(session.expires_at).getTime() <= Date.now()) return undefined;

    const user = await this.store.getUserById(session.user_id);
    if (!user || user.status !== "active" || user.deleted_at) return undefined;

    let organization: Organization | null = null;
    let membership: Membership | null = null;
    if (session.active_organization_id) {
      organization = (await this.store.getOrganizationById(session.active_organization_id)) ?? null;
      if (organization && organization.deleted_at) organization = null;
      if (organization) {
        membership = (await this.store.getMembership(organization.id, user.id)) ?? null;
      }
    }
    // Fall back to the user's first owned workspace if the session lacks one.
    if (!organization) {
      const resolved = await this.ensurePersonalWorkspace(user);
      organization = resolved.organization;
      membership = resolved.membership;
    }

    await this.store.markSessionUsed(session.id);
    return { user, session, organization, membership };
  }

  // Records that a sign-in was attempted against a provider that is not
  // currently available (in the AUTH_PROVIDERS allow-list but without configured
  // credentials, e.g. Microsoft while Google-only). No user/PII is involved.
  async recordProviderUnavailable(provider: string, phase: "start" | "callback"): Promise<void> {
    await this.store.recordAuditEvent({
      eventType: "auth.provider_unavailable",
      userId: null,
      organizationId: null,
      metadata: { provider, phase }
    });
  }

  // The provider the user most recently used to sign in. Phase 1 is
  // single-identity-per-user (account linking is Phase 2), so this is
  // effectively "the" provider for the account today.
  async getPrimaryProvider(userId: string): Promise<Provider | null> {
    const identities = await this.store.listIdentitiesForUser(userId);
    return identities[0]?.provider ?? null;
  }

  // Most-recent-first, capped, org-scoped audit trail for the admin-visible
  // security log. Never accepts an "all organizations" mode.
  async listRecentAuditEvents(organizationId: string, limit = 50): Promise<AuditEvent[]> {
    return this.store.listAuditEventsForOrganization(organizationId, limit);
  }

  // Active (non-revoked, non-expired) sessions for the self-service device list.
  async listActiveSessions(userId: string): Promise<Session[]> {
    return this.store.listActiveSessionsForUser(userId);
  }

  // Revokes a session owned by `userId`. Returns false if there is no matching
  // active session — whether because it's already gone or belongs to someone
  // else is intentionally indistinguishable to the caller.
  async revokeOwnSession(userId: string, sessionId: string): Promise<boolean> {
    const sessions = await this.store.listActiveSessionsForUser(userId);
    const target = sessions.find((session) => session.id === sessionId);
    if (!target) return false;
    await this.store.revokeSession(target.id);
    await this.store.recordAuditEvent({
      eventType: "session.revoked",
      userId,
      organizationId: target.active_organization_id,
      metadata: { sessionId: target.id, reason: "user_revoked_other" }
    });
    return true;
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken || !isValidSessionToken(rawToken)) return;
    const session = await this.store.getSessionByHash(hashToken(rawToken));
    if (!session || session.revoked_at) return;
    await this.store.revokeSession(session.id);
    await this.store.recordAuditEvent({
      eventType: "session.revoked",
      userId: session.user_id,
      organizationId: session.active_organization_id,
      metadata: { sessionId: session.id, reason: "logout" }
    });
  }
}
