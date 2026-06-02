import type { SnapshotDocument, SnapshotNode } from "./snapshot.js";
import { nodeCenter, resolveSelector, resolveSnapshotRef } from "./snapshot.js";

export type KeyInput = string | number;

const KEY_ALIASES: Record<string, number | string> = {
  app_switch: 187,
  app_switcher: 187,
  arrow_down: 20,
  arrow_left: 21,
  arrow_right: 22,
  arrow_up: 19,
  back: "back",
  backspace: 67,
  del: 67,
  delete: 112,
  enter: "enter",
  escape: 111,
  forward_delete: 112,
  home: "home",
  menu: "menu",
  power: 26,
  paste: 279,
  recent: 187,
  recent_apps: 187,
  recents: 187,
  search: 84,
  tab: 61,
  volume_down: 25,
  volume_up: 24,
};

const APP_ALIASES: Record<string, string> = {
  chrome: "com.android.chrome",
  files: "com.google.android.documentsui",
  gmail: "com.google.android.gm",
  maps: "com.google.android.apps.maps",
  play: "com.android.vending",
  "play store": "com.android.vending",
  settings: "com.android.settings",
  youtube: "com.google.android.youtube",
};

export function normalizeKeyInput(key: string | number): KeyInput {
  if (typeof key === "number") return key;
  const trimmed = key.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const normalized = trimmed.toLowerCase().replace(/^keycode_/, "").replace(/-/g, "_");
  const alias = KEY_ALIASES[normalized];
  if (alias !== undefined) return alias;
  // Un-aliased symbolic name: Android's KeyEvent.keyCodeFromString is
  // case-sensitive, so `input keyevent volume_mute` is a silent no-op while
  // VOLUME_MUTE resolves. Hand the device the uppercase label it understands.
  return normalized.toUpperCase();
}

/**
 * Commander option coercer for integer flags. Commander invokes a coercer as
 * `coerce(value, previous)`, where `previous` starts as the option's default.
 * Passing bare `parseInt` therefore makes a numeric default the radix —
 * `parseInt("1500", 5000)` is `NaN` — silently breaking any flag that supplies
 * a default. This forces radix 10 and ignores `previous`.
 */
export function parseIntOption(value: string, _previous?: unknown): number {
  return Number.parseInt(value, 10);
}

export function clearFocusedInputCommand(repeat = 80): string {
  const count = Math.max(1, Math.min(500, Math.round(repeat)));
  return `input keyevent 123; i=0; while [ "$i" -lt ${count} ]; do input keyevent 67; i=$((i+1)); done`;
}

// A durable `id=…` / `label=…` / `text=…` selector (resolved against the cached
// snapshot), as opposed to an index-based @eN ref or raw coordinates.
export function isSelectorTarget(value: string): boolean {
  return /^\s*(id|label|text)\s*=/i.test(value);
}

export function isSnapshotTarget(value: string): boolean {
  return /^@?e\d+$/.test(value) || /^\d+$/.test(value) || isSelectorTarget(value);
}

export function normalizeSnapshotTarget(value: string): string {
  if (/^\d+$/.test(value)) return `@e${value}`;
  if (value.startsWith("@")) return value;
  return `@${value}`;
}

// Resolve a tap/type target to a node: a durable selector when it looks like one,
// otherwise an index-based @eN ref against the cached snapshot.
export function resolveTargetNode(
  snapshot: SnapshotDocument,
  target: string
): SnapshotNode | null {
  return isSelectorTarget(target)
    ? resolveSelector(snapshot, target)
    : resolveSnapshotRef(snapshot, normalizeSnapshotTarget(target));
}

export function pointFromSnapshotTarget(
  snapshot: SnapshotDocument,
  target: string
): { x: number; y: number } | null {
  const node = resolveTargetNode(snapshot, target);
  return node ? nodeCenter(node) : null;
}

export function packageListCommand(includeSystem = true): string {
  return includeSystem ? "pm list packages" : "pm list packages -3";
}

export function parsePackageList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^package:/, ""))
    .filter(Boolean)
    .sort();
}

export interface LauncherActivity {
  activity?: string;
  packageName: string;
}

export function launcherActivitiesCommand(): string {
  return "cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER";
}

