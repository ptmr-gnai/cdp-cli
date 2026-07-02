#!/usr/bin/env node
import fs from "fs-extra";
import { Command } from "commander";
import { closeClient, connectTarget, createTarget, getBrowserStatus, listTargets, waitForLoad } from "./cdp.js";
import { DEFAULT_BROWSER_URL, DEFAULT_OUT_DIR, defaultChromeUserDataDir, resolveOutDir } from "./env.js";
import { clickExpression, helpersForUrl, pressKey, runHelper, runRecordedEvaluation, typeExpression } from "./actions.js";
import { evaluateExpression, writeSnapshot } from "./snapshot.js";
import { readDaemonState, serveDaemon, startDaemon, stopDaemon } from "./daemon.js";
import { errorEnvelope, printEnvelope, targetActions } from "./output.js";
import { configureTrace } from "./trace.js";
import type { CliGlobalOptions, JsonEnvelope } from "./types.js";

const program = new Command();

program
  .name("cdp-cli")
  .description("Agent-first Chrome DevTools Protocol CLI with filesystem snapshots.")
  .option("-b, --browser-url <url>", "CDP browser URL", process.env.CDP_BROWSER_URL ?? DEFAULT_BROWSER_URL)
  .option("-o, --out-dir <dir>", "artifact output directory", process.env.CDP_OUT_DIR ?? DEFAULT_OUT_DIR)
  .option("--user-data-dir <dir>", "Chrome user-data-dir for active-profile DevToolsActivePort discovery", process.env.CDP_USER_DATA_DIR ?? defaultChromeUserDataDir())
  .option("-t, --target <id-or-text>", "target id, title substring, or URL substring")
  .option("--timeout <ms>", "navigation/load timeout", parseIntOption, 5000)
  .option("--trace", "write JSONL instrumentation to <out-dir>/logs", process.env.CDP_TRACE === "1")
  .option("--daemon", "use or start the persistent cdp-cli daemon", process.env.CDP_DAEMON === "1")
  .option("--no-screenshot", "skip screenshot capture artifacts")
  .showHelpAfterError();

program
  .command("status")
  .description("Check the Chrome CDP endpoint and list page targets.")
  .action(async () => {
    await runCommand("status", async (options) => {
      const status = await getBrowserStatus(options.browserUrl, options.userDataDir);
      return {
        ok: true,
        command: "status",
        data: status as unknown as JsonEnvelope["data"],
        actions: [
          { rel: "list", command: "cdp-cli list", description: "List page targets." },
          { rel: "open", command: "cdp-cli open https://example.com", description: "Open a new page target." }
        ]
      };
    });
  });

program
  .command("list")
  .description("List attachable page targets.")
  .action(async () => {
    await runCommand("list", async (options) => {
      const targets = await listTargets(options.browserUrl, options.userDataDir);
      return {
        ok: true,
        command: "list",
        data: { targets },
        actions: targets.map((target) => ({
          rel: "snapshot",
          command: `cdp-cli snapshot --target ${JSON.stringify(target.id)}`,
          description: `Snapshot ${target.title || target.url}.`
        }))
      };
    });
  });

program
  .command("open")
  .description("Open a URL in a new Chrome target, then snapshot it.")
  .argument("<url>", "URL to open")
  .action(async (url: string) => {
    await runCommand("open", async (options) => {
      const target = await createTarget(options.browserUrl, url, options.userDataDir);
      const { client } = await connectTarget(options.browserUrl, target.id, options.userDataDir);
      try {
        await waitForLoad(client, options.timeout);
        const snapshot = await writeSnapshot(client, {
          outDir: options.outDir,
          target,
          label: "open",
          screenshot: options.screenshot
        });
        return {
          ok: true,
          command: "open",
          message: "Opened URL and wrote snapshot artifacts.",
          data: { target, snapshot: snapshot.meta },
          artifacts: snapshot.artifacts,
          helpers: helpersForUrl(snapshot.meta.url),
          actions: targetActions(target)
        };
      } finally {
        await closeClient(client);
      }
    });
  });

program
  .command("snapshot")
  .description("Project the current page target into local files.")
  .argument("[label]", "snapshot label", "manual")
  .action(async (label: string) => {
    await runCommand("snapshot", async (options) => {
      const { client, target } = await connectTarget(options.browserUrl, options.target, options.userDataDir);
      try {
        const snapshot = await writeSnapshot(client, {
          outDir: options.outDir,
          target,
          label,
          screenshot: options.screenshot
        });
        return {
          ok: true,
          command: "snapshot",
          data: { target, snapshot: snapshot.meta },
          artifacts: snapshot.artifacts,
          helpers: helpersForUrl(snapshot.meta.url),
          actions: targetActions(target)
        };
      } finally {
        await closeClient(client);
      }
    });
  });

