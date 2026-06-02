import type { Command } from "commander";

// In-CLI operating manual for agents. `handheld guide` lists topics; `handheld
// guide <topic>` prints one. Kept version-matched to the binary so an agent can
// orient itself from the tool itself instead of external docs.

const WORKFLOW = `
handheld — agent operating guide

CORE LOOP
  connect  ->  snap  ->  read refs  ->  act  ->  re-snap to verify  ->  disconnect
  Take a snapshot, read the actionable refs, act on one, then re-snapshot before
  acting again. The screen changes invalidate refs (see TARGETING).

CONNECT
  handheld connect --local                 # local adb device/emulator (no key)
  handheld connect --local emulator-5554   # name the serial (see: adb devices)
  handheld connect <deviceId>              # cloud phone (needs an API key)
  handheld disconnect                      # tear down
  Local connect bootstraps the on-device Tiny helper that serves snapshots/input.

OBSERVE
  handheld snap                # compact, on-screen, agent-facing tree (default)
  handheld snap --screenshot   # also save a JPEG screenshot
  handheld snap --all          # full uncollapsed tree incl. off-screen + keyboard
  handheld snap --offscreen    # keep below-the-fold nodes (still collapsed)
  handheld snap --raw|--json   # complete structured node list (never culled)
  Read 'handheld guide format' for the line grammar.

TARGETING (how to name what you act on)
  1. @eN ref        — from the last snap. Renumbers on EVERY screen change, so
                      re-snap after any action before reusing refs.
  2. id=/label=     — durable selectors that survive re-renders. Prefer these in
                      scripts. See 'handheld guide selectors'.
  3. x y            — raw coordinates. Last resort (brittle across layouts).

ACT
  handheld tap @e7 | tap 'id=foo' | tap 'label=Submit' | tap 540 960
  handheld long_press <target> | double_tap <target>
  handheld type "text"                 # type into the focused field (replaces)
  handheld type 'label=Notes' "text"   # focus a target first, then type
  handheld type @e5 "text" --append    # append instead of replacing
  handheld swipe x1 y1 x2 y2 | scroll down|up|left|right
  handheld back | home | recent | press_key <name|keycode>
  handheld open_app <pkg|alias> | launch <url|component> | copy/paste

WINDOWS & KEYBOARD
  Only the foreground activity's nodes are shown inline. Nodes from other windows
  appear under '[other window · <pkg>]' (status bar, nav bar). A soft keyboard is
  collapsed to '[keyboard open · <pkg> (~N keys) …]' — enter text with 'type',
  do not tap individual keys; pass --all to expand them.

OFF-SCREEN
  A '[N more below — scroll: …]' line means there is more content below the fold.
  scroll down, then re-snap; do not assume unseen items exist.

VERIFY
  Re-snap (or use 'is'/'get'/'wait' where available) after each action. Never act
  on a ref from a stale snapshot — re-snap or switch to an id=/label= selector.

If snapshots fail or refs won't resolve, read 'handheld guide troubleshooting'.
`;

const FORMAT = `
Snapshot output format

'snap' prints a compact, agent-facing tree: structural containers collapsed,
off-screen nodes dropped (with a scroll hint), only the foreground window inline.

  Snapshot com.android.settings [..SettingsHomepageActivity] (18/116 nodes, backend=tiny)
  - @e18 Button "Search Settings" [id=search_action_bar actions=[press]]
  - @e21 ScrollView [id=main_content_scrollable_container actions=[scroll]]
    - @e33 Button "Network & internet" subtitle="Mobile, Wi-Fi, hotspot" [actions=[press]]
    [22 more below — scroll: "Battery", "System", …]
  ▶ @e149 TextField "wifi" [id=open_search_view_edit_text focused actions=[press,set_value]]
  - Text "No results for wifi"
  [keyboard open · com.google.android.inputmethod.latin (~40 keys) — use type; --all to show keys]

Line grammar:
  {indent}{bullet} @eN Role "title" subtitle="…" = "value" [id=… focused disabled checked actions=[…]]

  bullet      '-', or '▶' when the node is focused (also flagged 'focused').
  @eN         actionable ref (cached to disk; pass to tap/type/…). Read-only text
              has NO ref ('- Text "…"'): visible to read, not a target.
  Role        Button, TextField, Text, ScrollView, List, CheckBox, Switch, Image…
  "title"     the element's name (own contentDescription, else a row's :id/title).
  subtitle=   secondary line (a row's :id/summary child).
  = "value"   the node's current text (e.g. an editable field's contents).
  [ … ]       id= (resource-id, package stripped), state (focused/disabled/
              checked/selected), and actions=[…] = what you can do here:
              press, long_press, set_value, toggle, scroll.
  [other window · pkg]   nodes from a different window than the foreground activity.
  [keyboard open · …]    the IME, collapsed (keys via --all).

--all = full uncollapsed tree, --offscreen = keep below-fold, --raw/--json = the
complete structured node list (every field, never culled).
`;

