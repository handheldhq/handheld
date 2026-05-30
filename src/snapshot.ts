import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HANDHELD_HOME } from "./state.js";

export interface SnapshotBounds {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface SnapshotNode {
  actionableId?: string;
  bounds?: SnapshotBounds;
  checked: boolean;
  checkable: boolean;
  depth?: number;
  editable: boolean;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  hittable: boolean;
  identifier?: string;
  label?: string;
  longPressable: boolean;
  raw: Record<string, unknown>;
  ref: string;
  role: string;
  scrollable: boolean;
  selected: boolean;
  stableId?: string;
  sourceRole?: string;
  value?: string;
}

export interface SnapshotDocument {
  actionDigest?: string;
  activity?: string;
  appName?: string;
  backend: "tiny";
  bundleId?: string;
  component?: string;
  capturedAt: string;
  deviceId: string;
  eventSeq?: number;
  // Filter-independent digest of the full-screen actionable set. Unlike
  // actionDigest/treeDigest (hashed over the *returned*, filter-dependent
  // nodes), this is the same regardless of `interactive`/`compact` — the only
  // digest safe to compare across two snapshots taken with different filters.
  layoutDigest?: string;
  nodes: SnapshotNode[];
  raw: Record<string, unknown>;
  treeDigest?: string;
}

export interface FormatSnapshotOptions {
  bounds?: boolean;
  header?: boolean;
  interactive?: boolean;
}

const SNAPSHOT_DIR = join(HANDHELD_HOME, "snapshots");

function objectPayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") {
    throw new Error("Tiny snapshot response was not an object");
  }
  const root = raw as Record<string, unknown>;
  for (const key of ["snapshot", "post", "state"]) {
    const value = root[key];
    if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).nodes)) {
      return value as Record<string, unknown>;
    }
  }
  return root;
}

function firstString(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return undefined;
}

function firstValueString(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

function boolField(
  raw: Record<string, unknown>,
  keys: string[],
  fallback: boolean
): boolean {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") return value;
  }
  return fallback;
}

function intValue(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue) : null;
}

function normalizeBounds(rawBounds: unknown): SnapshotBounds | undefined {
  if (!rawBounds || typeof rawBounds !== "object") return undefined;
  const bounds = rawBounds as Record<string, unknown>;
  const left = intValue(bounds.left);
  const top = intValue(bounds.top);
  const right = intValue(bounds.right);
  const bottom = intValue(bounds.bottom);
  if (left !== null && top !== null && right !== null && bottom !== null) {
    return { bottom, left, right, top };
  }

  const x = intValue(bounds.x);
  const y = intValue(bounds.y);
  const width = intValue(bounds.width);
  const height = intValue(bounds.height);
  if (x !== null && y !== null && width !== null && height !== null) {
    return { bottom: y + height, left: x, right: x + width, top: y };
  }
  return undefined;
}

function containsBounds(parent: SnapshotBounds | undefined, child: SnapshotBounds | undefined): boolean {
  if (!parent || !child) return false;
  return (
    child.left >= parent.left &&
    child.right <= parent.right &&
    child.top >= parent.top &&
    child.bottom <= parent.bottom
  );
}

function roleName(sourceRole: string | undefined, editable: boolean): string {
  const role = sourceRole ?? "node";
  const lower = role.toLowerCase();
  if (editable || lower.includes("edittext")) return "textinput";
  if (lower.includes("button")) return "button";
  if (lower.includes("checkbox")) return "checkbox";
  if (lower.includes("switch")) return "switch";
  if (lower.includes("image")) return "image";
  if (lower.includes("textview")) return "text";
  if (lower.includes("recyclerview") || lower.includes("listview")) return "list";
  if (lower.includes("scroll")) return "scrollview";
  if (lower.includes("viewgroup")) return "group";
  return role.split(".").pop()?.toLowerCase() || "node";
}

