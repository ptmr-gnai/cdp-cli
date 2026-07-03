import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { describe, expect, it } from "vitest";
import { evaluateSnapshotQuality, summarizeEvalSiteResults } from "./evalSites.js";

describe("evaluateSnapshotQuality", () => {
  it("passes a file-first snapshot with required artifacts and indexes", async () => {
    const dir = await makeSnapshotDir();
    await writeRequiredArtifacts(dir);
    await fs.writeJson(path.join(dir, "state.json"), {
      url: "https://example.com",
      title: "Example",
      readyState: "complete"
    });
    await fs.writeFile(path.join(dir, "dump.txt"), [
      "# cdp-cli dump v1",
      "PAGE title=\"Example\" url=\"https://example.com\" target=\"TARGET123\" snapshot=\"snap1\"",
      "COUNTS nodes=2 controls=1 visibleControls=1 links=0 forms=0 dialogs=0 frames=0 resources=1 scripts=1 openShadowRoots=1",
      "HELPERS generic.links generic.forms",
      "",
      "# suggested-grep",
      "rg 'CONTROL|FORM|DIALOG|FRAME|RESOURCE|SCRIPT|A11Y|#shadow-root|selector=' dump.txt",
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
      "# resources",
      "RESOURCE type=\"script\" url=\"https://example.com/app.js\" durationMs=12 transfer=512 encoded=400 decoded=800",
      "",
      "# scripts",
      "SCRIPT inline=false src=\"https://example.com/app.js\" selector=\"html > body > script\" chars=0",
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
    await writeNdjson(path.join(dir, "resources.ndjson"), [{ name: "https://example.com/app.js", initiatorType: "script" }]);
    await writeNdjson(path.join(dir, "scripts.ndjson"), [{ src: "https://example.com/app.js", inline: false }]);

    await expect(evaluateSnapshotQuality(dir)).resolves.toMatchObject({
      ok: true,
      counts: {
        dumpLines: 37,
        accessibilityLines: 3,
        textLines: 2,
        nodes: 2,
        controls: 1,
        visibleControls: 1,
        resources: 1,
        scripts: 1,
        openShadowRoots: 1
      },
      dumpSections: {
        page: true,
        counts: true,
        helpers: true,
        suggestedGrep: true,
        resources: true,
        scripts: true,
        accessibility: true,
        tree: true
      },
      coverage: {
        filesReady: true,
        dumpNavigable: true,
        pageReady: true,
        challengeLikely: false,
        grepReady: true,
        actionReady: true,
        accessibilityReady: true,
        networkReady: true,
        frameCoverage: false,
        shadowCoverage: true,
        dialogCoverage: false
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
    expect(quality.warnings).toContain("accessibility.txt is too thin for a11y-first inspection");
    expect(quality.warnings).toContain("resources.ndjson and scripts.ndjson have no records");
    expect(quality.warnings).toContain("page readyState is null");
    expect(quality.coverage).toMatchObject({
      filesReady: false,
      dumpNavigable: false,
      pageReady: false,
      challengeLikely: false,
      grepReady: false,
      actionReady: false,
      accessibilityReady: false,
      networkReady: false
    });
    expect(quality.suggestedSearches.join("\n")).toContain("visible-controls.ndjson");
    expect(quality.suggestedSearches.join("\n")).toContain("resources.ndjson");
  });

  it("warns when a snapshot looks like an unfinished challenge page", async () => {
    const dir = await makeSnapshotDir();
    await writeRequiredArtifacts(dir);
    await fs.writeJson(path.join(dir, "meta.json"), {
      url: "https://www.example.com/?js_challenge=1&token=abc",
      title: ""
    });
    await fs.writeJson(path.join(dir, "state.json"), {
      url: "https://www.example.com/?js_challenge=1&token=abc",
      title: "",
      readyState: "loading",
      activeElement: {
        selector: "html > body",
        tag: "body",
        text: "window.__CF$cv$params={}; a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';"
      }
    });
    await fs.writeFile(path.join(dir, "dump.txt"), [
      "# cdp-cli dump v1",
      "PAGE title=\"\" url=\"https://www.example.com/?js_challenge=1&token=abc\" target=\"T\" snapshot=\"S\"",
      "COUNTS nodes=1 controls=0 visibleControls=0 links=0 forms=0 dialogs=0 frames=0 resources=0 scripts=0 openShadowRoots=0",
      "HELPERS generic.links generic.forms",
      "",
      "# suggested-grep",
      "rg 'CONTROL|FORM|DIALOG|FRAME|RESOURCE|SCRIPT|A11Y|#shadow-root|selector=' dump.txt",
      "",
      "# visible-controls",
      "CONTROL none",
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
      "# resources",
      "RESOURCE type=\"script\" url=\"https://discord.com/cdn-cgi/challenge-platform/scripts/jsd/main.js\"",
      "",
      "# scripts",
      "SCRIPT inline=false src=\"/cdn-cgi/challenge-platform/scripts/jsd/main.js\" text=\"window.__CF$cv$params={r:'abc'}\"",
      "",
      "# accessibility",
      "# cdp-cli accessibility v1",
      "A11Y [1] role=\"RootWebArea\"",
      "",
      "# tree",
      "[n000001] <html> selector=\"html\" visible=true"
    ].join("\n") + "\n");
    await fs.writeFile(path.join(dir, "text.md"), "");
    await fs.writeFile(path.join(dir, "accessibility.txt"), "# cdp-cli accessibility v1\nA11Y [1] role=\"RootWebArea\"\n");
    await writeNdjson(path.join(dir, "nodes.ndjson"), [{ ref: "n000001" }]);
    await writeNdjson(path.join(dir, "links.ndjson"), []);
    await writeNdjson(path.join(dir, "controls.ndjson"), []);
    await writeNdjson(path.join(dir, "visible-controls.ndjson"), []);
    await writeNdjson(path.join(dir, "forms.ndjson"), []);
    await writeNdjson(path.join(dir, "dialogs.ndjson"), []);
    await writeNdjson(path.join(dir, "frames.ndjson"), []);
    await writeNdjson(path.join(dir, "resources.ndjson"), [{ name: "https://discord.com/cdn-cgi/challenge-platform/scripts/jsd/main.js" }]);
    await writeNdjson(path.join(dir, "scripts.ndjson"), [{ src: "/cdn-cgi/challenge-platform/scripts/jsd/main.js", text: "window.__CF$cv$params={r:'abc'}" }]);

    const quality = await evaluateSnapshotQuality(dir);

    expect(quality.coverage).toMatchObject({
      pageReady: false,
      challengeLikely: true,
      grepReady: false,
      actionReady: false
    });
    expect(quality.warnings).toContain('page readyState is "loading"');
    expect(quality.warnings).toContain("page looks like a bot challenge, captcha, or verification flow");
  });

  it("keeps challenge markers as a signal without failing a rich usable projection", async () => {
    const dir = await makeSnapshotDir();
    await writeRequiredArtifacts(dir);
    await fs.writeJson(path.join(dir, "meta.json"), {
      url: "https://www.example.com/?js_challenge=1&token=abc",
      title: "Example"
    });
    await fs.writeJson(path.join(dir, "state.json"), {
      url: "https://www.example.com/?js_challenge=1&token=abc",
      title: "Example",
      readyState: "complete"
    });
    await fs.writeFile(path.join(dir, "dump.txt"), [
      "# cdp-cli dump v1",
      "PAGE title=\"Example\" url=\"https://www.example.com/?js_challenge=1&token=abc\" target=\"T\" snapshot=\"S\"",
      "COUNTS nodes=2 controls=1 visibleControls=1 links=1 forms=0 dialogs=0 frames=0 resources=1 scripts=1 openShadowRoots=0",
      "HELPERS generic.links generic.forms",
      "",
      "# suggested-grep",
      "rg 'CONTROL|FORM|DIALOG|FRAME|RESOURCE|SCRIPT|A11Y|#shadow-root|selector=' dump.txt",
      "",
      "# visible-controls",
      "CONTROL [n000002] path=\"top\" <a> selector=\"#login\" visible=true text=\"Log In\" attrs={href=\"/login\"}",
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
      "# resources",
      "RESOURCE type=\"script\" url=\"https://www.example.com/app.js\"",
      "",
      "# scripts",
      "SCRIPT inline=false src=\"https://www.example.com/app.js\"",
      "",
      "# accessibility",
      "# cdp-cli accessibility v1",
      "A11Y [1] role=\"RootWebArea\" name=\"Example\"",
      "",
      "# tree",
      "[n000001] <html> selector=\"html\" visible=true",
      "  [n000002] <a> selector=\"#login\" visible=true text=\"Log In\""
    ].join("\n") + "\n");
    await fs.writeFile(path.join(dir, "text.md"), "Example\nLog In\n");
    await fs.writeFile(path.join(dir, "accessibility.txt"), "# cdp-cli accessibility v1\nA11Y [1] role=\"RootWebArea\" name=\"Example\"\n");
    await writeNdjson(path.join(dir, "nodes.ndjson"), [{ ref: "n000001" }, { ref: "n000002" }]);
    await writeNdjson(path.join(dir, "links.ndjson"), [{ ref: "n000002" }]);
    await writeNdjson(path.join(dir, "controls.ndjson"), [{ ref: "n000002" }]);
    await writeNdjson(path.join(dir, "visible-controls.ndjson"), [{ ref: "n000002", visible: true }]);
    await writeNdjson(path.join(dir, "forms.ndjson"), []);
    await writeNdjson(path.join(dir, "dialogs.ndjson"), []);
    await writeNdjson(path.join(dir, "frames.ndjson"), []);
    await writeNdjson(path.join(dir, "resources.ndjson"), [{ name: "https://www.example.com/app.js" }]);
    await writeNdjson(path.join(dir, "scripts.ndjson"), [{ src: "https://www.example.com/app.js" }]);

    const quality = await evaluateSnapshotQuality(dir);

    expect(quality.ok).toBe(true);
    expect(quality.coverage).toMatchObject({
      challengeLikely: true,
      grepReady: true,
      actionReady: true
    });
    expect(quality.warnings).not.toContain("page looks like a bot challenge, captcha, or verification flow");
  });

  it("warns when a snapshot looks stuck on a loading shell", async () => {
    const dir = await makeSnapshotDir();
    await writeRequiredArtifacts(dir);
    await fs.writeJson(path.join(dir, "meta.json"), {
      url: "https://app.example.com/login",
      title: "Example App"
    });
    await fs.writeJson(path.join(dir, "state.json"), {
      url: "https://app.example.com/login",
      title: "Example App",
      readyState: "interactive",
      activeElement: {
        selector: "html > body",
        tag: "body",
        text: "Loading..."
      }
    });
    await fs.writeFile(path.join(dir, "dump.txt"), [
      "# cdp-cli dump v1",
      "PAGE title=\"Example App\" url=\"https://app.example.com/login\" target=\"T\" snapshot=\"S\"",
      "COUNTS nodes=3 controls=0 visibleControls=0 links=0 forms=0 dialogs=0 frames=0 resources=1 scripts=1 openShadowRoots=0",
      "HELPERS generic.links generic.forms",
      "",
      "# suggested-grep",
      "rg 'CONTROL|FORM|DIALOG|FRAME|RESOURCE|SCRIPT|A11Y|#shadow-root|selector=' dump.txt",
      "",
      "# visible-controls",
      "CONTROL none",
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
      "# resources",
      "RESOURCE type=\"script\" url=\"https://app.example.com/app.js\"",
      "",
      "# scripts",
      "SCRIPT inline=false src=\"https://app.example.com/app.js\"",
      "",
      "# accessibility",
      "# cdp-cli accessibility v1",
      "A11Y [1] role=\"RootWebArea\" name=\"Example App\" props={busy=\"1\"}",
      "A11Y [2] role=\"progressbar\" props={busy=\"1\"}",
      "",
      "# tree",
      "[n000001] <html> selector=\"html\" visible=true",
      "  [n000002] <div role=\"progressbar\" aria-busy=\"true\"> selector=\"#loading\" visible=true text=\"Loading...\""
    ].join("\n") + "\n");
    await fs.writeFile(path.join(dir, "text.md"), "");
    await fs.writeFile(path.join(dir, "accessibility.txt"), "# cdp-cli accessibility v1\nA11Y [1] role=\"RootWebArea\" name=\"Example App\" props={busy=\"1\"}\nA11Y [2] role=\"progressbar\" props={busy=\"1\"}\n");
    await writeNdjson(path.join(dir, "nodes.ndjson"), [{ ref: "n000001" }, { ref: "n000002" }, { ref: "n000003" }]);
    await writeNdjson(path.join(dir, "links.ndjson"), []);
    await writeNdjson(path.join(dir, "controls.ndjson"), []);
    await writeNdjson(path.join(dir, "visible-controls.ndjson"), []);
    await writeNdjson(path.join(dir, "forms.ndjson"), []);
    await writeNdjson(path.join(dir, "dialogs.ndjson"), []);
    await writeNdjson(path.join(dir, "frames.ndjson"), []);
    await writeNdjson(path.join(dir, "resources.ndjson"), [{ name: "https://app.example.com/app.js" }]);
    await writeNdjson(path.join(dir, "scripts.ndjson"), [{ src: "https://app.example.com/app.js" }]);

    const quality = await evaluateSnapshotQuality(dir);

    expect(quality.coverage).toMatchObject({
      pageReady: true,
      loadingShellLikely: true,
      grepReady: false,
      actionReady: false
    });
    expect(quality.warnings).toContain("page looks stuck on a loading or skeleton shell");
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
          coverage: {
            filesReady: true,
            dumpNavigable: true,
            pageReady: true,
            challengeLikely: false,
            grepReady: true,
            actionReady: true,
            accessibilityReady: true,
            networkReady: true,
            frameCoverage: false,
            shadowCoverage: false,
            dialogCoverage: false
          },
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
            resources: 1,
            scripts: 1,
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
          coverage: {
            filesReady: false,
            dumpNavigable: false,
            pageReady: false,
            challengeLikely: false,
            grepReady: false,
            actionReady: false,
            accessibilityReady: false,
            networkReady: false,
            frameCoverage: false,
            shadowCoverage: false,
            dialogCoverage: false
          },
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
            resources: 0,
            scripts: 0,
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
        {
          id: "ok-site",
          ok: true,
          snapshotDir: "/tmp/snap",
          warnings: [],
          coverage: { grepReady: true, actionReady: true, accessibilityReady: true, networkReady: true },
          suggestedSearches: ["rg CONTROL /tmp/snap/dump.txt"]
        },
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
    fs.writeFile(path.join(dir, "resources.ndjson"), ""),
    fs.writeFile(path.join(dir, "scripts.ndjson"), ""),
    fs.writeJson(path.join(dir, "dom-snapshot.json"), {}),
    fs.writeJson(path.join(dir, "helpers.json"), [])
  ]);
}

async function writeNdjson(file: string, records: unknown[]): Promise<void> {
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
}
