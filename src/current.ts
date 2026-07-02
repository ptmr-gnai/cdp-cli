import path from "node:path";
import fs from "fs-extra";
import { helpersForUrl } from "./actions.js";
import { findCurrentSnapshotDir, readNdjson } from "./refs.js";
import type { ArtifactMap, SnapshotMeta, TargetInfo } from "./types.js";

export interface CurrentSnapshotSummary {
  target: TargetInfo;
  current: {
    dir: string | null;
    meta: SnapshotMeta | null;
    artifacts: ArtifactMap;
    files: CurrentFileSummary[];
    counts: Record<string, number>;
    refs: CurrentRefSummary;
  };
  suggestedSearches: string[];
  nextCommands: string[];
}

export interface CurrentFileSummary {
  name: string;
  path: string;
  exists: boolean;
  bytes: number;
  lines?: number;
}

export interface CurrentRefSummary {
  firstVisibleControl?: CurrentRef;
  firstFillable?: CurrentRef;
  firstDialog?: CurrentRef;
  candidates: CurrentRefCandidate[];
}

export interface CurrentRef {
  ref: string;
  selector?: string;
  tag?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  rect?: CurrentRect | null;
}

export interface CurrentRefCandidate extends CurrentRef {
  score: number;
  reasons: string[];
}

interface CurrentRefRecord {
  ref?: string;
  selector?: string;
  tag?: string;
  text?: string;
  accessibleName?: string;
  visible?: boolean;
  attrs?: Record<string, unknown>;
  rect?: CurrentRect | null;
}

interface CurrentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const IMPORTANT_FILES = [
  "dump.txt",
  "visible-controls.ndjson",
  "controls.ndjson",
  "links.ndjson",
  "forms.ndjson",
  "dialogs.ndjson",
  "frames.ndjson",
  "resources.ndjson",
  "nodes.ndjson",
  "state.json",
  "text.md",
  "accessibility.json",
  "accessibility.txt",
  "dom.html",
  "helpers.json"
];

const COUNT_FILES: Record<string, string> = {
  nodes: "nodes.ndjson",
  visibleControls: "visible-controls.ndjson",
  controls: "controls.ndjson",
  links: "links.ndjson",
  forms: "forms.ndjson",
  dialogs: "dialogs.ndjson",
  frames: "frames.ndjson",
  resources: "resources.ndjson"
};

export async function readCurrentSnapshotSummary(outDir: string, target: TargetInfo): Promise<CurrentSnapshotSummary> {
  const currentDir = await findCurrentSnapshotDir(outDir, target);
  if (!currentDir) {
    return {
      target,
      current: {
        dir: null,
        meta: null,
        artifacts: {},
        files: [],
        counts: {},
        refs: { candidates: [] }
      },
      suggestedSearches: [],
      nextCommands: [
        `cdp-cli snapshot --target ${JSON.stringify(target.id)}`,
        `cdp-cli navigate https://example.com --target ${JSON.stringify(target.id)}`
      ]
    };
  }

  const meta = await readJsonFile<SnapshotMeta>(path.join(currentDir, "meta.json"));
  const artifacts = Object.fromEntries(IMPORTANT_FILES.map((file) => [file, path.join(currentDir, file)]));
  const files = await Promise.all(IMPORTANT_FILES.map((file) => summarizeFile(currentDir, file)));
  const counts = await countIndexes(currentDir);
  const refs = await summarizeRefs(currentDir);
  const grepFiles = [
    artifacts["dump.txt"],
    artifacts["visible-controls.ndjson"],
    artifacts["forms.ndjson"],
    artifacts["dialogs.ndjson"]
  ];

  return {
    target,
    current: {
      dir: currentDir,
      meta,
      artifacts,
      files,
      counts,
      refs
    },
    suggestedSearches: [
      `rg 'Search|Login|Submit|Continue|Next|button|input|dialog' ${shellBrace(grepFiles)}`,
      `rg '"ref":"n[0-9]+".*"visible":true|"tag":"(button|input|textarea|select|a)"' ${shellBrace([
        artifacts["visible-controls.ndjson"],
        artifacts["controls.ndjson"]
      ])}`,
      `rg 'role="dialog"|aria-modal|popover|modal|cookie|consent' ${shellBrace([
        artifacts["dump.txt"],
        artifacts["dialogs.ndjson"]
      ])}`
    ],
    nextCommands: nextCommands(target, refs)
  };
}

export function helpersForCurrent(summary: CurrentSnapshotSummary) {
  return helpersForUrl(summary.current.meta?.url ?? summary.target.url);
}

async function summarizeFile(currentDir: string, file: string): Promise<CurrentFileSummary> {
  const fullPath = path.join(currentDir, file);
  try {
    const stat = await fs.stat(fullPath);
    const lineCount = file.endsWith(".txt") || file.endsWith(".md") || file.endsWith(".ndjson")
      ? await countLines(fullPath)
      : undefined;
    return {
      name: file,
      path: fullPath,
      exists: stat.isFile(),
      bytes: stat.size,
      lines: lineCount
    };
  } catch {
    return { name: file, path: fullPath, exists: false, bytes: 0 };
  }
}