export function normalizeTinySnapshot(input: {
  deviceId: string;
  raw: unknown;
}): SnapshotDocument {
  const raw = objectPayload(input.raw);
  const rawNodes = raw.nodes;
  if (!Array.isArray(rawNodes)) {
    throw new Error("Tiny snapshot response missing nodes list");
  }

  const nodes = rawNodes.flatMap((rawNode, index) => {
    if (!rawNode || typeof rawNode !== "object") return [];
    const node = rawNode as Record<string, unknown>;
    const editable = boolField(node, ["editable", "isEditable"], false);
    const sourceRole = firstString(node, ["role", "type", "className", "class"]);
    const depth = typeof node.depth === "number" ? node.depth : undefined;
    return [
      {
        actionableId: firstString(node, ["actionableId", "actionable_id"]),
        bounds: normalizeBounds(node.bounds ?? node.rect),
        checked: boolField(node, ["checked"], false),
        checkable: boolField(node, ["checkable"], false),
        depth,
        editable,
        enabled: boolField(node, ["enabled"], true),
        focusable: boolField(node, ["focusable"], false),
        focused: boolField(node, ["focused"], false),
        hittable: boolField(node, ["hittable", "clickable"], false),
        identifier: firstString(node, ["identifier", "resourceId", "id", "viewId"]),
        label: firstString(node, ["text", "label", "contentDescription", "description", "name"]),
        longPressable: boolField(
          node,
          ["longPressable", "long_pressable", "longClickable", "long_clickable"],
          false
        ),
        raw: node,
        ref: `@e${index + 1}`,
        role: roleName(sourceRole, editable),
        scrollable: boolField(node, ["scrollable"], false),
        selected: boolField(node, ["selected"], false),
        stableId: firstString(node, ["stableId", "stable_id"]),
        sourceRole,
        value: firstValueString(node, ["value", "inputValue"]),
      },
    ];
  });
  const labeledNodes = nodes.map((node, index) => {
    if (node.label || !isInteractiveNode(node)) return node;
    const labels: string[] = [];
    for (const child of nodes.slice(index + 1)) {
      if (
        node.depth !== undefined &&
        child.depth !== undefined &&
        child.depth <= node.depth
      ) {
        break;
      }
      if (!containsBounds(node.bounds, child.bounds)) continue;
      const label = child.label ?? child.value;
      if (label && !labels.includes(label)) labels.push(label);
      if (labels.length >= 2) break;
    }
    return labels.length > 0 ? { ...node, label: labels.join(" · ") } : node;
  });

  return {
    appName: firstString(raw, ["appName", "package"]),
    backend: "tiny",
    bundleId: firstString(raw, ["bundleId", "package"]),
    actionDigest: firstString(raw, ["actionDigest"]),
    // Foreground activity/component, when Tiny resolved it on-device (it folds
    // these into the /v2/snapshot response). Flows to every snapshot consumer —
    // pre-state and post-state alike — with no host-side dumpsys.
    activity: firstString(raw, ["activity"]),
    component: firstString(raw, ["component"]),
    capturedAt: new Date().toISOString(),
    deviceId: input.deviceId,
    eventSeq: typeof raw.eventSeq === "number" ? raw.eventSeq : undefined,
    layoutDigest: firstString(raw, ["layoutDigest"]),
    nodes: labeledNodes,
    raw,
    treeDigest: firstString(raw, ["treeDigest"]),
  };
}

