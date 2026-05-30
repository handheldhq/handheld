import { describe, expect, it } from "vitest";
import {
  formatSnapshot,
  nodeCenter,
  normalizeTinySnapshot,
  resolveSnapshotRef,
  snapshotForOutput,
  snapshotNodesForDisplay,
} from "./snapshot.js";

const tinySnapshot = {
  appName: "Settings",
  bundleId: "com.android.settings",
  eventSeq: 42,
  treeDigest: "tree-1",
  nodes: [
    {
      enabled: true,
      role: "android.widget.TextView",
      stableId: "title",
      text: "Settings",
      bounds: { left: 0, top: 0, right: 1080, bottom: 120 },
    },
    {
      actionableId: "search-action",
      editable: true,
      enabled: true,
      focused: true,
      hittable: true,
      resourceId: "com.android.settings:id/search_action_bar",
      role: "android.widget.EditText",
      stableId: "search",
      text: "Search settings",
      value: "",
      bounds: { left: 40, top: 140, right: 1040, bottom: 220 },
    },
    {
      enabled: true,
      hittable: true,
      role: "android.widget.TextView",
      stableId: "network",
      text: "Network & internet",
      rect: { x: 40, y: 300, width: 860, height: 80 },
    },
  ],
};

describe("Tiny snapshot formatting", () => {
  it("normalizes Tiny nodes to agent-device-style refs", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: tinySnapshot,
    });

    expect(snapshot.nodes[0]).toMatchObject({
      ref: "@e1",
      role: "text",
      label: "Settings",
    });
    expect(snapshot.nodes[1]).toMatchObject({
      ref: "@e2",
      role: "textinput",
      identifier: "com.android.settings:id/search_action_bar",
      hittable: true,
      focused: true,
      editable: true,
      value: "",
    });
    expect(nodeCenter(snapshot.nodes[1]!)).toEqual({ x: 540, y: 180 });
  });

  it("prints compact selectable refs", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: tinySnapshot,
    });

    expect(formatSnapshot(snapshot, { header: false, interactive: true }))
      .toContain('@e2 [textinput] label="Search settings" preview="" id="com.android.settings:id/search_action_bar" enabled hittable focused editable');
    // Compact mode keeps the 2 interactive nodes plus the standalone "Settings"
    // text node (not already surfaced in an interactive label) = 3.
    expect(snapshotNodesForDisplay(snapshot, { interactive: true })).toHaveLength(3);
  });

  it("compact mode keeps unseen text but drops layout noise and duplicate text", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        nodes: [
          // Interactive row whose absorbed label is "Storage · 233 kB used".
          {
            role: "android.widget.LinearLayout",
            hittable: true,
            depth: 0,
            bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
          },
          {
            role: "android.widget.TextView",
            text: "Storage",
            depth: 1,
            bounds: { left: 10, top: 10, right: 500, bottom: 90 },
          },
          {
            role: "android.widget.TextView",
            text: "233 kB used",
            depth: 1,
            bounds: { left: 510, top: 10, right: 990, bottom: 90 },
          },
          // Standalone heading not inside any interactive node → kept.
          {
            role: "android.widget.TextView",
            text: "Heads up message",
            depth: 0,
            bounds: { left: 0, top: 200, right: 1000, bottom: 260 },
          },
          // Labeled layout container (contentDescription) → dropped as noise.
          {
            role: "android.widget.FrameLayout",
            contentDescription: "Wifi signal full.",
            depth: 0,
            bounds: { left: 900, top: 0, right: 960, bottom: 60 },
          },
        ],
      },
    });

    const labels = snapshotNodesForDisplay(snapshot, { interactive: true }).map(
      (node) => node.label
    );
    // Kept: the interactive row (absorbs "Storage · 233 kB used") + the heading.
    expect(labels).toContain("Storage · 233 kB used");
    expect(labels).toContain("Heads up message");
    // Dropped: the two child text nodes (already in the row label) and the
    // contentDescription-only FrameLayout.
    expect(labels).not.toContain("Storage");
    expect(labels).not.toContain("233 kB used");
    expect(labels).not.toContain("Wifi signal full.");
  });

  it("compact mode keys on own displayed text (value), not just role==='text'", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        nodes: [
          // TextClock subclasses TextView but its class name lacks "textview",
          // so it gets role "textclock" — still real displayed text (has value).
          {
            role: "android.widget.TextClock",
            text: "3:45",
            value: "3:45",
            depth: 0,
            bounds: { left: 0, top: 0, right: 200, bottom: 60 },
          },
          // WebView text surfaces as android.view.View WITH its own text.
          {
            role: "android.view.View",
            text: "Article body text",
            value: "Article body text",
            depth: 0,
            bounds: { left: 0, top: 100, right: 1000, bottom: 200 },
          },
          // A View carrying only a contentDescription (no value) is noise.
          {
            role: "android.view.View",
            contentDescription: "Home",
            depth: 0,
            bounds: { left: 0, top: 300, right: 1000, bottom: 400 },
          },
        ],
      },
    });

    const labels = snapshotNodesForDisplay(snapshot, { interactive: true }).map(
      (node) => node.label
    );
    expect(labels).toContain("3:45"); // textclock kept via value
    expect(labels).toContain("Article body text"); // webview view kept via value
    expect(labels).not.toContain("Home"); // contentDescription-only view dropped
  });

  it("formatSnapshot indents nodes by relative nesting (skipping filtered gaps)", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        nodes: [
          // Scrollable container (depth 2) with its own label (so it doesn't
          // absorb child text).
          {
            role: "androidx.recyclerview.widget.RecyclerView",
            contentDescription: "Settings list",
            scrollable: true,
            depth: 2,
            bounds: { left: 0, top: 0, right: 1000, bottom: 2000 },
          },
          // Intermediate non-interactive layout (depth 4) that gets filtered
          // out, then a button nested under it (depth 6).
          {
            role: "android.widget.FrameLayout",
            depth: 4,
            bounds: { left: 10, top: 10, right: 990, bottom: 200 },
          },
          {
            role: "android.widget.Button",
            text: "Save changes",
            hittable: true,
            depth: 6,
            bounds: { left: 20, top: 20, right: 300, bottom: 100 },
          },
          // A sibling row back at depth 2, outside the list's bounds.
          {
            role: "android.widget.Button",
            text: "Cancel",
            hittable: true,
            depth: 2,
            bounds: { left: 0, top: 2100, right: 1000, bottom: 2200 },
          },
        ],
      },
    });

    const lines = formatSnapshot(snapshot, { header: false, interactive: true }).split("\n");
    const list = lines.find((l) => l.includes('"Settings list"'))!;
    const save = lines.find((l) => l.includes('"Save changes"'))!;
    const cancel = lines.find((l) => l.includes('"Cancel"'))!;
    // The list sits at level 0; "Save changes" nests one level under it (its
    // depth-4 parent was filtered, so it re-parents to the kept list). "Cancel"
    // is a sibling of the list, back at level 0.
    expect(list.startsWith("  ")).toBe(false);
    expect(save.startsWith("  ")).toBe(true);
    expect(save.startsWith("    ")).toBe(false); // exactly one level
    expect(cancel.startsWith("  ")).toBe(false);
  });

  it("snapshotForOutput drops the raw doc and keeps a total count", () => {
    const snapshot = normalizeTinySnapshot({ deviceId: "device-1", raw: tinySnapshot });

    const compact = snapshotForOutput(snapshot);
    expect(compact.totalNodeCount).toBe(3);
    expect(compact.raw).toBeUndefined();
    expect(compact.appName).toBe("Settings");
    expect(compact.bundleId).toBe("com.android.settings");

    // interactive:false keeps every node.
    expect(snapshotForOutput(snapshot, { interactive: false }).nodes).toHaveLength(3);

    // The result is still formattable (header + filtered body).
    expect(formatSnapshot(compact, { header: true })).toContain("Snapshot Settings");
  });

  it("resolves cached refs with or without @ prefix", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: tinySnapshot,
    });

    expect(resolveSnapshotRef(snapshot, "@e2")?.stableId).toBe("search");
    expect(resolveSnapshotRef(snapshot, "e3")?.stableId).toBe("network");
    expect(resolveSnapshotRef(snapshot, "@e9")).toBeNull();
  });
});
