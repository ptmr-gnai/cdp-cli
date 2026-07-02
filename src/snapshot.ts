import path from "node:path";
import fs from "fs-extra";
import { createPatch } from "diff";
import { nowStamp, sanitizeFilePart } from "./env.js";
import { helperSummaries } from "./helpers.js";
import { errorData, trace } from "./trace.js";
import type { ArtifactMap, HelperSummary, SnapshotMeta, SnapshotResult, TargetInfo } from "./types.js";

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

interface PageDumpRecord {
  ref?: string;
  framePath?: string[];
  selector?: string;
  tag?: string;
  attrs?: Record<string, unknown>;
  role?: string | null;
  visible?: boolean;
  rect?: unknown;
  text?: string;
  href?: string;
  src?: string | null;
  sameOrigin?: boolean;
  action?: string | null;
  method?: string | null;
  controls?: PageDumpRecord[];
  name?: string | null;
  type?: string | null;
  placeholder?: string | null;
}

interface PageResourceRecord {
  name?: string;
  initiatorType?: string;
  duration?: number;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  renderBlockingStatus?: string;
}

interface PageDump {
  tree?: string[];
  nodes?: PageDumpRecord[];
  links?: PageDumpRecord[];
  controls?: PageDumpRecord[];
  forms?: PageDumpRecord[];
  dialogs?: PageDumpRecord[];
  frames?: PageDumpRecord[];
  resources?: PageResourceRecord[];
}

interface AxTree {
  nodes?: AxNode[];
}

interface AxNode {
  nodeId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  properties?: Array<{ name?: string; value?: AxValue }>;
}

