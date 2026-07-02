import path from "node:path";
import fs from "fs-extra";
import { evaluateExpression, writeSnapshot } from "./snapshot.js";
import { nowStamp, sanitizeFilePart } from "./env.js";
import { findHelperCommand, helperSummaries } from "./helpers.js";
import type { ResolvedRef } from "./refs.js";
import type { ArtifactMap, SnapshotResult, TargetInfo } from "./types.js";

type CdpClient = any;

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

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type LocatorInput = string | Pick<ResolvedRef, "selector" | "roots" | "ref">;

export function clickExpression(locatorInput: LocatorInput): string {
  return `(() => {
    const locator = ${JSON.stringify(normalizeLocatorInput(locatorInput))};
    const root = resolveRoot(locator);
    const el = root.querySelector(locator.selector);
    if (!el) throw new Error('No element matched selector: ' + locator.selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return { clicked: locator.selector, ref: locator.ref || null, roots: locator.roots || [], text: (el.innerText || el.textContent || '').trim() };
    ${resolveRootSource()}
  })()`;
}

export function typeExpression(locatorInput: LocatorInput, text: string, append: boolean): string {
  return `(() => {
    const locator = ${JSON.stringify(normalizeLocatorInput(locatorInput))};
    const text = ${JSON.stringify(text)};
    const root = resolveRoot(locator);
    const el = root.querySelector(locator.selector);
    if (!el) throw new Error('No element matched selector: ' + locator.selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
    if ('value' in el) {
      if (${append ? "true" : "false"}) el.value += text;
      else el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: locator.selector, ref: locator.ref || null, roots: locator.roots || [], value: el.value };
    }
    if (el.isContentEditable) {
      if (!${append ? "true" : "false"}) el.textContent = '';
      document.execCommand('insertText', false, text);
      return { typed: locator.selector, ref: locator.ref || null, roots: locator.roots || [], text: el.textContent };
    }
    throw new Error('Element is not text-editable: ' + locator.selector);
    ${resolveRootSource()}
  })()`;
}

function normalizeLocatorInput(locatorInput: LocatorInput): Pick<ResolvedRef, "selector" | "roots" | "ref"> {
  return typeof locatorInput === "string" ? { selector: locatorInput } : locatorInput;
}

function resolveRootSource(): string {
  return `
    function resolveRoot(locator) {
      let root = document;
      for (const step of locator.roots || []) {
        const host = root.querySelector(step.selector);
        if (!host) throw new Error('No host matched ' + step.kind + ' ref ' + step.ref + ': ' + step.selector);
        if (step.kind === 'shadow-root') {
          if (!host.shadowRoot) throw new Error('Host ref ' + step.ref + ' has no open shadowRoot.');
          root = host.shadowRoot;
        } else if (step.kind === 'frame') {
          if (!host.contentDocument) throw new Error('Frame ref ' + step.ref + ' is not same-origin or is unavailable.');
          root = host.contentDocument;
        } else {
          throw new Error('Unsupported root step: ' + step.kind);
        }
      }
      return root;
    }
  `;
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
