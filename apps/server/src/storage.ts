import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const appRoot = path.resolve(__dirname, "..");
export const storageRoot = path.resolve(process.env.DATA_DIR || path.join(appRoot, "storage"));
export const dbRoot = path.join(storageRoot, "db");
export const uploadsRoot = path.join(storageRoot, "uploads");
export const modelsRoot = path.join(storageRoot, "models");
export const logsRoot = path.join(storageRoot, "logs");
export const workerOutputRoot = path.resolve(process.env.WORKER_OUTPUT_DIR || path.join(storageRoot, "worker-output"));
export const publicRoot = path.join(appRoot, "public");
export const webRoot = path.resolve(process.env.WEB_ROOT || path.join(appRoot, "..", "web", "dist"));
export const chunkedUploadsRoot = path.join(storageRoot, "tmp", "chunked-uploads");

export function ensureStorage(): void {
  fs.mkdirSync(dbRoot, { recursive: true });
  fs.mkdirSync(uploadsRoot, { recursive: true });
  fs.mkdirSync(modelsRoot, { recursive: true });
  fs.mkdirSync(logsRoot, { recursive: true });
  fs.mkdirSync(workerOutputRoot, { recursive: true });
  fs.mkdirSync(chunkedUploadsRoot, { recursive: true });
}

export function cleanAbandonedChunkedUploads(): void {
  try {
    if (!fs.existsSync(chunkedUploadsRoot)) return;
    const dirs = fs.readdirSync(chunkedUploadsRoot);
    const now = Date.now();
    const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
    for (const dir of dirs) {
      const dirPath = path.join(chunkedUploadsRoot, dir);
      const stat = fs.statSync(dirPath);
      if (stat.isDirectory() && now - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log(`Cleaned up abandoned chunked upload directory: ${dir}`);
      }
    }
  } catch (error) {
    console.error("Error cleaning abandoned chunked uploads:", error);
  }
}

export function createSlug(filename: string): string {
  const parsed = path.parse(filename);
  const base = parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);

  return `${base || "model"}-${stamp}`;
}

export function getUploadDir(slug: string): string {
  return path.join(uploadsRoot, slug);
}

export function getModelDir(slug: string): string {
  return path.join(modelsRoot, slug);
}

export function getLogDir(slug: string): string {
  return path.join(logsRoot, slug);
}

export function getWorkerOutputDir(slug: string): string {
  return path.join(workerOutputRoot, slug);
}

export function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}
