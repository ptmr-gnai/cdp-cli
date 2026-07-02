import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { describe, expect, it } from "vitest";
import { evaluateSnapshotQuality } from "./evalSites.js";

describe("evaluateSnapshotQuality", () => {
  it("passes a file-first snapshot with required artifacts and indexes", async () => {
    const dir = await makeSnapshotDir();
    await writeRequiredArtifacts(dir);
    await fs.writeFile(path.join(dir, "dump.txt"), [
      "[n000001] <html> selector=\"html\" visible=true",
      "  [n000002] <body> selector=\"html > body\" visible=true",
      "    [n000003] <button> selector=\"button\" visible=true text=\"Go\"",
      "    [n000004] #shadow-root(open)",
      "      [n000005] <span> selector=\"span\" visible=true text=\"Help\""
    ].join("\n") + "\n");
    await fs.writeFile(path.join(dir, "text.md"), "Go\nHelp\n");
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
        dumpLines: 5,
        textLines: 2,
        nodes: 2,
        controls: 1,
        visibleControls: 1,
        openShadowRoots: 1
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
    expect(quality.warnings).toContain("nodes.ndjson has no records");
    expect(quality.warnings).toContain("text.md has no readable text lines");
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
    fs.writeJson(path.join(dir, "dom-snapshot.json"), {}),
    fs.writeJson(path.join(dir, "helpers.json"), [])
  ]);
}

async function writeNdjson(file: string, records: unknown[]): Promise<void> {
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
}
