import { describe, expect, it } from "vitest";
import { findHelperCommand, helperSummaries } from "./helpers.js";

describe("helpers", () => {
  it("returns site-specific helpers plus generic helpers", () => {
    const helpers = helperSummaries("https://x.com/i/bookmarks");
    expect(helpers.map((helper) => helper.id)).toEqual(["x", "generic"]);
  });

  it("finds helper commands for matching URLs", () => {
    const { helper, command } = findHelperCommand(
      "https://github.com/openai/codex/pulls",
      "github",
      "discussion-items"
    );
    expect(helper.title).toBe("GitHub");
    expect(command.expression).toContain("TimelineItem");
  });
});
