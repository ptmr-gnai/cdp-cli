import path from "node:path";
import fs from "fs-extra";

export interface TraceEvent {
  event: string;
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

let traceDir: string | undefined;
let traceEnabled = false;

export function configureTrace(outDir: string, enabled: boolean): void {
  traceDir = path.join(outDir, "logs");
  traceEnabled = enabled;
}

export async function trace(event: TraceEvent): Promise<void> {
  if (!traceEnabled || !traceDir) return;
  await fs.ensureDir(traceDir);
  const file = path.join(traceDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    ...event
  });
  await fs.appendFile(file, `${line}\n`, "utf8");
}

export function errorData(error: unknown): TraceEvent["error"] {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    name: err.name,
    message: err.message,
    stack: err.stack
  };
}
