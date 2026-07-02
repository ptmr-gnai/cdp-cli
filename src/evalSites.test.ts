import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { describe, expect, it } from "vitest";
import { evaluateSnapshotQuality, summarizeEvalSiteResults } from "./evalSites.js";

describe("evaluateSnapshotQuality", () => {
  it("passes a file-first snapshot with required artifacts and indexes", async () => {
    const dir = await makeSnapshotDir();
    await writeRequiredArtifacts(dir);
    await fs.writeFile(path.join(dir, "dump.txt"), [
      "# cdp-cli dump v1",
      "PAGE title=\"Example\" url=\"https://example.com\" target=\"TARGET123\" snapshot=\"snap1\"",
      "COUNTS nodes=2 controls=1 visibleControls=1 links=0 forms=0 dialogs=0 frames=0 openShadowRoots=1",
      "HELPERS generic.links generic.forms",
      "",
      "# suggested-grep",
      "rg 'CONTROL|FORM|DIALOG|FRAME|A11Y|#shadow-root|selector=' dump.txt",
      "",
      "# visible-controls",
      "CONTROL [n000003] path=\"top\" <button> selector=\"button\" visible=true text=\"Go\"",
      "",
      "# forms",
      "FORM none",
      "",
      "# dialogs",
      "DIALOG none",
      "",
      "# frames",
      "FRAME none",
      "",
      "# accessibility",
      "# cdp-cli accessibility v1",
      "A11Y [1] role=\"RootWebArea\" name=\"Example\" children=\"2\"",
      "A11Y [2] role=\"button\" name=\"Go\"",
      "",
      "# tree",
      "[n000001] <html> selector=\"html\" visible=true",
      "  [n000002] <body> selector=\"html > body\" visible=true",
      "    [n000003] <button> selector=\"button\" visible=true text=\"Go\"",
      "    [n000004] #shadow-root(open)",
      "      [n000005] <span> selector=\"span\" visible=true text=\"Help\""
    ].join("\n") + "\n");
    await fs.writeFile(path.join(dir, "text.md"), "Go\nHelp\n");
    await fs.writeFile(path.join(dir, "accessibility.txt"), [
      "# cdp-cli accessibility v1",
      "A11Y [1] role=\"RootWebArea\" name=\"Example\" children=\"2\"",
      "A11Y [2] role=\"button\" name=\"Go\""
    ].join("\n") + "\n");
    await writeNdjson(path.join(dir, "nodes.ndjson"), [{ ref: "n000001" }, { ref: "n000003" }]);
    await writeNdjson(path.join(dir, "links.ndjson"), []);
    await writeNdjson(path.join(dir, "controls.ndjson"), [{ ref: "n000003" }]);
    await writeNdjson(path.join(dir, "visible-controls.ndjson"), [{ ref: "n000003", visible: true }]);
    await writeNdjson(path.join(dir, "forms.ndjson"), []);
    await writeNdjson(path.join(dir, "dialogs.ndjson"), []);
    await writeNdjson(path.join(dir, "frames.ndjson"), []);

    await expect(evaluateSnapshotQuality(dir)).resolves.toMatchObject({
      ok: true,
      counts: {
        dumpLines: 31,
        accessibilityLines: 3,
        textLines: 2,
        nodes: 2,
        controls: 1,
        visibleControls: 1,
        openShadowRoots: 1
      },
      dumpSections: {
        page: true,
        counts: true,
        helpers: true,
        suggestedGrep: true,
        accessibility: true,
        tree: true
      },
      warnings: []
    });
  });

  it("warns when an artifact projection is too thin to be useful", async () => {
    const dir = await makeSnapshotDir();
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, "dump.txt"), "[n000001] <html>\n");

    const quality = await evaluateSnapshotQuality(dir);

    expect(quality.ok).toBe(false);
    expect(quality.warnings).toContain("missing required artifact: accessibility.json");
    expect(quality.warnings).toContain("dump.txt is too small: 1 lines");
    expect(quality.warnings).toContain("dump.txt missing section: page");
    expect(quality.warnings).toContain("dump.txt missing section: tree");
    expect(quality.warnings).toContain("nodes.ndjson has no records");
    expect(quality.warnings).toContain("text.md has no readable text lines");
  });

  it("summarizes eval site results into an agent-readable matrix", () => {
    const summary = summarizeEvalSiteResults([
      {
        id: "ok-site",
        url: "https://example.com",
        ok: true,
        snapshotDir: "/tmp/snap",
        quality: {
          ok: true,
          requiredFiles: { "dump.txt": true },
          dumpSections: { page: true, tree: true },
          counts: {
            dumpLines: 20,
            accessibilityLines: 3,
            textLines: 3,
            nodes: 7,
            links: 1,
            controls: 2,
            visibleControls: 2,
            forms: 1,
            dialogs: 0,
            frames: 0,
            openShadowRoots: 0
          },
          suggestedSearches: ["rg CONTROL /tmp/snap/dump.txt"],
          warnings: []
        }
      },
      {
        id: "thin-site",
        url: "https://thin.example",
        ok: false,
        quality: {
          ok: false,
          requiredFiles: { "dump.txt": true, "accessibility.json": false },
          dumpSections: { page: true, tree: false },
          counts: {
            dumpLines: 1,
            accessibilityLines: 0,
            textLines: 0,
            nodes: 0,
            links: 0,
            controls: 0,
            visibleControls: 0,
            forms: 0,
            dialogs: 0,
            frames: 0,
            openShadowRoots: 0
          },
          suggestedSearches: [],
          warnings: ["missing required artifact: accessibility.json", "dump.txt missing section: tree"]
        }
      }
    ]);

    expect(summary).toMatchObject({
      ok: 1,
      failed: 1,
      matrix: [
        { id: "ok-site", ok: true, snapshotDir: "/tmp/snap", warnings: [], suggestedSearches: ["rg CONTROL /tmp/snap/dump.txt"] },
        { id: "thin-site", ok: false, warnings: ["missing required artifact: accessibility.json", "dump.txt missing section: tree"] }
      ],
      failedRequiredFiles: [{ id: "thin-site", files: ["accessibility.json"] }],
      failedDumpSections: [{ id: "thin-site", sections: ["tree"] }]
    });
  });
});

async function makeSnapshotDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cdp-cli-quality-"));
}

async function writeRequiredArtifacts(dir: string): Promise<void> {
  await fs.ensureDir(dir);
  await Promise.all([
    fs.writeJson(path.join(dir, "meta.json"), {}),
    fs.writeJson(path.join(dir, "state.json"), {}),
    fs.writeFile(path.join(dir, "dom.html"), "<html></html>"),
    fs.writeJson(path.join(dir, "accessibility.json"), {}),
    fs.writeFile(path.join(dir, "accessibility.txt"), "# cdp-cli accessibility v1\n"),
    fs.writeJson(path.join(dir, "dom-snapshot.json"), {}),
    fs.writeJson(path.join(dir, "helpers.json"), [])
  ]);
}

async function writeNdjson(file: string, records: unknown[]): Promise<void> {
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
}
