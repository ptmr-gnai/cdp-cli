import { describe, expect, it } from "vitest";
import { sanitizeFilePart } from "./env.js";

describe("sanitizeFilePart", () => {
  it("turns URLs into stable file-safe names", () => {
    expect(sanitizeFilePart("https://example.com/a path?q=1")).toBe("example.com-a-path-q-1");
  });

  it("falls back for strings without safe characters", () => {
    expect(sanitizeFilePart("///")).toBe("page");
  });
});
