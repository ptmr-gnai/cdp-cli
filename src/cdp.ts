import CDP from "chrome-remote-interface";
import { z } from "zod";
import fs from "fs-extra";
import path from "node:path";
import { errorData, trace } from "./trace.js";
import type { TargetInfo } from "./types.js";

type CdpClient = any;

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
  connectionMode: "http-json" | "active-port";
  webSocketDebuggerUrl?: string;
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

export async function getBrowserStatus(browserUrl: string, userDataDir?: string): Promise<BrowserStatus> {
  await trace({ event: "status.start", data: { browserUrl, userDataDir } });
  try {
    const [version, targets] = await Promise.all([
      fetchJson<Record<string, unknown>>(browserUrl, "/json/version"),
      listTargets(browserUrl, userDataDir)
    ]);

    return {
      browserUrl,
      version: VersionSchema.passthrough().parse(version),
      targets,
      connectionMode: "http-json"
    };
  } catch (error) {
    await trace({ event: "status.http_discovery_failed", error: errorData(error) });
    if (!isHttpDiscoveryError(error)) throw error;
    const browserWsEndpoint = await readActivePortEndpoint(browserUrl, userDataDir);
    const browser = await connectBrowser(browserWsEndpoint);
    try {
      const [version, rawTargets] = await Promise.all([
        browser.Browser.getVersion(),
        listTargetsFromBrowser(browser, browserUrl)
      ]);
      const targets = pageTargets(rawTargets);
      return {
        browserUrl,
        version: VersionSchema.passthrough().parse({
          Browser: version.product,
          "Protocol-Version": version.protocolVersion,
          "User-Agent": version.userAgent,
          "V8-Version": version.jsVersion,
          webSocketDebuggerUrl: browserWsEndpoint
        }),
        targets,
        connectionMode: "active-port",
        webSocketDebuggerUrl: browserWsEndpoint
      };
    } finally {
      await closeClient(browser);
      await trace({ event: "status.done", ok: true, data: { mode: "active-port" } });
    }
  }
}

export async function listTargets(browserUrl: string, userDataDir?: string): Promise<TargetInfo[]> {
  await trace({ event: "targets.list.start", data: { browserUrl, userDataDir } });
  const endpoint = parseBrowserUrl(browserUrl);
  let targets: TargetInfo[];
  try {
    targets = (await CDP.List({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.secure
    })) as TargetInfo[];
  } catch (error) {
    await trace({ event: "targets.list.http_failed", error: errorData(error) });
    try {
      const browserWsEndpoint = await readActivePortEndpoint(browserUrl, userDataDir);
      const browser = await connectBrowser(browserWsEndpoint);
      try {
        targets = await listTargetsFromBrowser(browser, browserUrl);
      } finally {
        await closeClient(browser);
      }
    } catch {
      await trace({ event: "targets.list.active_port_failed", error: errorData(error) });
      throw error;
    }
  }

  const pages = pageTargets(targets);
  await trace({ event: "targets.list.done", ok: true, data: { count: pages.length } });
  return pages;
}

function pageTargets(targets: TargetInfo[]): TargetInfo[] {
  return targets
    .filter((target) => target.type === "page")
    .sort((a, b) => {
      const aBlank = a.url === "about:blank" ? 1 : 0;
      const bBlank = b.url === "about:blank" ? 1 : 0;
      return aBlank - bBlank || a.title.localeCompare(b.title);
    });
}

export async function createTarget(browserUrl: string, url: string, userDataDir?: string): Promise<TargetInfo> {
  await trace({ event: "target.create.start", data: { browserUrl, url, userDataDir } });
  const endpoint = parseBrowserUrl(browserUrl);
  try {
    const target = (await CDP.New({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.secure,
      url
    })) as TargetInfo;
    await trace({ event: "target.create.done", ok: true, data: { mode: "http-json", targetId: target.id } });
    return target;
  } catch (error) {
    await trace({ event: "target.create.http_failed", error: errorData(error) });
    try {
      const browserWsEndpoint = await readActivePortEndpoint(browserUrl, userDataDir);
      const browser = await connectBrowser(browserWsEndpoint);
      try {
        const created = await browser.Target.createTarget({ url });
        const targets = await listTargetsFromBrowser(browser, browserUrl);
        const target = targets.find((candidate) => candidate.id === created.targetId);
        if (!target) throw new Error(`Chrome created target ${created.targetId}, but it was not listed.`);
        await trace({
          event: "target.create.done",
          ok: true,
          data: { mode: "active-port", targetId: target.id }
        });
        return target;
      } finally {
        await closeClient(browser);
      }
    } catch {
      await trace({ event: "target.create.active_port_failed", error: errorData(error) });
      throw error;
    }
  }
}

