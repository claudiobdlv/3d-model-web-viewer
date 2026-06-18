import fs from "node:fs";
import path from "node:path";
import express from "express";
import { initDb } from "./db.js";
import { foldersRouter } from "./routes/folders.js";
import { jobsRouter } from "./routes/jobs.js";
import { modelsRouter } from "./routes/models.js";
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
const app = express();

ensureStorage();
initDb();

app.use(express.json());
const frontendRoot = fs.existsSync(path.join(webRoot, "index.html")) ? webRoot : publicRoot;
app.use(express.static(frontendRoot, { index: false }));
if (frontendRoot !== publicRoot) {
  app.use(express.static(publicRoot, { index: false }));
}

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

app.get("/api/models", requireAdmin);
app.post("/api/models", requireAdmin);
app.patch("/api/models/:slug/folder", requireAdmin);
app.patch("/api/models/:slug", requireAdmin);
app.delete("/api/models/:slug", requireAdmin);
app.use("/api/models", modelsRouter);
app.use("/api/folders", requireAdmin, foldersRouter);
app.use("/api/jobs", requireAdmin, jobsRouter);
app.use("/api/worker", workerRouter);

app.get("/3dviewer/:slug", (req, res) => {
  const { slug } = req.params;
  if (!isSafeSlug(slug)) {
    res.status(400).send("Invalid model slug.");
    return;
  }

  res.sendFile(path.join(frontendRoot, frontendRoot === webRoot ? "index.html" : "model.html"));
});

app.get("/model-files/:slug/:file", (req, res) => {
  const { slug, file } = req.params;
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

app.get("/downloads/:slug/original", (req, res) => {
  const { slug } = req.params;
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

app.get("/downloads/:slug/display.glb", (req, res) => {
  const { slug } = req.params;
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

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  res.status(400).send(message);
});

app.listen(port, () => {
  console.log(`3D Viewer MVP server running at http://localhost:${port}`);
});
