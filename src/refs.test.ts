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
