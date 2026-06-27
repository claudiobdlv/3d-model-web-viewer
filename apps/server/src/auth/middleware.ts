import type express from "express";
import type { AuthService } from "./service.js";
import type { AuthConfig } from "./config.js";
import { ROLE_RANK, type AuthContext, type Role } from "./types.js";

// Augment Express Request with the resolved auth context.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function wantsJson(req: express.Request): boolean {
  // Use originalUrl: req.path is stripped of the mount prefix inside routers
  // mounted via app.use("/api/...", ...), which would hide the /api/ prefix.
  if ((req.originalUrl || req.url).startsWith("/api/")) return true;
  const accept = req.header("accept") || "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

function loginRedirect(req: express.Request, res: express.Response): void {
  const next = encodeURIComponent(req.originalUrl || "/admin");
  res.redirect(302, `/login?next=${next}`);
}

// Resolves the session cookie into req.auth (or leaves it undefined). Never
// throws and never blocks — gating is done by requireSession/requireRole.
export function attachAuth(service: AuthService, config: AuthConfig): express.RequestHandler {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[config.cookieName];
    if (!token) {
      next();
      return;
    }
    service
      .resolveSession(token)
      .then((context) => {
        if (context) req.auth = context;
        next();
      })
      .catch((error) => {
        // Treat resolution failures as unauthenticated; do not leak details.
        console.error("auth.resolve_failed", { message: error instanceof Error ? error.message : "unknown" });
        next();
      });
  };
}

export function requireSession(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.auth) {
    next();
    return;
  }
  if (wantsJson(req)) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  loginRedirect(req, res);
}

export function requireOrgMembership(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!req.auth) {
    requireSession(req, res, next);
    return;
  }
  if (!req.auth.membership || req.auth.membership.status !== "active" || !req.auth.organization) {
    res.status(403).json({ error: "Active workspace membership required." });
    return;
  }
  next();
}

export function requireRole(minimum: Role): express.RequestHandler {
  return (req, res, next) => {
    if (!req.auth) {
      requireSession(req, res, next);
      return;
    }
    const role = req.auth.membership?.role;
    if (!role || req.auth.membership?.status !== "active" || ROLE_RANK[role] < ROLE_RANK[minimum]) {
      res.status(403).json({ error: "Insufficient permissions for this workspace." });
      return;
    }
    next();
  };
}

// Pure authorization predicate used to scope SQLite model access by workspace.
// A model with no organization_id (not yet assigned) is only accessible when the
// caller has no active org context (i.e. accounts are disabled). Once a caller
// has an org, the model's organization_id must match exactly.
export function authorizeModelForOrg(
  model: { organization_id?: string | null },
  organizationId: string | null | undefined
): boolean {
  if (!organizationId) return true; // accounts disabled / no scoping
  return model.organization_id === organizationId;
}
