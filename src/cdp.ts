import CDP from "chrome-remote-interface";
import { z } from "zod";
import type { TargetInfo } from "./types.js";

type CdpClient = Awaited<ReturnType<typeof CDP>>;

const VersionSchema = z.object({
  Browser: z.string().optional(),
  "Protocol-Version": z.string().optional(),
  "User-Agent": z.string().optional(),
  webSocketDebuggerUrl: z.string().optional()
});

export interface BrowserEndpoint {
  url: URL;
  host: string;
  port: number;
  secure: boolean;
}

export interface BrowserStatus {
  browserUrl: string;
  version: Record<string, unknown>;
  targets: TargetInfo[];
}

export function parseBrowserUrl(browserUrl: string): BrowserEndpoint {
  const url = new URL(browserUrl);
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  return {
    url,
    host: url.hostname,
    port: Number(url.port || defaultPort),
    secure: url.protocol === "https:"
  };
}

export async function fetchJson<T>(browserUrl: string, path: string): Promise<T> {
  const base = browserUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`);
  if (!response.ok) {
    throw new Error(`CDP endpoint ${path} returned ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function getBrowserStatus(browserUrl: string): Promise<BrowserStatus> {
  const [version, targets] = await Promise.all([
    fetchJson<Record<string, unknown>>(browserUrl, "/json/version"),
    listTargets(browserUrl)
  ]);

  return {
    browserUrl,
    version: VersionSchema.passthrough().parse(version),
    targets
  };
}

export async function listTargets(browserUrl: string): Promise<TargetInfo[]> {
  const endpoint = parseBrowserUrl(browserUrl);
  const targets = (await CDP.List({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure
  })) as TargetInfo[];

  return targets
    .filter((target) => target.type === "page")
    .sort((a, b) => {
      const aBlank = a.url === "about:blank" ? 1 : 0;
      const bBlank = b.url === "about:blank" ? 1 : 0;
      return aBlank - bBlank || a.title.localeCompare(b.title);
    });
}

export async function createTarget(browserUrl: string, url: string): Promise<TargetInfo> {
  const endpoint = parseBrowserUrl(browserUrl);
  const target = (await CDP.New({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    url
  })) as TargetInfo;
  return target;
}

export async function selectTarget(browserUrl: string, selector?: string): Promise<TargetInfo> {
  const targets = await listTargets(browserUrl);
  if (targets.length === 0) {
    throw new Error("No page targets are available from Chrome.");
  }

  if (!selector) {
    return targets[0];
  }

  const exact = targets.find((target) => target.id === selector);
  if (exact) return exact;

  const fuzzy = targets.find((target) => {
    const haystack = `${target.title}\n${target.url}`.toLowerCase();
    return haystack.includes(selector.toLowerCase());
  });
  if (fuzzy) return fuzzy;

  throw new Error(`No page target matched ${JSON.stringify(selector)}.`);
}

export async function connectTarget(
  browserUrl: string,
  selector?: string
): Promise<{ client: CdpClient; target: TargetInfo }> {
  const endpoint = parseBrowserUrl(browserUrl);
  const target = await selectTarget(browserUrl, selector);
  const client = (await CDP({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    target: target.id
  })) as CdpClient;

  return { client, target };
}

export async function closeClient(client: CdpClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // Closing a detached target should not mask the command result.
  }
}

export async function waitForLoad(client: CdpClient, timeoutMs: number): Promise<void> {
  const Page = client.Page;
  await Page.enable();

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    Page.loadEventFired(done);
    Page.domContentEventFired(done);
  });
}
