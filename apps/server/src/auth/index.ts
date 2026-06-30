import type express from "express";
import { loadAuthConfig, type AuthConfig } from "./config.js";
import { AuthService } from "./service.js";
import { attachAuth, requireOrgMembership, requireSession } from "./middleware.js";
import { createAuthRouter } from "./routes.js";
import { MemoryAuthStore } from "./memoryStore.js";
import { PgAuthStore, createPool, runMigrations } from "./pgStore.js";
import type { AuthStore } from "./store.js";

export * from "./types.js";
export { loadAuthConfig, redirectUri } from "./config.js";
export { AuthService } from "./service.js";
export {
  attachAuth,
  requireSession,
  requireOrgMembership,
  requireRole,
  authorizeModelForOrg,
  parseCookies
} from "./middleware.js";
export {
  authorizeRole,
  authorizeModelAccess,
  authorizeUploadHandle,
  READ_ROLE,
  UPLOAD_ROLE,
  SOURCE_DOWNLOAD_ROLE,
  DIAGNOSTIC_ROLE,
  MUTATE_ROLE,
  type AccessResult
} from "./access.js";

export interface AuthSubsystem {
  enabled: boolean;
  config: AuthConfig;
  service?: AuthService;
  store?: AuthStore;
  attach?: express.RequestHandler;
  router?: express.Router;
  // Runs DB migrations when backed by Postgres; no-op otherwise.
  migrate(): Promise<void>;
  // Returns the middleware that guards admin/private routes. When accounts are
  // disabled it returns the supplied legacy guard so production is unchanged.
  adminGuard(legacy: express.RequestHandler): express.RequestHandler;
}

// Fail closed for insecure production session configuration (finding 7). When
// AUTH_ENABLED=true and NODE_ENV=production, secure cookies must be enabled
// (the app is expected to run behind HTTPS). ALLOW_INSECURE_SESSION=true is a
// documented escape hatch for non-HTTPS local/staging use only.
export function assertSecureProductionConfig(config: AuthConfig, env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== "production") return;
  const allowInsecure = /^(1|true|yes|on)$/i.test((env.ALLOW_INSECURE_SESSION || "").trim());
  if (!config.secureCookies && !allowInsecure) {
    throw new Error(
      "AUTH_ENABLED=true in production requires secure session cookies. " +
        "Set SESSION_COOKIE_SECURE=true (serve behind HTTPS), or set ALLOW_INSECURE_SESSION=true for a deliberate non-HTTPS override."
    );
  }
}

// Composes requireSession + requireOrgMembership into a single guard.
function sessionAdminGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  requireSession(req, res, (err?: unknown) => {
    if (err || res.headersSent) {
      if (err) next(err);
      return;
    }
    requireOrgMembership(req, res, next);
  });
}

export function createAuthSubsystem(config: AuthConfig = loadAuthConfig()): AuthSubsystem {
  if (!config.enabled) {
    return {
      enabled: false,
      config,
      async migrate() {
        /* accounts disabled: nothing to migrate */
      },
      adminGuard: (legacy) => legacy
    };
  }

  if (!config.sessionSecret) {
    throw new Error("AUTH_ENABLED=true requires SESSION_SECRET to be set.");
  }

  // Fail closed: an admin email allow-list is mandatory whenever accounts are
  // enabled. Without it, any verified Google account could create the first
  // admin workspace. Set AUTH_ALLOWED_EMAILS to a comma-separated list of the
  // Google admin emails permitted to sign in.
  if (config.allowedAdminEmails.length === 0) {
    throw new Error(
      "AUTH_ENABLED=true requires AUTH_ALLOWED_EMAILS to be set (comma-separated allow-list of admin Google emails)."
    );
  }

  // Deployment safety: in production we must fail closed when session cookies
  // would be transmitted insecurely (finding 7). A documented local override
  // exists for non-HTTPS development only.
  assertSecureProductionConfig(config, process.env);

  // Select the persistence backend. Postgres is required for production; an
  // in-memory store is allowed only for local development/testing of the flow.
  let store: AuthStore;
  let migrate: () => Promise<void>;
  if (config.databaseUrl) {
    // The pg driver is imported statically (no side effects); a pool/connection
    // is only ever created here, when a DATABASE_URL is configured.
    const pool = createPool(config.databaseUrl);
    store = new PgAuthStore(pool);
    migrate = async () => {
      const applied = await runMigrations(pool);
      if (applied.length) console.log(`auth.migrations_applied ${applied.join(", ")}`);
    };
  } else if (process.env.AUTH_STORE === "memory") {
    // The in-memory store is non-persistent and single-process: never allow it
    // to back a production deployment (finding 8).
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_STORE=memory is not permitted in production; configure DATABASE_URL (Postgres).");
    }
    store = new MemoryAuthStore();
    migrate = async () => {
      console.warn("auth.memory_store: using in-memory accounts store (non-persistent).");
    };
  } else {
    throw new Error("AUTH_ENABLED=true requires DATABASE_URL (or AUTH_STORE=memory for local dev).");
  }

  const service = new AuthService(store, {
    sessionTtlMs: config.sessionTtlMs,
    allowedEmails: config.allowedAdminEmails
  });
  return {
    enabled: true,
    config,
    service,
    store,
    attach: attachAuth(service, config),
    router: createAuthRouter(service, config),
    migrate,
    adminGuard: () => sessionAdminGuard
  };
}
