import path from "node:path";
import fs from "fs-extra";
import { createPatch } from "diff";
import type CDP from "chrome-remote-interface";
import { nowStamp, sanitizeFilePart } from "./env.js";
import { helperSummaries } from "./helpers.js";
import type { ArtifactMap, SnapshotResult, TargetInfo } from "./types.js";

type CdpClient = Awaited<ReturnType<typeof CDP>>;

interface RuntimeEvalResult {
  result?: {
    type?: string;
    value?: unknown;
    unserializableValue?: string;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
      value?: unknown;
    };
  };
}

export interface EvaluateResult {
  value: unknown;
  exception?: string;
}

export interface SnapshotOptions {
  outDir: string;
  target: TargetInfo;
  label: string;
  screenshot: boolean;
}

const PAGE_STATE_EXPRESSION = `(() => {
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const cssPath = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = node.localName;
      const testId = node.getAttribute('data-testid') || node.getAttribute('data-test-id');
      if (testId) {
        part += '[data-testid="' + CSS.escape(testId) + '"]';
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((sibling) => sibling.localName === node.localName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
  const controls = [...document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]')]
    .filter(visible)
    .map((el, index) => ({
      ref: 'el' + index,
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.id || null,
      href: el.href || null,
      text: textOf(el),
      placeholder: el.getAttribute('placeholder'),
      value: 'value' in el ? el.value : null,
      disabled: !!el.disabled,
      rect: (() => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })()
    }));
  const dialogs = [...document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"]')]
    .filter(visible)
    .map((el, index) => ({
      ref: 'dialog' + index,
      selector: cssPath(el),
      text: textOf(el),
      rect: (() => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })()
    }));
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    },
    activeElement: document.activeElement ? {
      selector: cssPath(document.activeElement),
      tag: document.activeElement.tagName.toLowerCase(),
      text: textOf(document.activeElement)
    } : null,
    selection: String(window.getSelection?.() ?? ''),
    headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .filter(visible)
      .map((el) => ({ level: Number(el.tagName.slice(1)), text: textOf(el), selector: cssPath(el) })),
    controls,
    dialogs,
    meta: [...document.querySelectorAll('meta[name], meta[property]')]
      .map((el) => ({ key: el.getAttribute('name') || el.getAttribute('property'), content: el.getAttribute('content') }))
  };
})()`;

export async function evaluateExpression(
  client: CdpClient,
  expression: string,
  awaitPromise = true
): Promise<EvaluateResult> {
  const Runtime = client.Runtime;
  await Runtime.enable();
  const response = (await Runtime.evaluate({
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  })) as RuntimeEvalResult;

  if (response.exceptionDetails) {
    return {
      value: null,
      exception:
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Runtime evaluation failed"
    };
  }

  const result = response.result;
  return {
    value: result?.value ?? result?.unserializableValue ?? result?.description ?? null
  };
}

export function targetDir(outDir: string, target: TargetInfo): string {
  return path.join(outDir, "targets", `${sanitizeFilePart(target.url)}-${target.id}`);
}

export async function writeSnapshot(
  client: CdpClient,
  options: SnapshotOptions
): Promise<SnapshotResult> {
  const baseDir = targetDir(options.outDir, options.target);
  const snapshotId = `${nowStamp()}-${sanitizeFilePart(options.label)}`;
  const dir = path.join(baseDir, "snapshots", snapshotId);
  const currentDir = path.join(baseDir, "current");
  await fs.ensureDir(dir);

  const [stateResult, htmlResult, textResult] = await Promise.all([
    evaluateExpression(client, PAGE_STATE_EXPRESSION),
    evaluateExpression(client, "document.documentElement.outerHTML"),
    evaluateExpression(client, "document.body ? document.body.innerText : ''")
  ]);

  if (stateResult.exception) throw new Error(stateResult.exception);
  const pageState = stateResult.value as { url?: string; title?: string };
  const helpers = helperSummaries(pageState.url ?? options.target.url);
  const meta = {
    id: snapshotId,
    label: options.label,
    createdAt: new Date().toISOString(),
    url: pageState.url ?? options.target.url,
    title: pageState.title ?? options.target.title,
    targetId: options.target.id,
    helperIds: helpers.map((helper) => helper.id)
  };

  const artifacts: ArtifactMap = {
    snapshot: dir,
    meta: path.join(dir, "meta.json"),
    state: path.join(dir, "state.json"),
    text: path.join(dir, "text.md"),
    dom: path.join(dir, "dom.html"),
    helpers: path.join(dir, "helpers.json")
  };

  await fs.writeJson(artifacts.meta, meta, { spaces: 2 });
  await fs.writeJson(artifacts.state, pageState, { spaces: 2 });
  await fs.writeFile(artifacts.text, String(textResult.value ?? ""), "utf8");
  await fs.writeFile(artifacts.dom, String(htmlResult.value ?? ""), "utf8");
  await fs.writeJson(artifacts.helpers, helpers, { spaces: 2 });

  try {
    const axTree = await client.Accessibility.getFullAXTree();
    artifacts.accessibility = path.join(dir, "accessibility.json");
    await fs.writeJson(artifacts.accessibility, axTree, { spaces: 2 });
  } catch {
    // Some targets do not expose the full accessibility tree. The core snapshot is still useful.
  }

  if (options.screenshot) {
    try {
      await client.Page.enable();
      const shot = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
      artifacts.screenshot = path.join(dir, "screenshot.png");
      await fs.writeFile(artifacts.screenshot, Buffer.from(shot.data, "base64"));
    } catch {
      // Screenshots are a backup artifact; text and DOM remain the primary projection.
    }
  }

  const diffArtifacts = await writeDiffs(currentDir, dir, path.join(baseDir, "diffs", snapshotId));
  Object.assign(artifacts, diffArtifacts);

  await fs.remove(currentDir);
  await fs.copy(dir, currentDir);
  await fs.writeJson(path.join(baseDir, "latest.json"), { meta, dir, artifacts }, { spaces: 2 });

  return { meta, dir, artifacts };
}

async function writeDiffs(currentDir: string, nextDir: string, diffDir: string): Promise<ArtifactMap> {
  if (!(await fs.pathExists(currentDir))) return {};

  await fs.ensureDir(diffDir);
  const pairs = [
    ["state", "state.json"],
    ["text", "text.md"],
    ["dom", "dom.html"],
    ["helpers", "helpers.json"]
  ] as const;
  const artifacts: ArtifactMap = {};

  for (const [name, file] of pairs) {
    const oldPath = path.join(currentDir, file);
    const newPath = path.join(nextDir, file);
    if (!(await fs.pathExists(oldPath)) || !(await fs.pathExists(newPath))) continue;
    const [oldText, newText] = await Promise.all([
      fs.readFile(oldPath, "utf8"),
      fs.readFile(newPath, "utf8")
    ]);
    if (oldText === newText) continue;
    const patch = createPatch(file, oldText, newText, "previous", "current");
    const outPath = path.join(diffDir, `${name}.diff`);
    await fs.writeFile(outPath, patch, "utf8");
    artifacts[`${name}Diff`] = outPath;
  }

  if (Object.keys(artifacts).length > 0) {
    artifacts.diffDir = diffDir;
  }

  return artifacts;
}
