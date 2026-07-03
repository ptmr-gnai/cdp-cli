import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { describe, expect, it } from "vitest";
import { resolveSelectorRef } from "./refs.js";
import type { TargetInfo } from "./types.js";

const target: TargetInfo = {
  id: "TARGET123",
  type: "page",
  title: "Example",
  url: "https://example.com"
};

describe("resolveSelectorRef", () => {
  it("resolves refs from the latest visible controls index", async () => {
    const outDir = await makeOutDir();
    const current = path.join(outDir, "targets", "example.com-TARGET123", "current");
    await fs.ensureDir(current);
    await fs.writeFile(
      path.join(current, "visible-controls.ndjson"),
      `${JSON.stringify({ ref: "n000017", selector: "#search", tag: "input", visible: true })}\n`
    );

    await expect(resolveSelectorRef(outDir, target, "n000017")).resolves.toMatchObject({
      ref: "n000017",
      selector: "#search"
    });
  });

  it("resolves stable refs from the actionable controls index", async () => {
    const outDir = await makeOutDir();
    const current = path.join(outDir, "targets", "example.com-TARGET123", "current");
    await fs.ensureDir(current);
    await fs.writeFile(
      path.join(current, "actionable-controls.ndjson"),
      `${JSON.stringify({ ref: "n000017", stableRef: "r_abcdef123456", selector: "#search", tag: "input", visible: true })}\n`
    );

    await expect(resolveSelectorRef(outDir, target, "stable:r_abcdef123456")).resolves.toMatchObject({
      ref: "n000017",
      stableRef: "r_abcdef123456",
      selector: "#search"
    });
  });


  it("falls back to dump.txt when a ref is not in structured indexes", async () => {
    const outDir = await makeOutDir();
    const current = path.join(outDir, "targets", "renavigated.example-TARGET123", "current");
    await fs.ensureDir(current);
    await fs.writeFile(
      path.join(current, "dump.txt"),
      '[n000042] <button> selector="button:nth-of-type(2)" visible=true rect={"x":0,"y":0,"width":1,"height":1} text="Go"\n'
    );

    await expect(resolveSelectorRef(outDir, target, "ref:n000042")).resolves.toMatchObject({
      ref: "n000042",
      selector: "button:nth-of-type(2)"
    });
  });

  it("returns root steps for refs inside open shadow roots", async () => {
    const outDir = await makeOutDir();
    const current = path.join(outDir, "targets", "example.com-TARGET123", "current");
    await fs.ensureDir(current);
    await fs.writeFile(
      path.join(current, "nodes.ndjson"),
      [
        { ref: "n000011", framePath: ["top"], selector: "popup-info", tag: "popup-info" },
        {
          ref: "n000016",
          framePath: ["top", "n000011#shadow-root"],
          selector: "span > span:nth-of-type(2)",
          tag: "span",
          text: "Shadow help"
        }
      ].map((record) => JSON.stringify(record)).join("\n") + "\n"
    );

    await expect(resolveSelectorRef(outDir, target, "n000016")).resolves.toMatchObject({
      ref: "n000016",
      selector: "span > span:nth-of-type(2)",
      roots: [{ ref: "n000011", kind: "shadow-root", selector: "popup-info" }]
    });
  });

  it("passes non-ref inputs through as selectors", async () => {
    await expect(resolveSelectorRef("/missing", target, "button.primary")).resolves.toEqual({
      input: "button.primary",
      selector: "button.primary"
    });
  });
});

async function makeOutDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cdp-cli-refs-"));
}
