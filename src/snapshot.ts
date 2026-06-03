import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  // Owning window/app of this node. Tiny captures all windows (foreground app,
  // status bar, nav bar, IME, dialogs); these let the renderer separate nodes
  // that belong to a different surface than the foreground activity.
  bundleId?: string;
  windowId?: number;
  surface?: string;
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
  parentIndex?: number;
  raw: Record<string, unknown>;
  ref: string;
  role: string;
  scrollable: boolean;
  selected: boolean;
  stableId?: string;
  sourceRole?: string;
  value?: string;
  // Display name resolution (computed in normalize). `title` is the element's
  // primary name (own contentDescription, or a hittable row's `…:id/title` child);
  // `subtitle` is the secondary line (a `…:id/summary` child). `consumed` marks a
  // text node whose content was folded into a parent's title/subtitle so it isn't
  // also rendered as its own line.
  title?: string;
  subtitle?: string;
  consumed?: boolean;
  // Indentation level (count of kept ancestors), pre-computed during display
  // selection when parentIndex linkage is present. The renderer falls back to a
  // depth-stack when it's absent (synthetic/legacy snapshots without parentIndex).
  displayDepth?: number;
}

export interface SnapshotForegroundSignature {
  activity?: string;
  bundleId?: string;
  component?: string;
  eventSeq?: number;
  layoutDigest?: string;
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
  foregroundSignature?: SnapshotForegroundSignature;
  nodes: SnapshotNode[];
  raw: Record<string, unknown>;
  treeDigest?: string;
  // Screen rect used to cull off-screen nodes in the text view. Derived from the
  // depth-0 (root/decor) bounds union, which Android clips to the display — so it
  // tracks the viewport, not the taller scrollable content beneath it.
  viewport?: { width: number; height: number };
}

export interface FormatSnapshotOptions {
  // Render every node including structural containers and off-screen content
  // (the full pre-order tree). Disables both collapse and viewport culling.
  all?: boolean;
  bounds?: boolean;
  header?: boolean;
  interactive?: boolean;
  // Keep nodes below the fold (skip viewport culling) while still collapsing
  // structural noise.
  offscreen?: boolean;
}

export interface CompactAgentSnapshotNode {
  actions: string[];
  bounds?: SnapshotBounds;
  disabled?: boolean;
  id?: string;
  label?: string;
  ref: string;
  role: string;
  selectors?: {
    id?: string;
    label?: string;
    text?: string;
  };
  state?: {
    checked?: boolean;
    focused?: boolean;
    selected?: boolean;
  };
  stableId?: string;
  subtitle?: string;
  value?: string;
}

export interface CompactAgentSnapshotOutput {
  activity?: string;
  appName?: string;
  backend: SnapshotDocument["backend"];
  bundleId?: string;
  capturedAt: string;
  component?: string;
  deviceId: string;
  foregroundSignature?: SnapshotForegroundSignature;
  layoutDigest?: string;
  nodes: CompactAgentSnapshotNode[];
  totalNodeCount: number;
}

export function foregroundSignatureOf(
  snapshot: Pick<SnapshotDocument, "activity" | "bundleId" | "component" | "eventSeq" | "layoutDigest">
): SnapshotForegroundSignature {
  return {
    activity: snapshot.activity,
    bundleId: snapshot.bundleId,
    component: canonicalForegroundComponent(snapshot.component),
    eventSeq: snapshot.eventSeq,
    layoutDigest: snapshot.layoutDigest,
  };
}

export function canonicalForegroundComponent(component: string | undefined): string | undefined {
  if (!component) return undefined;
  const slash = component.indexOf("/");
  if (slash <= 0 || slash === component.length - 1) return component;
  const packageName = component.slice(0, slash);
  const rawActivity = component.slice(slash + 1);
  const activity = rawActivity.startsWith(".")
    ? packageName + rawActivity
    : rawActivity.includes(".")
      ? rawActivity
      : packageName + "." + rawActivity;
  return packageName + "/" + activity;
}

