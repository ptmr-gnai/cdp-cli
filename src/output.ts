import type { JsonEnvelope, TargetInfo } from "./types.js";
import { errorData } from "./trace.js";

export function printEnvelope(envelope: JsonEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

export function errorEnvelope(command: string, error: unknown): JsonEnvelope {
  return {
    ok: false,
    command,
    error: errorData(error)
  };
}

export function targetActions(target?: TargetInfo): JsonEnvelope["actions"] {
  const suffix = target ? ` --target ${JSON.stringify(target.id)}` : "";
  return [
    {
      rel: "snapshot",
      command: `cdp-cli snapshot${suffix}`,
      description: "Capture the current page into local files."
    },
    {
      rel: "snapshot-all",
      command: "cdp-cli snapshot-all",
      description: "Capture every open page target, including popups and new tabs, into local files."
    },
    {
      rel: "current",
      command: `cdp-cli current${suffix}`,
      description: "Show the latest snapshot files, counts, grep commands, and next actions."
    },
    {
      rel: "current-all",
      command: "cdp-cli current-all",
      description: "Show latest snapshot summaries across every open page target."
    },
    {
      rel: "navigate",
      command: `cdp-cli navigate https://example.com${suffix}`,
      description: "Navigate this page target and capture a snapshot."
    },
    {
      rel: "eval",
      command: `cdp-cli eval 'document.title'${suffix}`,
      description: "Evaluate JavaScript and write before/after artifacts."
    },
    {
      rel: "wait",
      command: `cdp-cli wait 1000${suffix}`,
      description: "Wait for SPA/client-side changes and write before/after diffs."
    },
    {
      rel: "click-ref",
      command: `cdp-cli click <ref>${suffix}`,
      description: "Click a ref from current actionable-controls.ndjson, visible-controls.ndjson, controls.ndjson, or dump.txt."
    },
    {
      rel: "fill-ref",
      command: `cdp-cli fill <ref> 'text'${suffix}`,
      description: "Fill a ref from the latest snapshot files. Run cdp-cli current for concrete refs."
    },
    {
      rel: "helpers",
      command: `cdp-cli helpers${suffix}`,
      description: "List helpers available for this page."
    },
    {
      rel: "close",
      command: `cdp-cli close${suffix}`,
      description: "Close this page target."
    }
  ];
}
