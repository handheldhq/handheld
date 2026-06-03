import { describe, expect, it } from "vitest";
import {
  amStartError,
  clearFocusedInputCommand,
  isSelectorTarget,
  isSnapshotTarget,
  launchTargetCommand,
  normalizeKeyInput,
  parseCurrentComponent,
  parseIntOption,
  parseCurrentPackage,
  parseLauncherActivities,
  parsePackageList,
  parseScreenSize,
  humanizeAppLabel,
  pointFromSnapshotTarget,
  reconcileSnapshotByIdentity,
  resolveAppPackage,
  scrollSwipe,
} from "./device-actions.js";
import type { SnapshotDocument, SnapshotNode } from "./snapshot.js";

const mkNode = (o: Partial<SnapshotNode>): SnapshotNode =>
  ({
    ref: "@e1",
    role: "button",
    enabled: true,
    hittable: true,
    longPressable: false,
    checked: false,
    checkable: false,
    focusable: false,
    focused: false,
    scrollable: false,
    selected: false,
    editable: false,
    ...o,
  }) as SnapshotNode;

const mkDoc = (nodes: SnapshotNode[], over: Partial<SnapshotDocument> = {}): SnapshotDocument =>
  ({
    backend: "tiny",
    deviceId: "emu",
    component: "p/A",
    activity: "A",
    layoutDigest: "OLD",
    nodes,
    ...over,
  }) as SnapshotDocument;

describe("reconcileSnapshotByIdentity (same-screen drift recovery)", () => {
  it("keeps @eN refs but adopts live geometry by stableId; drops vanished targets", () => {
    const cached = mkDoc([
      mkNode({ ref: "@e2", stableId: "s1", label: "Storage", title: "Storage", identifier: "p:id/storage", bounds: { left: 0, top: 0, right: 100, bottom: 100 } }),
      mkNode({ ref: "@e3", stableId: "s2", label: "Battery", title: "Battery", bounds: { left: 0, top: 200, right: 100, bottom: 300 } }),
    ]);
    // Fresh screen: s1 scrolled down (new bounds, new ref numbering); s2 gone.
    const fresh = mkDoc(
      [
        mkNode({ ref: "@e9", stableId: "s1", label: "Storage", title: "Storage", identifier: "p:id/storage", bounds: { left: 0, top: 500, right: 100, bottom: 600 } }),
        mkNode({ ref: "@e10", stableId: "s9", label: "New", title: "New", bounds: { left: 0, top: 0, right: 50, bottom: 50 } }),
      ],
      { layoutDigest: "NEW" },
    );

    const r = reconcileSnapshotByIdentity(cached, fresh);

    // @e2 still resolves (ref preserved) but to the node's CURRENT position.
    expect(pointFromSnapshotTarget(r, "@e2")).toEqual({ x: 50, y: 550 });
    // A durable selector resolves to the same moved node.
    expect(pointFromSnapshotTarget(r, "label=Storage")).toEqual({ x: 50, y: 550 });
    // The vanished target fails closed instead of tapping a stale coordinate.
    expect(pointFromSnapshotTarget(r, "@e3")).toBeNull();
    // Digest is adopted from the fresh capture.
    expect(r.layoutDigest).toBe("NEW");
  });
});

describe("humanizeAppLabel", () => {
  it("prefers a known open-app alias, else a title-cased package leaf", () => {
    expect(humanizeAppLabel("com.android.chrome")).toBe("Chrome");
    expect(humanizeAppLabel("com.android.settings")).toBe("Settings");
    expect(humanizeAppLabel("com.android.vending")).toBe("Play"); // shortest alias wins
    expect(humanizeAppLabel("com.google.android.deskclock")).toBe("Deskclock");
    expect(humanizeAppLabel("com.google.android.contacts")).toBe("Contacts");
  });
});