function isInteractiveNode(node: SnapshotNode): boolean {
  return (
    node.hittable ||
    node.focusable ||
    node.focused ||
    node.editable ||
    node.longPressable ||
    node.scrollable ||
    node.checkable ||
    ["button", "checkbox", "switch", "textinput"].includes(node.role)
  );
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function truncate(value: string, max = 96): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatNode(node: SnapshotNode, opts: FormatSnapshotOptions): string {
  const parts = [`${node.ref} [${node.role}]`];
  if (node.label) parts.push(`label=${quote(truncate(node.label))}`);
  if (node.editable && node.value !== undefined) {
    parts.push(`preview=${quote(truncate(node.value))}`);
  } else if (node.value && node.value !== node.label) {
    parts.push(`value=${quote(truncate(node.value))}`);
  }
  if (node.identifier) parts.push(`id=${quote(truncate(node.identifier, 120))}`);

  const flags: string[] = [];
  flags.push(node.enabled ? "enabled" : "disabled");
  if (node.hittable) flags.push("hittable");
  if (node.focused) flags.push("focused");
  if (node.editable) flags.push("editable");
  if (node.selected) flags.push("selected");
  if (node.checkable) flags.push("checkable");
  if (node.checked) flags.push("checked");
  if (node.scrollable) flags.push("scrollable");
  if (node.longPressable) flags.push("longpress");
  parts.push(...flags);

  if (opts.bounds && node.bounds) {
    const { left, top, right, bottom } = node.bounds;
    parts.push(`bounds=${left},${top},${right},${bottom}`);
  }

  return parts.join(" ");
}

export function snapshotNodesForDisplay(
  snapshot: SnapshotDocument | SnapshotOutput,
  opts: FormatSnapshotOptions
): SnapshotNode[] {
  if (!opts.interactive) return snapshot.nodes;
  const keep = new Set(snapshot.nodes.filter(isInteractiveNode));
  // Compact mode keeps interactive nodes AND standalone readable text the agent
  // would otherwise be blind to (headings, descriptions, displayed values, error
  // text). Only `role === "text"` qualifies — labeled layout containers
  // (framelayout/linearlayout with a contentDescription) are noise. And a text
  // node is dropped when its content already appears in a kept node's
  // (absorbed) label/value, so the "·"-joined row labels aren't duplicated.
  const seen = [...keep]
    .flatMap((node) => [node.label, node.value])
    .filter(Boolean)
    .join(" ");
  for (const node of snapshot.nodes) {
    if (keep.has(node)) continue;
    // "Own displayed text" = a non-empty `value` (the node's getText()), which
    // is role-agnostic so it catches TextView, TextClock, Chronometer, and
    // WebView text alike; `role === "text"` is a fallback for text widgets that
    // report no value. Nodes with only a `label` (a contentDescription on a
    // layout container or icon — role view/framelayout/image, no value) are
    // omitted as noise.
    if (!node.value && node.role !== "text") continue;
    const text = node.label ?? node.value;
    if (text && !seen.includes(text)) keep.add(node);
  }
  return snapshot.nodes.filter((node) => keep.has(node));
}

export type SnapshotOutput = Omit<SnapshotDocument, "raw"> & {
  raw?: SnapshotDocument["raw"];
  totalNodeCount: number;
};

/**
 * The JSON-friendly snapshot shape returned by `snap`/`snap` (and the
 * `--post-state` / MCP post-action snapshot): display-filtered `nodes`, the
 * top-level `raw` doc dropped, and `totalNodeCount` so a filtered list still
 * reports how many nodes existed. `formatSnapshot` accepts it directly (pass
 * `interactive: false` since nodes are already filtered).
 */
export function snapshotForOutput(
  snapshot: SnapshotDocument,
  opts: { interactive?: boolean } = {}
): SnapshotOutput {
  return {
    ...snapshot,
    nodes: snapshotNodesForDisplay(snapshot, { interactive: opts.interactive ?? true }),
    raw: undefined,
    totalNodeCount: snapshot.nodes.length,
  };
}

export function formatSnapshot(
  snapshot: SnapshotDocument | SnapshotOutput,
  opts: FormatSnapshotOptions = {}
): string {
  const options = { header: true, ...opts };
  const nodes = snapshotNodesForDisplay(snapshot, options);
  // Indent each node under its nearest displayed ancestor. Nodes arrive in
  // pre-order DFS with a `depth`; a depth stack turns absolute depths into
  // relative nesting, so filtering out intermediate nodes doesn't leave gaps —
  // a kept child simply nests under the nearest kept (shallower) node.
  const stack: number[] = [];
  const lines = nodes.map((node) => {
    const depth = node.depth ?? 0;
    while (stack.length > 0 && stack[stack.length - 1]! >= depth) stack.pop();
    const indent = "  ".repeat(stack.length);
    stack.push(depth);
    return indent + formatNode(node, options);
  });
  if (!options.header) return lines.join("\n");

  const target = snapshot.appName ?? snapshot.bundleId ?? snapshot.deviceId;
  // Show the foreground activity in the header when known — `appName`/`bundleId`
  // is the window's app (often "System UI"), so the activity is the reliable
  // "where am I".
  const where = snapshot.activity ? `${target} [${snapshot.activity}]` : target;
  return [
    `Snapshot ${where} (${nodes.length}/${snapshot.nodes.length} nodes, backend=${snapshot.backend})`,
    ...lines,
  ].join("\n");
}

export function saveLastSnapshot(snapshot: SnapshotDocument): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(SNAPSHOT_DIR, `${snapshot.deviceId}.json`),
    JSON.stringify(snapshot, null, 2) + "\n",
    { mode: 0o600 }
  );
}

export function loadLastSnapshot(deviceId: string): SnapshotDocument | null {
  const path = join(SNAPSHOT_DIR, `${deviceId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SnapshotDocument;
}

export function resolveSnapshotRef(
  snapshot: SnapshotDocument,
  ref: string
): SnapshotNode | null {
  const normalized = ref.startsWith("@") ? ref : `@${ref}`;
  return snapshot.nodes.find((node) => node.ref === normalized) ?? null;
}

export function nodeCenter(node: SnapshotNode): { x: number; y: number } | null {
  if (!node.bounds) return null;
  return {
    x: Math.round((node.bounds.left + node.bounds.right) / 2),
    y: Math.round((node.bounds.top + node.bounds.bottom) / 2),
  };
}
