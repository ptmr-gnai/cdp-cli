import fs from "fs-extra";
import path from "node:path";
import { closeClient, closeTarget, connectTarget, createTarget, waitForLoad } from "./cdp.js";
import { readNdjson } from "./refs.js";
import { writeSnapshot } from "./snapshot.js";
import type { ArtifactMap, CliGlobalOptions } from "./types.js";

export interface EvalSite {
  id: string;
  url: string;
}

export interface EvalSiteResult {
  id: string;
  url: string;
  ok: boolean;
  targetId?: string;
  snapshotDir?: string;
  closed?: boolean;
  artifacts?: ArtifactMap;
  sizes?: Record<string, number>;
  quality?: EvalSiteQuality;
  error?: string;
  closeError?: string;
}

export interface EvalSiteRunOptions {
  closeTargets?: boolean;
}

export interface EvalSiteQuality {
  ok: boolean;
  requiredFiles: Record<string, boolean>;
  dumpSections: Record<string, boolean>;
  counts: {
    dumpLines: number;
    accessibilityLines: number;
    textLines: number;
    nodes: number;
    links: number;
    controls: number;
    visibleControls: number;
    forms: number;
    dialogs: number;
    frames: number;
    resources: number;
    openShadowRoots: number;
  };
  suggestedSearches: string[];
  warnings: string[];
}

export interface EvalSiteSummaryRow {
  id: string;
  ok: boolean;
  url: string;
  snapshotDir?: string;
  counts?: EvalSiteQuality["counts"];
  dumpSections?: Record<string, boolean>;
  warnings: string[];
  suggestedSearches: string[];
  error?: string;
}