interface AxValue {
  value?: unknown;
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
    frames: [],
    resources: []
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
  const resourcesOf = () => {
    try {
      return performance.getEntriesByType('resource')
        .map((entry) => ({
          name: entry.name,
          initiatorType: entry.initiatorType || '',
          duration: Math.round(entry.duration),
          transferSize: Number(entry.transferSize || 0),
          encodedBodySize: Number(entry.encodedBodySize || 0),
          decodedBodySize: Number(entry.decodedBodySize || 0),
          renderBlockingStatus: entry.renderBlockingStatus || ''
        }))
        .slice(-500);
    } catch {
      return [];
    }
  };
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
  out.resources = resourcesOf();
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

export function buildDumpText(
  meta: SnapshotMeta,
  pageDump: PageDump,
  helpers: HelperSummary[],
  accessibilityText?: string
): string {
  const tree = pageDump.tree ?? [];
  const controls = pageDump.controls ?? [];
  const visibleControls = controls.filter((record) => record.visible);
  const forms = pageDump.forms ?? [];
  const dialogs = pageDump.dialogs ?? [];
  const frames = pageDump.frames ?? [];
  const resources = pageDump.resources ?? [];
  const nodes = pageDump.nodes ?? [];
  const links = pageDump.links ?? [];
  const helperCommands = helpers.flatMap((helper) =>
    helper.commands.map((command) => `${helper.id}.${command.name}`)
  );
  const openShadowRoots = tree.filter((line) => line.includes("#shadow-root(open)")).length;

  const lines = [
    "# cdp-cli dump v1",
    `PAGE title=${quote(meta.title)} url=${quote(meta.url)} target=${quote(meta.targetId)} snapshot=${quote(meta.id)}`,
    `COUNTS nodes=${nodes.length} controls=${controls.length} visibleControls=${visibleControls.length} links=${links.length} forms=${forms.length} dialogs=${dialogs.length} frames=${frames.length} resources=${resources.length} openShadowRoots=${openShadowRoots}`,
    `HELPERS ${helperCommands.length ? helperCommands.join(" ") : "none"}`,
    "",
    "# suggested-grep",
    "rg 'CONTROL|FORM|DIALOG|FRAME|RESOURCE|A11Y|#shadow-root|selector=' dump.txt",
    "rg 'Search|Login|Submit|Continue|Next|button|input|dialog' dump.txt",
    "",
    "# visible-controls"
  ];

  lines.push(...visibleControls.slice(0, 80).map((record) => `CONTROL ${recordLine(record)}`));
  if (visibleControls.length > 80) lines.push(`CONTROL_MORE hidden=${visibleControls.length - 80}`);
  if (visibleControls.length === 0) lines.push("CONTROL none");

  lines.push("", "# forms");
  lines.push(...forms.slice(0, 40).map((record) => {
    const controlsText = (record.controls ?? [])
      .slice(0, 20)
      .map((control) => [
        control.tag,
        control.name ? `name=${quote(control.name)}` : "",
        control.type ? `type=${quote(control.type)}` : "",
        control.placeholder ? `placeholder=${quote(control.placeholder)}` : "",
        control.text ? `text=${quote(control.text)}` : ""
      ].filter(Boolean).join(":"))
      .join(" ");
    return `FORM ${recordLine(record)} action=${quote(record.action ?? "")} method=${quote(record.method ?? "")} controls=${quote(controlsText)}`;
  }));
  if (forms.length > 40) lines.push(`FORM_MORE hidden=${forms.length - 40}`);
  if (forms.length === 0) lines.push("FORM none");

  lines.push("", "# dialogs");
  lines.push(...dialogs.slice(0, 40).map((record) => `DIALOG ${recordLine(record)}`));
  if (dialogs.length > 40) lines.push(`DIALOG_MORE hidden=${dialogs.length - 40}`);
  if (dialogs.length === 0) lines.push("DIALOG none");

  lines.push("", "# frames");
  lines.push(...frames.slice(0, 40).map((record) => `FRAME ${recordLine(record)} src=${quote(record.src ?? "")} sameOrigin=${record.sameOrigin === true}`));
  if (frames.length > 40) lines.push(`FRAME_MORE hidden=${frames.length - 40}`);
  if (frames.length === 0) lines.push("FRAME none");

  lines.push("", "# resources");
  lines.push(...resources.slice(0, 120).map((record) => `RESOURCE ${resourceLine(record)}`));
  if (resources.length > 120) lines.push(`RESOURCE_MORE hidden=${resources.length - 120}`);
  if (resources.length === 0) lines.push("RESOURCE none");

  lines.push("", "# accessibility");
  if (accessibilityText?.trim()) {
    lines.push(...accessibilityText.trimEnd().split("\n"));
  } else {
    lines.push("A11Y unavailable");
  }

  lines.push("", "# tree", ...tree);
  return `${lines.join("\n")}\n`;
}

function resourceLine(record: PageResourceRecord): string {
  return [
    record.initiatorType ? `type=${quote(record.initiatorType)}` : "",
    record.name ? `url=${quote(record.name)}` : "",
    record.duration !== undefined ? `durationMs=${record.duration}` : "",
    record.transferSize !== undefined ? `transfer=${record.transferSize}` : "",
    record.encodedBodySize !== undefined ? `encoded=${record.encodedBodySize}` : "",
    record.decodedBodySize !== undefined ? `decoded=${record.decodedBodySize}` : "",
    record.renderBlockingStatus ? `renderBlocking=${quote(record.renderBlockingStatus)}` : ""
  ].filter(Boolean).join(" ");
}

export function buildAccessibilityText(axTree: AxTree): string {
  const nodes = axTree.nodes ?? [];
  const lines = ["# cdp-cli accessibility v1"];
  if (nodes.length === 0) {
    lines.push("A11Y none");
    return `${lines.join("\n")}\n`;
  }
  for (const node of nodes) {
    const role = axString(node.role);
    const name = axString(node.name);
    const value = axString(node.value);
    const description = axString(node.description);
    const props = (node.properties ?? [])
      .map((property) => {
        const propertyValue = axString(property.value);
        return property.name && propertyValue ? `${property.name}=${quote(propertyValue)}` : "";
      })
      .filter(Boolean)
      .slice(0, 20)
      .join(" ");
    lines.push([
      `A11Y [${node.nodeId ?? "unknown"}]`,
      role ? `role=${quote(role)}` : "",
      name ? `name=${quote(name)}` : "",
      value ? `value=${quote(value)}` : "",
      description ? `description=${quote(description)}` : "",
      node.ignored !== undefined ? `ignored=${node.ignored}` : "",
      node.childIds?.length ? `children=${quote(node.childIds.join(","))}` : "",
      props ? `props={${props}}` : ""
    ].filter(Boolean).join(" "));
  }
  return `${lines.join("\n")}\n`;
}

function axString(value: AxValue | undefined): string {
  const raw = value?.value;
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw.replace(/\s+/g, " ").trim();
  return String(raw);
}

function recordLine(record: PageDumpRecord): string {
  return [
    record.ref ? `[${record.ref}]` : "",
    record.framePath?.length ? `path=${quote(record.framePath.join(" > "))}` : "",
    record.tag ? `<${record.tag}>` : "",
    record.role ? `role=${quote(record.role)}` : "",
    record.selector ? `selector=${quote(record.selector)}` : "",
    record.visible !== undefined ? `visible=${record.visible}` : "",
    record.rect ? `rect=${JSON.stringify(record.rect)}` : "",
    record.text ? `text=${quote(record.text)}` : "",
    record.attrs ? attrsLine(record.attrs) : ""
  ].filter(Boolean).join(" ");
}

function attrsLine(attrs: Record<string, unknown>): string {
  const entries = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 16)
    .map(([key, value]) => `${key}=${quote(value)}`);
  return entries.length ? `attrs={${entries.join(" ")}}` : "";
}