function stampForegroundSignature(snapshot: SnapshotDocument): SnapshotDocument {
  const current = foregroundSignatureOf(snapshot);
  const previous = snapshot.foregroundSignature;
  snapshot.foregroundSignature = {
    activity: current.activity ?? previous?.activity,
    bundleId: current.bundleId ?? previous?.bundleId,
    component: current.component ?? canonicalForegroundComponent(previous?.component),
    eventSeq: current.eventSeq ?? previous?.eventSeq,
    layoutDigest: current.layoutDigest ?? previous?.layoutDigest,
  };
  return snapshot;
}

export interface ForegroundSignatureComparison {
  ok: boolean;
  reason?: string;
}

function hasComparableSignature(
  signature: SnapshotForegroundSignature | null | undefined
): signature is SnapshotForegroundSignature & { component: string; layoutDigest: string } {
  return Boolean(
    signature &&
      canonicalForegroundComponent(signature.component) &&
      typeof signature.layoutDigest === "string" &&
      signature.layoutDigest.length > 0
  );
}

export function compareForegroundSignatures(input: {
  cached?: SnapshotForegroundSignature | null;
  live?: SnapshotForegroundSignature | null;
}): ForegroundSignatureComparison {
  if (!hasComparableSignature(input.cached)) {
    return { ok: false, reason: "missing cached foreground signature" };
  }
  if (!hasComparableSignature(input.live)) {
    return { ok: false, reason: "missing live foreground signature" };
  }
  const cachedComponent = canonicalForegroundComponent(input.cached.component)!;
  const liveComponent = canonicalForegroundComponent(input.live.component)!;
  if (cachedComponent !== liveComponent) {
    return {
      ok: false,
      reason: `foreground changed from ${cachedComponent} to ${liveComponent}`,
    };
  }
  if (input.cached.layoutDigest !== input.live.layoutDigest) {
    return { ok: false, reason: "layout changed since last snap" };
  }
  return { ok: true };
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
        parentIndex: typeof node.parentIndex === "number" ? node.parentIndex : undefined,
        bundleId: firstString(node, ["bundleId", "packageName", "package"]),
        windowId: typeof node.windowId === "number" ? node.windowId : undefined,
        surface: firstString(node, ["surface"]),
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
  resolveTitles(nodes);

  const document: SnapshotDocument = {
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
    nodes,
    raw,
    treeDigest: firstString(raw, ["treeDigest"]),
    viewport: deriveViewport(nodes),
  };
  document.foregroundSignature = foregroundSignatureOf(document);
  return document;
}

// Resolve each actionable node's display name. An own contentDescription wins as
// the title. A `hittable` row WITHOUT its own name borrows from descendant text:
// the child whose resource-id ends `/title` (else the first text child) becomes the
// title; the `/summary` child (else the next text child) becomes the subtitle. The
// borrowed children are marked `consumed` so they don't also render as their own
// lines. Non-hittable containers (scroll/list) stay nameless. This is how we tell
// title vs subtitle apart on Android, which otherwise only exposes flat text.
function resolveTitles(nodes: SnapshotNode[]): void {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (!isInteractiveNode(node)) continue;
    if (node.label) {
      node.title = node.label;
      continue;
    }
    if (!node.hittable) continue;
    const kids: SnapshotNode[] = [];
    for (let j = index + 1; j < nodes.length; j++) {
      const child = nodes[j]!;
      if (node.depth !== undefined && child.depth !== undefined && child.depth <= node.depth) {
        break;
      }
      if (!containsBounds(node.bounds, child.bounds)) continue;
      if (!(child.value || child.role === "text")) continue;
      if (child.label ?? child.value) kids.push(child);
    }
    if (kids.length === 0) continue;
    const byTitle = kids.find((k) => /\/title$/.test(k.identifier ?? ""));
    const bySummary = kids.find((k) => /\/summary$/.test(k.identifier ?? ""));
    const titleNode = byTitle ?? kids[0]!;
    const subNode = bySummary ?? kids.find((k) => k !== titleNode);
    node.title = titleNode.label ?? titleNode.value;
    titleNode.consumed = true;
    if (subNode) {
      node.subtitle = subNode.label ?? subNode.value;
      subNode.consumed = true;
    }
  }
}

