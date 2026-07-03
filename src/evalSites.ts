import fs from "fs-extra";
import path from "node:path";
import { closeClient, closeTarget, connectTarget, createTarget, waitForLoad } from "./cdp.js";
import { readNdjson } from "./refs.js";
import { writeSnapshot } from "./snapshot.js";
import { errorMessage } from "./trace.js";
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
  coverage: EvalSiteCoverage;
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
    scripts: number;
    openShadowRoots: number;
  };
  suggestedSearches: string[];
  warnings: string[];
}

export interface EvalSiteCoverage {
  filesReady: boolean;
  dumpNavigable: boolean;
  pageReady: boolean;
  challengeLikely: boolean;
  loadingShellLikely: boolean;
  grepReady: boolean;
  actionReady: boolean;
  accessibilityReady: boolean;
  networkReady: boolean;
  frameCoverage: boolean;
  shadowCoverage: boolean;
  dialogCoverage: boolean;
}

export interface EvalSiteSummaryRow {
  id: string;
  ok: boolean;
  url: string;
  snapshotDir?: string;
  counts?: EvalSiteQuality["counts"];
  dumpSections?: Record<string, boolean>;
  coverage?: EvalSiteCoverage;
  warnings: string[];
  suggestedSearches: string[];
  error?: string;
}

interface EvalSnapshotState {
  url?: string;
  title?: string;
  readyState?: string;
  activeElement?: {
    text?: string;
  };
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
        error: errorMessage(error)
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
          currentResult.closeError = errorMessage(error);
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
    coverage: result.quality?.coverage,
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
  const state = await readJsonFile<EvalSnapshotState>(path.join(snapshotDir, "state.json"));
  const meta = await readJsonFile<EvalSnapshotState>(path.join(snapshotDir, "meta.json"));
  const challengeText = await readChallengeText(snapshotDir);
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
    scripts: await countNdjson(path.join(snapshotDir, "scripts.ndjson")),
    openShadowRoots: await countPattern(path.join(snapshotDir, "dump.txt"), "#shadow-root(open)")
  };
  const coverage = qualityCoverage(requiredFiles, dumpSections, counts, state, meta, challengeText);
  const warnings = qualityWarnings(requiredFiles, dumpSections, counts, coverage, state);
  return {
    ok: warnings.length === 0,
    requiredFiles,
    dumpSections,
    coverage,
    counts,
    suggestedSearches: [
      `rg '^(PAGE|COUNTS|HELPERS|CONTROL|FORM|DIALOG|FRAME|RESOURCE|SCRIPT|A11Y)' '${snapshotDir}/dump.txt' '${snapshotDir}/accessibility.txt'`,
      `rg '#shadow-root|#frame|path="top >' '${snapshotDir}/dump.txt'`,
      `rg 'Search|Login|Submit|Continue|Next|button|input|dialog' '${snapshotDir}/dump.txt'`,
      `rg '\"ref\":\"n[0-9]+\"|\"selector\":|\"accessibleName\":' '${snapshotDir}/visible-controls.ndjson' '${snapshotDir}/controls.ndjson' '${snapshotDir}/forms.ndjson'`,
      `rg 'script|fetch|xmlhttprequest|navigation|resource' '${snapshotDir}/resources.ndjson' '${snapshotDir}/scripts.ndjson'`
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
    "scripts.ndjson",
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
    scripts: /^# scripts$/m.test(text),
    accessibility: /^# accessibility$/m.test(text),
    tree: /^# tree$/m.test(text)
  };
}

function qualityCoverage(
  requiredFiles: Record<string, boolean>,
  dumpSections: Record<string, boolean>,
  counts: EvalSiteQuality["counts"],
  state: EvalSnapshotState | null,
  meta: EvalSnapshotState | null,
  challengeText: string
): EvalSiteCoverage {
  const readyState = String(state?.readyState ?? "").toLowerCase();
  const url = String(state?.url ?? meta?.url ?? "");
  const title = String(state?.title ?? meta?.title ?? "");
  const activeText = String(state?.activeElement?.text ?? "");
  const challengeHaystack = `${url}\n${title}\n${activeText}\n${challengeText}`;
  const loadingShellLikely =
    /(?:role="progressbar"|aria-busy="true"|busy="1"|Loading[.\u2026]*|loading-spinner|initial-loading-spinner|skeleton)/i.test(challengeHaystack) &&
    !/loading="lazy"/i.test(challengeHaystack);
  return {
    filesReady: Object.values(requiredFiles).every(Boolean),
    dumpNavigable: Object.values(dumpSections).every(Boolean),
    pageReady: readyState === "complete" || readyState === "interactive",
    challengeLikely: /(?:captcha required|enter captcha|solve captcha|js_challenge|challenge\.js|challenge-platform|cdn-cgi\/challenge-platform|__CF\$cv|cf_chl|awswaf|aws-waf|not a robot|verify that you'?re not a robot|verification flow|blocked by)/i.test(challengeHaystack),
    loadingShellLikely,
    grepReady: counts.dumpLines >= 5 && counts.nodes > 0 && counts.textLines > 0,
    actionReady: counts.visibleControls > 0 || counts.links > 0 || counts.forms > 0,
    accessibilityReady: counts.accessibilityLines > 1,
    networkReady: counts.resources > 0 || counts.scripts > 0,
    frameCoverage: counts.frames > 0,
    shadowCoverage: counts.openShadowRoots > 0,
    dialogCoverage: counts.dialogs > 0
  };
}

function qualityWarnings(
  requiredFiles: Record<string, boolean>,
  dumpSections: Record<string, boolean>,
  counts: EvalSiteQuality["counts"],
  coverage: EvalSiteCoverage,
  state: EvalSnapshotState | null
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
  if (!coverage.actionReady) warnings.push("no visible controls, links, or forms were indexed");
  if (!coverage.accessibilityReady) warnings.push("accessibility.txt is too thin for a11y-first inspection");
  if (!coverage.networkReady) warnings.push("resources.ndjson and scripts.ndjson have no records");
  if (!coverage.pageReady) warnings.push(`page readyState is ${JSON.stringify(state?.readyState ?? null)}`);
  if (coverage.loadingShellLikely && (!coverage.grepReady || !coverage.actionReady)) {
    warnings.push("page looks stuck on a loading or skeleton shell");
  }
  if (coverage.challengeLikely && (!coverage.grepReady || !coverage.actionReady)) {
    warnings.push("page looks like a bot challenge, captcha, or verification flow");
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

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return await fs.readJson(file) as T;
  } catch {
    return null;
  }
}

async function readChallengeText(snapshotDir: string): Promise<string> {
  const files = ["dump.txt", "text.md", "resources.ndjson", "scripts.ndjson"];
  const chunks = await Promise.all(files.map(async (file) => {
    try {
      return (await fs.readFile(path.join(snapshotDir, file), "utf8")).slice(0, 50_000);
    } catch {
      return "";
    }
  }));
  return chunks.join("\n");
}