async function countIndexes(currentDir: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [name, file] of Object.entries(COUNT_FILES)) {
    let count = 0;
    for await (const _record of readNdjson(path.join(currentDir, file))) count += 1;
    counts[name] = count;
  }
  return counts;
}

async function summarizeRefs(currentDir: string): Promise<CurrentRefSummary> {
  const records: CurrentRefRecord[] = [];
  const summary: CurrentRefSummary = { candidates: [] };
  for await (const record of readNdjson<CurrentRefRecord>(path.join(currentDir, "visible-controls.ndjson"))) {
    if (!record.ref) continue;
    records.push(record);
    if (!summary.firstVisibleControl) summary.firstVisibleControl = currentRef(record);
    if (!summary.firstFillable && isFillable(record)) summary.firstFillable = currentRef(record);
  }
  summary.candidates = records
    .map(candidateRef)
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
    .slice(0, 8);
  summary.firstVisibleControl = summary.candidates.find((candidate) => !isFillable(candidate)) ?? summary.firstVisibleControl;
  summary.firstFillable = summary.candidates.find(isFillable) ?? summary.firstFillable;
  for await (const record of readNdjson<CurrentRefRecord>(path.join(currentDir, "dialogs.ndjson"))) {
    if (record.ref) {
      summary.firstDialog = currentRef(record);
      break;
    }
  }
  return summary;
}

function nextCommands(target: TargetInfo, refs: CurrentRefSummary): string[] {
  const suffix = ` --target ${JSON.stringify(target.id)}`;
  const commands = [`cdp-cli snapshot${suffix}`];
  if (refs.firstVisibleControl?.ref) commands.push(`cdp-cli click ${refs.firstVisibleControl.ref}${suffix}`);
  if (refs.firstFillable?.ref) commands.push(`cdp-cli fill ${refs.firstFillable.ref} 'text'${suffix}`);
  if (refs.firstDialog?.ref) commands.push(`cdp-cli press Escape${suffix}`);
  commands.push(`cdp-cli helpers list${suffix}`);
  return commands;
}

function currentRef(record: CurrentRefRecord): CurrentRef {
  return {
    ref: record.ref ?? "",
    selector: record.selector,
    tag: record.tag,
    text: bestLabel(record),
    attrs: record.attrs,
    rect: record.rect
  };
}

function candidateRef(record: CurrentRefRecord): CurrentRefCandidate {
  const reasons: string[] = [];
  const text = bestLabel(record);
  const tag = record.tag?.toLowerCase() ?? "";
  const href = String(record.attrs?.href ?? "");
  let score = 0;

  if (record.visible) {
    score += 10;
    reasons.push("visible");
  }
  if (text) {
    score += Math.min(20, text.length);
    reasons.push("has text");
  }
  if (["button", "input", "textarea", "select"].includes(tag)) {
    score += 18;
    reasons.push(`${tag} control`);
  }
  if (tag === "a") {
    score += 6;
    reasons.push("link");
  }
  if (isFillable(record)) {
    score += 20;
    reasons.push("fillable");
  }
  if (/\b(search|submit|continue|next|login|sign in|save|send|post|apply)\b/i.test(text)) {
    score += 16;
    reasons.push("action text");
  }
  if (/\b(search|q|query|email|username|password)\b/i.test(String(record.attrs?.name ?? "") + " " + String(record.attrs?.placeholder ?? "") + " " + String(record.accessibleName ?? ""))) {
    score += 12;
    reasons.push("input hint");
  }
  if (!text && tag === "a") {
    score -= 10;
    reasons.push("empty link text");
  }
  if (tag === "a" && /^(#|javascript:|void\(0\)|)$/.test(href)) {
    score -= 6;
    reasons.push("weak href");
  }
  if (/\b(upvote|hide|logo|avatar|icon|rss)\b/i.test(text + " " + href)) {
    score -= 12;
    reasons.push("low-value chrome");
  }
  if (record.rect && record.rect.y > 800) {
    const penalty = Math.min(20, Math.floor((record.rect.y - 800) / 50) + 1);
    score -= penalty;
    reasons.push("below fold");
  }

  return {
    ...currentRef(record),
    score,
    reasons
  };
}

function isFillable(record: CurrentRefRecord): boolean {
  const tag = record.tag?.toLowerCase();
  const type = String(record.attrs?.type ?? "").toLowerCase();
  return tag === "textarea" || tag === "select" || tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "hidden"].includes(type);
}

function cleanText(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function bestLabel(record: CurrentRefRecord): string {
  return cleanText(record.accessibleName || record.text);
}

async function countLines(file: string): Promise<number> {
  const text = await fs.readFile(file, "utf8");
  if (!text) return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return await fs.readJson(file) as T;
  } catch {
    return null;
  }
}

function shellBrace(files: string[]): string {
  const unique = [...new Set(files)];
  if (unique.length === 1) return shellQuote(unique[0]);
  const dir = path.dirname(unique[0]);
  if (unique.every((file) => path.dirname(file) === dir)) {
    return `${shellQuote(dir)}/{${unique.map((file) => path.basename(file)).join(",")}}`;
  }
  return unique.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
