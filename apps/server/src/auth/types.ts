// Domain types for the professional accounts layer (Phase 1).
// These mirror the PostgreSQL auth schema (see migrations/0001_auth_init.sql).

export type Provider = "google" | "microsoft";

export type UserStatus = "active" | "suspended" | "deleted";

export type Role = "owner" | "admin" | "member" | "viewer";

export type MembershipStatus = "active" | "invited" | "suspended";

// Higher rank = more privilege. Used by requireRole().
export const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4
};

export function isRole(value: unknown): value is Role {
  return value === "owner" || value === "admin" || value === "member" || value === "viewer";
}

export interface User {
  id: string;
  primary_email: string;
  display_name: string | null;
  avatar_url: string | null;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  deleted_at: string | null;
}

export interface AuthIdentity {
  id: string;
  user_id: string;
  provider: Provider;
  issuer: string;
  subject: string;
  provider_email: string | null;
  provider_email_verified: boolean;
  display_name: string | null;
  avatar_url: string | null;
  linked_at: string;
  last_used_at: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  owner_user_id: string;
  plan: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Membership {
  id: string;
  organization_id: string;
  user_id: string;
  role: Role;
  status: MembershipStatus;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  token_hash: string;
  active_organization_id: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export type AuditEventType =
  | "login.success"
  | "login.collision"
  | "login.rejected"
  | "logout"
  | "session.created"
  | "session.revoked"
  | "user.created"
  | "organization.created";

export interface AuditEvent {
  id: string;
  event_type: AuditEventType | string;
  user_id: string | null;
  organization_id: string | null;
  // Free-form sanitized metadata. MUST NOT contain tokens, secrets, or raw emails of other users.
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// A verified profile produced by the OIDC callback, handed to the service layer.
export interface ProviderProfile {
  provider: Provider;
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

// Resolved auth context attached to a request after a valid session.
export interface AuthContext {
  user: User;
  session: Session;
  organization: Organization | null;
  membership: Membership | null;
}
