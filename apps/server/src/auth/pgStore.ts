import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

// Repeatable, safe migration runner. Each .sql file is applied at most once,
// inside a transaction, and recorded in schema_migrations. Re-running is a no-op.
export async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (rows.length > 0) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

function mapUser(row: any): User {
  return {
    id: row.id,
    primary_email: row.primary_email,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    status: row.status,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    last_login_at: toIsoOrNull(row.last_login_at),
    deleted_at: toIsoOrNull(row.deleted_at)
  };
}

function mapIdentity(row: any): AuthIdentity {
  return {
    id: row.id,
    user_id: row.user_id,
    provider: row.provider,
    issuer: row.issuer,
    subject: row.subject,
    provider_email: row.provider_email,
    provider_email_verified: Boolean(row.provider_email_verified),
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    linked_at: toIso(row.linked_at),
    last_used_at: toIsoOrNull(row.last_used_at)
  };
}

function mapOrg(row: any): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    owner_user_id: row.owner_user_id,
    plan: row.plan,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    deleted_at: toIsoOrNull(row.deleted_at)
  };
}

function mapMembership(row: any): Membership {
  return {
    id: row.id,
    organization_id: row.organization_id,
    user_id: row.user_id,
    role: row.role,
    status: row.status,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at)
  };
}

function mapSession(row: any): Session {
  return {
    id: row.id,
    user_id: row.user_id,
    token_hash: row.token_hash,
    active_organization_id: row.active_organization_id,
    created_at: toIso(row.created_at),
    expires_at: toIso(row.expires_at),
    revoked_at: toIsoOrNull(row.revoked_at),
    last_used_at: toIsoOrNull(row.last_used_at),
    ip_address: row.ip_address,
    user_agent: row.user_agent
  };
}

