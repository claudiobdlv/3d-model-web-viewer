import crypto from "node:crypto";
import type {
  AuthStore,
  CreateAuditEventInput,
  CreateIdentityInput,
  CreateOrganizationInput,
  CreateSessionInput,
  CreateUserInput
} from "./store.js";
import type {
  AuditEvent,
  AuthIdentity,
  Membership,
  Organization,
  Provider,
  Session,
  User
} from "./types.js";

// In-memory AuthStore for unit tests and for running the server without a
// PostgreSQL instance. NOT for production use (no durability).

export class MemoryAuthStore implements AuthStore {
  private users = new Map<string, User>();
  private identities = new Map<string, AuthIdentity>();
  private organizations = new Map<string, Organization>();
  private memberships = new Map<string, Membership>();
  private sessions = new Map<string, Session>();
  private audit: AuditEvent[] = [];

  private now(): string {
    return new Date().toISOString();
  }

  async getUserById(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const normalized = email.toLowerCase();
    return [...this.users.values()].find((user) => user.primary_email === normalized);
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const now = this.now();
    const user: User = {
      id: crypto.randomUUID(),
      primary_email: input.primaryEmail.toLowerCase(),
      display_name: input.displayName,
      avatar_url: input.avatarUrl,
      status: "active",
      created_at: now,
      updated_at: now,
      last_login_at: null,
      deleted_at: null
    };
    this.users.set(user.id, user);
    return user;
  }

  async markUserLogin(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) {
      user.last_login_at = this.now();
      user.updated_at = this.now();
    }
  }

  async getIdentity(provider: Provider, issuer: string, subject: string): Promise<AuthIdentity | undefined> {
    return [...this.identities.values()].find(
      (identity) => identity.provider === provider && identity.issuer === issuer && identity.subject === subject
    );
  }

  async listIdentitiesForUser(userId: string): Promise<AuthIdentity[]> {
    return [...this.identities.values()].filter((identity) => identity.user_id === userId);
  }

  async createIdentity(input: CreateIdentityInput): Promise<AuthIdentity> {
    const existing = await this.getIdentity(input.provider, input.issuer, input.subject);
    if (existing) {
      throw new Error("identity_conflict");
    }
    const now = this.now();
    const identity: AuthIdentity = {
      id: crypto.randomUUID(),
      user_id: input.userId,
      provider: input.provider,
      issuer: input.issuer,
      subject: input.subject,
      provider_email: input.providerEmail ? input.providerEmail.toLowerCase() : null,
      provider_email_verified: input.providerEmailVerified,
      display_name: input.displayName,
      avatar_url: input.avatarUrl,
      linked_at: now,
      last_used_at: now
    };
    this.identities.set(identity.id, identity);
    return identity;
  }

  async markIdentityUsed(identityId: string): Promise<void> {
    const identity = this.identities.get(identityId);
    if (identity) identity.last_used_at = this.now();
  }

  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
    const now = this.now();
    const org: Organization = {
      id: crypto.randomUUID(),
      name: input.name,
      slug: input.slug,
      owner_user_id: input.ownerUserId,
      plan: input.plan ?? "free",
      created_at: now,
      updated_at: now,
      deleted_at: null
    };
    this.organizations.set(org.id, org);
    return org;
  }

  async getOrganizationById(id: string): Promise<Organization | undefined> {
    return this.organizations.get(id);
  }

  async organizationSlugExists(slug: string): Promise<boolean> {
    return [...this.organizations.values()].some((org) => org.slug === slug);
  }

  async createMembership(input: {
    organizationId: string;
    userId: string;
    role: Membership["role"];
    status?: Membership["status"];
  }): Promise<Membership> {
    const now = this.now();
    const membership: Membership = {
      id: crypto.randomUUID(),
      organization_id: input.organizationId,
      user_id: input.userId,
      role: input.role,
      status: input.status ?? "active",
      created_at: now,
      updated_at: now
    };
    this.memberships.set(membership.id, membership);
    return membership;
  }

  async getMembership(organizationId: string, userId: string): Promise<Membership | undefined> {
    return [...this.memberships.values()].find(
      (membership) => membership.organization_id === organizationId && membership.user_id === userId
    );
  }

  async listMembershipsForUser(userId: string): Promise<Membership[]> {
    return [...this.memberships.values()].filter((membership) => membership.user_id === userId);
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const now = this.now();
    const session: Session = {
      id: crypto.randomUUID(),
      user_id: input.userId,
      token_hash: input.tokenHash,
      active_organization_id: input.activeOrganizationId,
      created_at: now,
      expires_at: input.expiresAt.toISOString(),
      revoked_at: null,
      last_used_at: now,
      ip_address: input.ipAddress,
      user_agent: input.userAgent
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async getSessionByHash(tokenHash: string): Promise<Session | undefined> {
    return [...this.sessions.values()].find((session) => session.token_hash === tokenHash);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && !session.revoked_at) session.revoked_at = this.now();
  }

  async markSessionUsed(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.last_used_at = this.now();
  }

  async deleteExpiredSessions(now: Date): Promise<number> {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (new Date(session.expires_at).getTime() <= now.getTime()) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async recordAuditEvent(input: CreateAuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: crypto.randomUUID(),
      event_type: input.eventType,
      user_id: input.userId,
      organization_id: input.organizationId,
      metadata: input.metadata,
      created_at: this.now()
    };
    this.audit.push(event);
    return event;
  }

  // Test helpers (not part of AuthStore).
  _auditEvents(): AuditEvent[] {
    return [...this.audit];
  }
}
