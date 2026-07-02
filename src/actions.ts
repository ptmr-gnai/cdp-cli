import path from "node:path";
import fs from "fs-extra";
import type CDP from "chrome-remote-interface";
import { evaluateExpression, writeSnapshot } from "./snapshot.js";
import { nowStamp, sanitizeFilePart } from "./env.js";
import { findHelperCommand, helperSummaries } from "./helpers.js";
import type { ArtifactMap, SnapshotResult, TargetInfo } from "./types.js";

type CdpClient = Awaited<ReturnType<typeof CDP>>;

export interface ActionContext {
  client: CdpClient;
  target: TargetInfo;
  outDir: string;
  screenshot: boolean;
}

export interface ActionResult {
  result: unknown;
  exception?: string;
  before: SnapshotResult;
  after: SnapshotResult;
  artifacts: ArtifactMap;
}

export async function runRecordedEvaluation(
  context: ActionContext,
  label: string,
  expression: string,
  afterEvaluate?: () => Promise<void>
): Promise<ActionResult> {
  const before = await writeSnapshot(context.client, {
    outDir: context.outDir,
    target: context.target,
    label: `${label}-before`,
    screenshot: context.screenshot
  });

  const runDir = path.join(context.outDir, "runs", `${nowStamp()}-${sanitizeFilePart(label)}`);
  await fs.ensureDir(runDir);
  const scriptPath = path.join(runDir, "script.js");
  const resultPath = path.join(runDir, "result.json");
  await fs.writeFile(scriptPath, expression, "utf8");

  const evalResult = await evaluateExpression(context.client, expression);
  await fs.writeJson(resultPath, evalResult, { spaces: 2 });
  if (afterEvaluate) await afterEvaluate();

  const after = await writeSnapshot(context.client, {
    outDir: context.outDir,
    target: context.target,
    label: `${label}-after`,
    screenshot: context.screenshot
  });

  return {
    result: evalResult.value,
    exception: evalResult.exception,
    before,
    after,
    artifacts: {
      run: runDir,
      script: scriptPath,
      result: resultPath,
      before: before.dir,
      after: after.dir,
      ...after.artifacts
    }
  };
}

export function clickExpression(selector: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const el = document.querySelector(selector);
    if (!el) throw new Error('No element matched selector: ' + selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return { clicked: selector, text: (el.innerText || el.textContent || '').trim() };
  })()`;
}

export function typeExpression(selector: string, text: string, append: boolean): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const text = ${JSON.stringify(text)};
    const el = document.querySelector(selector);
    if (!el) throw new Error('No element matched selector: ' + selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
    if ('value' in el) {
      if (${append ? "true" : "false"}) el.value += text;
      else el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: selector, value: el.value };
    }
    if (el.isContentEditable) {
      if (!${append ? "true" : "false"}) el.textContent = '';
      document.execCommand('insertText', false, text);
      return { typed: selector, text: el.textContent };
    }
    throw new Error('Element is not text-editable: ' + selector);
  })()`;
}

export async function pressKey(client: CdpClient, key: string): Promise<void> {
  const Input = client.Input;
  await Input.dispatchKeyEvent({ type: "keyDown", key });
  await Input.dispatchKeyEvent({ type: "keyUp", key });
}

export async function runHelper(
  context: ActionContext,
  helperId: string,
  commandName: string,
  currentUrl: string
): Promise<ActionResult> {
  const { command } = findHelperCommand(currentUrl, helperId, commandName);
  return runRecordedEvaluation(context, `helper-${helperId}-${commandName}`, command.expression);
}

export function helpersForUrl(url: string) {
  return helperSummaries(url);
}