export async function closeTarget(browserUrl: string, targetId: string, userDataDir?: string): Promise<boolean> {
  await trace({ event: "target.close.start", data: { browserUrl, targetId, userDataDir } });
  try {
    const base = browserUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/json/close/${encodeURIComponent(targetId)}`);
    if (response.ok) {
      await trace({ event: "target.close.done", ok: true, data: { mode: "http-json", targetId } });
      return true;
    }
    await trace({
      event: "target.close.http_failed",
      error: { name: "HttpError", message: `${response.status} ${response.statusText}` }
    });
  } catch (error) {
    await trace({ event: "target.close.http_failed", error: errorData(error) });
  }

  const browserWsEndpoint = await readActivePortEndpoint(browserUrl, userDataDir);
  const browser = await connectBrowser(browserWsEndpoint);
  try {
    const result = await browser.Target.closeTarget({ targetId });
    const success = Boolean(result?.success ?? true);
    await trace({ event: "target.close.done", ok: success, data: { mode: "active-port", targetId } });
    return success;
  } finally {
    await closeClient(browser);
  }
}

export async function selectTarget(
  browserUrl: string,
  selector?: string,
  userDataDir?: string
): Promise<TargetInfo> {
  const targets = await listTargets(browserUrl, userDataDir);
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
  selector?: string,
  userDataDir?: string
): Promise<{ client: CdpClient; target: TargetInfo }> {
  const endpoint = parseBrowserUrl(browserUrl);
  const target = await selectTarget(browserUrl, selector, userDataDir);
  await trace({
    event: "target.connect.start",
    data: { targetId: target.id, url: target.url, mode: target.connectionMode ?? "http-json" }
  });

  if (target.connectionMode === "active-port") {
    const browserWsEndpoint =
      target.browserWebSocketDebuggerUrl ?? (await readActivePortEndpoint(browserUrl, userDataDir));
    const browser = await connectBrowser(browserWsEndpoint);
    const attached = await browser.Target.attachToTarget({
      targetId: target.id,
      flatten: true
    });
    await trace({
      event: "target.attach.done",
      ok: true,
      data: { targetId: target.id, sessionId: attached.sessionId }
    });
    return { client: createSessionClient(browser, attached.sessionId), target };
  }

  const client = (await CDP({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    target: target.webSocketDebuggerUrl ?? target.id,
    local: Boolean(target.webSocketDebuggerUrl?.startsWith("ws:"))
  })) as CdpClient;
  await trace({ event: "target.connect.done", ok: true, data: { targetId: target.id } });

  return { client, target };
}

export async function closeClient(client: CdpClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // Closing a detached target should not mask the command result.
  }
}

export async function navigateTarget(client: CdpClient, url: string, timeoutMs: number): Promise<void> {
  await trace({ event: "page.navigate.start", data: { url, timeoutMs } });
  await client.Page.enable();
  await client.Page.navigate({ url });
  await waitForLoad(client, timeoutMs);
  await trace({ event: "page.navigate.done", ok: true, data: { url } });
}

export async function waitForLoad(client: CdpClient, timeoutMs: number): Promise<void> {
  const Page = client.Page;
  await trace({ event: "page.wait.start", data: { timeoutMs } });
  try {
    await cdpTimeout(Page.enable(), Math.min(timeoutMs, 3000), "Page.enable");
  } catch (error) {
    await trace({ event: "page.enable.failed", error: errorData(error) });
    return;
  }

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
  await trace({ event: "page.wait.done", ok: true });
}

async function cdpTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void promise.catch(() => undefined);
  }
}

async function connectBrowser(browserWsEndpoint: string): Promise<CdpClient> {
  await trace({ event: "browser.connect.start", data: { browserWsEndpoint } });
  const browser = (await CDP({
    target: browserWsEndpoint,
    local: true
  })) as CdpClient;
  await trace({ event: "browser.connect.done", ok: true, data: { browserWsEndpoint } });
  return browser;
}

async function listTargetsFromBrowser(browser: CdpClient, browserUrl: string): Promise<TargetInfo[]> {
  const endpoint = parseBrowserUrl(browserUrl);
  const browserWebSocketDebuggerUrl = browser.webSocketUrl as string | undefined;
  const response = await browser.Target.getTargets();
  return response.targetInfos.map((target: any) => ({
    id: target.targetId,
    type: target.type,
    title: target.title,
    url: target.url,
    description: "",
    devtoolsFrontendUrl: "",
    webSocketDebuggerUrl: `${endpoint.secure ? "wss" : "ws"}://${endpoint.host}:${endpoint.port}/devtools/page/${target.targetId}`,
    connectionMode: "active-port",
    browserWebSocketDebuggerUrl
  }));
}

