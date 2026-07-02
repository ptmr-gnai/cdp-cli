import fs from "fs-extra";
import { closeClient, closeTarget, connectTarget, createTarget, waitForLoad } from "./cdp.js";
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
  error?: string;
  closeError?: string;
}

export interface EvalSiteRunOptions {
  closeTargets?: boolean;
}

export const DEFAULT_EVAL_SITES: EvalSite[] = [
  { id: "wikipedia", url: "https://en.wikipedia.org/wiki/World_Wide_Web" },
  { id: "github", url: "https://github.com/ptmr-gnai/cdp-cli" },
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
      currentResult = {
        id: site.id,
        url: site.url,
        ok: true,
        targetId: connected.target.id,
        snapshotDir: snapshot.dir,
        artifacts: snapshot.artifacts,
        sizes: await artifactSizes(snapshot.artifacts)
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
