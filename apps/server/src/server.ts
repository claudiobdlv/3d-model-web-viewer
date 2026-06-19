import fs from "node:fs";
import path from "node:path";
import express from "express";
import crypto from "node:crypto";
import {
  createPublicShare,
  getActivePublicShareForModel,
  getModelById,
  getPublicShareModelByHash,
  getStorageQuota,
  initDb,
  recordPublicShareAccess,
  revokePublicSharesForModel
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
import {
  ensureStorage,
  getLogDir,
  getModelDir,
  getUploadDir,
  getWorkerOutputDir,
  isSafeSlug,
  publicRoot,
  webRoot
} from "./storage.js";

const port = Number(process.env.PORT || 3009);
export const app = express();

ensureStorage();
initDb();

app.use(express.json());
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

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
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

app.get("/admin", requireAdmin, (_req, res) => {
  res.sendFile(path.join(frontendRoot, frontendRoot === webRoot ? "index.html" : "admin.html"));
});

app.get("/", (_req, res) => {
  res.redirect(302, "/admin");
});

app.post("/api/models/:id/share", requireAdmin, (req, res) => {
  const modelId = Number(req.params.id);
  const model = Number.isInteger(modelId) ? getModelById(modelId) : undefined;
  if (!model) {
    res.status(404).json({ error: "Model not found." });
    return;
  }

  const glbPath = path.join(getModelDir(model.slug), "display.glb");
  if (!["ready", "viewer-ready"].includes(model.status) || !model.has_display_glb || !fs.existsSync(glbPath)) {
    res.status(409).json({ error: "Only viewer-ready models can be shared." });
    return;
  }

  const activeShare = getActivePublicShareForModel(model.id);
  const token = activeShare?.public_token || generatePublicToken();
  if (!activeShare) {
    createPublicShare({
      id: crypto.randomUUID(),
      modelId: model.id,
      tokenHash: hashPublicToken(token),
      tokenPrefix: token.slice(0, 8),
      publicToken: token
    });
  }
  res.status(activeShare ? 200 : 201).json({
    token,
    url: publicShareUrl(token),
    model: { id: model.id, slug: model.slug, name: model.name },
    reused: Boolean(activeShare)
  });
});

app.delete("/api/models/:id/share", requireAdmin, (req, res) => {
  const modelId = Number(req.params.id);
  const model = Number.isInteger(modelId) ? getModelById(modelId) : undefined;
  if (!model) {
    res.status(404).json({ error: "Model not found." });
    return;
  }
  res.json({ ok: true, revoked: revokePublicSharesForModel(model.id) });
});

app.use("/api/models", requireAdmin, modelsRouter);
app.use("/api/folders", requireAdmin, foldersRouter);
app.use("/api/projects", requireAdmin, projectsRouter);
app.get("/api/storage/quota", requireAdmin, (_req, res) => res.json(getStorageQuota()));
app.use("/api/jobs", requireAdmin, jobsRouter);
app.use("/api/worker", workerRouter);

app.get("/3dviewer/:slug", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  if (!isSafeSlug(slug)) {
    res.status(400).send("Invalid model slug.");
    return;
  }

  res.sendFile(path.join(frontendRoot, frontendRoot === webRoot ? "index.html" : "model.html"));
});

app.get("/model-files/:slug/:file", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  const file = String(req.params.file);
  const allowedFiles = new Set(["display.glb", "manifest.json", "stats.json", "xcaf-report.json"]);

  if (!isSafeSlug(slug) || !allowedFiles.has(file)) {
    res.status(404).send("Not found");
    return;
  }

  const filePath = path.join(getModelDir(slug), file);
  if (!fs.existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }

  res.sendFile(filePath);
});

app.get("/downloads/:slug/original", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  if (!isSafeSlug(slug)) {
    res.status(404).send("Not found");
    return;
  }

  const uploadDir = getUploadDir(slug);
  if (!fs.existsSync(uploadDir)) {
    res.status(404).send("Not found");
    return;
  }

  const original = fs.readdirSync(uploadDir, { withFileTypes: true })
    .find((entry) => entry.isFile() && /^original\.(step|stp|glb|gltf)$/i.test(entry.name));

  if (!original) {
    res.status(404).send("Not found");
    return;
  }

  res.download(path.join(uploadDir, original.name));
});

app.get("/downloads/:slug/display.glb", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  if (!isSafeSlug(slug)) {
    res.status(404).send("Not found");
    return;
  }

  const filePath = path.join(getModelDir(slug), "display.glb");
  if (!fs.existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }

  res.download(filePath, `${slug}.glb`);
});

app.get("/admin/logs/:slug/conversion.log", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  if (!isSafeSlug(slug)) {
    res.status(404).send("Not found");
    return;
  }

  const filePath = [
    path.join(getLogDir(slug), "conversion.log"),
    path.join(getWorkerOutputDir(slug), "conversion.log")
  ].find((candidate) => fs.existsSync(candidate));

  if (!filePath) {
    res.type("text/plain").send(`No conversion log is available for "${slug}".`);
    return;
  }

  res.type("text/plain").sendFile(filePath);
});

app.get("/admin/models/:slug/material-debug.json", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  if (!isSafeSlug(slug)) {
    res.status(404).send("Not found");
    return;
  }

  const filePath = path.join(getModelDir(slug), "material-debug.json");
  if (!fs.existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }

  res.type("application/json").sendFile(filePath);
});

app.get("/admin/models/:slug/xcaf-report.json", requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  if (!isSafeSlug(slug)) {
    res.status(404).send("Not found");
    return;
  }

  const filePath = path.join(getModelDir(slug), "xcaf-report.json");
  if (!fs.existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }

  res.type("application/json").sendFile(filePath);
});

app.use("/public/assets", express.static(path.join(frontendRoot, "assets"), {
  fallthrough: false,
  immutable: true,
  maxAge: "1y"
}));

app.get("/public/:token/model.json", (req, res) => {
  const token = String(req.params.token);
  const share = resolvePublicShare(token);
  if (!share) {
    sendPublicNotFound(res, false);
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.json({
    name: share.name,
    slug: share.slug,
    glb_url: `/public/${encodeURIComponent(token)}/model.glb`,
    default_view_json: share.default_view_json
  });
});

app.get("/public/:token/model.glb", (req, res) => {
  const share = resolvePublicShare(String(req.params.token));
  if (!share) {
    sendPublicNotFound(res, false);
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.type("model/gltf-binary").sendFile(path.join(getModelDir(share.slug), "display.glb"));
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

function resolvePublicShare(token: string) {
  if (!isValidPublicToken(token)) return undefined;
  const share = getPublicShareModelByHash(hashPublicToken(token));
  if (!share || !["ready", "viewer-ready"].includes(share.status) || !share.has_display_glb) return undefined;
  return fs.existsSync(path.join(getModelDir(share.slug), "display.glb")) ? share : undefined;
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

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  res.status(400).send(message);
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`3D Viewer MVP server running at http://localhost:${port}`);
  });
}
