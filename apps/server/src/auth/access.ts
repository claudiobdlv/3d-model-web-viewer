// Central authorization layer for the professional accounts feature.
//
// Every private/admin model operation must run through one of these helpers so
// that tenant-safety (organization ownership + role enforcement) is decided in
// ONE place instead of being re-derived ad hoc in each route.
//
// Two operating modes:
//   * AUTH_ENABLED=false (production today): req.authEnabled is false. The
//     helpers are pure pass-throughs that preserve the legacy single-tenant
//     SQLite + Basic-auth behaviour exactly. They authorize by slug/ID alone,
//     because that is the legacy contract and no organization scoping exists.
//   * AUTH_ENABLED=true: req.authEnabled is true. The admin guard
//     (requireSession + requireOrgMembership) has already run, so req.auth and
//     an active membership are expected. The helpers then require that the
//     target model belongs to the caller's active organization AND that the
//     caller's role meets the minimum for the operation.
//
// IMPORTANT: mode is decided by the explicit req.authEnabled flag (set once in
// server.ts), never by the mere presence of req.auth — a logged-out request on
// an auth-enabled server must still fail closed, not fall through to legacy.

import { ROLE_RANK, type AuthContext, type Role } from "./types.js";
import { authorizeModelForOrg } from "./middleware.js";

// Role thresholds for the model operations (see security review finding 3).
//   viewer  → read-only (view private models, view display GLB)
//   member  → may upload models/revisions and download source files
//   admin   → may rename, move, trash/restore/delete, manage shares,
//             change default view / revision settings
//   owner   → everything admin can do
export const READ_ROLE: Role = "viewer";
export const UPLOAD_ROLE: Role = "member";
export const SOURCE_DOWNLOAD_ROLE: Role = "member";
export const DIAGNOSTIC_ROLE: Role = "member";
export const MUTATE_ROLE: Role = "admin";

// Minimal request shape the helpers depend on. Express's Request satisfies this.
export interface AuthAwareRequest {
  auth?: AuthContext;
  authEnabled?: boolean;
}

interface ModelOrgShape {
  organization_id?: string | null;
}

export type AccessResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

const NOT_FOUND: AccessResult = { ok: false, status: 404, error: "Model not found." };
const FORBIDDEN_MEMBERSHIP: AccessResult = {
  ok: false,
  status: 403,
  error: "Active workspace membership required."
};
const FORBIDDEN_ROLE: AccessResult = {
  ok: false,
  status: 403,
  error: "Insufficient permissions for this workspace."
};

function isAuthEnabled(req: AuthAwareRequest): boolean {
  return req.authEnabled === true;
}

function activeMembership(req: AuthAwareRequest): { organizationId: string; role: Role } | null {
  const organization = req.auth?.organization;
  const membership = req.auth?.membership;
  if (!organization || !membership || membership.status !== "active") return null;
  return { organizationId: organization.id, role: membership.role };
}

// Role-only authorization (e.g. creating a brand new model with no existing
// owner record yet). Pass-through when accounts are disabled.
export function authorizeRole(req: AuthAwareRequest, minimumRole: Role): AccessResult {
  if (!isAuthEnabled(req)) return { ok: true };
  const ctx = activeMembership(req);
  if (!ctx) return FORBIDDEN_MEMBERSHIP;
  if (ROLE_RANK[ctx.role] < ROLE_RANK[minimumRole]) return FORBIDDEN_ROLE;
  return { ok: true };
}

// Authorize an operation against a specific model. Ordering matters: a model in
// another workspace returns 404 (never 403) so existence is not leaked; a model
// in the caller's workspace but beyond their role returns 403.
export function authorizeModelAccess(
  req: AuthAwareRequest,
  model: ModelOrgShape | undefined | null,
  minimumRole: Role
): AccessResult {
  if (!model) return NOT_FOUND;
  if (!isAuthEnabled(req)) return { ok: true };
  const ctx = activeMembership(req);
  if (!ctx) return FORBIDDEN_MEMBERSHIP;
  if (!authorizeModelForOrg(model, ctx.organizationId)) return NOT_FOUND;
  if (ROLE_RANK[ctx.role] < ROLE_RANK[minimumRole]) return FORBIDDEN_ROLE;
  return { ok: true };
}

// Stored chunked-upload handle metadata that records its owning session/org.
export interface UploadHandleOwner {
  organizationId?: string | null;
  createdByUserId?: string | null;
}

// Verify the current session/org owns a chunked-upload handle. Pass-through when
// accounts are disabled. A handle owned by another org/user returns 404 so we do
// not confirm that someone else's upload id exists.
export function authorizeUploadHandle(
  req: AuthAwareRequest,
  handle: UploadHandleOwner
): AccessResult {
  if (!isAuthEnabled(req)) return { ok: true };
  const ctx = activeMembership(req);
  if (!ctx) return FORBIDDEN_MEMBERSHIP;
  const user = req.auth?.user;
  if (
    !user ||
    handle.organizationId !== ctx.organizationId ||
    handle.createdByUserId !== user.id
  ) {
    return { ok: false, status: 404, error: "Upload not found or expired." };
  }
  return { ok: true };
}
