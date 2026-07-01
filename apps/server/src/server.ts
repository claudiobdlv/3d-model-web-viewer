import fs from "node:fs";
import path from "node:path";
import express from "express";
import crypto from "node:crypto";
import {
  db,
  createPublicShare,
  getActivePublicShareForModel,
  getModelById,
  getModelBySlug,
  getCurrentRevisionForModel,
  getRevisionForModel,
  listRevisionsForModel,
  getActiveRevisionFileVersion,
  getStorageQuota,
  initDb,
  recordPublicShareAccess,
  revokePublicSharesForModel,
  resolvePublicShareRevision,
  updatePublicShareSettings,
  type ModelRecord,
  type ModelRevisionRecord,
  type PublicShareLinkMode,
  type PublicShareRecord
} from "./db.js";
import {
  generatePublicToken,
  hashPublicToken,
  isValidPublicToken,
  publicShareUrl
} from "./publicShares.js";
import { foldersRouter } from "./routes/folders.js";
import { jobsRouter } from "./routes/jobs.js";
import { modelsRouter } from "./routes/models.js";
import { projectsRouter } from "./routes/projects.js";
import { workerRouter } from "./routes/worker.js";
import { uploadsRouter } from "./routes/uploads.js";
import {
  ensureStorage,
  getLogDir,
  getModelDir,
  getUploadDir,
  getWorkerOutputDir,
  getRevisionLogDir,
  getRevisionVersionLogDir,
  isSafeSlug,
  publicRoot,
  webRoot,
  cleanAbandonedChunkedUploads,
  resolveDisplayGlbPath,
  resolveSourcePath
} from "./storage.js";
import { isDxfUploadEnabled } from "./featureFlags.js";
import { renderPrivacyPage, renderSecurityPage } from "./publicPages.js";
import {
  createAuthSubsystem,
  authorizeModelAccess,
  type Role,
  READ_ROLE,
  SOURCE_DOWNLOAD_ROLE,
  DIAGNOSTIC_ROLE,
  MUTATE_ROLE
} from "./auth/index.js";

const port = Number(process.env.PORT || 3009);
export const app = express();

ensureStorage();
cleanAbandonedChunkedUploads();
initDb();

// Accounts subsystem (feature-flagged via AUTH_ENABLED; default off → legacy
// Basic-auth admin path and existing SQLite flows are unchanged in production).
const auth = createAuthSubsystem();
if (auth.enabled) {
  await auth.migrate();
}
// Flag-aware admin guard: session-based when accounts are on, legacy otherwise.
const adminGuard = auth.adminGuard(legacyRequireAdmin);
// Exposed for integration tests to mint sessions without a live OAuth provider.
export const authSubsystem = auth;

app.use(express.json());
// Expose the accounts-enabled flag on every request so the central
// authorization helpers fail closed under AUTH_ENABLED=true and pass through
// unchanged (legacy single-tenant behaviour) when disabled.
app.use((req, _res, next) => {
  req.authEnabled = auth.enabled;
  next();
});
// Resolve the session cookie into req.auth before any route runs (no-op when off).
if (auth.enabled && auth.attach) app.use(auth.attach);
// Public, no-login auth routes (/login, /auth/*, /api/me) when accounts are on.
if (auth.enabled && auth.router) app.use(auth.router);

const frontendRoot = fs.existsSync(path.join(webRoot, "index.html")) ? webRoot : publicRoot;
app.use((req, res, next) => {
  const protectedShells = new Set(["/index.html", "/admin.html", "/model.html", "/admin.js", "/model.js"]);
  if (protectedShells.has(req.path)) {
    requireAdmin(req, res, next);
    return;
  }
  next();
});
app.use(express.static(frontendRoot, { index: false }));

if (!process.env.ADMIN_PASSWORD) {
  console.warn("ADMIN_PASSWORD is not set. Admin upload routes are unprotected in this local/development process.");
}

// Flag-aware admin guard used by all private/admin routes. Delegates to the
// session-based workspace guard when accounts are enabled, otherwise to the
// legacy Basic-auth check below (unchanged production behavior).
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (auth.enabled) {
    adminGuard(req, res, next);
    return;
  }
  legacyRequireAdmin(req, res, next);
}

function legacyRequireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    next();
    return;
  }

  const header = req.header("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const submitted = separator >= 0 ? decoded.slice(separator + 1) : "";
    if (submitted === password) {
      next();
      return;
    }
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="3D Viewer Admin"');
  res.status(401).send("Admin password required.");
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "3d-model-web-viewer" });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "3d-model-web-viewer" });
});

app.get("/api/config", requireAdmin, (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ features: { dxfUploadEnabled: isDxfUploadEnabled() } });
});

app.get("/admin", requireAdmin, (_req, res) => {
  res.sendFile(path.join(frontendRoot, frontendRoot === webRoot ? "index.html" : "admin.html"));
});

app.get("/", (_req, res) => {
  res.redirect(302, "/admin");
});

// Static informational pages, always available regardless of AUTH_ENABLED —
// they carry no account data and are linked from the (feature-flagged)
// /login page once accounts are turned on.
app.get("/privacy", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.type("html").send(renderPrivacyPage());
});

app.get("/security", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.type("html").send(renderSecurityPage());
});

// Resolve the model targeted by a /api/models/:id/share route and enforce that
// the caller owns it within their active workspace and holds a role that may
// manage shares (finding 1). Returns null (after sending the response) on any
// failure so a cross-organization caller can neither read nor mutate shares for
// another workspace's model, and cannot even confirm the model exists.
function requireShareModel(req: express.Request, res: express.Response): ModelRecord | null {
  const modelId = Number(req.params.id);
  const model = Number.isInteger(modelId) ? getModelById(modelId) : undefined;
  const access = authorizeModelAccess(req, model, MUTATE_ROLE);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return null;
  }
  return model as ModelRecord;
}

app.get("/api/models/:id/share", requireAdmin, (req, res) => {
  const model = requireShareModel(req, res);
  if (!model) return;
  const share = getActivePublicShareForModel(model.id);
  res.json(share ? publicShareSettingsResponse(share) : { active: false });
});

app.post("/api/models/:id/share", requireAdmin, (req, res) => {
  const model = requireShareModel(req, res);
  if (!model) return;

  const activeShare = getActivePublicShareForModel(model.id);
  let settings: ReturnType<typeof parsePublicShareSettings>;
  try {
    settings = parsePublicShareSettings(model.id, req.body, activeShare);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid share settings." });
    return;
  }
  const linkedRevision = settings.linkMode === "locked_revision"
    ? getRevisionForModel(model.id, settings.revisionId!)
    : getCurrentRevisionForModel(model.id);
  if (!linkedRevision || linkedRevision.deleted_at || linkedRevision.status !== "ready") {
    res.status(409).json({
      error: settings.linkMode === "latest_current"
        ? "A ready current revision is required for a latest/current share."
        : "The selected locked revision must be ready."
    });
    return;
  }
  const glbPath = resolveDisplayGlbPath(model, linkedRevision);
  if (!fs.existsSync(glbPath)) {
    res.status(409).json({ error: "The selected revision does not have an available display GLB." });
    return;
  }

  const token = activeShare?.public_token || generatePublicToken();
  let share: PublicShareRecord;
  if (!activeShare) {
    share = createPublicShare({
      id: crypto.randomUUID(),
      modelId: model.id,
      tokenHash: hashPublicToken(token),
      tokenPrefix: token.slice(0, 8),
      publicToken: token,
      linkMode: settings.linkMode,
      revisionId: settings.revisionId,
      allowRevisionSwitching: settings.allowRevisionSwitching
    });
  } else {
    share = updatePublicShareSettings(activeShare.id, settings) ?? activeShare;
  }
  res.status(activeShare ? 200 : 201).json({
    ...publicShareSettingsResponse(share),
    model: { id: model.id, slug: model.slug, name: model.name },
    reused: Boolean(activeShare)
  });
});

app.delete("/api/models/:id/share", requireAdmin, (req, res) => {
  const model = requireShareModel(req, res);
  if (!model) return;
  res.json({ ok: true, revoked: revokePublicSharesForModel(model.id) });
});

