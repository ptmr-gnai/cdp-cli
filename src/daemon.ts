import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "fs-extra";
import { WebSocketServer, WebSocket } from "ws";
import CDP from "chrome-remote-interface";
import { readActivePortEndpoint } from "./cdp.js";
import { trace, errorData } from "./trace.js";

const require = createRequire(import.meta.url);
const localProtocol = require("chrome-remote-interface/lib/protocol.json");

interface DaemonState {
  pid: number;
  port: number;
  browserUrl: string;
  userDataDir?: string;
  startedAt: string;
  stateFile: string;
}

export interface DaemonOptions {
  outDir: string;
  browserUrl: string;
  userDataDir?: string;
  port: number;
}

export function daemonStateFile(outDir: string): string {
  return path.join(outDir, "daemon.json");
}

export async function readDaemonState(outDir: string): Promise<DaemonState | undefined> {
  const stateFile = daemonStateFile(outDir);
  if (!(await fs.pathExists(stateFile))) return undefined;
  const state = (await fs.readJson(stateFile)) as DaemonState;
  if (!isProcessAlive(state.pid)) return undefined;
  return state;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonState> {
  await fs.ensureDir(options.outDir);
  const existing = await readDaemonState(options.outDir);
  if (existing) return existing;

  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const args = [
    cliPath,
    "--browser-url",
    options.browserUrl,
    "--out-dir",
    options.outDir,
    "--user-data-dir",
    options.userDataDir ?? "",
    "--trace",
    "daemon",
    "serve",
    "--port",
    String(options.port)
  ];

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd()
  });
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });
  child.unref();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await delay(200);
    if (childExit) {
      throw new Error(
        `cdp-cli daemon exited before startup completed (code ${childExit.code ?? "null"}, signal ${childExit.signal ?? "null"}).`
      );
    }
    const state = await readDaemonState(options.outDir);
    if (state) return state;
  }

  throw new Error("Timed out waiting for cdp-cli daemon to start.");
}

export async function stopDaemon(outDir: string): Promise<boolean> {
  const state = await readDaemonState(outDir);
  if (!state) return false;
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  await fs.remove(daemonStateFile(outDir));
  return true;
}

export async function serveDaemon(options: DaemonOptions): Promise<void> {
  await fs.ensureDir(options.outDir);
  const browserWsEndpoint = await readActivePortEndpoint(options.browserUrl, options.userDataDir);
  await trace({ event: "daemon.browser.connect.start", data: { browserWsEndpoint } });
  let browser: any;
  try {
    browser = (await withTimeout(
      CDP({ target: browserWsEndpoint, local: true }),
      15_000,
      "Browser websocket connect"
    )) as any;
  } catch (error) {
    await trace({ event: "daemon.browser.connect.done", ok: false, error: errorData(error) });
    throw error;
  }
  await trace({ event: "daemon.browser.connect.done", ok: true, data: { browserWsEndpoint } });

  const server = http.createServer(async (req, res) => {
    try {
      await handleHttp(req, res, browser, options);
    } catch (error) {
      await trace({ event: "daemon.http.error", error: errorData(error) });
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handlePageSocket(req, ws, browser, options);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const state: DaemonState = {
    pid: process.pid,
    port,
    browserUrl: `http://127.0.0.1:${port}`,
    userDataDir: options.userDataDir,
    startedAt: new Date().toISOString(),
    stateFile: daemonStateFile(options.outDir)
  };
  await fs.writeJson(state.stateFile, state, { spaces: 2 });
  await trace({ event: "daemon.listen", ok: true, data: { port, stateFile: state.stateFile } });

  const shutdown = async () => {
    await trace({ event: "daemon.shutdown" });
    await fs.remove(state.stateFile);
    server.close();
    await browser.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  browser: any,
  options: DaemonOptions
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${options.port}`);
  await trace({ event: "daemon.http.request", data: { method: req.method, path: url.pathname } });

  if (url.pathname === "/json/version") {
    const version = await browser.Browser.getVersion();
    sendJson(res, 200, {
      Browser: version.product,
      "Protocol-Version": version.protocolVersion,
      "User-Agent": version.userAgent,
      "V8-Version": version.jsVersion,
      webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/devtools/browser`
    });
    return;
  }

  if (url.pathname === "/json/protocol") {
    sendJson(res, 200, localProtocol);
    return;
  }

  if (url.pathname === "/json/list" || url.pathname === "/json") {
    sendJson(res, 200, await daemonTargets(browser, options.port));
    return;
  }

  if (url.pathname === "/json/new") {
    const targetUrl = decodeURIComponent(url.search.slice(1) || "about:blank");
    const created = await browser.Target.createTarget({ url: targetUrl });
    const targets = await daemonTargets(browser, options.port);
    sendJson(res, 200, targets.find((target: any) => target.id === created.targetId) ?? targets[0]);
    return;
  }

  const closeMatch = url.pathname.match(/^\/json\/close\/([^/]+)$/);
  if (closeMatch) {
    const targetId = decodeURIComponent(closeMatch[1]);
    const result = await browser.Target.closeTarget({ targetId });
    await trace({
      event: "daemon.target.close",
      ok: Boolean(result?.success ?? true),
      data: { targetId }
    });
    sendJson(res, 200, { targetId, success: Boolean(result?.success ?? true) });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function daemonTargets(browser: any, port: number) {
  const response = await browser.Target.getTargets();
  return response.targetInfos
    .filter((target: any) => target.type === "page")
    .map((target: any) => ({
      id: target.targetId,
      type: target.type,
      title: target.title,
      url: target.url,
      description: "",
      devtoolsFrontendUrl: "",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${target.targetId}`
    }));
}

async function handlePageSocket(
  req: http.IncomingMessage,
  ws: WebSocket,
  browser: any,
  options: DaemonOptions
): Promise<void> {
  const match = (req.url ?? "").match(/^\/devtools\/page\/([^/?#]+)/);
  const targetId = match?.[1];
  if (!targetId) {
    ws.close(1008, "missing target id");
    return;
  }

  const attached = await browser.Target.attachToTarget({ targetId, flatten: true });
  const sessionId = attached.sessionId;
  await trace({ event: "daemon.target.attach", ok: true, data: { targetId, sessionId } });

  const onEvent = (message: any) => {
    if (message.sessionId !== sessionId || !message.method || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ method: message.method, params: message.params ?? {} }));
  };
  browser.on("event", onEvent);

  ws.on("message", (raw) => {
    void (async () => {
      const request = JSON.parse(raw.toString()) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (!request.id || !request.method) return;
      try {
        const result = await browser.send(request.method, request.params ?? {}, sessionId);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, result }));
      } catch (error: any) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              id: request.id,
              error: {
                code: error?.response?.code ?? -32000,
                message: error?.message ?? String(error)
              }
            })
          );
        }
      }
    })();
  });

  ws.on("close", () => {
    browser.removeListener("event", onEvent);
    void browser.Target.detachFromTarget({ sessionId }).catch(() => undefined);
    void trace({ event: "daemon.target.detach", data: { targetId, sessionId } });
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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
