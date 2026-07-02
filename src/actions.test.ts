import { describe, expect, it } from "vitest";
import { domSettleExpression } from "./actions.js";

describe("domSettleExpression", () => {
  it("waits for a mutation quiet window and reports useful metadata", () => {
    const expression = domSettleExpression(1200, 75);

    expect(expression).toContain("new MutationObserver");
    expect(expression).toContain("const timeoutMs = 1200");
    expect(expression).toContain("const quietMs = 75");
    expect(expression).toContain("const minWaitMs = 500");
    expect(expression).toContain("Math.max(quietMs, minWaitMs - elapsed)");
    expect(expression).toContain("mutations += records.length");
    expect(expression).toContain("reason");
    expect(expression).toContain("elapsedMs");
    expect(expression).toContain("readyState");
  });
});
