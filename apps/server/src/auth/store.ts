import type {
  AuditEvent,
  AuthIdentity,
  Membership,
  Organization,
  Provider,
  Session,
  User
} from "./types.js";

// Persistence interface for the accounts layer. Implemented by PgAuthStore
// (PostgreSQL, production) and MemoryAuthStore (tests / no-DB). Keeping the
// surface small and async lets the service layer be tested against the in-memory
// implementation without a running database.

export interface CreateUserInput {
  primaryEmail: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface CreateIdentityInput {
  userId: string;
  provider: Provider;
  issuer: string;
  subject: string;
  providerEmail: string | null;
  providerEmailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  ownerUserId: string;
  plan?: string;
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  activeOrganizationId: string | null;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreateAuditEventInput {
  eventType: string;
  userId: string | null;
  organizationId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AuthStore {
  // Users
  getUserById(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(input: CreateUserInput): Promise<User>;
  markUserLogin(userId: string): Promise<void>;

  // Identities
  getIdentity(provider: Provider, issuer: string, subject: string): Promise<AuthIdentity | undefined>;
  listIdentitiesForUser(userId: string): Promise<AuthIdentity[]>;
  createIdentity(input: CreateIdentityInput): Promise<AuthIdentity>;
  markIdentityUsed(identityId: string): Promise<void>;

  // Organizations & memberships
  createOrganization(input: CreateOrganizationInput): Promise<Organization>;
  getOrganizationById(id: string): Promise<Organization | undefined>;
  organizationSlugExists(slug: string): Promise<boolean>;
  createMembership(input: { organizationId: string; userId: string; role: Membership["role"]; status?: Membership["status"] }): Promise<Membership>;
  getMembership(organizationId: string, userId: string): Promise<Membership | undefined>;
  listMembershipsForUser(userId: string): Promise<Membership[]>;

  // Sessions
  createSession(input: CreateSessionInput): Promise<Session>;
  getSessionByHash(tokenHash: string): Promise<Session | undefined>;
  revokeSession(sessionId: string): Promise<void>;
  markSessionUsed(sessionId: string): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<number>;

  // Audit
  recordAuditEvent(input: CreateAuditEventInput): Promise<AuditEvent>;
  // Most-recent-first, scoped to a single organization, capped at `limit`. Used
  // by the admin-visible audit/security log — never call without an
  // organizationId (there is no "all orgs" variant to avoid accidental leaks).
  listAuditEventsForOrganization(organizationId: string, limit: number): Promise<AuditEvent[]>;

  // Sessions (listing)
  // Non-revoked, non-expired sessions for a user, most-recently-used first.
  // Used for the self-service "signed-in devices" list.
  listActiveSessionsForUser(userId: string): Promise<Session[]>;

  // Runs `fn` so that every store write it performs commits or rolls back
  // together. The store passed to `fn` MUST be used for the writes that should
  // be atomic. For PostgreSQL this is a real `BEGIN`/`COMMIT`/`ROLLBACK` on a
  // single dedicated client; for the in-memory store it snapshots and restores
  // state on failure so tests can exercise partial-failure rollback without a
  // database. Used by account provisioning (user + identity + organization +
  // membership + initial audit events succeed or fail as a unit).
  transaction<T>(fn: (tx: AuthStore) => Promise<T>): Promise<T>;
}