export const DEFAULT_EVAL_SITES: EvalSite[] = [
  { id: "wikipedia", url: "https://en.wikipedia.org/wiki/World_Wide_Web" },
  { id: "github", url: "https://github.com/github/docs" },
  { id: "x-bookmarks", url: "https://x.com/i/bookmarks" },
  { id: "cnn", url: "https://www.cnn.com" },
  { id: "openai-docs", url: "https://developers.openai.com/codex/app" },
  { id: "news-ycombinator", url: "https://news.ycombinator.com" },
  { id: "mdn-form", url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form" },
  { id: "webcomponents", url: "https://mdn.github.io/web-components-examples/popup-info-box-web-component/" }
];

export async function runReadOnlyEvalSites(
  options: CliGlobalOptions,
  sites: EvalSite[],
  runOptions: EvalSiteRunOptions = {}
): Promise<EvalSiteResult[]> {
  const results: EvalSiteResult[] = [];
  const shouldCloseTargets = runOptions.closeTargets ?? true;

  for (const site of sites) {
    let client: Awaited<ReturnType<typeof connectTarget>>["client"] | undefined;
    let createdTargetId: string | undefined;
    let currentResult: EvalSiteResult | undefined;
    try {
      const target = await createTarget(options.browserUrl, site.url, options.userDataDir);
      createdTargetId = target.id;
      const connected = await connectTarget(options.browserUrl, target.id, options.userDataDir);
      client = connected.client;
      await waitForLoad(client, options.timeout);
      const snapshot = await writeSnapshot(client, {
        outDir: options.outDir,
        target: connected.target,
        label: `eval-${site.id}`,
        screenshot: options.screenshot
      });
      const quality = await evaluateSnapshotQuality(snapshot.dir);
      currentResult = {
        id: site.id,
        url: site.url,
        ok: quality.ok,
        targetId: connected.target.id,
        snapshotDir: snapshot.dir,
        artifacts: snapshot.artifacts,
        sizes: await artifactSizes(snapshot.artifacts),
        quality
      };
      results.push(currentResult);
    } catch (error) {
      currentResult = {
        id: site.id,
        url: site.url,
        ok: false,
        targetId: createdTargetId,
        error: error instanceof Error ? error.message : String(error)
      };
      results.push(currentResult);
    } finally {
      if (client) await closeClient(client);
      if (createdTargetId && shouldCloseTargets) {
        try {
          currentResult = currentResult ?? results[results.length - 1];
          currentResult.closed = await closeTarget(options.browserUrl, createdTargetId, options.userDataDir);
        } catch (error) {
          currentResult = currentResult ?? results[results.length - 1];
          currentResult.closed = false;
          currentResult.closeError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }

  return results;
}

export function parseEvalSites(values: string[] | undefined): EvalSite[] {
  if (!values?.length) return DEFAULT_EVAL_SITES;
  return values.map((value, index) => {
    const [id, ...urlParts] = value.includes("=") ? value.split("=") : [`site-${index + 1}`, value];
    const url = urlParts.join("=");
    return { id, url: url || value };
  });
}

export function summarizeEvalSiteResults(results: EvalSiteResult[]): {
  ok: number;
  failed: number;
  matrix: EvalSiteSummaryRow[];
  qualityWarnings: Array<{ id: string; warnings: string[] }>;
  failedRequiredFiles: Array<{ id: string; files: string[] }>;
  failedDumpSections: Array<{ id: string; sections: string[] }>;
} {
  const matrix = results.map((result): EvalSiteSummaryRow => ({
    id: result.id,
    ok: result.ok,
    url: result.url,
    snapshotDir: result.snapshotDir,
    counts: result.quality?.counts,
    dumpSections: result.quality?.dumpSections,
    warnings: result.quality?.warnings ?? (result.error ? [result.error] : []),
    suggestedSearches: result.quality?.suggestedSearches ?? [],
    error: result.error
  }));
  return {
    ok: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    matrix,
    qualityWarnings: matrix
      .filter((row) => row.warnings.length)
      .map((row) => ({ id: row.id, warnings: row.warnings })),
    failedRequiredFiles: results
      .map((result) => ({
        id: result.id,
        files: Object.entries(result.quality?.requiredFiles ?? {})
          .filter(([, present]) => !present)
          .map(([file]) => file)
      }))
      .filter((row) => row.files.length),
    failedDumpSections: results
      .map((result) => ({
        id: result.id,
        sections: Object.entries(result.quality?.dumpSections ?? {})
          .filter(([, present]) => !present)
          .map(([section]) => section)
      }))
      .filter((row) => row.sections.length)
  };
}

async function artifactSizes(artifacts: ArtifactMap): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const [name, file] of Object.entries(artifacts)) {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) sizes[name] = stat.size;
    } catch {
      // Ignore directories and optional files that were not produced.
    }
  }
  return sizes;
}

export async function evaluateSnapshotQuality(snapshotDir: string): Promise<EvalSiteQuality> {
  const requiredFiles = await requiredFilePresence(snapshotDir);
  const dumpSections = await dumpSectionPresence(path.join(snapshotDir, "dump.txt"));
  const counts = {
    dumpLines: await countLines(path.join(snapshotDir, "dump.txt")),
    accessibilityLines: await countLines(path.join(snapshotDir, "accessibility.txt")),
    textLines: await countLines(path.join(snapshotDir, "text.md")),
    nodes: await countNdjson(path.join(snapshotDir, "nodes.ndjson")),
    links: await countNdjson(path.join(snapshotDir, "links.ndjson")),
    controls: await countNdjson(path.join(snapshotDir, "controls.ndjson")),
    visibleControls: await countNdjson(path.join(snapshotDir, "visible-controls.ndjson")),
    forms: await countNdjson(path.join(snapshotDir, "forms.ndjson")),
    dialogs: await countNdjson(path.join(snapshotDir, "dialogs.ndjson")),
    frames: await countNdjson(path.join(snapshotDir, "frames.ndjson")),
    resources: await countNdjson(path.join(snapshotDir, "resources.ndjson")),
    openShadowRoots: await countPattern(path.join(snapshotDir, "dump.txt"), "#shadow-root(open)")
  };
  const warnings = qualityWarnings(requiredFiles, dumpSections, counts);
  return {
    ok: warnings.length === 0,
    requiredFiles,
    dumpSections,
    counts,
    suggestedSearches: [
      `rg '^(PAGE|COUNTS|HELPERS|CONTROL|FORM|DIALOG|FRAME|RESOURCE|A11Y)' '${snapshotDir}/dump.txt' '${snapshotDir}/accessibility.txt'`,
      `rg '#shadow-root|#frame|path="top >' '${snapshotDir}/dump.txt'`,
      `rg 'Search|Login|Submit|Continue|Next|button|input|dialog' '${snapshotDir}/dump.txt'`
    ],
    warnings
  };
}

