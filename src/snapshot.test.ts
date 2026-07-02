import { describe, expect, it } from "vitest";
import { buildAccessibilityText, buildDumpText } from "./snapshot.js";
import type { HelperSummary, SnapshotMeta } from "./types.js";

const meta: SnapshotMeta = {
  id: "snap1",
  label: "manual",
  createdAt: "2026-07-02T00:00:00.000Z",
  url: "https://example.com/login",
  title: "Example Login",
  targetId: "TARGET123",
  helperIds: ["generic"]
};

const helpers: HelperSummary[] = [
  {
    id: "generic",
    title: "Generic page",
    description: "Baseline helpers available for any web page.",
    matches: ["http://**", "https://**"],
    commands: [
      { name: "links", description: "Extract visible links." },
      { name: "forms", description: "Extract visible forms." }
    ]
  }
];

describe("buildDumpText", () => {
  it("adds grep-native orientation sections before the raw tree", () => {
    const accessibilityText = buildAccessibilityText({
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Example Login" }, childIds: ["2"] },
        {
          nodeId: "2",
          role: { value: "button" },
          name: { value: "Continue" },
          properties: [{ name: "focusable", value: { value: true } }]
        }
      ]
    });
    const dump = buildDumpText(meta, {
      tree: [
        "[n000001] <html> selector=\"html\" visible=true",
        "  [n000002] <login-card> selector=\"login-card\" visible=true",
        "    #shadow-root(open) host=n000002",
        "      [n000003] <button> selector=\"button\" visible=true text=\"Continue\""
      ],
      nodes: [
        { ref: "n000001", tag: "html", selector: "html" },
        { ref: "n000002", tag: "login-card", selector: "login-card" },
        {
          ref: "n000003",
          framePath: ["top", "n000002#shadow-root"],
          tag: "button",
          selector: "button",
          visible: true,
          accessibleName: "Continue action",
          text: "Continue"
        }
      ],
      controls: [
        {
          ref: "n000003",
          framePath: ["top", "n000002#shadow-root"],
          tag: "button",
          selector: "button",
          visible: true,
          accessibleName: "Continue action",
          text: "Continue"
        }
      ],
      links: [],
      forms: [
        {
          ref: "n000004",
          tag: "form",
          selector: "form",
          visible: true,
          action: "https://example.com/session",
          method: "post",
          controls: [
            { tag: "input", name: "email", type: "email", accessibleName: "Email address" },
            { tag: "button", text: "Sign in" }
          ]
        }
      ],
      dialogs: [
        { ref: "n000005", tag: "dialog", selector: "dialog", visible: true, text: "Cookie settings" }
      ],
      frames: [
        { ref: "n000006", tag: "iframe", selector: "iframe", visible: true, src: "https://example.com/frame", sameOrigin: false }
      ],
      resources: [
        {
          name: "https://example.com/app.js",
          initiatorType: "script",
          duration: 42,
          transferSize: 1024,
          encodedBodySize: 900,
          decodedBodySize: 1800,
          renderBlockingStatus: "non-blocking"
        }
      ],
      scripts: [
        {
          selector: "html > body > script",
          src: "https://example.com/app.js",
          type: "module",
          async: true,
          defer: false,
          noModule: false,
          inline: false,
          inlineChars: 0
        },
        {
          selector: "html > body > script:nth-of-type(2)",
          inline: true,
          inlineChars: 28,
          inlineHash: "abc123",
          inlineSnippet: "console.log('boot sequence')"
        }
      ]
    }, helpers, accessibilityText);

    expect(dump).toContain("# cdp-cli dump v1");
    expect(dump).toContain("PAGE title=\"Example Login\"");
    expect(dump).toContain("COUNTS nodes=3 controls=1 visibleControls=1 links=0 forms=1 dialogs=1 frames=1 resources=1 scripts=2 openShadowRoots=1");
    expect(dump).toContain("HELPERS generic.links generic.forms");
    expect(dump).toContain("CONTROL [n000003] path=\"top > n000002#shadow-root\" <button>");
    expect(dump).toContain("label=\"Continue action\" text=\"Continue\"");
    expect(dump).toContain("FORM [n000004] <form>");
    expect(dump).toContain("controls=\"input:name=\\\"email\\\":type=\\\"email\\\":label=\\\"Email address\\\" button:text=\\\"Sign in\\\"\"");
    expect(dump).toContain("DIALOG [n000005] <dialog>");
    expect(dump).toContain("FRAME [n000006] <iframe>");
    expect(dump).toContain("RESOURCE type=\"script\" url=\"https://example.com/app.js\" durationMs=42 transfer=1024 encoded=900 decoded=1800 renderBlocking=\"non-blocking\"");
    expect(dump).toContain("SCRIPT inline=false src=\"https://example.com/app.js\" selector=\"html > body > script\" type=\"module\" async=true chars=0");
    expect(dump).toContain("SCRIPT inline=true selector=\"html > body > script:nth-of-type(2)\" chars=28 hash=\"abc123\" snippet=\"console.log('boot sequence')\"");
    expect(dump).toContain("# accessibility\n# cdp-cli accessibility v1");
    expect(dump).toContain("A11Y [2] role=\"button\" name=\"Continue\"");
    expect(dump).toContain("# tree\n[n000001] <html>");
    expect(dump).toContain("#shadow-root(open) host=n000002");
  });

  it("formats accessibility tree records for grep", () => {
    const text = buildAccessibilityText({
      nodes: [
        {
          nodeId: "17",
          role: { value: "textbox" },
          name: { value: "Search docs" },
          value: { value: "" },
          ignored: false,
          childIds: ["18"],
          properties: [
            { name: "editable", value: { value: "plaintext" } },
            { name: "focusable", value: { value: true } }
          ]
        }
      ]
    });

    expect(text).toContain("# cdp-cli accessibility v1");
    expect(text).toContain("A11Y [17] role=\"textbox\" name=\"Search docs\" ignored=false children=\"18\"");
    expect(text).toContain("props={editable=\"plaintext\" focusable=\"true\"}");
  });
});