function quote(value: unknown): string {
  return JSON.stringify(String(value ?? "").replace(/\s+/g, " ").trim());
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
  const pageDump = dumpResult.value as PageDump;
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
    resources: path.join(dir, "resources.ndjson"),
    helpers: path.join(dir, "helpers.json")
  };

  await fs.ensureDir(dir);
  await fs.writeJson(artifacts.meta, meta, { spaces: 2 });
  await fs.writeJson(artifacts.state, pageState, { spaces: 2 });
  await fs.writeFile(artifacts.text, String(textResult.value ?? ""), "utf8");
  await fs.writeFile(artifacts.dom, String(htmlResult.value ?? ""), "utf8");
  await writeNdjson(artifacts.nodes, pageDump.nodes ?? []);
  await writeNdjson(artifacts.links, pageDump.links ?? []);
  await writeNdjson(artifacts.controls, controls);
  await writeNdjson(artifacts.visibleControls, visibleControls);
  await writeNdjson(artifacts.forms, pageDump.forms ?? []);
  await writeNdjson(artifacts.dialogs, pageDump.dialogs ?? []);
  await writeNdjson(artifacts.frames, pageDump.frames ?? []);
  await writeNdjson(artifacts.resources, pageDump.resources ?? []);
  await fs.writeJson(artifacts.helpers, helpers, { spaces: 2 });

  let accessibilityText: string | undefined;
  try {
    await trace({ event: "snapshot.accessibility.start", data: { label: options.label } });
    const axTree = await withTimeout(client.Accessibility.getFullAXTree(), 8000, "Accessibility.getFullAXTree");
    artifacts.accessibility = path.join(dir, "accessibility.json");
    artifacts.accessibilityText = path.join(dir, "accessibility.txt");
    await fs.writeJson(artifacts.accessibility, axTree, { spaces: 2 });
    accessibilityText = buildAccessibilityText(axTree as AxTree);
    await fs.writeFile(artifacts.accessibilityText, accessibilityText, "utf8");
    await trace({ event: "snapshot.accessibility.done", ok: true, data: { label: options.label } });
  } catch (error) {
    await trace({ event: "snapshot.accessibility.failed", error: errorData(error) });
    // Some targets do not expose the full accessibility tree. The core snapshot is still useful.
  }

  await fs.writeFile(artifacts.dump, buildDumpText(meta, pageDump, helpers, accessibilityText), "utf8");

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
    ["frames", "frames.ndjson"],
    ["resources", "resources.ndjson"],
    ["accessibilityText", "accessibility.txt"],
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