app.patch("/api/models/:id/share", requireAdmin, (req, res) => {
  const model = requireShareModel(req, res);
  if (!model) return;
  const share = getActivePublicShareForModel(model.id);
  if (!share) {
    res.status(404).json({ error: "Active public share not found." });
    return;
  }
  try {
    const settings = parsePublicShareSettings(model.id, req.body, share);
    const linkedRevision = settings.linkMode === "locked_revision"
      ? getRevisionForModel(model.id, settings.revisionId!)
      : getCurrentRevisionForModel(model.id);
    if (!linkedRevision || linkedRevision.deleted_at || linkedRevision.status !== "ready") {
      res.status(409).json({ error: "The share must resolve to a ready revision." });
      return;
    }
    if (!fs.existsSync(resolveDisplayGlbPath(model, linkedRevision))) {
      res.status(409).json({ error: "The selected revision does not have an available display GLB." });
      return;
    }
    const updated = updatePublicShareSettings(share.id, settings);
    res.json(publicShareSettingsResponse(updated ?? share));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid share settings." });
  }
});

// Folders, projects, jobs, and the storage quota are global (no organization
// scoping column) in the legacy SQLite schema. Phase 1 does not migrate them to
// be multi-tenant, so rather than leak cross-workspace data we deny these routes
// entirely while accounts are enabled (finding 5). With AUTH_ENABLED=false the
// existing global behaviour is preserved unchanged.
function workspaceUnavailable(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.authEnabled) {
    res.status(403).json({ error: "This area is not yet available in workspace (accounts) mode." });
    return;
  }
  next();
}

app.use("/api/models", requireAdmin, modelsRouter);
app.use("/api/uploads/chunked", requireAdmin, uploadsRouter);
app.use("/api/folders", requireAdmin, workspaceUnavailable, foldersRouter);
app.use("/api/projects", requireAdmin, workspaceUnavailable, projectsRouter);
app.get("/api/storage/quota", requireAdmin, workspaceUnavailable, (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(getStorageQuota());
});
app.use("/api/jobs", requireAdmin, workspaceUnavailable, jobsRouter);
app.use("/api/worker", workerRouter);

app.get("/3dviewer/:slug", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  if (!isSafeSlug(slug)) {
    res.status(400).send("Invalid model slug.");
    return;
  }

  res.sendFile(path.join(frontendRoot, frontendRoot === webRoot ? "index.html" : "model.html"));
});

// Resolve the model behind an artifact/file route and enforce workspace
// ownership + role (finding 4). There is NO filesystem fallback: if the model
// row is absent (never existed, or was deleted/trashed) the request 404s, so a
// deleted or orphaned slug can never serve a GLB, source file, log, or report.
function requireArtifactModel(
  req: express.Request,
  res: express.Response,
  slug: string,
  minimumRole: Role
): ModelRecord | null {
  if (!isSafeSlug(slug)) {
    res.status(404).send("Not found");
    return null;
  }
  const model = getModelBySlug(slug);
  const access = authorizeModelAccess(req, model, minimumRole);
  if (!access.ok) {
    res.status(access.status).send(access.error);
    return null;
  }
  return model as ModelRecord;
}

app.get("/model-files/:slug/:file", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  const file = String(req.params.file);
  const allowedFiles = new Set(["display.glb", "manifest.json", "stats.json", "xcaf-report.json", "mesh-report.json"]);

  if (!allowedFiles.has(file)) {
    res.status(404).send("Not found");
    return;
  }

  const model = requireArtifactModel(req, res, slug, READ_ROLE);
  if (!model) return;

  const resolved = resolveAdminRevision(model.id, req.query.revisionId);
  if (resolved.invalid) {
    res.status(404).send("Not found");
    return;
  }
  const revision = resolved.revision;
  const filePath = file === "display.glb"
    ? resolveDisplayGlbPath({ slug }, revision)
    : path.join(revision ? path.dirname(resolveDisplayGlbPath({ slug }, revision)) : getModelDir(slug), file);
  if (!fs.existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }

  res.sendFile(filePath);
});

