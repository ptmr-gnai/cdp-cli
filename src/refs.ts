import path from "node:path";
import fs from "fs-extra";
import { targetDir } from "./snapshot.js";
import type { TargetInfo } from "./types.js";

interface RefRecord {
  ref?: string;
  selector?: string;
  text?: string;
  tag?: string;
  visible?: boolean;
  attrs?: Record<string, unknown>;
}

export interface ResolvedRef {
  input: string;
  selector: string;
  ref?: string;
  source?: string;
  record?: RefRecord;
}

const REF_PATTERN = /^(?:ref:)?(n\d{6})$/i;

export async function resolveSelectorRef(
  outDir: string,
  target: TargetInfo,
  input: string
): Promise<ResolvedRef> {
  const ref = normalizeRef(input);
  if (!ref) return { input, selector: input };

  const currentDir = await findCurrentSnapshotDir(outDir, target);
  if (!currentDir) {
    throw new Error(
      `No current snapshot files found for target ${target.id}. Run cdp-cli snapshot first, then use ${ref}.`
    );
  }

  const indexed = await findIndexedRef(currentDir, ref);
  if (indexed?.selector) return indexed;

  const dumped = await findDumpRef(currentDir, ref);
  if (dumped?.selector) return dumped;

  throw new Error(`No selector for ${ref} in ${currentDir}. Re-run snapshot to refresh refs.`);
}

function normalizeRef(input: string): string | undefined {
  return input.match(REF_PATTERN)?.[1].toLowerCase();
}

async function findCurrentSnapshotDir(outDir: string, target: TargetInfo): Promise<string | undefined> {
  const direct = path.join(targetDir(outDir, target), "current");
  if (await fs.pathExists(direct)) return direct;

  const targetsDir = path.join(outDir, "targets");
  if (!(await fs.pathExists(targetsDir))) return undefined;
  const entries = await fs.readdir(targetsDir);
  const candidates: Array<{ dir: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(`-${target.id}`)) continue;
    const dir = path.join(targetsDir, entry, "current");
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) candidates.push({ dir, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore stale target folders.
    }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.dir;
}

async function findIndexedRef(currentDir: string, ref: string): Promise<ResolvedRef | undefined> {
  for (const file of ["visible-controls.ndjson", "controls.ndjson", "links.ndjson", "dialogs.ndjson", "forms.ndjson"]) {
    const fullPath = path.join(currentDir, file);
    for await (const record of readNdjson<RefRecord>(fullPath)) {
      if (record.ref?.toLowerCase() === ref && record.selector) {
        return { input: ref, ref, selector: record.selector, source: fullPath, record };
      }
    }
  }
  return undefined;
}

async function findDumpRef(currentDir: string, ref: string): Promise<ResolvedRef | undefined> {
  const dumpPath = path.join(currentDir, "dump.txt");
  if (!(await fs.pathExists(dumpPath))) return undefined;
  const lines = (await fs.readFile(dumpPath, "utf8")).split("\n");
  const line = lines.find((candidate) => candidate.includes(`[${ref}]`));
  if (!line) return undefined;
  const selector = parseDumpSelector(line);
  return selector ? { input: ref, ref, selector, source: dumpPath } : undefined;
}

function parseDumpSelector(line: string): string | undefined {
  const match = line.match(/\sselector=("(?:\\.|[^"\\])*")/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}

async function* readNdjson<T>(file: string): AsyncGenerator<T> {
  if (!(await fs.pathExists(file))) return;
  const text = await fs.readFile(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    yield JSON.parse(line) as T;
  }
}
