import path from "node:path";
import fs from "fs-extra";
import { createPatch } from "diff";
import { nowStamp, sanitizeFilePart } from "./env.js";
import { helperSummaries } from "./helpers.js";
import { errorData, trace } from "./trace.js";
import type { ArtifactMap, SnapshotResult, TargetInfo } from "./types.js";

type CdpClient = any;

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
  const sensitivePattern = /token|authenticity|csrf|xsrf|password|passwd|secret|session|credential|key/i;
  const isSensitiveInput = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const name = el.getAttribute('name') || '';
    const id = el.getAttribute('id') || '';
    return type === 'hidden' || type === 'password' || sensitivePattern.test(name) || sensitivePattern.test(id);
  };
  const valueOf = (el) => {
    if (!('value' in el)) return null;
    if (isSensitiveInput(el)) return el.value ? '[redacted]' : '';
    return el.value;
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
      value: valueOf(el),
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

const PAGE_DUMP_EXPRESSION = `(() => {
  const out = {
    tree: [],
    nodes: [],
    links: [],
    controls: [],
    forms: [],
    dialogs: [],
    frames: []
  };
  let seq = 0;
  const seen = new WeakSet();
  const esc = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
  const clip = (value, max = 240) => {
    const text = esc(value);
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  };
  const quote = (value) => JSON.stringify(esc(value));
  const rectOf = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    } catch {
      return null;
    }
  };
  const visible = (el) => {
    try {
      const style = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  };
  const sensitivePattern = /token|authenticity|csrf|xsrf|password|passwd|secret|session|credential|key/i;
  const isSensitiveInput = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const name = el.getAttribute('name') || '';
    const id = el.getAttribute('id') || '';
    return type === 'hidden' || type === 'password' || sensitivePattern.test(name) || sensitivePattern.test(id);
  };
  const valueOf = (el) => {
    if (!('value' in el)) return '';
    if (isSensitiveInput(el)) return el.value ? '[redacted]' : '';
    return el.value || '';
  };
  const attrValueOf = (el, attr) => {
    if (attr.name === 'value' && isSensitiveInput(el)) return attr.value ? '[redacted]' : '';
    return attr.value;
  };
  const cssPath = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 10) {
      let part = node.localName;
      const testId = node.getAttribute('data-testid') || node.getAttribute('data-test-id') || node.getAttribute('data-cy');
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
  const attrsOf = (el) => {
    const keep = new Set([
      'id', 'class', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-modal',
      'name', 'type', 'placeholder', 'value', 'href', 'src', 'alt', 'title', 'for', 'data-testid',
      'data-test-id', 'data-cy', 'contenteditable', 'disabled', 'checked', 'selected'
    ]);
    return [...el.attributes]
      .filter((attr) => keep.has(attr.name) || attr.name.startsWith('aria-'))
      .map((attr) => [attr.name, attrValueOf(el, attr)]);
  };
  const directTextOf = (el) => clip([...el.childNodes]
    .filter((child) => child.nodeType === Node.TEXT_NODE)
    .map((child) => child.nodeValue || '')
    .join(' '));
  const labelOf = (el) => {
    if (el.localName === 'script') return el.textContent ? '[script text omitted]' : '';
    if (el.localName === 'template') return el.textContent ? '[template text omitted]' : '';
    return clip(
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      el.getAttribute('placeholder') ||
      valueOf(el) ||
      directTextOf(el) ||
      (el.children.length === 0 ? el.textContent : '')
    );
  };
  const textOf = (el) => {
    if (el.localName === 'script') return el.textContent ? '[script text omitted]' : '';
    if (el.localName === 'template') return el.textContent ? '[template text omitted]' : '';
    return clip(el.innerText || el.textContent || labelOf(el), 500);
  };
  const nodeRecord = (el, ref, framePath) => ({
    ref,
    framePath,
    selector: cssPath(el),
    tag: el.localName,
    attrs: Object.fromEntries(attrsOf(el)),
    role: el.getAttribute('role'),
    visible: visible(el),
    rect: rectOf(el),
    text: textOf(el)
  });
  const isControl = (el) => el.matches?.('a[href], button, input, textarea, select, option, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [contenteditable="true"]');
  const isDialog = (el) => el.matches?.('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover]');
  const walk = (root, depth, framePath) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    const children = root.nodeType === Node.DOCUMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      ? [...root.childNodes]
      : [...root.childNodes];
    for (const node of children) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = esc(node.nodeValue || '');
        const parentTag = node.parentElement?.localName;
        if (text && parentTag === 'script') out.tree.push('  '.repeat(depth) + '[script text omitted]');
        else if (text && parentTag === 'template') out.tree.push('  '.repeat(depth) + '[template text omitted]');
        else if (text) out.tree.push('  '.repeat(depth) + '[text] ' + quote(text));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node;
      const ref = 'n' + String(++seq).padStart(6, '0');
      const attrs = attrsOf(el).map(([k, v]) => k + '=' + quote(v)).join(' ');
      const line = [
        '[' + ref + ']',
        '<' + el.localName + (attrs ? ' ' + attrs : '') + '>',
        'selector=' + quote(cssPath(el) || ''),
        'visible=' + visible(el),
        'rect=' + JSON.stringify(rectOf(el)),
        labelOf(el) ? 'text=' + quote(labelOf(el)) : ''
      ].filter(Boolean).join(' ');
      out.tree.push('  '.repeat(depth) + line);
      const record = nodeRecord(el, ref, framePath);
      out.nodes.push(record);
      if (el.localName === 'a' && el.href) out.links.push({ ...record, href: el.href });
      if (isControl(el)) out.controls.push(record);
      if (isDialog(el)) out.dialogs.push(record);
      if (el.localName === 'form') {
        out.forms.push({
          ...record,
          action: el.action || null,
          method: el.method || null,
          controls: [...el.querySelectorAll('input, textarea, select, button')]
            .map((control) => ({
              selector: cssPath(control),
              tag: control.localName,
              name: control.getAttribute('name'),
              type: control.getAttribute('type'),
              placeholder: control.getAttribute('placeholder'),
              text: textOf(control)
            }))
        });
      }
      if (el.shadowRoot) {
        out.tree.push('  '.repeat(depth + 1) + '#shadow-root(open) host=' + ref);
        walk(el.shadowRoot, depth + 2, framePath.concat(ref + '#shadow-root'));
      }
      if (el.localName === 'iframe' || el.localName === 'frame') {
        const frameInfo = { ...record, src: el.src || null, sameOrigin: false };
        try {
          if (el.contentDocument) {
            frameInfo.sameOrigin = true;
            out.frames.push(frameInfo);
            out.tree.push('  '.repeat(depth + 1) + '#frame same-origin src=' + quote(el.src || ''));
            walk(el.contentDocument, depth + 2, framePath.concat(ref + '#frame'));
            continue;
          }
        } catch {}
        out.frames.push(frameInfo);
        out.tree.push('  '.repeat(depth + 1) + '#frame cross-origin src=' + quote(el.src || ''));
      }
      walk(el, depth + 1, framePath);
    }
  };
  walk(document, 0, ['top']);
  return out;
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
    userGesture: true,
    timeout: 15000
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

export function targetDir(outDir: string, target: TargetInfo, url = target.url): string {
  return path.join(outDir, "targets", `${sanitizeFilePart(url)}-${target.id}`);
}

export async function writeSnapshot(
  client: CdpClient,
  options: SnapshotOptions
): Promise<SnapshotResult> {
  const snapshotId = `${nowStamp()}-${sanitizeFilePart(options.label)}`;
  await trace({ event: "snapshot.start", data: { label: options.label, targetId: options.target.id } });

  await trace({ event: "snapshot.evaluate.start", data: { label: options.label } });
  const [stateResult, htmlResult, textResult, dumpResult] = await Promise.all([
    evaluateExpression(client, PAGE_STATE_EXPRESSION),
    evaluateExpression(client, "document.documentElement.outerHTML"),
    evaluateExpression(client, "document.body ? document.body.innerText : ''"),
    evaluateExpression(client, PAGE_DUMP_EXPRESSION)
  ]);
  await trace({ event: "snapshot.evaluate.done", ok: true, data: { label: options.label } });

  if (stateResult.exception) throw new Error(stateResult.exception);
  if (dumpResult.exception) throw new Error(dumpResult.exception);
  const pageState = stateResult.value as { url?: string; title?: string };
  const pageDump = dumpResult.value as {
    tree?: string[];
    nodes?: unknown[];
    links?: unknown[];
    controls?: unknown[];
    forms?: unknown[];
    dialogs?: unknown[];
    frames?: unknown[];
  };
  const controls = pageDump.controls ?? [];
  const visibleControls = controls.filter((record) => {
    return Boolean((record as { visible?: unknown })?.visible);
  });
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
  const baseDir = targetDir(options.outDir, options.target, meta.url);
  const dir = path.join(baseDir, "snapshots", snapshotId);
  const currentDir = path.join(baseDir, "current");

  const artifacts: ArtifactMap = {
    snapshot: dir,
    meta: path.join(dir, "meta.json"),
    state: path.join(dir, "state.json"),
    dump: path.join(dir, "dump.txt"),
    text: path.join(dir, "text.md"),
    dom: path.join(dir, "dom.html"),
    nodes: path.join(dir, "nodes.ndjson"),
    links: path.join(dir, "links.ndjson"),
    controls: path.join(dir, "controls.ndjson"),
    visibleControls: path.join(dir, "visible-controls.ndjson"),
    forms: path.join(dir, "forms.ndjson"),
    dialogs: path.join(dir, "dialogs.ndjson"),
    frames: path.join(dir, "frames.ndjson"),
    helpers: path.join(dir, "helpers.json")
  };

  await fs.ensureDir(dir);
  await fs.writeJson(artifacts.meta, meta, { spaces: 2 });
  await fs.writeJson(artifacts.state, pageState, { spaces: 2 });
  await fs.writeFile(artifacts.dump, `${(pageDump.tree ?? []).join("\n")}\n`, "utf8");
  await fs.writeFile(artifacts.text, String(textResult.value ?? ""), "utf8");
  await fs.writeFile(artifacts.dom, String(htmlResult.value ?? ""), "utf8");
  await writeNdjson(artifacts.nodes, pageDump.nodes ?? []);
  await writeNdjson(artifacts.links, pageDump.links ?? []);
  await writeNdjson(artifacts.controls, controls);
  await writeNdjson(artifacts.visibleControls, visibleControls);
  await writeNdjson(artifacts.forms, pageDump.forms ?? []);
  await writeNdjson(artifacts.dialogs, pageDump.dialogs ?? []);
  await writeNdjson(artifacts.frames, pageDump.frames ?? []);
  await fs.writeJson(artifacts.helpers, helpers, { spaces: 2 });

  try {
    await trace({ event: "snapshot.accessibility.start", data: { label: options.label } });
    const axTree = await withTimeout(client.Accessibility.getFullAXTree(), 8000, "Accessibility.getFullAXTree");
    artifacts.accessibility = path.join(dir, "accessibility.json");
    await fs.writeJson(artifacts.accessibility, axTree, { spaces: 2 });
    await trace({ event: "snapshot.accessibility.done", ok: true, data: { label: options.label } });
  } catch (error) {
    await trace({ event: "snapshot.accessibility.failed", error: errorData(error) });
    // Some targets do not expose the full accessibility tree. The core snapshot is still useful.
  }

  try {
    await trace({ event: "snapshot.dom_snapshot.start", data: { label: options.label } });
    const domSnapshot = await withTimeout(client.DOMSnapshot.captureSnapshot({
      computedStyles: [],
      includeDOMRects: true,
      includePaintOrder: true,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false
    }), 8000, "DOMSnapshot.captureSnapshot");
    artifacts.domSnapshot = path.join(dir, "dom-snapshot.json");
    await fs.writeJson(artifacts.domSnapshot, domSnapshot, { spaces: 2 });
    await trace({ event: "snapshot.dom_snapshot.done", ok: true, data: { label: options.label } });
  } catch (error) {
    await trace({ event: "snapshot.dom_snapshot.failed", error: errorData(error) });
    // DOMSnapshot is best-effort; dump.txt and dom.html remain the load-bearing files.
  }

  if (options.screenshot) {
    try {
      await trace({ event: "snapshot.screenshot.start", data: { label: options.label } });
      await client.Page.enable();
      const shot = (await withTimeout(
        client.Page.captureScreenshot({ format: "png", fromSurface: true }),
        8000,
        "Page.captureScreenshot"
      )) as { data: string };
      artifacts.screenshot = path.join(dir, "screenshot.png");
      await fs.writeFile(artifacts.screenshot, Buffer.from(shot.data, "base64"));
      await trace({ event: "snapshot.screenshot.done", ok: true, data: { label: options.label } });
    } catch (error) {
      await trace({ event: "snapshot.screenshot.failed", error: errorData(error) });
      // Screenshots are a backup artifact; text and DOM remain the primary projection.
    }
  }

  const diffArtifacts = await writeDiffs(currentDir, dir, path.join(baseDir, "diffs", snapshotId));
  Object.assign(artifacts, diffArtifacts);

  await fs.remove(currentDir);
  await fs.copy(dir, currentDir);
  await fs.writeJson(path.join(baseDir, "latest.json"), { meta, dir, artifacts }, { spaces: 2 });
  await trace({ event: "snapshot.done", ok: true, data: { label: options.label, dir } });

  return { meta, dir, artifacts };
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

async function writeDiffs(currentDir: string, nextDir: string, diffDir: string): Promise<ArtifactMap> {
  if (!(await fs.pathExists(currentDir))) return {};

  await fs.ensureDir(diffDir);
  const pairs = [
    ["state", "state.json"],
    ["dump", "dump.txt"],
    ["text", "text.md"],
    ["dom", "dom.html"],
    ["nodes", "nodes.ndjson"],
    ["links", "links.ndjson"],
    ["controls", "controls.ndjson"],
    ["visibleControls", "visible-controls.ndjson"],
    ["forms", "forms.ndjson"],
    ["dialogs", "dialogs.ndjson"],
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

async function writeNdjson(file: string, records: unknown[]): Promise<void> {
  const lines = records.map((record) => JSON.stringify(record));
  await fs.writeFile(file, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}