// Minimal surface shared by a pg Pool and a checked-out PoolClient. Every store
// method talks to a `Queryable` so the same implementation can run either
// against the pool (autocommit, one statement per call) or against a single
// client inside a BEGIN/COMMIT transaction (see `transaction`).
interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export class PgAuthStore implements AuthStore {
  // `pool` is retained for acquiring a dedicated client in `transaction`; `db`
  // is what every statement runs against (the pool itself by default, or a
  // transaction-bound client for the store handed to `transaction`'s callback).
  private readonly db: Queryable;

  constructor(private readonly pool: Pool, db?: Queryable) {
    this.db = db ?? pool;
  }

  async transaction<T>(fn: (tx: AuthStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const txStore = new PgAuthStore(this.pool, client);
      const result = await fn(txStore);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore rollback failures; surface the original error below */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getUserById(id: string): Promise<User | undefined> {
    const { rows } = await this.db.query("SELECT * FROM users WHERE id = $1", [id]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const { rows } = await this.db.query("SELECT * FROM users WHERE lower(primary_email) = lower($1)", [email]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const { rows } = await this.db.query(
      `INSERT INTO users (id, primary_email, display_name, avatar_url)
       VALUES ($1, lower($2), $3, $4) RETURNING *`,
      [crypto.randomUUID(), input.primaryEmail, input.displayName, input.avatarUrl]
    );
    return mapUser(rows[0]);
  }

  async markUserLogin(userId: string): Promise<void> {
    await this.db.query("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1", [userId]);
  }

  async getIdentity(provider: Provider, issuer: string, subject: string): Promise<AuthIdentity | undefined> {
    const { rows } = await this.db.query(
      "SELECT * FROM auth_identities WHERE provider = $1 AND issuer = $2 AND subject = $3",
      [provider, issuer, subject]
    );
    return rows[0] ? mapIdentity(rows[0]) : undefined;
  }

  async listIdentitiesForUser(userId: string): Promise<AuthIdentity[]> {
    const { rows } = await this.db.query("SELECT * FROM auth_identities WHERE user_id = $1", [userId]);
    return rows.map(mapIdentity);
  }

  async createIdentity(input: CreateIdentityInput): Promise<AuthIdentity> {
    const { rows } = await this.db.query(
      `INSERT INTO auth_identities
         (id, user_id, provider, issuer, subject, provider_email, provider_email_verified, display_name, avatar_url, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()) RETURNING *`,
      [
        crypto.randomUUID(),
        input.userId,
        input.provider,
        input.issuer,
        input.subject,
        input.providerEmail ? input.providerEmail.toLowerCase() : null,
        input.providerEmailVerified,
        input.displayName,
        input.avatarUrl
      ]
    );
    return mapIdentity(rows[0]);
  }

  async markIdentityUsed(identityId: string): Promise<void> {
    await this.db.query("UPDATE auth_identities SET last_used_at = now() WHERE id = $1", [identityId]);
  }

  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
    const { rows } = await this.db.query(
      `INSERT INTO organizations (id, name, slug, owner_user_id, plan)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [crypto.randomUUID(), input.name, input.slug, input.ownerUserId, input.plan ?? "free"]
    );
    return mapOrg(rows[0]);
  }

  async getOrganizationById(id: string): Promise<Organization | undefined> {
    const { rows } = await this.db.query("SELECT * FROM organizations WHERE id = $1", [id]);
    return rows[0] ? mapOrg(rows[0]) : undefined;
  }

  async organizationSlugExists(slug: string): Promise<boolean> {
    const { rows } = await this.db.query("SELECT 1 FROM organizations WHERE slug = $1", [slug]);
    return rows.length > 0;
  }

  async createMembership(input: {
    organizationId: string;
    userId: string;
    role: Membership["role"];
    status?: Membership["status"];
  }): Promise<Membership> {
    const { rows } = await this.db.query(
      `INSERT INTO organization_memberships (id, organization_id, user_id, role, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [crypto.randomUUID(), input.organizationId, input.userId, input.role, input.status ?? "active"]
    );
    return mapMembership(rows[0]);
  }

  async getMembership(organizationId: string, userId: string): Promise<Membership | undefined> {
    const { rows } = await this.db.query(
      "SELECT * FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
      [organizationId, userId]
    );
    return rows[0] ? mapMembership(rows[0]) : undefined;
  }

  async listMembershipsForUser(userId: string): Promise<Membership[]> {
    const { rows } = await this.db.query(
      "SELECT * FROM organization_memberships WHERE user_id = $1 ORDER BY created_at ASC",
      [userId]
    );
    return rows.map(mapMembership);
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const { rows } = await this.db.query(
      `INSERT INTO sessions (id, user_id, token_hash, active_organization_id, expires_at, last_used_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7) RETURNING *`,
      [
        crypto.randomUUID(),
        input.userId,
        input.tokenHash,
        input.activeOrganizationId,
        input.expiresAt.toISOString(),
        input.ipAddress,
        input.userAgent
      ]
    );
    return mapSession(rows[0]);
  }

  async getSessionByHash(tokenHash: string): Promise<Session | undefined> {
    const { rows } = await this.db.query("SELECT * FROM sessions WHERE token_hash = $1", [tokenHash]);
    return rows[0] ? mapSession(rows[0]) : undefined;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
  }

  async markSessionUsed(sessionId: string): Promise<void> {
    await this.db.query("UPDATE sessions SET last_used_at = now() WHERE id = $1", [sessionId]);
  }

  async deleteExpiredSessions(now: Date): Promise<number> {
    const result = await this.db.query("DELETE FROM sessions WHERE expires_at <= $1", [now.toISOString()]);
    return result.rowCount ?? 0;
  }

  async recordAuditEvent(input: CreateAuditEventInput): Promise<AuditEvent> {
    const { rows } = await this.db.query(
      `INSERT INTO audit_events (id, event_type, user_id, organization_id, metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [crypto.randomUUID(), input.eventType, input.userId, input.organizationId, input.metadata ? JSON.stringify(input.metadata) : null]
    );
    const row = rows[0];
    return {
      id: row.id,
      event_type: row.event_type,
      user_id: row.user_id,
      organization_id: row.organization_id,
      metadata: row.metadata,
      created_at: toIso(row.created_at)
    };
  }

  // Used by tests / transactional callers if needed.
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
}