app.get("/downloads/:slug/original", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  // Source (STEP/STP) download is gated behind member+; viewers cannot pull the
  // original source file (finding 3).
  const model = requireArtifactModel(req, res, slug, SOURCE_DOWNLOAD_ROLE);
  if (!model) return;

  const { revision, invalid } = resolveAdminRevision(model.id, req.query.revisionId);
  if (invalid) {
    res.status(404).send("Revision not found.");
    return;
  }
  const sourcePath = resolveSourcePath(model, revision);
  if (!fs.existsSync(sourcePath)) {
    res.status(404).send("Not found");
    return;
  }
  res.download(sourcePath, revision?.source_filename || model.source_filename);
});

app.get("/downloads/:slug/display.glb", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  const model = requireArtifactModel(req, res, slug, READ_ROLE);
  if (!model) return;

  const resolved = resolveAdminRevision(model.id, req.query.revisionId);
  if (resolved.invalid) {
    res.status(404).send("Revision not found.");
    return;
  }
  const revision = resolved.revision;
  const filePath = resolveDisplayGlbPath({ slug }, revision);
  if (!fs.existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }

  res.download(filePath, `${slug}.glb`);
});

app.get("/admin/logs/:slug/conversion.log", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  // Diagnostic artifacts require workspace membership + member role (finding 4).
  const model = requireArtifactModel(req, res, slug, DIAGNOSTIC_ROLE);
  if (!model) return;

  const resolved = resolveAdminRevision(model.id, req.query.revisionId);
  if (resolved.invalid) {
    res.status(404).send("Revision not found.");
    return;
  }
  const revision = resolved.revision;
  const fileVersion = revision ? getActiveRevisionFileVersion(revision.id) : undefined;
  const currentLogDir = revision
    ? fileVersion && fileVersion.file_version_number > 1
      ? getRevisionVersionLogDir(slug, revision.id, fileVersion.file_version_number)
      : getRevisionLogDir(slug, revision.id)
    : getLogDir(slug);
  const filePath = [
    path.join(currentLogDir, "conversion.log"),
    path.join(getWorkerOutputDir(slug), "conversion.log")
  ].find((candidate) => fs.existsSync(candidate));

  if (!filePath) {
    res.type("text/plain").send(`No conversion log is available for "${slug}".`);
    return;
  }

  res.type("text/plain").sendFile(filePath);
});

// Serve a per-model diagnostic JSON report (material/XCAF/mesh) after enforcing
// workspace ownership + diagnostic role. Returns null (response already sent) on
// any authorization or resolution failure.
function sendDiagnosticReport(req: express.Request, res: express.Response, reportFile: string): void {
  const slug = String(req.params.slug);
  const model = requireArtifactModel(req, res, slug, DIAGNOSTIC_ROLE);
  if (!model) return;

  const artifactDir = getArtifactDir(model, req.query.revisionId);
  if (!artifactDir) {
    res.status(404).send("Revision not found.");
    return;
  }
  const filePath = path.join(artifactDir, reportFile);
  if (!fs.existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }
  res.type("application/json").sendFile(filePath);
}

app.get("/admin/models/:slug/material-debug.json", requireAdmin, (req, res) => {
  sendDiagnosticReport(req, res, "material-debug.json");
});

app.get("/admin/models/:slug/xcaf-report.json", requireAdmin, (req, res) => {
  sendDiagnosticReport(req, res, "xcaf-report.json");
});

app.get("/admin/models/:slug/mesh-report.json", requireAdmin, (req, res) => {
  sendDiagnosticReport(req, res, "mesh-report.json");
});

app.use("/public/assets", express.static(path.join(frontendRoot, "assets"), {
  fallthrough: false,
  immutable: true,
  maxAge: "1y"
}));