const SELECTORS = `
Durable selectors (id= / label= / text=)

@eN refs renumber every time the screen changes. A selector is a durable handle
that re-resolves against the last snapshot and survives the tree shuffling, so
it is the right target for scripts and retries.

  handheld tap 'id=search_action_bar'        # resource-id (full or pkg-stripped leaf)
  handheld tap 'label=Network & internet'    # the visible name (case-insensitive)
  handheld tap 'text=Submit'                  # also matches a node's displayed value
  handheld type 'label=Notes' "hello"         # selectors work on type/fill/long_press/…

Matching:
  id=     node's resource-id, full ('com.app:id/x') or leaf ('x'). Exact.
  label=  the resolved title or raw contentDescription. Case-insensitive.
  text=   title/label OR the node's displayed value. Case-insensitive.
  When several nodes match, the actionable one wins — so a row's tappable Button
  is chosen over its (consumed) child text.

The 'id=' and "title" you see on actionable nodes in 'snap' are exactly the
handles you pass here. Quote selectors that contain spaces or shell metacharacters.
`;

const TROUBLESHOOTING = `
Troubleshooting

"No cached snapshot. Run handheld snap first."
  Targets resolve against the last snapshot. Run 'handheld snap' before tap/type.

Target did not resolve / ref not tappable
  Refs renumber on every screen change. Re-'snap', or use a durable id=/label=
  selector (see 'handheld guide selectors').

Snapshot fails, empty, or "Tiny unavailable"
  Re-bootstrap the on-device helper: 'handheld tiny bootstrap' (--force to
  reinstall). Only one UiAutomation can be resident at a time — if another tool
  holds it (e.g. agent-device, a stray instrumentation), stop that first. On
  Android 16 / API 36 the stock 'uiautomator dump' fallback is unavailable, so
  keep Tiny healthy.

Keyboard is in the way / text not entering the field
  Use 'type' (not key taps). If a handwriting/IME overlay owns the field, dismiss
  or switch the IME, then retry. The IME is collapsed in 'snap'; --all expands it.

Action seemed to do nothing
  Re-'snap' and compare. Some controls need a settle; the CLI settles by default
  (--no-settle to skip, --settle <ms> to cap).
`;

const GUIDES: Record<string, string> = {
  workflow: WORKFLOW,
  format: FORMAT,
  selectors: SELECTORS,
  troubleshooting: TROUBLESHOOTING,
};

export const GUIDE_TOPICS = Object.keys(GUIDES);

const TOPIC_SUMMARY: Array<[string, string]> = [
  ["workflow", "the core connect → snap → act → verify loop and command map"],
  ["format", "the 'snap' output line grammar (refs, roles, actions, windows)"],
  ["selectors", "durable id=/label=/text= targets that survive re-renders"],
  ["troubleshooting", "snapshots failing, stale refs, keyboard, Tiny helper"],
];

export function registerGuideCommand(program: Command): void {
  program
    .command("guide [topic]")
    .description("operating guide for agents (topics: workflow, format, selectors, troubleshooting)")
    .action((topic?: string) => {
      if (!topic) {
        console.log("handheld guide — operating manual for agents\n");
        console.log("Topics (run `handheld guide <topic>`):");
        for (const [name, summary] of TOPIC_SUMMARY) {
          console.log(`  ${name.padEnd(16)} ${summary}`);
        }
        console.log("\nStart with: handheld guide workflow");
        return;
      }
      const body = GUIDES[topic.toLowerCase()];
      if (!body) {
        console.error(
          `Unknown guide topic "${topic}". Available: ${Object.keys(GUIDES).join(", ")}`
        );
        process.exit(1);
      }
      console.log(body.trim());
    });
}