describe("agent device action helpers", () => {
  it("recognizes refs, bare indices, and durable selectors as snapshot targets", () => {
    // index-based refs
    expect(isSnapshotTarget("@e7")).toBe(true);
    expect(isSnapshotTarget("7")).toBe(true);
    // durable selectors
    for (const sel of ['id=search_box', 'label="Network & internet"', "text=Search", "ID = foo"]) {
      expect(isSelectorTarget(sel)).toBe(true);
      expect(isSnapshotTarget(sel)).toBe(true);
    }
    // coordinates / plain text are not snapshot targets
    expect(isSnapshotTarget("540")).toBe(true); // bare index, still a ref
    expect(isSelectorTarget("540")).toBe(false);
    expect(isSelectorTarget("hello world")).toBe(false);
  });

  it("normalizes key names and raw keycodes", () => {
    expect(normalizeKeyInput("recent_apps")).toBe(187);
    expect(normalizeKeyInput("KEYCODE_TAB")).toBe(61);
    expect(normalizeKeyInput("66")).toBe(66);
    expect(normalizeKeyInput("home")).toBe("home");
    expect(normalizeKeyInput("paste")).toBe(279);
  });

  it("uppercases un-aliased symbolic key names so `input keyevent` resolves them", () => {
    // Android's KeyEvent.keyCodeFromString is case-sensitive: `input keyevent
    // volume_mute` is a silent no-op, while VOLUME_MUTE works. Any name not in
    // the alias map must reach the device uppercased.
    expect(normalizeKeyInput("KEYCODE_VOLUME_MUTE")).toBe("VOLUME_MUTE");
    expect(normalizeKeyInput("volume_mute")).toBe("VOLUME_MUTE");
    expect(normalizeKeyInput("media_play_pause")).toBe("MEDIA_PLAY_PAUSE");
    expect(normalizeKeyInput("dpad-center")).toBe("DPAD_CENTER");
    // Special string aliases stay lowercase — the transports map them by name.
    expect(normalizeKeyInput("back")).toBe("back");
    expect(normalizeKeyInput("enter")).toBe("enter");
    expect(normalizeKeyInput("menu")).toBe("menu");
  });

  it("parseIntOption uses radix 10 and ignores commander's previous-value arg", () => {
    // Commander invokes an option coercer as coerce(value, previous), where
    // `previous` starts as the option's default. Bare `parseInt` then treats a
    // numeric default as the radix — parseInt("1500", 5000) === NaN — silently
    // breaking every `--timeout/--duration/--interval/--repeat` flag.
    expect(parseIntOption("1500", 5000)).toBe(1500);
    expect(parseIntOption("500", 300)).toBe(500);
    expect(parseIntOption("60", 80)).toBe(60);
    expect(parseIntOption("42")).toBe(42);
  });

  it("detects am start failures in output (which exits 0 even on error)", () => {
    // `am start` prints errors to stdout and exits 0, so the shell exit code
    // can't be trusted — the output must be parsed.
    expect(
      amStartError(
        "Starting: Intent { cmp=com.fake.nope/.Nope }\nError type 3\nError: Activity class {com.fake.nope/com.fake.nope.Nope} does not exist."
      )
    ).toMatch(/does not exist/);
    expect(
      amStartError("Error: Activity not started, unable to resolve Intent")
    ).toMatch(/unable to resolve/);
    expect(
      amStartError("java.lang.SecurityException: Permission Denial")
    ).toMatch(/SecurityException/);
    // Successes (including the "brought to the front" warning) are not failures.
    expect(amStartError("Starting: Intent { ... }\nStatus: ok")).toBeNull();
    expect(
      amStartError(
        "Warning: Activity not started, its current task has been brought to the front"
      )
    ).toBeNull();
  });

  it("builds bounded clear input commands", () => {
    expect(clearFocusedInputCommand(2)).toContain("-lt 2");
    expect(clearFocusedInputCommand(999)).toContain("-lt 500");
  });

  it("parses package and launcher output", () => {
    expect(parsePackageList("package:com.android.settings\npackage:com.android.chrome"))
      .toEqual(["com.android.chrome", "com.android.settings"]);
    expect(parseLauncherActivities("com.android.settings/.Settings\ncom.foo/com.foo.Main"))
      .toEqual([
        { activity: "com.android.settings.Settings", packageName: "com.android.settings" },
        { activity: "com.foo.Main", packageName: "com.foo" },
      ]);
  });

  it("parses the foreground component (package + fully-qualified activity)", () => {
    // mFocusedApp is the canonical foreground Activity (relative class name);
    // resolve it against the package.
    const out = [
      "  mCurrentFocus=Window{b075137 u0 com.android.settings/com.android.settings.Settings}",
      "  mFocusedApp=ActivityRecord{ca72a9b u0 com.android.settings/.Settings} t10}",
    ].join("\n");
    expect(parseCurrentComponent(out)).toEqual({
      packageName: "com.android.settings",
      activity: "com.android.settings.Settings",
      component: "com.android.settings/com.android.settings.Settings",
    });

    // A focused dialog/popup window (mCurrentFocus) over a hosting activity:
    // mFocusedApp still names the activity.
    const dialog = [
      "  mCurrentFocus=Window{1a2 u0 NotificationShade}",
      "  mFocusedApp=ActivityRecord{9f u0 com.google.android.deskclock/com.android.deskclock.DeskClock} t5}",
    ].join("\n");
    expect(parseCurrentComponent(dialog).activity).toBe("com.android.deskclock.DeskClock");
    expect(parseCurrentComponent(dialog).packageName).toBe("com.google.android.deskclock");

    // Nothing focused (lock screen) → nulls.
    expect(parseCurrentComponent("  mFocusedApp=null")).toEqual({
      packageName: null,
      activity: null,
      component: null,
    });
  });

  it("resolves app aliases and package-like names", () => {
    const packages = ["com.android.settings", "com.example.notes"];
    expect(resolveAppPackage({ packages, query: "settings" })?.packageName)
      .toBe("com.android.settings");
    expect(resolveAppPackage({ packages, query: "notes" })?.packageName)
      .toBe("com.example.notes");
  });

  it("builds deep link and component launch commands", () => {
    expect(launchTargetCommand({ target: "https://mobileuse.dev/demo" }))
      .toBe("am start -W -a 'android.intent.action.VIEW' -d 'https://mobileuse.dev/demo'");
    expect(launchTargetCommand({ packageName: "com.android.chrome", target: "https://example.com/a'b" }))
      .toBe("am start -W -a 'android.intent.action.VIEW' -p 'com.android.chrome' -d 'https://example.com/a'\"'\"'b'");
    expect(launchTargetCommand({ target: "com.example/.MainActivity" }))
      .toBe("am start -W -n 'com.example/.MainActivity'");
  });

  it("builds action-only intents (settings shortcuts) without data/component", () => {
    expect(launchTargetCommand({ action: "android.settings.WIFI_SETTINGS" }))
      .toBe("am start -W -a 'android.settings.WIFI_SETTINGS'");
    expect(launchTargetCommand({ action: "android.settings.SETTINGS", packageName: "com.android.settings" }))
      .toBe("am start -W -a 'android.settings.SETTINGS' -p 'com.android.settings'");
    expect(() => launchTargetCommand({})).toThrow(/requires a target/);
  });

  it("parses current app and scroll geometry", () => {
    expect(parseCurrentPackage("mCurrentFocus=Window{u0 com.android.settings/.Settings}"))
      .toBe("com.android.settings");
    expect(parseScreenSize("Physical size: 1080x1920")).toEqual({
      height: 1920,
      width: 1080,
    });
    expect(scrollSwipe({ direction: "down", height: 1000, width: 500 }))
      .toEqual({ x1: 250, x2: 250, y1: 750, y2: 250 });
  });
});