export function parseLauncherActivities(output: string): LauncherActivity[] {
  const seen = new Set<string>();
  const activities: LauncherActivity[] = [];
  for (const match of output.matchAll(/([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+|[.][A-Za-z0-9_.$]+)/g)) {
    const packageName = match[1]!;
    const activity = match[2]!.startsWith(".")
      ? `${packageName}${match[2]!}`
      : match[2]!;
    const key = `${packageName}/${activity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    activities.push({ activity, packageName });
  }
  return activities;
}

function appNeedle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function resolveAppPackage(input: {
  activities?: LauncherActivity[];
  packages: string[];
  query: string;
}): LauncherActivity | null {
  const query = input.query.trim();
  if (!query) return null;

  const alias = APP_ALIASES[query.toLowerCase()];
  const candidates = [
    ...(input.activities ?? []),
    ...input.packages.map((packageName) => ({ packageName })),
  ];

  const exact = candidates.find((entry) => entry.packageName === query);
  if (exact) return exact;

  if (alias) {
    const aliasEntry = candidates.find((entry) => entry.packageName === alias);
    return aliasEntry ?? { packageName: alias };
  }

  const needle = appNeedle(query);
  return (
    candidates.find((entry) => appNeedle(entry.packageName.split(".").pop() ?? "") === needle) ??
    candidates.find((entry) => appNeedle(entry.packageName).includes(needle)) ??
    null
  );
}

export function startAppCommand(app: LauncherActivity): string {
  if (app.activity) return `am start -n ${app.packageName}/${app.activity}`;
  return `monkey -p ${app.packageName} -c android.intent.category.LAUNCHER 1 >/dev/null`;
}

function quoteDeviceShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function launchTargetCommand(input: {
  action?: string;
  component?: string;
  data?: string;
  packageName?: string;
  target?: string;
}): string {
  const rawTarget = input.target?.trim();
  if (rawTarget?.startsWith("am ")) return rawTarget;

  const component = input.component ?? (
    rawTarget && /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$/]+$/.test(rawTarget)
      ? rawTarget
      : undefined
  );
  if (component) return `am start -W -n ${quoteDeviceShellArg(component)}`;

  const data = input.data ?? rawTarget;
  if (!data) {
    // Action-only intent (no data/component/target) — e.g. a settings shortcut
    // like `am start -a android.settings.WIFI_SETTINGS`. Valid when an explicit
    // --action was given; otherwise there's nothing to launch.
    if (input.action) {
      return [
        "am start -W",
        "-a",
        quoteDeviceShellArg(input.action),
        input.packageName ? `-p ${quoteDeviceShellArg(input.packageName)}` : "",
      ].filter(Boolean).join(" ");
    }
    throw new Error("launch requires a target, --action, --data, or --component");
  }

  const action = input.action ?? "android.intent.action.VIEW";
  return [
    "am start -W",
    "-a",
    quoteDeviceShellArg(action),
    input.packageName ? `-p ${quoteDeviceShellArg(input.packageName)}` : "",
    "-d",
    quoteDeviceShellArg(data),
  ].filter(Boolean).join(" ");
}

/**
 * `am start` prints failures to stdout and still exits 0, so the shell exit
 * code can't tell a launch apart from a no-such-activity / unresolved-intent /
 * SecurityException error. Inspect the output for the markers `am` uses and
 * return the offending line (or null when the launch looks fine). The success
 * "Warning: Activity not started, its current task has been brought to the
 * front" deliberately does not match — only genuine `Error:`/`Exception` lines.
 */
export function amStartError(output: string): string | null {
  const lines = (output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const detailed = lines.find(
    (line) => /^Error:/.test(line) || /Exception/.test(line) || /does not exist/.test(line)
  );
  if (detailed) return detailed;
  return lines.find((line) => /^Error type \d+/.test(line)) ?? null;
}

export function stopAppCommand(packageName: string): string {
  return `am force-stop ${packageName}`;
}

export function currentAppCommand(): string {
  return "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'";
}

export function parseCurrentPackage(output: string): string | null {
  return output.match(/\s([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/)?.[1] ?? null;
}

export interface CurrentComponent {
  activity: string | null;
  component: string | null;
  packageName: string | null;
}

/**
 * Parse the foreground package + activity from `dumpsys window` focus lines.
 * Prefers `mFocusedApp` (the canonical foreground ActivityRecord, which stays
 * correct even when a dialog/popup owns `mCurrentFocus`); falls back to
 * `mCurrentFocus`. Resolves a relative activity (`.Foo`) against its package
 * and returns a fully-qualified `component` (`pkg/activity`) usable with
 * `launch`.
 */
export function parseCurrentComponent(output: string): CurrentComponent {
  const line = (key: string) => output.split("\n").find((l) => l.includes(key));
  // Anchor on the `uN ` user prefix so we match the component, not other slashes.
  const matchLine = (l: string | undefined) =>
    l?.match(/\bu\d+\s+([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/) ?? null;
  const match = matchLine(line("mFocusedApp")) ?? matchLine(line("mCurrentFocus"));
  if (!match) {
    return { activity: null, component: null, packageName: parseCurrentPackage(output) };
  }
  const packageName = match[1]!;
  const raw = match[2]!;
  const activity = raw.startsWith(".")
    ? `${packageName}${raw}`
    : raw.includes(".")
      ? raw
      : `${packageName}.${raw}`;
  return { activity, component: `${packageName}/${activity}`, packageName };
}

export function screenSizeCommand(): string {
  return "wm size";
}

export function parseScreenSize(output: string): { height: number; width: number } | null {
  const match = output.match(/(\d+)x(\d+)/);
  if (!match) return null;
  return { height: Number(match[2]), width: Number(match[1]) };
}

export function scrollSwipe(input: {
  direction: "down" | "left" | "right" | "up";
  height: number;
  width: number;
}): { x1: number; x2: number; y1: number; y2: number } {
  const midX = Math.round(input.width / 2);
  const midY = Math.round(input.height / 2);
  const lowX = Math.round(input.width * 0.25);
  const highX = Math.round(input.width * 0.75);
  const lowY = Math.round(input.height * 0.25);
  const highY = Math.round(input.height * 0.75);

  switch (input.direction) {
    case "down":
      return { x1: midX, x2: midX, y1: highY, y2: lowY };
    case "up":
      return { x1: midX, x2: midX, y1: lowY, y2: highY };
    case "left":
      return { x1: highX, x2: lowX, y1: midY, y2: midY };
    case "right":
      return { x1: lowX, x2: highX, y1: midY, y2: midY };
  }
}