app.get("/public/:token/model.json", (req, res) => {
  const token = String(req.params.token);
  const share = resolvePublicShare(token, req.query.revisionId);
  if (!share) {
    sendPublicNotFound(res, false);
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.json({
    name: share.name,
    slug: share.slug,
    glb_url: publicAssetUrl(token, "model.glb", share.activeRevision?.id),
    default_view_json: share.default_view_json,
    activeRevision: share.activeRevision ? publicRevisionSummary(share.activeRevision) : null,
    revisions: share.revisions.map(publicRevisionSummary),
    allowRevisionSwitching: share.allowRevisionSwitching,
    invalidRevisionRequested: share.invalidRevisionRequested
  });
});

app.get("/public/:token/model.glb", (req, res) => {
  const share = resolvePublicShare(String(req.params.token), req.query.revisionId);
  if (!share) {
    sendPublicNotFound(res, false);
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.type("model/gltf-binary").sendFile(share.glbPath);
});

app.get("/public/:token", (req, res) => {
  const share = resolvePublicShare(String(req.params.token));
  if (!share) {
    sendPublicNotFound(res, true);
    return;
  }
  recordPublicShareAccess(share.share_id);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const shellPath = path.join(frontendRoot, frontendRoot === webRoot ? "index.html" : "model.html");
  const shell = fs.readFileSync(shellPath, "utf8").replaceAll('"/assets/', '"/public/assets/');
  res.type("html").send(shell);
});

function resolvePublicShare(token: string, requestedRevisionId?: unknown) {
  if (!isValidPublicToken(token)) return undefined;
  const tokenHash = hashPublicToken(token);
  const share = db.prepare("SELECT * FROM public_shares WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1").get(tokenHash) as PublicShareRecord | undefined;
  if (!share) return undefined;

  const linkedRevision = resolvePublicShareRevision(tokenHash);
  if (linkedRevision) {
    const model = getModelById(linkedRevision.model_id);
    if (!model) return undefined;
    const allowRevisionSwitching = Boolean(share.allow_revision_switching);
    const publicSelectable = allowRevisionSwitching
      ? listRevisionsForModel(model.id).filter((revision) => revision.is_publicly_selectable === 1 && revision.status === "ready")
      : [];
    const allowedRevisionIds = new Set([linkedRevision.id, ...publicSelectable.map((revision) => revision.id)]);
    const parsedRevisionId = parseRevisionId(requestedRevisionId);
    const requestedRevision = parsedRevisionId ? getRevisionForModel(model.id, parsedRevisionId) : undefined;
    const requestedAllowed = requestedRevision && allowedRevisionIds.has(requestedRevision.id);
    const activeRevision = requestedAllowed ? requestedRevision : linkedRevision;
    if (activeRevision.status !== "ready") return undefined;
    const glbPath = resolveDisplayGlbPath(model, activeRevision);
    if (!fs.existsSync(glbPath)) return undefined;
    return {
      share_id: share.id,
      name: model.name,
      slug: model.slug,
      default_view_json: model.default_view_json,
      glbPath,
      activeRevision,
      revisions: publicSelectable,
      allowRevisionSwitching,
      invalidRevisionRequested: requestedRevisionId !== undefined && !requestedAllowed
    };
  }

  // Legacy fallback
  const model = getModelById(share.model_id);
  if (!model || !["ready", "viewer-ready"].includes(model.status) || !model.has_display_glb) return undefined;
  const glbPath = path.join(getModelDir(model.slug), "display.glb");
  if (!fs.existsSync(glbPath)) return undefined;

  return {
    share_id: share.id,
    name: model.name,
    slug: model.slug,
    default_view_json: model.default_view_json,
    glbPath,
    activeRevision: null,
    revisions: [],
    allowRevisionSwitching: false,
    invalidRevisionRequested: requestedRevisionId !== undefined
  };
}

function sendPublicNotFound(res: express.Response, html: boolean): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!html) {
    res.status(404).json({ error: "Public model link not found or expired." });
    return;
  }
  res.status(404).type("html").send(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Model unavailable</title><body style="font:16px system-ui;background:#0b0d10;color:#f8fafc;display:grid;min-height:100vh;place-items:center;margin:0"><main style="text-align:center;padding:2rem"><h1>Model unavailable</h1><p>This public link is invalid, expired, or has been revoked.</p></main></body></html>'
  );
}