program
  .command("eval")
  .description("Evaluate JavaScript in the page, recording before/after snapshots and diffs.")
  .argument("[script]", "JavaScript expression or program")
  .option("-f, --file <path>", "read JavaScript from a file")
  .action(async (script: string | undefined, commandOptions: { file?: string }) => {
    await runCommand("eval", async (options) => {
      const expression = await readScript(script, commandOptions.file);
      const { client, target } = await connectTarget(options.browserUrl, options.target, options.userDataDir);
      try {
        const action = await runRecordedEvaluation(
          { client, target, outDir: options.outDir, screenshot: options.screenshot },
          "eval",
          expression
        );
        return {
          ok: !action.exception,
          command: "eval",
          data: { target, result: action.result, exception: action.exception ?? null },
          artifacts: action.artifacts,
          helpers: helpersForUrl(action.after.meta.url),
          actions: targetActions(target)
        };
      } finally {
        await closeClient(client);
      }
    });
  });

program
  .command("click")
  .description("Click a DOM selector, recording before/after snapshots and diffs.")
  .argument("<selector>", "CSS selector")
  .action(async (selector: string) => {
    await runCommand("click", async (options) => {
      const { client, target } = await connectTarget(options.browserUrl, options.target, options.userDataDir);
      try {
        const action = await runRecordedEvaluation(
          { client, target, outDir: options.outDir, screenshot: options.screenshot },
          "click",
          clickExpression(selector),
          () => waitForLoad(client, options.timeout)
        );
        return {
          ok: !action.exception,
          command: "click",
          data: { target, result: action.result, exception: action.exception ?? null },
          artifacts: action.artifacts,
          helpers: helpersForUrl(action.after.meta.url),
          actions: targetActions(target)
        };
      } finally {
        await closeClient(client);
      }
    });
  });

program
  .command("type")
  .description("Type text into a selector, recording before/after snapshots and diffs.")
  .argument("<selector>", "CSS selector")
  .argument("<text>", "text to enter")
  .option("--append", "append instead of replacing")
  .action(async (selector: string, text: string, commandOptions: { append?: boolean }) => {
    await runCommand("type", async (options) => {
      const { client, target } = await connectTarget(options.browserUrl, options.target, options.userDataDir);
      try {
        const action = await runRecordedEvaluation(
          { client, target, outDir: options.outDir, screenshot: options.screenshot },
          "type",
          typeExpression(selector, text, Boolean(commandOptions.append))
        );
        return {
          ok: !action.exception,
          command: "type",
          data: { target, result: action.result, exception: action.exception ?? null },
          artifacts: action.artifacts,
          helpers: helpersForUrl(action.after.meta.url),
          actions: targetActions(target)
        };
      } finally {
        await closeClient(client);
      }
    });
  });

program
  .command("press")
  .description("Send a keyboard key, recording before/after snapshots and diffs.")
  .argument("<key>", "CDP key value, for example Enter, Escape, Tab")
  .action(async (key: string) => {
    await runCommand("press", async (options) => {
      const { client, target } = await connectTarget(options.browserUrl, options.target, options.userDataDir);
      try {
        const before = await writeSnapshot(client, {
          outDir: options.outDir,
          target,
          label: "press-before",
          screenshot: options.screenshot
        });
        await pressKey(client, key);
        const after = await writeSnapshot(client, {
          outDir: options.outDir,
          target,
          label: "press-after",
          screenshot: options.screenshot
        });
        return {
          ok: true,
          command: "press",
          data: { target, key },
          artifacts: { before: before.dir, after: after.dir, ...after.artifacts },
          helpers: helpersForUrl(after.meta.url),
          actions: targetActions(target)
        };
      } finally {
        await closeClient(client);
      }
    });
  });

const helpers = program.command("helpers").description("List or run helpers available for the page.");

helpers
  .command("list", { isDefault: true })
  .description("List helpers available for the current page.")
  .action(async () => {
    await runCommand("helpers", async (options) => {
      const { client, target } = await connectTarget(options.browserUrl, options.target, options.userDataDir);
      try {
        const urlResult = await evaluateExpression(client, "location.href");
        const url = String(urlResult.value ?? target.url);
        return {
          ok: true,
          command: "helpers",
          data: { target, url },
          helpers: helpersForUrl(url),
          actions: targetActions(target)
        };
      } finally {
        await closeClient(client);
      }
    });
  });

const daemon = program.command("daemon").description("Manage the persistent cdp-cli CDP proxy daemon.");

