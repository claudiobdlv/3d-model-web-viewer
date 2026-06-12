import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const appRoot = path.resolve(__dirname, "..");
export const storageRoot = path.join(appRoot, "storage");
export const uploadsRoot = path.join(storageRoot, "uploads");
export const modelsRoot = path.join(storageRoot, "models");
export const publicRoot = path.join(appRoot, "public");

export function ensureStorage(): void {
  fs.mkdirSync(uploadsRoot, { recursive: true });
  fs.mkdirSync(modelsRoot, { recursive: true });
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

export function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}
