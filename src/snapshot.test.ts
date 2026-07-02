import { describe, expect, it } from "vitest";
import { buildDumpText } from "./snapshot.js";
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
            { tag: "input", name: "email", type: "email", placeholder: "Email" },
            { tag: "button", text: "Sign in" }
          ]
        }
      ],
      dialogs: [
        { ref: "n000005", tag: "dialog", selector: "dialog", visible: true, text: "Cookie settings" }
      ],
      frames: [
        { ref: "n000006", tag: "iframe", selector: "iframe", visible: true, src: "https://example.com/frame", sameOrigin: false }
      ]
    }, helpers);

    expect(dump).toContain("# cdp-cli dump v1");
    expect(dump).toContain("PAGE title=\"Example Login\"");
    expect(dump).toContain("COUNTS nodes=3 controls=1 visibleControls=1 links=0 forms=1 dialogs=1 frames=1 openShadowRoots=1");
    expect(dump).toContain("HELPERS generic.links generic.forms");
    expect(dump).toContain("CONTROL [n000003] path=\"top > n000002#shadow-root\" <button>");
    expect(dump).toContain("FORM [n000004] <form>");
    expect(dump).toContain("controls=\"input:name=\\\"email\\\":type=\\\"email\\\":placeholder=\\\"Email\\\" button:text=\\\"Sign in\\\"\"");
    expect(dump).toContain("DIALOG [n000005] <dialog>");
    expect(dump).toContain("FRAME [n000006] <iframe>");
    expect(dump).toContain("# tree\n[n000001] <html>");
    expect(dump).toContain("#shadow-root(open) host=n000002");
  });
});