// The viewport = union of the shallowest-depth (root/decor) node bounds. Android
// clips the decor view to the physical display, so this is the screen rect even
// when scrollable content beneath reports a taller bottom. Returns undefined when
// no root bounds exist (then culling is skipped — every node renders).
function deriveViewport(
  nodes: SnapshotNode[]
): { width: number; height: number } | undefined {
  let minDepth = Infinity;
  for (const node of nodes) {
    const depth = node.depth ?? 0;
    if (depth < minDepth) minDepth = depth;
  }
  let width = 0;
  let height = 0;
  for (const node of nodes) {
    if ((node.depth ?? 0) !== minDepth || !node.bounds) continue;
    width = Math.max(width, node.bounds.right);
    height = Math.max(height, node.bounds.bottom);
  }
  return width > 0 && height > 0 ? { width, height } : undefined;
}

// Actionable = the agent can DO something here. Deliberately excludes
// focusable/focused: on Android focus is a side effect of tapping, not a discrete
// action, so focus-only containers collapse away as structure.
export function isInteractiveNode(node: SnapshotNode): boolean {
  return (
    node.hittable ||
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

// Strip the constant "<package>:id/" prefix Android puts on every resource-id —
// the package is redundant noise on every line. "com.android.chrome:id/url_bar"
// → "url_bar". Leaves ids without that shape (e.g. webview "mwFw") untouched.
function idLeaf(id: string): string {
  return id.replace(/^[^:\s]+:id\//, "");
}

// TitleCase display names for our normalized roles (CUA-style: `Button`, not `[button]`).
const DISPLAY_ROLE: Record<string, string> = {
  button: "Button", text: "Text", textinput: "TextField", image: "Image",
  scrollview: "ScrollView", list: "List", checkbox: "CheckBox", switch: "Switch",
  group: "Group", node: "Node",
};
function displayRole(role: string): string {
  return DISPLAY_ROLE[role] ?? (role ? role[0]!.toUpperCase() + role.slice(1) : "Node");
}

// Map our state flags to the concrete actions an agent can perform here.
function nodeActions(node: SnapshotNode): string[] {
  const actions: string[] = [];
  if (node.hittable) actions.push("press");
  if (node.longPressable) actions.push("long_press");
  if (node.editable) actions.push("set_value");
  if (node.checkable) actions.push("toggle");
  if (node.scrollable) actions.push("scroll");
  return actions;
}

function hasPositiveArea(node: SnapshotNode): boolean {
  const b = node.bounds;
  return !b || (b.bottom > b.top && b.right > b.left);
}

function hasDisplayName(node: SnapshotNode): boolean {
  return Boolean(node.title ?? node.label ?? node.value ?? node.identifier);
}

function keepDefaultNode(node: SnapshotNode): boolean {
  if (!hasPositiveArea(node)) return false;
  if (!isInteractiveNode(node)) return true;
  return hasDisplayName(node);
}

// IME / soft-keyboard windows. Their keys are almost never ref-tap targets (you
// `type` instead), so the renderer collapses them to a single hint line.
function isImePackage(bundleId: string | undefined): boolean {
  return /inputmethod|keyboard|\.ime\.|\bime\b/i.test(bundleId ?? "");
}

function formatNode(node: SnapshotNode, opts: FormatSnapshotOptions): string {
  // Actionable nodes carry a ref, name, resource-id, and `actions=[…]`. Read-only
  // text renders ref-less with a bare quoted string — visible to read, not a target.
  const interactive = isInteractiveNode(node);
  const parts: string[] = [];
  if (interactive) parts.push(node.ref);
  parts.push(displayRole(node.role));

  if (interactive) {
    const title = node.title ?? node.label;
    if (title) parts.push(quote(truncate(title)));
    if (node.subtitle) parts.push(`subtitle=${quote(truncate(node.subtitle))}`);
    // The node's own current text (an editable field's contents, a dynamic value).
    if (node.value && node.value !== title) parts.push(`= ${quote(truncate(node.value))}`);
  } else {
    const text = node.label ?? node.value;
    if (text) parts.push(quote(truncate(text)));
  }

  const attrs: string[] = [];
  if (interactive && node.identifier) attrs.push(`id=${truncate(idLeaf(node.identifier), 120)}`);
  if (node.focused) attrs.push("focused");
  if (interactive && !node.enabled) attrs.push("disabled");
  if (node.checkable) attrs.push(node.checked ? "checked" : "unchecked");
  if (interactive && node.selected) attrs.push("selected");
  if (interactive) {
    const actions = nodeActions(node);
    if (actions.length) attrs.push(`actions=[${actions.join(",")}]`);
  }
  if (opts.bounds && node.bounds) {
    const { left, top, right, bottom } = node.bounds;
    attrs.push(`bounds=${left},${top},${right},${bottom}`);
  }
  if (attrs.length) parts.push(`[${attrs.join(" ")}]`);

  return parts.join(" ");
}

// Collapse structural noise: keep interactive nodes plus standalone readable text
// the agent would otherwise be blind to. Shared by the JSON node list and the text
// view. (Comment below documents the readable-text rule.)
function compactKeep(
  nodes: SnapshotNode[],
  opts: { actionableOnly?: boolean } = {}
): SnapshotNode[] {
  const keep = new Set(nodes.filter((node) => isInteractiveNode(node) && keepDefaultNode(node)));
  // `-i` / actionableOnly: only the tappable/typeable nodes — skip the readable-text
  // pass below (this is what `snap -i` returns).
  if (opts.actionableOnly) return nodes.filter((node) => keep.has(node));
  // Compact mode keeps interactive nodes AND standalone readable text the agent
  // would otherwise be blind to (headings, descriptions, displayed values, error
  // text). Only `role === "text"` qualifies — labeled layout containers
  // (framelayout/linearlayout with a contentDescription) are noise. And a text
  // node is dropped when its content already appears in a kept node's
  // (absorbed) label/value, so the "·"-joined row labels aren't duplicated.
  const seen = [...keep]
    .flatMap((node) => [node.title, node.subtitle, node.label, node.value])
    .filter(Boolean)
    .join("\u0000");
  for (const node of nodes) {
    if (keep.has(node)) continue;
    if (!keepDefaultNode(node)) continue;
    if (node.consumed) continue;
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
  return nodes.filter((node) => keep.has(node));
}

function isOnScreen(
  node: SnapshotNode,
  viewport: { width: number; height: number }
): boolean {
  const b = node.bounds;
  if (!b) return true;
  // Zero/negative-area nodes (e.g. a fold-straddling list row that collapses to a
  // 0px-high line at the viewport edge) have no tappable surface — treat as
  // off-screen so they don't render as title-less, un-tappable phantom buttons.
  if (b.bottom <= b.top || b.right <= b.left) return false;
  return b.bottom > 0 && b.top < viewport.height && b.right > 0 && b.left < viewport.width;
}

// Indent each kept node by its number of kept ancestors, walking the parentIndex
// chain over the full tree. This re-bases nesting to the displayed tree so culling
// intermediate containers doesn't leave a staircase. Returns nodes unchanged (no
// displayDepth set) when parentIndex linkage is absent — the renderer then falls
// back to its depth-stack.
function annotateDisplayDepth(
  kept: SnapshotNode[],
  allNodes: SnapshotNode[]
): SnapshotNode[] {
  if (!allNodes.some((node) => typeof node.parentIndex === "number")) return kept;
  const byRef = new Map(allNodes.map((node) => [node.ref, node]));
  const keptRefs = new Set(kept.map((node) => node.ref));
  const depthOf = (node: SnapshotNode): number => {
    let depth = 0;
    let parentIndex = node.parentIndex;
    let hops = 0;
    while (typeof parentIndex === "number" && parentIndex >= 0 && hops++ < 1024) {
      const parent = byRef.get(`@e${parentIndex + 1}`);
      if (!parent) break;
      if (keptRefs.has(parent.ref)) depth++;
      parentIndex = parent.parentIndex;
    }
    return depth;
  };
  return kept.map((node) => ({ ...node, displayDepth: depthOf(node) }));
}

// Structured/JSON node list: collapse structural noise but keep the COMPLETE set
// (on- and off-screen). Viewport culling is a text-presentation concern handled in
// formatSnapshot — programmatic consumers (MCP, post-state, `--json`) get every
// collapsed node so nothing is silently dropped.
export function snapshotNodesForDisplay(
  snapshot: SnapshotDocument | SnapshotOutput,
  opts: FormatSnapshotOptions
): SnapshotNode[] {
  if (opts.all) return snapshot.nodes;
  return compactKeep(snapshot.nodes, { actionableOnly: !!opts.interactive });
}

// Text-view selection: collapse, then cull off-screen nodes (unless `all`/`offscreen`)
// and report what was hidden below the fold so the agent knows to scroll.
function selectForDisplay(
  snapshot: SnapshotDocument | SnapshotOutput,
  opts: FormatSnapshotOptions
): { nodes: SnapshotNode[]; hiddenBelow: SnapshotNode[] } {
  const base = opts.all
    ? snapshot.nodes
    : compactKeep(snapshot.nodes, { actionableOnly: !!opts.interactive });
  const viewport = snapshot.viewport;
  if (opts.all || opts.offscreen || !viewport) {
    return { nodes: annotateDisplayDepth(base, snapshot.nodes), hiddenBelow: [] };
  }
  const onScreen = base.filter((node) => isOnScreen(node, viewport));
  const hiddenBelow = base.filter(
    (node) => node.bounds && node.bounds.top >= viewport.height && (node.label || node.value)
  );
  return { nodes: annotateDisplayDepth(onScreen, snapshot.nodes), hiddenBelow };
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
    nodes: snapshotNodesForDisplay(snapshot, { interactive: opts.interactive ?? false }),
    raw: undefined,
    totalNodeCount: snapshot.nodes.length,
  };
}

export function snapshotForAgent(snapshot: SnapshotDocument): CompactAgentSnapshotOutput {
  const nodes = snapshotNodesForDisplay(snapshot, { interactive: true }).map((node) => {
    const state: CompactAgentSnapshotNode["state"] = {};
    if (node.focused) state.focused = true;
    if (node.checkable) state.checked = node.checked;
    if (node.selected) state.selected = true;
    const id = node.identifier ? idLeaf(node.identifier) : undefined;
    const label = node.title ?? node.label;
    const value = node.value ?? (node.editable ? node.label : undefined);
    const selectors: CompactAgentSnapshotNode["selectors"] = {};
    if (id) selectors.id = id;
    if (label) selectors.label = label;
    if (value && value !== label) selectors.text = value;
    return {
      actions: nodeActions(node),
      bounds: node.bounds,
      disabled: node.enabled ? undefined : true,
      id,
      label,
      ref: node.ref,
      role: displayRole(node.role),
      selectors: Object.keys(selectors).length ? selectors : undefined,
      state: Object.keys(state).length ? state : undefined,
      stableId: node.stableId,
      subtitle: node.subtitle,
      value,
    };
  });
  return {
    activity: snapshot.activity,
    appName: snapshot.appName,
    backend: snapshot.backend,
    bundleId: snapshot.bundleId,
    capturedAt: snapshot.capturedAt,
    component: snapshot.component,
    deviceId: snapshot.deviceId,
    foregroundSignature: snapshot.foregroundSignature ?? foregroundSignatureOf(snapshot),
    layoutDigest: snapshot.layoutDigest,
    nodes,
    totalNodeCount: snapshot.nodes.length,
  };
}

// Lay a window's nodes out as indented lines. Honors pre-computed displayDepth
// (kept-ancestor depth) when present so culled intermediates don't leave a
// staircase; falls back to a depth-stack (turning absolute pre-order depths into
// relative nesting) for snapshots without parentIndex.
function renderGroup(groupNodes: SnapshotNode[], options: FormatSnapshotOptions): string[] {
  // A focused node gets an obvious "▶" bullet (plus a `focused` attr); everything
  // else a plain "-".
  const bullet = (node: SnapshotNode): string => (node.focused ? "▶ " : "- ");
  if (groupNodes.some((node) => node.displayDepth !== undefined)) {
    return groupNodes.map(
      (node) => "  ".repeat(node.displayDepth ?? 0) + bullet(node) + formatNode(node, options)
    );
  }
  const stack: number[] = [];
  return groupNodes.map((node) => {
    const depth = node.depth ?? 0;
    while (stack.length > 0 && stack[stack.length - 1]! >= depth) stack.pop();
    const indent = "  ".repeat(stack.length);
    stack.push(depth);
    return indent + bullet(node) + formatNode(node, options);
  });
}

function appendScrollHint(lines: string[], hiddenBelow: SnapshotNode[]): void {
  if (hiddenBelow.length === 0) return;
  const preview = hiddenBelow
    .slice(0, 4)
    .map((node) => quote(truncate(node.label ?? node.value ?? "", 24)))
    .join(", ");
  lines.push(
    `  [${hiddenBelow.length} more below — scroll: ${preview}${hiddenBelow.length > 4 ? ", …" : ""}]`
  );
}

// The window holding the foreground activity: prefer windows owned by the
// component's package (the activity Tiny reports), else the densest window.
// Returns undefined when no node carries windowId (synthetic/legacy data), so
// single-window rendering stays unchanged.
function primaryWindowId(
  snapshot: SnapshotDocument | SnapshotOutput,
  nodes: SnapshotNode[]
): number | undefined {
  const pkg = snapshot.component?.split("/")[0];
  const tally = (predicate: (node: SnapshotNode) => boolean): Map<number, number> => {
    const counts = new Map<number, number>();
    for (const node of nodes) {
      if (node.windowId === undefined || !predicate(node)) continue;
      counts.set(node.windowId, (counts.get(node.windowId) ?? 0) + 1);
    }
    return counts;
  };
  let counts = pkg ? tally((node) => node.bundleId === pkg) : new Map<number, number>();
  if (counts.size === 0) counts = tally(() => true);
  let best: number | undefined;
  let bestCount = -1;
  for (const [windowId, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = windowId;
    }
  }
  return best;
}

export function formatSnapshot(
  snapshot: SnapshotDocument | SnapshotOutput,
  opts: FormatSnapshotOptions = {}
): string {
  const options = { header: true, ...opts };
  const { nodes, hiddenBelow } = selectForDisplay(snapshot, options);
  const primaryWin = primaryWindowId(snapshot, nodes);

  const lines: string[] = [];
  if (primaryWin === undefined) {
    lines.push(...renderGroup(nodes, options));
    appendScrollHint(lines, hiddenBelow);
  } else {
    const primary = nodes.filter(
      (node) => node.windowId === undefined || node.windowId === primaryWin
    );
    const foreign = nodes.filter(
      (node) => node.windowId !== undefined && node.windowId !== primaryWin
    );
    lines.push(...renderGroup(primary, options));
    appendScrollHint(lines, hiddenBelow);
    // Nodes from other windows (status bar, nav bar, IME, dialogs) are NOT part of
    // the foreground activity. Group them under a labeled divider, in first-seen
    // window order, so the agent doesn't read them as part of the current screen.
    const order: number[] = [];
    const groups = new Map<number, SnapshotNode[]>();
    for (const node of foreign) {
      const windowId = node.windowId!;
      if (!groups.has(windowId)) {
        groups.set(windowId, []);
        order.push(windowId);
      }
      groups.get(windowId)!.push(node);
    }
    for (const windowId of order) {
      const group = groups.get(windowId)!;
      const owner = group[0]?.bundleId ?? `window ${windowId}`;
      // Soft keyboards are dozens of key buttons you never ref-tap (you `type`).
      // Collapse to a one-line hint unless --all.
      if (!options.all && isImePackage(owner)) {
        const keys = group.filter((node) => node.hittable).length;
        lines.push(
          `[keyboard open · ${owner} (~${keys} keys) — use \`type\` to enter text; --all to show keys]`
        );
        continue;
      }
      lines.push(`[other window · ${owner}]`);
      lines.push(...renderGroup(group, options));
    }
  }

  // `--offscreen` only un-culls nodes that are in the tree but below the viewport
  // fold; it does NOT (and can't) reveal scrolled-away list rows, which Android
  // recycles out of the accessibility tree entirely. Agents reach for it expecting
  // the rest of a long list — so when it's used, say where the missing content
  // actually lives: `scroll` (list rows) and `--all` (folded structural nodes).
  if (options.offscreen && !options.all) {
    lines.push(
      "[--offscreen shows every in-tree node; off-screen list rows are recycled by Android and load only on `scroll` — use `--all` for folded structural containers]"
    );
  }

  if (!options.header) return lines.join("\n");

  // Foreground app package (from the resolved component) is the reliable "where
  // am I" — `appName`/`bundleId` is the raw window owner, often "System UI".
  const target =
    snapshot.component?.split("/")[0] ??
    snapshot.appName ??
    snapshot.bundleId ??
    snapshot.deviceId;
  // Show the foreground activity in the header when known.
  const where = snapshot.activity ? `${target} [${snapshot.activity}]` : target;
  return [
    `Snapshot ${where} (${nodes.length}/${snapshot.nodes.length} nodes, backend=${snapshot.backend})`,
    ...lines,
  ].join("\n");
}

export function saveLastSnapshot(snapshot: SnapshotDocument): void {
  stampForegroundSignature(snapshot);
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
  return stampForegroundSignature(JSON.parse(readFileSync(path, "utf8")) as SnapshotDocument);
}

// Drop the cached snapshot after a navigation that changes the screen without
// re-capturing (back/home/recent). The stored @eN coordinates no longer match the
// live screen, so a follow-up `tap @eN` would blindly tap stale coordinates; with
// the cache cleared it fails safe ("run snap first") instead.
export function clearLastSnapshot(deviceId: string): void {
  const path = join(SNAPSHOT_DIR, `${deviceId}.json`);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // best-effort — a stale cache is recreated by the next snap
  }
}

export function resolveSnapshotRef(
  snapshot: SnapshotDocument,
  ref: string
): SnapshotNode | null {
  const normalized = ref.startsWith("@") ? ref : `@${ref}`;
  return snapshot.nodes.find((node) => node.ref === normalized) ?? null;
}

// Resolve a durable `id=…` / `label=…` / `text=…` selector against the cached
// snapshot — a handle that survives re-renders, unlike index-based @eN refs (which
// are reassigned every screen change). `id=` matches the resource-id (full, or the
// package-stripped leaf we display — exact). `label=` matches the resolved title or
// raw contentDescription; `text=` also matches the node's displayed value. Both are
// case-insensitive. When several nodes match, the actionable one wins — so a row's
// tappable Button is chosen over its consumed child text. Surrounding quotes optional.
export function resolveSelector(
  snapshot: SnapshotDocument,
  selector: string
): SnapshotNode | null {
  const match = /^\s*(id|label|text)\s*=\s*(.+?)\s*$/i.exec(selector);
  if (!match) return null;
  const kind = match[1]!.toLowerCase();
  let value = match[2]!;
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  if (!value) return null;
  const ieq = (candidate?: string): boolean =>
    candidate !== undefined && candidate.toLowerCase() === value.toLowerCase();
  const matches = (node: SnapshotNode): boolean => {
    if (kind === "id") {
      return node.identifier === value || idLeaf(node.identifier ?? "") === value;
    }
    if (kind === "label") {
      return node.title === value || node.label === value || ieq(node.title) || ieq(node.label);
    }
    return (
      node.value === value ||
      node.title === value ||
      node.label === value ||
      ieq(node.value) ||
      ieq(node.title) ||
      ieq(node.label)
    );
  };
  const hits = snapshot.nodes.filter(matches);
  if (hits.length === 0) return null;
  // Only resolve to an ACTIONABLE node — read-only text is not an action target,
  // so a selector that matches only read-only nodes returns null (the caller then
  // reports "did not resolve" rather than silently tapping a label).
  return hits.find((node) => node.hittable) ?? hits.find(isInteractiveNode) ?? null;
}

export function nodeCenter(node: SnapshotNode): { x: number; y: number } | null {
  if (!node.bounds) return null;
  return {
    x: Math.round((node.bounds.left + node.bounds.right) / 2),
    y: Math.round((node.bounds.top + node.bounds.bottom) / 2),
  };
}
