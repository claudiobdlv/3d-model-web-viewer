import fs from "node:fs";
import path from "node:path";
import express from "express";
import { initDb } from "./db.js";
import { jobsRouter } from "./routes/jobs.js";
import { modelsRouter } from "./routes/models.js";
import { workerRouter } from "./routes/worker.js";
import {
  ensureStorage,
  getModelDir,
  isSafeSlug,
  publicRoot
} from "./storage.js";

const port = Number(process.env.PORT || 3009);
const app = express();

ensureStorage();
initDb();

app.use(express.json());
app.use(express.static(publicRoot));

app.use("/api/models", modelsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/worker", workerRouter);

app.get("/3dviewer/:slug", (req, res) => {
  const { slug } = req.params;
  if (!isSafeSlug(slug)) {
    res.status(400).send("Invalid model slug.");
    return;
  }

  res.sendFile(path.join(publicRoot, "model.html"));
});

app.get("/model-files/:slug/:file", (req, res) => {
  const { slug, file } = req.params;
  const allowedFiles = new Set(["display.glb", "manifest.json", "stats.json"]);

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

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  res.status(400).send(message);
});

app.listen(port, () => {
  console.log(`3D Viewer MVP server running at http://localhost:${port}`);
});
