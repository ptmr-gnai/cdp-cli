import path from "node:path";
import process from "node:process";
import os from "node:os";

export const DEFAULT_BROWSER_URL = "http://127.0.0.1:9222";
export const DEFAULT_OUT_DIR = ".cdp-cli";

export function defaultChromeUserDataDir(): string | undefined {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData ? path.join(localAppData, "Google", "Chrome", "User Data") : undefined;
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

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
