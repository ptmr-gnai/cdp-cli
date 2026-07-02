import type { JsonEnvelope, TargetInfo } from "./types.js";

export function printEnvelope(envelope: JsonEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

export function errorEnvelope(command: string, error: unknown): JsonEnvelope {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    ok: false,
    command,
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack
    }
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
      rel: "eval",
      command: `cdp-cli eval 'document.title'${suffix}`,
      description: "Evaluate JavaScript and write before/after artifacts."
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