function createSessionClient(browser: CdpClient, sessionId: string): CdpClient {
  const send = (method: string, params?: Record<string, unknown>) => {
    return browser.send(method, params ?? {}, sessionId);
  };
  const onSessionEvent = (method: string, callback: (...args: unknown[]) => void) => {
    browser.on(`${method}.${sessionId}`, callback);
    return () => browser;
  };

  return {
    webSocketUrl: browser.webSocketUrl,
    send,
    close: async () => {
      try {
        await browser.Target.detachFromTarget({ sessionId });
      } catch {
        // Ignore detach races; closing the websocket below releases resources.
      }
      await browser.close();
    },
    Runtime: {
      enable: () => send("Runtime.enable"),
      evaluate: (params: Record<string, unknown>) => send("Runtime.evaluate", params)
    },
    Page: {
      enable: () => send("Page.enable"),
      navigate: (params: Record<string, unknown>) => send("Page.navigate", params),
      captureScreenshot: (params: Record<string, unknown>) => send("Page.captureScreenshot", params),
      loadEventFired: (callback: (...args: unknown[]) => void) =>
        onSessionEvent("Page.loadEventFired", callback),
      domContentEventFired: (callback: (...args: unknown[]) => void) =>
        onSessionEvent("Page.domContentEventFired", callback)
    },
    Accessibility: {
      getFullAXTree: () => send("Accessibility.getFullAXTree")
    },
    DOMSnapshot: {
      captureSnapshot: (params: Record<string, unknown>) => send("DOMSnapshot.captureSnapshot", params)
    },
    Input: {
      dispatchKeyEvent: (params: Record<string, unknown>) => send("Input.dispatchKeyEvent", params)
    }
  };
}

export async function readActivePortEndpoint(
  browserUrl: string,
  userDataDir?: string
): Promise<string> {
  if (!userDataDir) {
    throw new Error(
      "Chrome did not expose /json discovery. Provide --user-data-dir so DevToolsActivePort can be read."
    );
  }
  const endpoint = parseBrowserUrl(browserUrl);
  const portPath = path.join(userDataDir, "DevToolsActivePort");
  await trace({ event: "active_port.read.start", data: { portPath } });
  const fileContent = await fs.readFile(portPath, "utf8");
  const [rawPort, rawPath] = fileContent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const port = Number.parseInt(rawPort ?? "", 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535 || !rawPath?.startsWith("/")) {
    throw new Error(`Invalid DevToolsActivePort content in ${portPath}.`);
  }
  const host = endpoint.host || "127.0.0.1";
  const browserWsEndpoint = `${endpoint.secure ? "wss" : "ws"}://${host}:${port}${rawPath}`;
  await trace({ event: "active_port.read.done", ok: true, data: { portPath, browserWsEndpoint } });
  return browserWsEndpoint;
}

function isHttpDiscoveryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /404 Not Found|Unexpected server response|ECONNREFUSED|fetch failed|target list/i.test(
    error.message
  );
}