function getArtifactDir(model: Pick<ModelRecord, "id" | "slug">, revisionIdValue?: unknown): string | undefined {
  const resolved = resolveAdminRevision(model.id, revisionIdValue);
  if (resolved.invalid) return undefined;
  const revision = resolved.revision;
  return revision ? path.dirname(resolveDisplayGlbPath({ slug: model.slug }, revision)) : getModelDir(model.slug);
}

function resolveAdminRevision(modelId: number, revisionIdValue?: unknown): {
  revision?: ModelRevisionRecord;
  invalid?: boolean;
} {
  if (revisionIdValue === undefined || revisionIdValue === null || revisionIdValue === "") {
    return { revision: getCurrentRevisionForModel(modelId) };
  }
  const revisionId = parseRevisionId(revisionIdValue);
  if (!revisionId) return { invalid: true };
  const revision = getRevisionForModel(modelId, revisionId);
  return revision && !revision.deleted_at ? { revision } : { invalid: true };
}

function parseRevisionId(value: unknown): number | undefined {
  const scalar = Array.isArray(value) ? value[0] : value;
  if (typeof scalar !== "string" && typeof scalar !== "number") return undefined;
  const parsed = Number(scalar);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function publicRevisionSummary(revision: ModelRevisionRecord) {
  return {
    id: revision.id,
    revision_label: revision.revision_label,
    issued_date: revision.issued_date,
    status: revision.status,
    is_current: revision.is_current,
    is_publicly_selectable: revision.is_publicly_selectable
  };
}

function publicAssetUrl(token: string, asset: string, revisionId?: number): string {
  const base = `/public/${encodeURIComponent(token)}/${asset}`;
  return revisionId ? `${base}?revisionId=${revisionId}` : base;
}

function parsePublicShareSettings(
  modelId: number,
  body: Record<string, unknown> | undefined,
  existing?: PublicShareRecord
): {
  linkMode: PublicShareLinkMode;
  revisionId: number | null;
  allowRevisionSwitching: boolean;
} {
  const requestedMode = body?.linkMode;
  const existingMode = existing?.link_mode === "latest_current" ? "latest_current" : "locked_revision";
  const linkMode = requestedMode === undefined
    ? existingMode
    : requestedMode === "locked_revision" || requestedMode === "latest_current"
      ? requestedMode
      : (() => { throw new Error("linkMode must be locked_revision or latest_current."); })();

  const allowRevisionSwitching = body?.allowRevisionSwitching === undefined
    ? Boolean(existing?.allow_revision_switching)
    : typeof body.allowRevisionSwitching === "boolean"
      ? body.allowRevisionSwitching
      : (() => { throw new Error("allowRevisionSwitching must be true or false."); })();

  if (linkMode === "latest_current") {
    return { linkMode, revisionId: null, allowRevisionSwitching };
  }

  const requestedRevisionId = body?.revisionId === undefined
    ? existing?.revision_id ?? getCurrentRevisionForModel(modelId)?.id
    : parseRevisionId(body.revisionId);
  if (!requestedRevisionId) throw new Error("A locked revision is required.");
  const revision = getRevisionForModel(modelId, requestedRevisionId);
  if (!revision || revision.deleted_at) throw new Error("Locked revision not found for this model.");
  return { linkMode, revisionId: revision.id, allowRevisionSwitching };
}

function publicShareSettingsResponse(share: PublicShareRecord) {
  return {
    active: true,
    token: share.public_token ?? undefined,
    url: share.public_token ? publicShareUrl(share.public_token) : undefined,
    linkMode: share.link_mode === "latest_current" ? "latest_current" : "locked_revision",
    revisionId: share.revision_id ?? null,
    allowRevisionSwitching: Boolean(share.allow_revision_switching)
  };
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  const statusCode = typeof (err as { statusCode?: unknown })?.statusCode === "number"
    ? (err as { statusCode: number }).statusCode
    : 400;
  res.status(statusCode).send(message);
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`3D Viewer MVP server running at http://localhost:${port}`);
  });
}