daemon
  .command("start")
  .description("Start the daemon and print its connection details.")
  .option("--port <port>", "daemon listen port", parseIntOption, 9339)
  .action(async (commandOptions: { port: number }) => {
    await runCommand("daemon start", async (options) => {
      const state = await startDaemon({
        outDir: options.outDir,
        browserUrl: options.browserUrl,
        userDataDir: options.userDataDir,
        port: commandOptions.port
      });
      return {
        ok: true,
        command: "daemon start",
        data: state,
        actions: [
          {
            rel: "use-daemon",
            command: `cdp-cli --daemon status`,
            description: "Run commands through the persistent daemon."
          }
        ]
      };
    });
  });

daemon
  .command("status")
  .description("Show daemon state if it is running.")
  .action(async () => {
    await runCommand("daemon status", async (options) => {
      const state = await readDaemonState(options.outDir);
      return {
        ok: Boolean(state),
        command: "daemon status",
        data: { running: Boolean(state), state: state ?? null }
      };
    });
  });

daemon
  .command("stop")
  .description("Stop the daemon.")
  .action(async () => {
    await runCommand("daemon stop", async (options) => {
      const stopped = await stopDaemon(options.outDir);
      return {
        ok: true,
        command: "daemon stop",
        data: { stopped }
      };
    });
  });

daemon
  .command("serve")
  .description("Internal foreground daemon entrypoint.")
  .option("--port <port>", "daemon listen port", parseIntOption, 9339)
  .action(async (commandOptions: { port: number }) => {
    const raw = program.opts<{
      browserUrl: string;
      outDir: string;
      userDataDir?: string;
      trace: boolean;
    }>();
    const outDir = resolveOutDir(raw.outDir);
    configureTrace(outDir, raw.trace);
    await serveDaemon({
      outDir,
      browserUrl: raw.browserUrl,
      userDataDir: raw.userDataDir || undefined,
      port: commandOptions.port
    });
  });

helpers
  .command("run")
  .description("Run a helper command, recording before/after snapshots and diffs.")
  .argument("<helper>", "helper id")
  .argument("<commandName>", "helper command name")
  .action(async (helperId: string, commandName: string) => {
    await runCommand("helpers run", async (options) => {
      const { client, target } = await connectTarget(options.browserUrl, options.target, options.userDataDir);
      try {
        const urlResult = await evaluateExpression(client, "location.href");
        const url = String(urlResult.value ?? target.url);
        const action = await runHelper(
          { client, target, outDir: options.outDir, screenshot: options.screenshot },
          helperId,
          commandName,
          url
        );
        return {
          ok: !action.exception,
          command: "helpers run",
          data: { target, helper: helperId, helperCommand: commandName, result: action.result, exception: action.exception ?? null },
          artifacts: action.artifacts,
          helpers: helpersForUrl(action.after.meta.url),
          actions: targetActions(target)
        };
      } finally {
        await closeClient(client);
      }
    });
  });

async function runCommand(
  command: string,
  fn: (options: CliGlobalOptions) => Promise<JsonEnvelope>
): Promise<void> {
  const raw = program.opts<{
    browserUrl: string;
    outDir: string;
    userDataDir?: string;
    target?: string;
    timeout: number;
    trace: boolean;
    daemon: boolean;
    screenshot: boolean;
  }>();

  let browserUrl = raw.browserUrl;
  let userDataDir = raw.userDataDir;
  if (raw.daemon && !command.startsWith("daemon")) {
    const daemonDir = resolveOutDir(DEFAULT_OUT_DIR);
    const state =
      (await readDaemonState(daemonDir)) ??
      (await startDaemon({
        outDir: daemonDir,
        browserUrl: raw.browserUrl,
        userDataDir: raw.userDataDir,
        port: 9339
      }));
    browserUrl = state.browserUrl;
    userDataDir = undefined;
  }

  const options: CliGlobalOptions = {
    browserUrl,
    outDir: resolveOutDir(raw.outDir),
    userDataDir,
    target: raw.target,
    timeout: raw.timeout,
    screenshot: raw.screenshot
  };
  configureTrace(options.outDir, raw.trace);

  try {
    await fs.ensureDir(options.outDir);
    const envelope = await fn(options);
    printEnvelope(envelope);
    if (!envelope.ok) process.exitCode = 1;
  } catch (error) {
    printEnvelope(errorEnvelope(command, error));
    process.exitCode = 1;
  }
}

async function readScript(script?: string, file?: string): Promise<string> {
  if (file) return fs.readFile(file, "utf8");
  if (script) return script;
  throw new Error("Provide a script argument or --file path.");
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Expected integer, got ${value}`);
  return parsed;
}

await program.parseAsync(process.argv);