async function requiredFilePresence(snapshotDir: string): Promise<Record<string, boolean>> {
  const required = [
    "meta.json",
    "state.json",
    "dump.txt",
    "text.md",
    "dom.html",
    "nodes.ndjson",
    "links.ndjson",
    "controls.ndjson",
    "visible-controls.ndjson",
    "forms.ndjson",
    "dialogs.ndjson",
    "frames.ndjson",
    "resources.ndjson",
    "accessibility.json",
    "accessibility.txt",
    "dom-snapshot.json",
    "helpers.json"
  ];
  const entries = await Promise.all(required.map(async (file) => {
    const fullPath = path.join(snapshotDir, file);
    try {
      const stat = await fs.stat(fullPath);
      return [file, stat.isFile()] as const;
    } catch {
      return [file, false] as const;
    }
  }));
  return Object.fromEntries(entries);
}

async function dumpSectionPresence(dumpPath: string): Promise<Record<string, boolean>> {
  let text = "";
  try {
    text = await fs.readFile(dumpPath, "utf8");
  } catch {
    // Missing dump.txt is reported by required file checks.
  }
  return {
    page: /^PAGE /m.test(text),
    counts: /^COUNTS /m.test(text),
    helpers: /^HELPERS /m.test(text),
    suggestedGrep: /^# suggested-grep$/m.test(text),
    visibleControls: /^# visible-controls$/m.test(text),
    forms: /^# forms$/m.test(text),
    dialogs: /^# dialogs$/m.test(text),
    frames: /^# frames$/m.test(text),
    resources: /^# resources$/m.test(text),
    accessibility: /^# accessibility$/m.test(text),
    tree: /^# tree$/m.test(text)
  };
}

function qualityWarnings(
  requiredFiles: Record<string, boolean>,
  dumpSections: Record<string, boolean>,
  counts: EvalSiteQuality["counts"]
): string[] {
  const warnings: string[] = [];
  for (const [file, present] of Object.entries(requiredFiles)) {
    if (!present) warnings.push(`missing required artifact: ${file}`);
  }
  for (const [section, present] of Object.entries(dumpSections)) {
    if (!present) warnings.push(`dump.txt missing section: ${section}`);
  }
  if (counts.dumpLines < 5) warnings.push(`dump.txt is too small: ${counts.dumpLines} lines`);
  if (counts.nodes < 1) warnings.push("nodes.ndjson has no records");
  if (counts.textLines < 1) warnings.push("text.md has no readable text lines");
  if (counts.visibleControls < 1 && counts.links < 1 && counts.forms < 1) {
    warnings.push("no visible controls, links, or forms were indexed");
  }
  return warnings;
}

async function countNdjson(file: string): Promise<number> {
  let count = 0;
  for await (const _record of readNdjson(file)) count += 1;
  return count;
}

async function countLines(file: string): Promise<number> {
  try {
    const text = await fs.readFile(file, "utf8");
    if (!text) return 0;
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return 0;
  }
}

async function countPattern(file: string, pattern: string): Promise<number> {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.split(pattern).length - 1;
  } catch {
    return 0;
  }
}
