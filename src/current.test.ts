import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { describe, expect, it } from "vitest";
import { readCurrentSnapshotSummary } from "./current.js";
import type { TargetInfo } from "./types.js";

const target: TargetInfo = {
  id: "TARGET123",
  type: "page",
  title: "Example",
  url: "https://example.com"
};

describe("readCurrentSnapshotSummary", () => {
  it("returns snapshot and navigate commands when no current files exist", async () => {
    const outDir = await makeOutDir();

    await expect(readCurrentSnapshotSummary(outDir, target)).resolves.toMatchObject({
      current: {
        dir: null,
        artifacts: {},
        files: [],
        counts: {},
        diffs: null
      },
      nextCommands: [
        'cdp-cli snapshot --target "TARGET123"',
        'cdp-cli navigate https://example.com --target "TARGET123"'
      ]
    });
  });

  it("summarizes current artifact paths, file sizes, lines, and index counts", async () => {
    const outDir = await makeOutDir();
    const current = path.join(outDir, "targets", "example.com-TARGET123", "current");
    await fs.ensureDir(current);
    await fs.writeJson(path.join(current, "meta.json"), {
      id: "snap1",
      label: "manual",
      createdAt: "2026-07-02T00:00:00.000Z",
      url: "https://example.com",
      title: "Example",
      targetId: "TARGET123",
      helperIds: ["generic"]
    });
    await fs.writeFile(path.join(current, "dump.txt"), "[n000001] <button> text=\"Search\"\n");
    await fs.writeFile(
      path.join(current, "actionable-controls.ndjson"),
      [
        { ref: "n000003", stableRef: "r_logo00000000", selector: "a.logo", tag: "a", attrs: { href: "/" }, visible: true, text: "", recommendedAction: "click", confidence: 35, reasons: ["visible", "link"] },
        { ref: "n000017", stableRef: "r_searchbutton1", selector: "button", tag: "button", visible: true, text: "Search", recommendedAction: "click", confidence: 55, reasons: ["visible", "clickable", "action text"] },
        { ref: "n000042", stableRef: "r_emailinput01", selector: "input", tag: "input", attrs: { type: "text" }, accessibleName: "Email address", visible: true, recommendedAction: "fill", confidence: 70, reasons: ["visible", "fillable"] }
      ].map((record) => JSON.stringify(record)).join("\n") + "\n"
    );
    await fs.writeFile(
      path.join(current, "visible-controls.ndjson"),
      [
        { ref: "n000003", selector: "a.logo", tag: "a", attrs: { href: "/" }, visible: true, text: "" },
        { ref: "n000017", selector: "button", tag: "button", visible: true, text: "Search" },
        { ref: "n000042", selector: "input", tag: "input", attrs: { type: "text" }, accessibleName: "Email address", visible: true }
      ].map((record) => JSON.stringify(record)).join("\n") + "\n"
    );
    await fs.writeFile(path.join(current, "nodes.ndjson"), `${JSON.stringify({ ref: "n000001" })}\n`);
    await fs.writeFile(path.join(current, "forms.ndjson"), "");
    await fs.writeFile(path.join(current, "dialogs.ndjson"), "");
    await fs.writeFile(path.join(current, "resources.ndjson"), `${JSON.stringify({ name: "https://example.com/app.js" })}\n`);
    await fs.writeFile(path.join(current, "scripts.ndjson"), `${JSON.stringify({ src: "https://example.com/app.js" })}\n`);
    const diffDir = path.join(outDir, "targets", "example.com-TARGET123", "diffs", "snap1");
    await fs.ensureDir(diffDir);
    await fs.writeFile(
      path.join(diffDir, "dump.diff"),
      [
        "--- dump.txt\tprevious",
        "+++ dump.txt\tcurrent",
        "@@ -1 +1,2 @@",
        " [n000001] <button> text=\"Search\"",
        "+[n000099] <div> role=\"dialog\" text=\"Cookie consent\"",
        "-[n000050] <button> text=\"Old\"",
        ""
      ].join("\n")
    );
    await fs.writeJson(path.join(outDir, "targets", "example.com-TARGET123", "latest.json"), {
      artifacts: { diffDir }
    });

    const summary = await readCurrentSnapshotSummary(outDir, target);

    expect(summary.current.dir).toBe(current);
    expect(summary.current.meta?.title).toBe("Example");
    expect(summary.current.artifacts["dump.txt"]).toBe(path.join(current, "dump.txt"));
    expect(summary.current.counts).toMatchObject({
      nodes: 1,
      visibleControls: 3,
      forms: 0,
      dialogs: 0,
      resources: 1,
      scripts: 1
    });
    expect(summary.current.refs).toMatchObject({
      firstVisibleControl: { ref: "n000017", tag: "button", text: "Search" },
      firstFillable: { ref: "n000042", tag: "input", text: "Email address" }
    });
    expect(summary.current.diffs).toMatchObject({
      dir: diffDir,
      totals: { files: 1, additions: 1, removals: 1, hunks: 1 },
      files: [
        expect.objectContaining({
          name: "dump.diff",
          additions: 1,
          removals: 1,
          hunks: 1
        })
      ]
    });
    expect(summary.current.refs.candidates[0]).toMatchObject({
      ref: "n000042",
      stableRef: "r_emailinput01",
      reasons: expect.arrayContaining(["input hint", "fillable"])
    });
    expect(summary.current.refs.candidates.find((candidate) => candidate.ref === "n000042")).toMatchObject({
      ref: "n000042",
      reasons: expect.arrayContaining(["fillable"])
    });
    expect(summary.current.refs.candidates.map((candidate) => candidate.ref).indexOf("n000003"))
      .toBeGreaterThan(summary.current.refs.candidates.map((candidate) => candidate.ref).indexOf("n000017"));
    expect(summary.current.files).toContainEqual(expect.objectContaining({
      name: "actionable-controls.ndjson",
      exists: true,
      lines: 3
    }));
    expect(summary.current.files).toContainEqual(expect.objectContaining({
      name: "visible-controls.ndjson",
      exists: true,
      lines: 3
    }));
    expect(summary.suggestedSearches.join("\n")).toContain("rg");
    expect(summary.suggestedSearches.join("\n")).toContain(diffDir);
    expect(summary.nextCommands).toContain('cdp-cli click r_searchbutton1 --target "TARGET123"');
    expect(summary.nextCommands).toContain('cdp-cli fill r_emailinput01 \'text\' --target "TARGET123"');
  });
});

async function makeOutDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cdp-cli-current-"));
}
