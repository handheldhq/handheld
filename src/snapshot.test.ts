import { describe, expect, it } from "vitest";
import {
  canonicalForegroundComponent,
  compareForegroundSignatures,
  foregroundSignatureOf,
  formatSnapshot,
  nodeCenter,
  normalizeTinySnapshot,
  resolveSelector,
  resolveSnapshotRef,
  snapshotForAgent,
  snapshotForOutput,
  snapshotNodesForDisplay,
} from "./snapshot.js";

const tinySnapshot = {
  activity: "com.android.settings.Settings",
  appName: "Settings",
  bundleId: "com.android.settings",
  component: "com.android.settings/com.android.settings.Settings",
  eventSeq: 42,
  layoutDigest: "layout-1",
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

  it("persists and compares foreground signatures for stale ref guards", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: tinySnapshot,
    });

    expect(snapshot.foregroundSignature).toEqual({
      activity: "com.android.settings.Settings",
      bundleId: "com.android.settings",
      component: "com.android.settings/com.android.settings.Settings",
      eventSeq: 42,
      layoutDigest: "layout-1",
    });
    expect(foregroundSignatureOf(snapshot)).toEqual(snapshot.foregroundSignature);
    expect(
      compareForegroundSignatures({
        cached: snapshot.foregroundSignature,
        live: {
          component: "com.android.settings/.Settings",
          eventSeq: 43,
          layoutDigest: "layout-1",
        },
      })
    ).toEqual({ ok: true });
    expect(canonicalForegroundComponent("com.android.settings/.Settings")).toBe(
      "com.android.settings/com.android.settings.Settings"
    );
    expect(
      compareForegroundSignatures({
        cached: snapshot.foregroundSignature,
        live: {
          component: "com.android.settings/com.android.settings.Settings",
          layoutDigest: "layout-2",
        },
      })
    ).toMatchObject({ ok: false, reason: "layout changed since last snap" });
    expect(
      compareForegroundSignatures({
        cached: snapshot.foregroundSignature,
        live: { layoutDigest: "layout-1" },
      })
    ).toMatchObject({ ok: false, reason: "missing live foreground signature" });
  });

  it("prints compact selectable refs", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: tinySnapshot,
    });

    // Default view (no -i): keeps read-only text.
    const text = formatSnapshot(snapshot, { header: false });
    // Actionable node: ref + TitleCase role + name + leaf id + actions. A focused
    // node gets a "▶" bullet and an explicit `focused` attr.
    expect(text).toContain(
      '▶ @e2 TextField "Search settings" [id=search_action_bar focused actions=[press,set_value]]'
    );
    // Read-only text renders ref-less with a bare quoted value.
    expect(text).toContain('- Text "Settings"');
    expect(text).not.toContain('@e1');
    // Default keeps the 2 interactive nodes plus the standalone "Settings" text = 3.
    expect(snapshotNodesForDisplay(snapshot, {})).toHaveLength(3);
    // `-i` (interactive/actionable-only) drops the read-only "Settings" text → 2.
    const lean = snapshotNodesForDisplay(snapshot, { interactive: true });
    expect(lean).toHaveLength(2);
    expect(lean.some((node) => (node.label ?? node.value) === "Settings")).toBe(false);
    expect(formatSnapshot(snapshot, { header: false, interactive: true })).not.toContain(
      'Text "Settings"'
    );
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

    const kept = snapshotNodesForDisplay(snapshot, {}); // default view keeps read-only text
    // The hittable row resolves title + subtitle from its two child texts, which are
    // then consumed (not rendered as their own lines).
    const row = kept.find((node) => node.hittable)!;
    expect(row.title).toBe("Storage");
    expect(row.subtitle).toBe("233 kB used");
    const text = kept.map((node) => node.label ?? node.value);
    // The standalone heading survives; the consumed child texts and the
    // contentDescription-only FrameLayout do not.
    expect(text).toContain("Heads up message");
    expect(kept.some((node) => !node.hittable && (node.label ?? node.value) === "Storage")).toBe(false);
    expect(text).not.toContain("233 kB used");
    expect(text).not.toContain("Wifi signal full.");

    // --all bypasses collapse and returns every node (structural included).
    expect(snapshotNodesForDisplay(snapshot, { all: true })).toHaveLength(5);
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

    const labels = snapshotNodesForDisplay(snapshot, {}).map((node) => node.label); // default keeps text
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

    // The structured node list always collapses (no viewport culling); here all
    // three nodes survive collapse.
    expect(snapshotForOutput(snapshot, { interactive: false }).nodes).toHaveLength(3);

    // The result is still formattable (header + filtered body).
    expect(formatSnapshot(compact, { header: true })).toContain("Snapshot com.android.settings");
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

  it("culls off-screen nodes in the text view and surfaces a scroll hint", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        nodes: [
          // Root/decor clipped to the 1080x2400 display → derives the viewport.
          {
            role: "android.widget.FrameLayout",
            depth: 0,
            bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          },
          {
            role: "android.widget.Button",
            text: "On screen",
            hittable: true,
            depth: 1,
            bounds: { left: 0, top: 100, right: 200, bottom: 180 },
          },
          {
            role: "android.widget.Button",
            text: "Below fold",
            hittable: true,
            depth: 1,
            bounds: { left: 0, top: 2600, right: 200, bottom: 2700 },
          },
        ],
      },
    });

    expect(snapshot.viewport).toEqual({ width: 1080, height: 2400 });

    const text = formatSnapshot(snapshot, { header: false });
    expect(text).toContain('@e2 Button "On screen"');
    // The off-screen button isn't rendered as a node line, only summarized.
    expect(text).not.toMatch(/@e3\b/);
    expect(text).toContain("1 more below");
    expect(text).toContain('"Below fold"'); // appears only inside the scroll hint

    // --offscreen disables culling in the text view.
    expect(formatSnapshot(snapshot, { header: false, offscreen: true })).toMatch(/@e3\b/);
    // The structured node list never culls (both buttons survive collapse).
    expect(snapshotNodesForDisplay(snapshot, {})).toHaveLength(2);
  });

  it("indents by kept-ancestor depth (parentIndex), not raw depth staircase", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        nodes: [
          {
            role: "androidx.recyclerview.widget.RecyclerView",
            contentDescription: "List",
            scrollable: true,
            parentIndex: -1,
            depth: 0,
            bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          },
          // Two direct children of the list whose raw depths jump (5, 6). The old
          // depth-stack would staircase the second to level 2; kept-ancestor depth
          // keeps both at level 1 since they share the kept root as their parent.
          {
            role: "android.widget.Button",
            text: "Aaa",
            hittable: true,
            parentIndex: 0,
            depth: 5,
            bounds: { left: 0, top: 100, right: 200, bottom: 180 },
          },
          {
            role: "android.widget.Button",
            text: "Bbb",
            hittable: true,
            parentIndex: 0,
            depth: 6,
            bounds: { left: 0, top: 200, right: 200, bottom: 280 },
          },
        ],
      },
    });

    const lines = formatSnapshot(snapshot, { header: false }).split("\n");
    const a = lines.find((l) => l.includes('"Aaa"'))!;
    const b = lines.find((l) => l.includes('"Bbb"'))!;
    for (const line of [a, b]) {
      expect(line.startsWith("  ")).toBe(true); // one level under the kept root
      expect(line.startsWith("    ")).toBe(false); // exactly one — no staircase
    }
  });

  it("culls zero-height / fold-straddling phantom nodes from the text view (M2)", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        nodes: [
          { role: "android.widget.FrameLayout", depth: 0, bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } },
          { role: "android.widget.Button", text: "Real", hittable: true, depth: 1, bounds: { left: 0, top: 100, right: 200, bottom: 180 } },
          // A fold-straddling RecyclerView row collapsed to a 0px-high line at the
          // viewport edge — must not render as a title-less phantom button.
          { role: "android.widget.Button", hittable: true, depth: 1, bounds: { left: 0, top: 2399, right: 1080, bottom: 2399 } },
        ],
      },
    });
    const text = formatSnapshot(snapshot, { header: false });
    expect(text).toContain('"Real"');
    expect(text).not.toMatch(/@e3\b/); // the zero-height button is culled
  });

  it("culls zero-width and nameless actionable phantoms from the default view", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        nodes: [
          { role: "android.widget.FrameLayout", depth: 0, bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } },
          { role: "android.widget.Button", text: "Real", hittable: true, depth: 1, bounds: { left: 0, top: 100, right: 300, bottom: 180 } },
          { role: "android.widget.Button", hittable: true, depth: 1, bounds: { left: 40, top: 200, right: 40, bottom: 280 } },
          { role: "android.widget.Button", hittable: true, depth: 1, bounds: { left: 0, top: 300, right: 300, bottom: 380 } },
        ],
      },
    });

    const text = formatSnapshot(snapshot, { header: false });

    expect(text).toContain('"Real"');
    expect(text).not.toMatch(/@e3\b/);
    expect(text).not.toMatch(/@e4\b/);
    expect(formatSnapshot(snapshot, { all: true, header: false })).toMatch(/@e4\b/);
  });

  it("returns a compact agent projection without changing snapshot json output", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        appName: "Settings",
        layoutDigest: "digest-1",
        nodes: [
          { role: "android.widget.FrameLayout", depth: 0, bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } },
          { role: "android.widget.EditText", editable: true, focused: true, resourceId: "com.app:id/search", text: "wifi", depth: 1, bounds: { left: 0, top: 100, right: 1000, bottom: 180 } },
          { role: "android.widget.Button", hittable: true, text: "Save", depth: 1, bounds: { left: 0, top: 200, right: 300, bottom: 280 } },
        ],
      },
    });

    expect(snapshotForOutput(snapshot).nodes[0]).toHaveProperty("raw");
    expect(snapshotForAgent(snapshot)).toMatchObject({
      appName: "Settings",
      deviceId: "device-1",
      layoutDigest: "digest-1",
      nodes: [
        {
          actions: ["set_value"],
          id: "search",
          label: "wifi",
          ref: "@e2",
          role: "TextField",
          state: { focused: true },
          value: "wifi",
        },
        {
          actions: ["press"],
          label: "Save",
          ref: "@e3",
          role: "Button",
        },
      ],
    });
  });

  it("groups other-window nodes under a labeled divider", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        component: "com.android.settings/com.android.settings.Home",
        nodes: [
          // Status-bar clock: a different window owned by System UI.
          {
            role: "android.widget.TextView",
            text: "9:41",
            bundleId: "com.android.systemui",
            windowId: 78,
            parentIndex: -1,
            depth: 0,
            bounds: { left: 0, top: 0, right: 200, bottom: 60 },
          },
          // Foreground app row.
          {
            role: "android.widget.Button",
            text: "Network & internet",
            hittable: true,
            bundleId: "com.android.settings",
            windowId: 70,
            parentIndex: -1,
            depth: 0,
            bounds: { left: 0, top: 200, right: 1080, bottom: 300 },
          },
        ],
      },
    });

    const lines = formatSnapshot(snapshot, { header: false }).split("\n");
    const appIdx = lines.findIndex((l) => l.includes("Network & internet"));
    const dividerIdx = lines.findIndex((l) => l.includes("other window"));
    const clockIdx = lines.findIndex((l) => l.includes('"9:41"'));
    // Foreground node renders first; the foreign window follows under a divider
    // that names the owning package; the clock sits under that divider.
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(dividerIdx).toBeGreaterThan(appIdx);
    expect(lines[dividerIdx]).toContain("com.android.systemui");
    expect(clockIdx).toBeGreaterThan(dividerIdx);
  });

  it("resolves title/subtitle from /title and /summary resource-ids, not position", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        nodes: [
          { role: "android.widget.Button", hittable: true, depth: 0, bounds: { left: 0, top: 0, right: 1000, bottom: 100 } },
          { role: "android.widget.ImageView", resourceId: "android:id/icon", depth: 1, bounds: { left: 0, top: 0, right: 80, bottom: 80 } },
          // summary appears BEFORE title in tree order — id selection must still win.
          { role: "android.widget.TextView", resourceId: "android:id/summary", text: "Mobile, Wi‑Fi, hotspot", depth: 1, bounds: { left: 90, top: 50, right: 900, bottom: 90 } },
          { role: "android.widget.TextView", resourceId: "android:id/title", text: "Network & internet", depth: 1, bounds: { left: 90, top: 10, right: 900, bottom: 45 } },
        ],
      },
    });
    const row = snapshot.nodes[0]!;
    expect(row.title).toBe("Network & internet");
    expect(row.subtitle).toBe("Mobile, Wi‑Fi, hotspot");
    expect(formatSnapshot(snapshot, { header: false })).toContain(
      '@e1 Button "Network & internet" subtitle="Mobile, Wi‑Fi, hotspot" [actions=[press]]'
    );
  });

  it("resolves durable id=/label=/text= selectors, preferring the actionable node", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        nodes: [
          // Row button (no own label) with title + summary children.
          { role: "android.widget.Button", hittable: true, depth: 0, bounds: { left: 0, top: 0, right: 1000, bottom: 100 } },
          { role: "android.widget.TextView", resourceId: "android:id/title", text: "Network & internet", depth: 1, bounds: { left: 10, top: 10, right: 900, bottom: 45 } },
          { role: "android.widget.TextView", resourceId: "android:id/summary", text: "Mobile, Wi‑Fi, hotspot", depth: 1, bounds: { left: 10, top: 50, right: 900, bottom: 90 } },
          // Editable field with a package-qualified resource-id.
          { role: "android.widget.EditText", editable: true, hittable: true, resourceId: "com.app:id/search_box", text: "Search", depth: 0, bounds: { left: 0, top: 200, right: 1000, bottom: 280 } },
        ],
      },
    });

    // id= matches the package-stripped leaf OR the full resource-id.
    expect(resolveSelector(snapshot, "id=search_box")?.ref).toBe("@e4");
    expect(resolveSelector(snapshot, "id=com.app:id/search_box")?.ref).toBe("@e4");
    // label= resolves the tappable row (Button), not its consumed child text.
    const byLabel = resolveSelector(snapshot, 'label="Network & internet"');
    expect(byLabel?.ref).toBe("@e1");
    expect(byLabel?.hittable).toBe(true);
    // case-insensitive.
    expect(resolveSelector(snapshot, "label=network & internet")?.ref).toBe("@e1");
    // text= matches the node's displayed text.
    expect(resolveSelector(snapshot, "text=Search")?.ref).toBe("@e4");
    // A selector matching ONLY read-only text does NOT resolve — read-only is not a
    // tap target (the subtitle text belongs to a consumed, non-actionable node).
    expect(resolveSelector(snapshot, "text=Mobile, Wi‑Fi, hotspot")).toBeNull();
    // misses + non-selectors.
    expect(resolveSelector(snapshot, "id=nope")).toBeNull();
    expect(resolveSelector(snapshot, "@e1")).toBeNull();
  });

  it("collapses an IME window to a one-line hint (expandable with --all)", () => {
    const snapshot = normalizeTinySnapshot({
      deviceId: "device-1",
      raw: {
        component: "com.app/.Main",
        nodes: [
          { role: "android.widget.Button", text: "Submit", hittable: true, bundleId: "com.app", windowId: 1, parentIndex: -1, depth: 0, bounds: { left: 0, top: 0, right: 1080, bottom: 200 } },
          { role: "android.widget.Button", text: "q", hittable: true, bundleId: "com.google.android.inputmethod.latin", windowId: 2, parentIndex: -1, depth: 0, bounds: { left: 0, top: 2000, right: 100, bottom: 2100 } },
          { role: "android.widget.Button", text: "w", hittable: true, bundleId: "com.google.android.inputmethod.latin", windowId: 2, parentIndex: -1, depth: 0, bounds: { left: 100, top: 2000, right: 200, bottom: 2100 } },
        ],
      },
    });
    const text = formatSnapshot(snapshot, { header: false });
    expect(text).toContain('"Submit"');
    expect(text).toMatch(/keyboard open/);
    expect(text).toContain("~2 keys");
    expect(text).not.toContain('"q"'); // keys omitted by default
    // --all expands the keyboard.
    expect(formatSnapshot(snapshot, { header: false, all: true })).toContain('"q"');
  });
});
