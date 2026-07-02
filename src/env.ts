import path from "node:path";
import process from "node:process";

export const DEFAULT_BROWSER_URL = "http://127.0.0.1:9222";
export const DEFAULT_OUT_DIR = ".cdp-cli";

export function resolveOutDir(outDir: string): string {
  return path.resolve(process.cwd(), outDir);
}

export function nowStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function sanitizeFilePart(input: string): string {
  return input
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "page";
}
