import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type CreateDeviceInput,
  type CreateGatewayProfileInput,
  HandheldApiClient,
  type ProxyConfigInput,
  type ProxyStatus,
} from "../api-client.js";
import { getAuthorizationHeaders } from "../auth.js";
import {
  getActiveConnection,
  getConnection,
  getRelayState,
  removeConnection,
  saveConnection,
  type Connection,
  type TinyState,
} from "../state.js";
import { RelayClient } from "../transport/relay/client.js";
import { routeCommand } from "../transport/router.js";
import { AdbTransport } from "../transport/adb/client.js";
import type {
  CommandResult,
  ScreenshotResult,
  Transport,
  TransportCommand,
} from "../transport/types.js";
import {
  connectDevice as connectCommandDevice,
  connectLocalDevice as connectLocalCommandDevice,
} from "../commands/connect.js";
import {
  domainSkillsDir,
  listDomainSkillFiles,
  projectAgentSpaceDirFromEnv,
  promoteRunDomainSkill,
  readDomainSkill,
  runAgentSpaceDirFromEnv,
  writeRunDomainSkill,
} from "../agent-space.js";
import { startTeachDetached } from "../commands/teach.js";
import {
  beginActionWait,
  finishActionWait,
  parseSettleMs,
  type ActionWaitResult,
  type TinyReader,
} from "../action-wait.js";
import {
  bundledTinyApkPath,
  ensureTinyToken,
  getTinySnapshot,
  getTinySignature,
  getTinyStatus,
  startTinyHelper,
  tinyDeviceInstallCommand,
  tinyDeviceRequestCommand,
  tinyDeviceStartCommand,
  type TinyInputOptions,
  tinyInputBody,
  tinySignaturePath,
  tinySupportsRequiredAgentShape,
  tinySetTextBody,
  tinyWaitForChangePath,
  tinyWaitForStablePath,
  waitTinyStable,
} from "../tiny-helper.js";
import { tryServerSettle, type TinyInputSender } from "../server-settle.js";
import { hasFocusedEditableField, typeViaTinySetText } from "../text-entry.js";
import {
  clearLastSnapshot,
  compareForegroundSignatures,
  foregroundSignatureOf,
  loadLastSnapshot,
  normalizeTinySnapshot,
  saveLastSnapshot,
  snapshotForAgent,
  snapshotNodesForDisplay,
  type SnapshotDocument,
  type SnapshotForegroundSignature,
} from "../snapshot.js";
import {
  amStartError,
  clearFocusedInputCommand,
  currentAppCommand,
  launchTargetCommand,
  launcherActivitiesCommand,
  isSnapshotTarget,
  normalizeKeyInput,
  packageListCommand,
  parseCurrentComponent,
  parseLauncherActivities,
  parsePackageList,
  parseScreenSize,
  pointFromSnapshotTarget,
  resolveAppPackage,
  screenSizeCommand,
  scrollSwipe,
  startAppCommand,
  stopAppCommand,
} from "../device-actions.js";

type McpTransportResult =
  | CommandResult
  | (ScreenshotResult & { error?: string });

type McpToolCategory = "core" | "operator" | "compatibility";
type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

const MCP_EVIDENCE_DIR_MODE = 0o700;
const MCP_EVIDENCE_FILE_MODE = 0o600;

const TOOLS = [
  {
    name: "devices",
    description: "List available cloud phone devices",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "create_device",
    description: "Create a cloud Android device with sensible defaults",
    inputSchema: {
      type: "object" as const,
      properties: {
        androidVersion: { type: "string" },
        countryCode: { type: "string" },
        displayName: { type: "string" },
        idempotencyKey: { type: "string" },
        profileId: { type: "string" },
      },
    },
  },
  {
    name: "proxies",
    description: "List org proxies, optionally filtered by status or group",
    inputSchema: {
      type: "object" as const,
      properties: {
        cursor: { type: "string" },
        groupId: { type: "string" },
        limit: { type: "number" },
        status: { type: "string", enum: ["unknown", "healthy", "failing"] },
      },
    },
  },
  {
    name: "proxy_get",
    description: "Get a proxy by proxyId",
    inputSchema: {
      type: "object" as const,
      properties: { proxyId: { type: "string" } },
      required: ["proxyId"],
    },
  },
  {
    name: "proxy_create",
    description: "Create a proxy or Smart IP proxy record",
    inputSchema: {
      type: "object" as const,
      properties: {
        bypassDomainList: { type: "array", items: { type: "string" } },
        bypassIpList: { type: "array", items: { type: "string" } },
        bypassPackageList: { type: "array", items: { type: "string" } },
        groupId: { type: "string" },
        mode: { type: "string", enum: ["standard", "smart_ip"] },
        proxy: { type: "string" },
        remarks: { type: "string" },
        smartIpMode: { type: "string", enum: ["proxy", "vpn"] },
      },
      required: ["proxy"],
    },
  },
  {
    name: "proxy_update",
    description: "Update proxy metadata, bypass lists, mode, or group assignment",
    inputSchema: {
      type: "object" as const,
      properties: {
        bypassDomainList: { type: "array", items: { type: "string" } },
        bypassIpList: { type: "array", items: { type: "string" } },
        bypassPackageList: { type: "array", items: { type: "string" } },
        groupId: { type: ["string", "null"] },
        mode: { type: "string", enum: ["standard", "smart_ip"] },
        proxyId: { type: "string" },
        remarks: { type: "string" },
        smartIpMode: { type: "string", enum: ["proxy", "vpn"] },
      },
      required: ["proxyId"],
    },
  },
  {
    name: "proxy_check",
    description: "Record or refresh proxy health check metadata",
    inputSchema: {
      type: "object" as const,
      properties: {
        detection: { type: "object" },
        proxyId: { type: "string" },
        proxyWorking: { type: "boolean" },
        publicIp: { type: "string" },
      },
      required: ["proxyId"],
    },
  },
  {
    name: "proxy_delete",
    description: "Delete a proxy and clear links from devices/profiles",
    inputSchema: {
      type: "object" as const,
      properties: { proxyId: { type: "string" } },
      required: ["proxyId"],
    },
  },
  {
    name: "proxy_links",
    description: "List devices and profiles linked to a proxy",
    inputSchema: {
      type: "object" as const,
      properties: { proxyId: { type: "string" } },
      required: ["proxyId"],
    },
  },
  {
    name: "proxy_groups",
    description: "List proxy groups",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "proxy_group_create",
    description: "Create a proxy group",
    inputSchema: {
      type: "object" as const,
      properties: {
        color: { type: "string" },
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "proxy_group_update",
    description: "Update a proxy group name or color",
    inputSchema: {
      type: "object" as const,
      properties: {
        color: { type: "string" },
        groupId: { type: "string" },
        name: { type: "string" },
      },
      required: ["groupId"],
    },
  },
  {
    name: "proxy_group_delete",
    description: "Delete a proxy group",
    inputSchema: {
      type: "object" as const,
      properties: { groupId: { type: "string" } },
      required: ["groupId"],
    },
  },
  {
    name: "profiles",
    description: "List gateway-v3 profiles available to the current org",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "profile_get",
    description: "Get a gateway-v3 profile by id",
    inputSchema: {
      type: "object" as const,
      properties: { profileId: { type: "string" } },
      required: ["profileId"],
    },
  },
  {
    name: "profile_create",
    description: "Create a gateway-v3 profile with provisioning options",
    inputSchema: {
      type: "object" as const,
      properties: {
        androidVersion: { type: "string" },
        body: { type: "object" },
        idempotencyKey: { type: "string" },
        proxy: { type: "object" },
        region: { type: "string" },
        templateSlug: { type: "string" },
        type: { type: "string", enum: ["ephemeral", "dedicated"] },
      },
      required: ["androidVersion"],
    },
  },
  {
    name: "profile_delete",
    description: "Delete a gateway-v3 profile",
    inputSchema: {
      type: "object" as const,
      properties: { profileId: { type: "string" } },
      required: ["profileId"],
    },
  },
  {
    name: "profile_snapshots",
    description: "List saved-state snapshots for a gateway-v3 profile",
    inputSchema: {
      type: "object" as const,
      properties: { profileId: { type: "string" } },
      required: ["profileId"],
    },
  },
  {
    name: "profile_capture",
    description: "Capture the current saved-state head for a gateway-v3 profile",
    inputSchema: {
      type: "object" as const,
      properties: {
        idempotencyKey: { type: "string" },
        profileId: { type: "string" },
      },
      required: ["profileId"],
    },
  },
  {
    name: "profile_restore",
    description: "Restore the latest saved-state head for a gateway-v3 profile",
    inputSchema: {
      type: "object" as const,
      properties: {
        equipmentId: { type: "string" },
        idempotencyKey: { type: "string" },
        profileId: { type: "string" },
      },
      required: ["profileId"],
    },
  },
  {
    name: "profile_job",
    description: "Get a profile saved-state capture or restore job",
    inputSchema: {
      type: "object" as const,
      properties: {
        jobId: { type: "string" },
        profileId: { type: "string" },
      },
      required: ["profileId", "jobId"],
    },
  },
  {
    name: "profile_reboot",
    description: "Enqueue a hardware reboot job for a Gateway profile/device",
    inputSchema: {
      type: "object" as const,
      properties: {
        idempotencyKey: { type: "string" },
        profileId: { type: "string" },
      },
      required: ["profileId"],
    },
  },
  {
    name: "billing_balance",
    description: "Read the current org wallet balance",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "billing_usage_state",
    description: "Read wallet balance, free-tier minutes, and current billing cycle state",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "billing_transactions",
    description: "List recent org wallet transactions",
    inputSchema: {
      type: "object" as const,
      properties: { limit: { type: "number" } },
    },
  },
  {
    name: "billing_spend_summary",
    description: "Read org spend summary for an optional millisecond window",
    inputSchema: {
      type: "object" as const,
      properties: {
        windowEndMs: { type: "number" },
        windowStartMs: { type: "number" },
      },
    },
  },
  {
    name: "connect",
    description:
      "Connect to a cloud phone, or pass local:true to attach to a local adb device/emulator with no Gateway/API key",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: {
          type: "string",
          description:
            "Cloud device ID to connect to, or (with local:true) the adb serial; omit local serial to auto-pick the sole ready device",
        },
        local: {
          type: "boolean",
          description: "Attach to a local adb device/emulator directly (no Gateway, no API key)",
        },
      },
    },
  },
  {
    name: "disconnect",
    description: "Disconnect from a cloud phone",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Device ID to disconnect" },
      },
    },
  },
  {
    name: "teach_request",
    description:
      "Ask a human to DEMONSTRATE a device task you cannot do autonomously. Opens the live viewer in the human's browser to take over and record; returns immediately with an envelope path to POLL. Use only when genuinely stuck (see the teach-from-human skill's four gates). Non-blocking: poll the envelope until status is 'ready', then run the teach-from-human skill on the captured trajectory.",
    inputSchema: {
      type: "object" as const,
      properties: {
        objective: {
          type: "string",
          description: "One-line description of the task the human will demonstrate",
        },
        package: {
          type: "string",
          description: "Android package the workflow is keyed to (optional hint)",
        },
        deviceId: { type: "string", description: "Target cloud device (optional; defaults to the active connection)" },
      },
      required: ["objective"],
    },
  },
  {
    name: "snap",
    description:
      "Read the actionable UI snapshot for the connected device. Returns the compact, " +
      "on-screen tree (structural containers collapsed) plus a totalNodeCount. " +
      "Re-snap after every action: cached refs/selectors are checked against Tiny's live foreground/digest and stale targets refuse before input. " +
      "Line grammar: `{indent}{bullet} @eN Role \"title\" subtitle=\"…\" = \"value\" [id=… focused disabled checked actions=[…]]`. " +
      "bullet `-`, or `▶` when focused. @eN = actionable ref (pass to tap/type/…); read-only Text has NO ref (visible to read, not a target). " +
      "Role is TitleCase (Button, TextField, Text, ScrollView, List, CheckBox, Switch, Image…). " +
      "\"title\" = the element's name; subtitle= = its secondary line; = \"value\" = its current text (e.g. an editable field's contents). " +
      "[ … ] holds id= (resource-id, package stripped), state (focused/disabled/checked/selected), and actions=[press,long_press,set_value,toggle,scroll]. " +
      "`[other window · pkg]` = nodes from a different window than the foreground activity (status bar, nav bar). " +
      "`[keyboard open · …]` = the IME, collapsed — use `type` to enter text, do not tap keys. " +
      "The id= and \"title\" on actionable nodes double as durable selectors (id=…/label=…) you can pass to action tools instead of the volatile @eN ref.",
    inputSchema: {
      type: "object" as const,
      properties: {
        interactive: {
          type: "boolean",
          description:
            "Default false: return actionable nodes PLUS read-only text (headings, results, errors). " +
            "Set true to return only actionable nodes (drops read-only text). " +
            "Structural containers are always collapsed and are not exposed by this flag.",
        },
        raw: {
          type: "boolean",
          description:
            "Include the complete unprocessed Tiny snapshot under `raw` (every field, never culled) alongside the normalized nodes.",
        },
        agent: {
          type: "boolean",
          description:
            "Return a compact agent-loop projection with refs, labels, ids, actions, and minimal state instead of the default snapshot shape.",
        },
        screenshot: {
          type: "boolean",
          description: "Also capture and include a base64 PNG screenshot of the current screen.",
        },
      },
    },
  },
  {
    name: "click",
    description: "Click a snapshot ref, durable id=/label= selector, or screen coordinate pair",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "What to click: a @eN ref from the last snap (e.g. 7 or @e7; renumbers on every screen change), a durable id=/label=/text= selector (survives re-renders — prefer for retries), or omit and pass x/y for raw coordinates.",
        },
        x: { type: "number", description: "X coordinate (use with y when no target ref is given)" },
        y: { type: "number", description: "Y coordinate (use with x when no target ref is given)" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
    },
  },
  {
    name: "click_at",
    description: "Click at screen coordinates",
    inputSchema: {
      type: "object" as const,
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "click_area",
    description: "Click the center of a screen area",
    inputSchema: {
      type: "object" as const,
      properties: {
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["x1", "y1", "x2", "y2"],
    },
  },
  {
    name: "long_press",
    description: "Long press a snapshot ref, durable id=/label= selector, or coordinates",
    inputSchema: {
      type: "object" as const,
      properties: {
        duration: { type: "number", description: "Duration in ms" },
        target: {
          type: "string",
          description:
            "What to long-press: a @eN ref from the last snap (e.g. 7 or @e7; renumbers on every screen change), a durable id=/label=/text= selector (survives re-renders), or omit and pass x/y for raw coordinates.",
        },
        x: { type: "number", description: "X coordinate (use with y when no target ref is given)" },
        y: { type: "number", description: "Y coordinate (use with x when no target ref is given)" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
    },
  },
  {
    name: "double_tap",
    description: "Double tap a snapshot ref, durable id=/label= selector, or coordinates",
    inputSchema: {
      type: "object" as const,
      properties: {
        intervalMs: { type: "number", description: "Delay between taps in ms" },
        target: {
          type: "string",
          description:
            "What to double-tap: a @eN ref from the last snap (e.g. 7 or @e7; renumbers on every screen change), a durable id=/label=/text= selector (survives re-renders), or omit and pass x/y for raw coordinates.",
        },
        x: { type: "number", description: "X coordinate (use with y when no target ref is given)" },
        y: { type: "number", description: "Y coordinate (use with x when no target ref is given)" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
    },
  },
  {
    name: "fill",
    description: "Focus an input target, clear it by default, and type text",
    inputSchema: {
      type: "object" as const,
      properties: {
        append: { type: "boolean", description: "Append instead of clearing first" },
        submit: { type: "boolean", description: "Press enter after typing" },
        target: {
          type: "string",
          description:
            "Field to fill: a @eN ref from the last snap (renumbers on every screen change), a durable id=/label=/text= selector (survives re-renders), or omit/\"focused\" to use the currently focused field.",
        },
        text: { type: "string" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["text"],
    },
  },
  {
    name: "clear",
    description: "Clear the focused field or an input target",
    inputSchema: {
      type: "object" as const,
      properties: {
        repeat: { type: "number", description: "Delete key repeat count" },
        target: {
          type: "string",
          description:
            "Field to clear: a @eN ref from the last snap (renumbers on every screen change), a durable id=/label=/text= selector (survives re-renders), or omit/\"focused\" to use the currently focused field.",
        },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
    },
  },
  {
    name: "tap",
    description: "Tap a snapshot ref, durable id=/label= selector, or screen coordinate pair",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "What to tap: a @eN ref from the last snap (e.g. 7 or @e7; renumbers on every screen change), a durable id=/label=/text= selector (survives re-renders — prefer for retries), or omit and pass x/y for raw coordinates.",
        },
        x: { type: "number", description: "X coordinate (use with y when no target ref is given)" },
        y: { type: "number", description: "Y coordinate (use with x when no target ref is given)" },
        longPress: { type: "boolean", description: "Long press (optional)" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
    },
  },
  {
    name: "swipe",
    description: "Swipe gesture between two points",
    inputSchema: {
      type: "object" as const,
      properties: {
        startX: { type: "number" },
        startY: { type: "number" },
        endX: { type: "number" },
        endY: { type: "number" },
        duration: { type: "number", description: "Duration in ms (optional)" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["startX", "startY", "endX", "endY"],
    },
  },
  {
    name: "type",
    description: "Type text, optionally focusing and clearing a target first",
    inputSchema: {
      type: "object" as const,
      properties: {
        append: { type: "boolean", description: "Append instead of clearing when target is provided" },
        clear: { type: "boolean", description: "Clear before typing" },
        submit: { type: "boolean", description: "Press enter after typing" },
        target: {
          type: "string",
          description:
            "Field to type into: a @eN ref from the last snap (renumbers on every screen change), a durable id=/label=/text= selector (survives re-renders), or omit/\"focused\" to type into the currently focused field.",
        },
        text: { type: "string", description: "Text to type" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["text"],
    },
  },
  {
    name: "key",
    description: "Press a key name or Android keycode",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: ["string", "number"] },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["key"],
    },
  },
  {
    name: "press_key",
    description: "Press a key name or Android keycode",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: ["string", "number"] },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["key"],
    },
  },
  {
    name: "back",
    description: "Press Android back",
    inputSchema: {
      type: "object" as const,
      properties: {
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
    },
  },
  {
    name: "home",
    description: "Press Android home",
    inputSchema: {
      type: "object" as const,
      properties: {
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
    },
  },
  {
    name: "recent",
    description: "Open Android recent apps",
    inputSchema: {
      type: "object" as const,
      properties: {
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
    },
  },
  {
    name: "system_button",
    description: "Press a system button such as back, home, recent, or enter",
    inputSchema: {
      type: "object" as const,
      properties: {
        button: { type: "string" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["button"],
    },
  },
  {
    name: "keycode",
    description: "Press a raw Android keycode",
    inputSchema: {
      type: "object" as const,
      properties: {
        keycode: { type: "number" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["keycode"],
    },
  },
  {
    name: "scroll",
    description: "Scroll up, down, left, or right",
    inputSchema: {
      type: "object" as const,
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        duration: { type: "number", description: "Duration in ms" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["direction"],
    },
  },
  {
    name: "wait",
    description: "Wait for a duration in seconds",
    inputSchema: {
      type: "object" as const,
      properties: { seconds: { type: "number" } },
    },
  },
  {
    name: "wait_for",
    description: "Wait for stable UI, text, ref, or snapshot change",
    inputSchema: {
      type: "object" as const,
      properties: {
        condition: {
          type: "string",
          enum: ["stable", "text", "ref", "change"],
          description:
            "What to wait for: `stable` = the UI stops changing; `text` = value appears in any node's text/label/id; `ref` = value resolves to a tappable node; `change` = the screen differs from the last snapshot. `text` and `ref` require `value`.",
        },
        timeoutMs: { type: "number", description: "Max time to wait in ms before giving up (default 5000)." },
        value: {
          type: "string",
          description:
            "For condition=text: substring to match in any node's text/label/id (case-insensitive). For condition=ref: a @eN ref or id=/label= selector to wait for. Ignored for stable/change.",
        },
      },
      required: ["condition"],
    },
  },
  {
    name: "open_app",
    description: "Open an app by package, alias, or package-like name",
    inputSchema: {
      type: "object" as const,
      properties: {
        nameOrPackage: { type: "string" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["nameOrPackage"],
    },
  },
  {
    name: "launch",
    description: "Launch an Android intent, deep link, component, or raw am command",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string" },
        component: { type: "string" },
        data: { type: "string" },
        packageName: { type: "string" },
        target: { type: "string", description: "Deep link URI, component, or raw am command" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
    },
  },
  {
    name: "list_apps",
    description: "List launchable app packages",
    inputSchema: {
      type: "object" as const,
      properties: {
        system: {
          type: "boolean",
          description: "Include system/pre-installed packages too (default false: only user-installed, launchable apps).",
        },
      },
    },
  },
  {
    name: "current_app",
    description: "Read the current foreground package",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "stop_app",
    description: "Force-stop an app by package, alias, or package-like name",
    inputSchema: {
      type: "object" as const,
      properties: {
        nameOrPackage: { type: "string" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["nameOrPackage"],
    },
  },
  {
    name: "screenshot",
    description: "Capture a screenshot of the device screen. Returns base64 PNG.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "capture_evidence",
    description:
      "Capture durable evidence for this run: snapshot/status JSON plus an optional screenshot file in HANDHELD_EVIDENCE_DIR.",
    inputSchema: {
      type: "object" as const,
      properties: {
        label: { type: "string", description: "Short label for the evidence files, e.g. initial, login-form, final" },
        screenshot: { type: "boolean", description: "Write a screenshot image too (default true)" },
      },
    },
  },
  {
    name: "list_domain_skills",
    description: "List run-local and project domain-skill files in the agent-space.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "read_domain_skill",
    description: "Read a domain-skill file from the run or project agent-space.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative skill path, e.g. com.android.settings.md" },
        scope: { type: "string", enum: ["run", "project"], description: "Defaults to run." },
      },
      required: ["path"],
    },
  },
  {
    name: "save_domain_skill_candidate",
    description: "Write a run-local domain-skill candidate for a reusable app workflow or selector map.",
    inputSchema: {
      type: "object" as const,
      properties: {
        body: { type: "string" },
        packageName: { type: "string", description: "Used as filename when path is omitted." },
        path: { type: "string", description: "Run-local relative path under skills/domain." },
        title: { type: "string", description: "Fallback filename source when packageName/path are omitted." },
      },
      required: ["body"],
    },
  },
  {
    name: "promote_domain_skill",
    description: "Promote a run-local domain-skill file back into the project agent-space.",
    inputSchema: {
      type: "object" as const,
      properties: {
        overwrite: { type: "boolean", description: "Replace an existing project skill with the same path." },
        path: { type: "string", description: "Run-local relative skill path under skills/domain." },
      },
      required: ["path"],
    },
  },
  {
    name: "shell",
    description: "Execute a shell command on the device",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
      required: ["command"],
    },
  },
  {
    name: "gps",
    description: "Set GPS coordinates on the device",
    inputSchema: {
      type: "object" as const,
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "clipboard",
    description: "Get or set device clipboard",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["get", "set"] },
        text: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "copy",
    description: "Copy text to the device clipboard",
    inputSchema: {
      type: "object" as const,
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "paste",
    description: "Paste clipboard text into the focused field or a target",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description:
            "Field to paste into: a @eN ref from the last snap (renumbers on every screen change), a durable id=/label=/text= selector (survives re-renders), or omit/\"focused\" to use the currently focused field.",
        },
        settleMs: { type: "number", description: "Post-action settle wait in ms" },
      },
    },
  },
] satisfies McpTool[];

export const CORE_MCP_TOOL_NAMES = new Set([
  "devices",
  "create_device",
  "connect",
  "disconnect",
  "snap",
  "capture_evidence",
  "list_domain_skills",
  "read_domain_skill",
  "save_domain_skill_candidate",
  "promote_domain_skill",
  "tap",
  "long_press",
  "double_tap",
  "swipe",
  "type",
  "list_apps",
  "open_app",
  "launch",
  "copy",
  "paste",
  "press_key",
  "back",
  "home",
  "recent",
  "shell",
  "teach_request",
]);

const READ_ONLY_MCP_TOOL_NAMES = new Set([
  "devices",
  "proxies",
  "proxy_get",
  "proxy_links",
  "proxy_groups",
  "profiles",
  "profile_get",
  "profile_snapshots",
  "profile_job",
  "billing_balance",
  "billing_usage_state",
  "billing_transactions",
  "billing_spend_summary",
  "snap",
  "wait",
  "wait_for",
  "list_apps",
  "current_app",
  "screenshot",
  "list_domain_skills",
  "read_domain_skill",
]);

const DESTRUCTIVE_MCP_TOOL_NAMES = new Set([
  "proxy_delete",
  "proxy_group_delete",
  "profile_delete",
  "profile_restore",
  "profile_reboot",
  "disconnect",
  "stop_app",
  "shell",
]);

const IDEMPOTENT_MUTATION_MCP_TOOL_NAMES = new Set([
  "connect",
  "copy",
  "home",
  "wait",
  "wait_for",
  "stop_app",
]);

const COMPATIBILITY_MCP_TOOL_NAMES = new Set([
  "click",
  "click_at",
  "click_area",
  "fill",
  "key",
  "keycode",
  "system_button",
  "clipboard",
  "wait",
  "wait_for",
  "current_app",
  "stop_app",
]);

function toolCategory(name: string): McpToolCategory {
  if (CORE_MCP_TOOL_NAMES.has(name)) return "core";
  if (COMPATIBILITY_MCP_TOOL_NAMES.has(name)) return "compatibility";
  return "operator";
}

function toolAnnotations(name: string): ToolAnnotations {
  const readOnly = READ_ONLY_MCP_TOOL_NAMES.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : DESTRUCTIVE_MCP_TOOL_NAMES.has(name),
    idempotentHint: readOnly || IDEMPOTENT_MUTATION_MCP_TOOL_NAMES.has(name),
    openWorldHint: true,
  };
}

function decorateTool(tool: McpTool): McpTool {
  const category = toolCategory(tool.name);
  return {
    ...tool,
    annotations: {
      ...toolAnnotations(tool.name),
      ...tool.annotations,
    },
    _meta: {
      ...tool._meta,
      "handheld/category": category,
      "handheld/default": CORE_MCP_TOOL_NAMES.has(tool.name),
    },
  };
}

export function listVisibleTools(): McpTool[] {
  const allTools = TOOLS as readonly McpTool[];
  const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
  const tools = process.env.HANDHELD_MCP_FULL === "1"
    ? allTools
    : [...CORE_MCP_TOOL_NAMES]
        .map((name) => toolsByName.get(name))
        .filter((tool): tool is McpTool => tool !== undefined);
  return tools.map(decorateTool);
}

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function requiredString(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(args: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = args?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(
  args: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const value = args?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function proxyConfigFromArgs(args: Record<string, unknown> | undefined): ProxyConfigInput {
  const bypassDomainList = optionalStringArray(args, "bypassDomainList");
  const bypassIpList = optionalStringArray(args, "bypassIpList");
  const bypassPackageList = optionalStringArray(args, "bypassPackageList");
  const groupId = optionalString(args, "groupId");
  const proxy = optionalString(args, "proxy");
  const remarks = optionalString(args, "remarks");

  return {
    ...(bypassDomainList ? { bypassDomainList } : {}),
    ...(bypassIpList ? { bypassIpList } : {}),
    ...(bypassPackageList ? { bypassPackageList } : {}),
    ...(args?.groupId === null ? { groupId: null } : groupId ? { groupId } : {}),
    ...(args?.mode === "standard" || args?.mode === "smart_ip" ? { mode: args.mode } : {}),
    ...(proxy ? { proxy } : {}),
    ...(remarks ? { remarks } : {}),
    ...(args?.smartIpMode === "proxy" || args?.smartIpMode === "vpn"
      ? { smartIpMode: args.smartIpMode }
      : {}),
  };
}

function resolveConnection(deviceId?: string) {
  return deviceId ? getConnection(deviceId) : getActiveConnection();
}

function getTransport(deviceId?: string): {
  conn: Connection | null;
  relay: RelayClient | null;
  adb: AdbTransport | null;
} {
  const conn = resolveConnection(deviceId);
  if (!conn) return { adb: null, conn: null, relay: null };

  const relayState = getRelayState(conn);
  const relay =
    relayState.connected && relayState.relayUrl
      ? new RelayClient(relayState.relayUrl, getAuthorizationHeaders())
      : null;
  const adbSerial = conn.adb?.serial;
  const adb = adbSerial ? new AdbTransport(adbSerial) : null;

  // Stash the live transports so the settle helpers can build a device-shell
  // TinyReader/sender for the relay path without threading relay/adb through
  // every tool handler. MCP processes tool calls serially over stdio.
  currentMcpTransports = { adb, relay };
  return { adb, conn, relay };
}

let currentMcpTransports: { adb: AdbTransport | null; relay: RelayClient | null } | null = null;

// Device-shell input-with-settle sender (relay/adb) — POSTs /v2/input?settle
// over the on-device curl channel, mirroring the CLI's deviceInputSender.
function mcpDeviceInputSender(relay: RelayClient | null, adb: AdbTransport | null): TinyInputSender {
  const token = ensureTinyToken().token;
  return async (full) =>
    await readMcpTinyJsonFromDevice({
      adb,
      body: tinyInputBody(full),
      maxTimeSec: Math.ceil(((full.settleTimeoutMs ?? 1500) + (full.durationMs ?? 0)) / 1000) + 6,
      method: "POST",
      path: "/input?chunked=1&maxChars=32768",
      relay,
      token,
    });
}

// Device-shell TinyReader (relay/adb) for the settle path — /status, /snapshot,
// /waitForStable over the on-device curl channel, mirroring the CLI reader.
function mcpDeviceShellTinyReader(relay: RelayClient | null, adb: AdbTransport | null): TinyReader {
  const token = ensureTinyToken().token;
  const withChunk = (p: string) => p + (p.includes("?") ? "&" : "?") + "chunked=1&maxChars=32768";
  const get = (path: string, maxTimeSec?: number) =>
    readMcpTinyJsonFromDevice({ adb, maxTimeSec, path, relay, token });
  return {
    eventCounterCheap: false,
    status: () => get("/status"),
    snapshot: () => get(withChunk("/snapshot?compact=1&interactiveOnly=1&maxNodes=300"), 12),
    waitChange: (opts) => get(withChunk(tinyWaitForChangePath(opts))),
    waitStable: (opts) =>
      get(withChunk(tinyWaitForStablePath(opts)), Math.ceil((opts.timeoutMs ?? 1500) / 1000) + 6),
  };
}

// The device-shell reader/sender when there's no direct Tiny endpoint (relay).
function mcpRelayReader(conn: Connection | null): TinyReader | undefined {
  const tx = currentMcpTransports;
  return conn && !conn.tiny && tx && (tx.relay || tx.adb)
    ? mcpDeviceShellTinyReader(tx.relay, tx.adb)
    : undefined;
}

function pick(
  command: TransportCommand,
  relay: RelayClient | null,
  adb: AdbTransport | null
): Transport | null {
  const route = routeCommand(command, !!relay);
  if (route === "relay" && relay) return relay;
  if (adb) return adb;
  return relay;
}

async function connectDevice(
  deviceId: string,
  opts?: { local?: boolean }
): Promise<{ deviceId: string; sessionId: string }> {
  if (opts?.local) {
    const result = await connectLocalCommandDevice({
      json: true,
      serial: deviceId || undefined,
      startTiny: true,
    });
    return { deviceId: result.deviceId, sessionId: "local" };
  }
  const result = await connectCommandDevice({
    deviceId,
    json: true,
    startTiny: true,
    withAdb: true,
  });
  return { deviceId: result.deviceId, sessionId: result.sessionId };
}

async function runWithAdbFallback<T extends McpTransportResult>(
  command: TransportCommand,
  relay: RelayClient | null,
  adb: AdbTransport | null,
  execute: (transport: Transport) => Promise<T>
): Promise<T> {
  const primary = pick(command, relay, adb);
  if (!primary) {
    return {
      ok: false,
      error: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device).",
    } as T;
  }
  const result = await executeSafely(primary, execute);
  if (
    result.ok ||
    !adb ||
    primary === adb ||
    !["tap", "swipe", "type", "key", "screenshot", "shell"].includes(command)
  ) {
    return result;
  }
  return await executeSafely(adb, execute);
}

async function executeSafely<T extends McpTransportResult>(
  transport: Transport,
  execute: (transport: Transport) => Promise<T>
): Promise<T> {
  try {
    return await execute(transport);
  } catch (err) {
    return { ok: false, error: (err as Error).message } as T;
  }
}

async function settleMcpResult<T extends McpTransportResult>(
  beforeAction: Awaited<ReturnType<typeof beginActionWait>>,
  result: T
): Promise<T & { snapshot?: unknown; wait?: Omit<ActionWaitResult, "snapshot"> }> {
  if (!result.ok) return result;
  const wait = await finishActionWait(beforeAction);
  if (!wait) return result;
  // Lift the post-action snapshot to the top level so agents see it alongside
  // ok/data rather than nested in the settle metadata.
  const { snapshot, ...waitMeta } = wait;
  return snapshot !== undefined
    ? { ...result, snapshot, wait: waitMeta }
    : { ...result, wait: waitMeta };
}

// A gesture for the MCP surface: try Tiny server-side input-with-settle first
// (inject + settle on the filter-independent layoutDigest in one round-trip),
// falling back to the client dispatch (`run`) + client-side settle. MCP always
// returns the settled post-action snapshot. Mirrors settleCommandResult on the
// CLI so both surfaces share one settle path (server-settle.ts).
async function settleMcpGesture<T extends McpTransportResult>(
  conn: Connection | null,
  args: Record<string, unknown> | undefined,
  gesture: TinyInputOptions,
  run: () => Promise<T>
): Promise<(T | McpTransportResult) & { snapshot?: unknown; wait?: Omit<ActionWaitResult, "snapshot"> }> {
  if (conn) {
    // Server-side input-with-settle: direct when connection.tiny exists, else
    // over the relay/adb device-shell channel (same as the CLI).
    const tx = currentMcpTransports;
    const send =
      !conn.tiny && tx && (tx.relay || tx.adb)
        ? mcpDeviceInputSender(tx.relay, tx.adb)
        : undefined;
    if (conn.tiny || send) {
      const served = await tryServerSettle(conn, gesture, {
        enabled: true,
        postState: true,
        timeoutMs: parseSettleMs(args?.settleMs),
      }, send);
      if (served) {
        const { snapshot, wait, ...rest } = served;
        return {
          ...rest,
          ...(snapshot !== undefined ? { snapshot } : {}),
          ...(wait ? { wait } : {}),
        };
      }
    }
  }
  const beforeAction = await beginMcpActionWait(conn, args);
  const result = await run();
  return await settleMcpResult(beforeAction, result);
}

async function beginMcpActionWait(
  conn: Connection | null,
  args: Record<string, unknown> | undefined
) {
  return await beginActionWait(conn, {
    // MCP actions always return the settled post-action snapshot — agents
    // otherwise need a separate snap round-trip after every action.
    postState: true,
    timeoutMs: parseSettleMs(args?.settleMs),
  }, mcpRelayReader(conn));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTinySnapshot(conn: Connection) {
  const tiny = await ensureTinyState(conn);
  const raw = await getTinySnapshot(tiny);
  const snapshot = normalizeTinySnapshot({ deviceId: conn.deviceId, raw });
  saveLastSnapshot(snapshot);
  return snapshot;
}

function snapshotTextMatches(
  snapshot: Awaited<ReturnType<typeof readTinySnapshot>>,
  text: string
): boolean {
  const needle = text.toLowerCase();
  return snapshot.nodes.some((node) =>
    [node.label, node.value, node.identifier]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  );
}

async function waitForMcpSnapshotCondition(input: {
  condition: string;
  conn: Connection;
  timeoutMs: number;
  value?: string;
}) {
  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  const baseline = input.condition === "change"
    ? loadLastSnapshot(input.conn.deviceId) ?? await readTinySnapshot(input.conn)
    : null;

  while (Date.now() <= deadline) {
    const snapshot = await readTinySnapshot(input.conn);
    const matched =
      input.condition === "text"
        ? snapshotTextMatches(snapshot, input.value ?? "")
        : input.condition === "ref"
          ? Boolean(input.value && pointFromSnapshotTarget(snapshot, input.value))
          : input.condition === "change"
            // Filter-independent layout digest first (baseline + poll may use
            // different filters; only layoutDigest is comparable across them, #1).
            ? (baseline?.layoutDigest && snapshot.layoutDigest
                ? baseline.layoutDigest !== snapshot.layoutDigest
                : baseline?.treeDigest && snapshot.treeDigest
                  ? baseline.treeDigest !== snapshot.treeDigest
                  : JSON.stringify(baseline?.nodes) !== JSON.stringify(snapshot.nodes))
            : false;
    if (matched) {
      return { ok: true, snapshot, waitedMs: Date.now() - startedAt };
    }
    await sleep(200);
  }
  return {
    error: `Timed out waiting for ${input.condition}${input.value ? ` ${input.value}` : ""}`,
    ok: false,
    waitedMs: Date.now() - startedAt,
  };
}

async function ensureTinyState(connection: Connection): Promise<TinyState> {
  if (connection.tiny) {
    try {
      if (tinySupportsRequiredAgentShape(await getTinyStatus(connection.tiny))) {
        return connection.tiny;
      }
    } catch {
      // Fall through to bootstrap/reinstall when local ADB is available.
    }
  }
  const serial = connection.adb?.serial;
  if (!serial) {
    throw new Error("Snapshot requires a current Tiny helper or ADB. Reconnect with ADB enabled.");
  }
  const tiny = await startTinyHelper({ serial });
  saveConnection({ ...connection, tiny });
  return tiny;
}

function mcpFieldString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mcpFieldNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mcpSignatureFromRaw(raw: Record<string, unknown>): SnapshotForegroundSignature {
  return {
    activity: mcpFieldString(raw.activity),
    bundleId: mcpFieldString(raw.bundleId),
    component: mcpFieldString(raw.component),
    eventSeq: mcpFieldNumber(raw.eventSeq),
    layoutDigest: mcpFieldString(raw.layoutDigest),
  };
}

async function mcpLiveForegroundSignature(input: {
  adb: AdbTransport | null;
  conn: Connection;
  previousEventSeq?: number;
  relay: RelayClient | null;
}): Promise<SnapshotForegroundSignature> {
  let signature: SnapshotForegroundSignature;
  if (input.conn.tiny || input.conn.adb?.serial) {
    try {
      const tiny = await ensureTinyState(input.conn);
      signature = mcpSignatureFromRaw(
        await getTinySignature(tiny, { previousEventSeq: input.previousEventSeq }) as Record<string, unknown>
      );
      return await completeMcpLiveForegroundSignature(signature, input.relay, input.adb);
    } catch (error) {
      if (!input.relay && !input.adb) throw error;
    }
  }

  const tokenState = await ensureMcpDeviceTiny({
    adb: input.adb,
    api: () => new HandheldApiClient(),
    conn: input.conn,
    relay: input.relay,
  });
  signature = mcpSignatureFromRaw(
    await readMcpTinyJsonFromDevice({
      adb: input.adb,
      path: tinySignaturePath({ previousEventSeq: input.previousEventSeq }),
      relay: input.relay,
      token: tokenState.token,
    })
  );
  return await completeMcpLiveForegroundSignature(signature, input.relay, input.adb);
}

async function completeMcpLiveForegroundSignature(
  signature: SnapshotForegroundSignature,
  relay: RelayClient | null,
  adb: AdbTransport | null
): Promise<SnapshotForegroundSignature> {
  if (signature.component) return signature;
  try {
    const focus = await runMcpShell(relay, adb, currentAppCommand());
    if (!focus.ok || typeof focus.data !== "string") return signature;
    const current = parseCurrentComponent(focus.data);
    return {
      ...signature,
      activity: signature.activity ?? current.activity ?? undefined,
      component: signature.component ?? current.component ?? undefined,
    };
  } catch {
    return signature;
  }
}

async function assertMcpCachedSnapshotFresh(input: {
  adb: AdbTransport | null;
  conn: Connection;
  relay: RelayClient | null;
  snapshot: SnapshotDocument;
  target: string;
}): Promise<void> {
  const cached = input.snapshot.foregroundSignature ?? foregroundSignatureOf(input.snapshot);
  let live: SnapshotForegroundSignature;
  try {
    live = await mcpLiveForegroundSignature({
      adb: input.adb,
      conn: input.conn,
      previousEventSeq: cached.eventSeq,
      relay: input.relay,
    });
  } catch (error) {
    throw new Error(
      `Cached snapshot target "${input.target}" cannot be verified: ${error instanceof Error ? error.message : String(error)}. Call snap again before using cached refs/selectors.`
    );
  }
  const comparison = compareForegroundSignatures({ cached, live });
  if (!comparison.ok) {
    throw new Error(
      `Cached snapshot target "${input.target}" is stale: ${comparison.reason ?? "screen changed since last snap"}. Call snap again before using cached refs/selectors.`
    );
  }
}

async function mcpPointFromArgs(
  args: Record<string, unknown> | undefined,
  conn: Connection,
  transports: { adb: AdbTransport | null; relay: RelayClient | null }
): Promise<{ x: number; y: number }> {
  if (typeof args?.target === "string" && args.target.trim()) {
    const snapshot = loadLastSnapshot(conn.deviceId);
    if (!snapshot) {
      throw new Error("No cached snapshot — call snap first, then pass a ref or id=/label= selector from it.");
    }
    await assertMcpCachedSnapshotFresh({
      adb: transports.adb,
      conn,
      relay: transports.relay,
      snapshot,
      target: args.target,
    });
    const point = pointFromSnapshotTarget(snapshot, args.target);
    if (!point) {
      throw new Error(
        `Target "${args.target}" did not resolve to a tappable node — refs renumber on every screen change, so re-snap, or use a durable id=/label= selector (or x/y coordinates).`
      );
    }
    return point;
  }
  if (typeof args?.x === "number" && typeof args?.y === "number") {
    return { x: args.x, y: args.y };
  }
  throw new Error("target or x/y is required — pass a @eN ref / id=/label= selector from the last snap, or both x and y coordinates.");
}

async function focusMcpTarget(input: {
  adb: AdbTransport | null;
  args?: Record<string, unknown>;
  conn: Connection;
  relay: RelayClient | null;
  target?: string;
}): Promise<void> {
  const target = input.target ?? optionalString(input.args, "target");
  if (!target || target === "focused" || target === "-") return;
  const point = await mcpPointFromArgs({ target }, input.conn, {
    adb: input.adb,
    relay: input.relay,
  });
  requireOk(
    await runWithAdbFallback("tap", input.relay, input.adb, (transport) =>
      transport.tap(point)
    ),
    "Focus target failed"
  );
  await sleep(150);
}

async function focusClearAndTypeMcp(input: {
  adb: AdbTransport | null;
  args?: Record<string, unknown>;
  conn: Connection;
  relay: RelayClient | null;
  text: string;
}): Promise<McpTransportResult> {
  const target = optionalString(input.args, "target");
  const append = input.args?.append === true;
  const submit = input.args?.submit === true;

  // Prefer Tiny over racy key injection — see typeViaTinySetText. Replace uses
  // semantic ACTION_SET_TEXT; append uses paste mode (clipboard + ACTION_PASTE).
  if (input.conn.tiny) {
    if (target && isSnapshotTarget(target)) {
      const snapshot = loadLastSnapshot(input.conn.deviceId);
      if (snapshot) {
        await assertMcpCachedSnapshotFresh({
          adb: input.adb,
          conn: input.conn,
          relay: input.relay,
          snapshot,
          target,
        });
      }
    }
    const viaTiny = await typeViaTinySetText({
      append,
      deviceId: input.conn.deviceId,
      target,
      text: input.text,
      tiny: input.conn.tiny,
    });
    if (viaTiny?.ok) {
      if (!submit) return viaTiny;
      return await runWithAdbFallback("key", input.relay, input.adb, (transport) =>
        transport.key("enter")
      );
    }
    // Tiny rejected the set and no target was given — nothing is focused, so
    // fail honestly rather than vacuously "succeeding" via key injection.
    if (viaTiny && !target) {
      return {
        ok: false,
        error: "No input field is focused — tap a field first or pass a target ref.",
      };
    }
  } else if (currentMcpTransports && (currentMcpTransports.relay || currentMcpTransports.adb)) {
    // No direct Tiny endpoint (relay): set the field via Tiny /setText over the
    // device-shell channel — deterministic and far faster than `adb input text`.
    if (target) await focusMcpTarget({ ...input, target });
    const token = ensureTinyToken().token;
    const body = tinySetTextBody({
      clear: append ? "append" : "replace",
      mode: append ? "paste" : "semantic",
      target: "focused",
      text: input.text,
    });
    try {
      const res = await readMcpTinyJsonFromDevice({
        adb: input.adb,
        body,
        method: "POST",
        path: "/setText",
        relay: input.relay,
        token,
      });
      if (res.ok === true) {
        if (!submit) return { ok: true, data: res };
        return await runWithAdbFallback("key", input.relay, input.adb, (transport) =>
          transport.key("enter")
        );
      }
      if (!target) {
        return {
          ok: false,
          error: "No input field is focused — tap a field first or pass a target ref.",
        };
      }
    } catch {
      // device-shell setText unreachable — fall through to key injection.
    }
  }

  await focusMcpTarget({ ...input, target });
  const shouldClear =
    input.args?.append !== true &&
    (input.args?.clear === true || Boolean(target));
  if (shouldClear) {
    requireOk(
      await runMcpShell(input.relay, input.adb, clearFocusedInputCommand()),
      "Clear failed"
    );
  }
  const typed = await runWithAdbFallback("type", input.relay, input.adb, (transport) =>
    transport.type(input.text)
  );
  if (!typed.ok || input.args?.submit !== true) return typed;
  return await runWithAdbFallback("key", input.relay, input.adb, (transport) =>
    transport.key("enter")
  );
}

async function pasteClipboardTextMcp(input: {
  adb: AdbTransport | null;
  relay: RelayClient | null;
}): Promise<McpTransportResult> {
  const clipboard = await runWithAdbFallback("clipboard", input.relay, input.adb, (transport) =>
    transport.clipboard("get")
  );
  if (clipboard.ok && typeof clipboard.data === "string") {
    if (!clipboard.data) return clipboard;
    return await runWithAdbFallback("type", input.relay, input.adb, (transport) =>
      transport.type(clipboard.data as string)
    );
  }
  return await runWithAdbFallback("key", input.relay, input.adb, (transport) =>
    transport.key(normalizeKeyInput("paste"))
  );
}

async function doubleTapMcp(input: {
  adb: AdbTransport | null;
  intervalMs: number;
  point: { x: number; y: number };
  relay: RelayClient | null;
}): Promise<McpTransportResult> {
  const first = await runWithAdbFallback("tap", input.relay, input.adb, (transport) =>
    transport.tap(input.point)
  );
  if (!first.ok) return first;
  await sleep(input.intervalMs);
  return await runWithAdbFallback("tap", input.relay, input.adb, (transport) =>
    transport.tap(input.point)
  );
}

async function runMcpShell(
  relay: RelayClient | null,
  adb: AdbTransport | null,
  command: string
): Promise<CommandResult> {
  return await runWithAdbFallback("shell", relay, adb, (transport) =>
    transport.shell(command)
  );
}

async function runMcpShellString(
  relay: RelayClient | null,
  adb: AdbTransport | null,
  command: string,
  label: string
): Promise<string> {
  const result = await runMcpShell(relay, adb, command);
  requireOk(result, label);
  return String(result.data ?? "");
}

async function uploadMcpSessionFile(input: {
  api: HandheldApiClient;
  customizeFilePath?: string;
  deviceId: string;
  filename?: string;
  localFile: string;
  sessionId?: string;
}) {
  const sessionId =
    input.sessionId || await input.api.resolveActiveSessionId(input.deviceId);
  const filename = input.filename ?? basename(input.localFile);
  const intent = await input.api.createSessionUploadIntent(sessionId, {
    filename,
    size: statSync(input.localFile).size,
  });
  const put = await fetch(intent.uploadUrl, {
    body: readFileSync(input.localFile),
    method: "PUT",
  });
  if (!put.ok) throw new Error(`Upload failed with HTTP ${put.status}`);
  return await input.api.commitSessionUpload(sessionId, {
    customizeFilePath: input.customizeFilePath,
    filename,
    key: intent.key,
  });
}

const MCP_TINY_REMOTE_APK = "/data/local/tmp/handheld-tiny-snapshot-helper.apk";
// Full Tiny snapshots can stall on the Settings app; bounded actionable refs stay fast.
// /snapshot (not /observe) so the relay path matches local + carries layoutDigest
// (the observation shape drops it); normalizeTinySnapshot consumes it identically.
// 32768 = Tiny's per-chunk ceiling; <=32KB returns single-shot over the relay
// shell (~64KB capacity), larger bodies chunk in a few refetches.
const MCP_TINY_AGENT_SNAPSHOT_PATH =
  "/snapshot?interactiveOnly=1&compact=1&maxNodes=300&chunked=1&maxChars=32768";

function parseMcpTinyJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("Tiny returned empty shell output");
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tiny returned non-object shell output");
  }
  return parsed as Record<string, unknown>;
}

function isMcpTinyChunkEnvelope(value: Record<string, unknown>): boolean {
  return value.chunked === true && typeof value.id === "string" && typeof value.data === "string";
}

function mcpChunkNextOffset(value: Record<string, unknown>): number | null {
  const raw = value.nextOffset;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : null;
}

function mcpTinyStatusSupportsAgentShape(status: Record<string, unknown>): boolean {
  return tinySupportsRequiredAgentShape(status);
}

function isTransientMcpTinyRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ADB command timed out|timed out waiting for shell|Relay request timed out|closed before .* completed/i
    .test(message);
}

async function readMcpTinyJsonFromDevice(input: {
  adb: AdbTransport | null;
  body?: string;
  maxTimeSec?: number;
  method?: string;
  path: string;
  relay: RelayClient | null;
  token: string;
}): Promise<Record<string, unknown>> {
  // Only idempotent GET reads retry; a POST (e.g. /input) runs once — never
  // resend a mutating op that may have already executed on-device (#5).
  const attempts =
    !input.method || input.method.toUpperCase() === "GET"
      ? (/^\/(snapshot|observe|capture)\b/.test(input.path) ? 3 : 1)
      : 1;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const parsed = parseMcpTinyJson(
        await runMcpShellString(
          input.relay,
          input.adb,
          tinyDeviceRequestCommand(input.path, input.token, {
            body: input.body,
            maxTimeSec: input.maxTimeSec,
            method: input.method,
          }),
          `Tiny ${input.path} failed`
        )
      );
      return isMcpTinyChunkEnvelope(parsed)
        ? await readMcpTinyChunkedJsonFromDevice({
            adb: input.adb,
            first: parsed,
            relay: input.relay,
            token: input.token,
          })
        : parsed;
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientMcpTinyRequestError(error)) break;
      await runMcpShell(input.relay, input.adb, tinyDeviceStartCommand(input.token)).catch(
        () => undefined
      );
      await sleep(750);
    }
  }
  throw lastError;
}

async function readMcpTinyChunkedJsonFromDevice(input: {
  adb: AdbTransport | null;
  first: Record<string, unknown>;
  relay: RelayClient | null;
  token: string;
}): Promise<Record<string, unknown>> {
  const id = String(input.first.id);
  let text = String(input.first.data ?? "");
  let eof = input.first.eof === true;
  let nextOffset = mcpChunkNextOffset(input.first);
  let reads = 0;
  while (!eof && nextOffset !== null) {
    reads += 1;
    if (reads > 128) {
      throw new Error(`Tiny chunked response ${id} did not finish`);
    }
    const chunk = parseMcpTinyJson(
      await runMcpShellString(
        input.relay,
        input.adb,
        tinyDeviceRequestCommand(`/responseChunk?id=${encodeURIComponent(id)}&offset=${nextOffset}&maxChars=32768`, input.token),
        `Tiny response chunk ${id} failed`
      )
    );
    if (chunk.ok === false) {
      throw new Error(String(chunk.message ?? "Tiny response chunk failed"));
    }
    text += String(chunk.data ?? "");
    eof = chunk.eof === true;
    nextOffset = mcpChunkNextOffset(chunk);
  }
  return parseMcpTinyJson(text);
}

async function waitForMcpDeviceTiny(input: {
  adb: AdbTransport | null;
  relay: RelayClient | null;
  token: string;
}) {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;
  while (Date.now() <= deadline) {
    try {
      return await readMcpTinyJsonFromDevice({
        adb: input.adb,
        path: "/status",
        relay: input.relay,
        token: input.token,
      });
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Tiny helper did not become ready: ${message}`);
}

async function ensureMcpDeviceTiny(input: {
  adb: AdbTransport | null;
  // Lazy: only the Gateway-upload fallback below builds a client, so a local /
  // already-running Tiny never requires an API key.
  api: () => HandheldApiClient;
  conn: Connection;
  relay: RelayClient | null;
}) {
  const tokenState = ensureTinyToken();
  try {
    const status = await readMcpTinyJsonFromDevice({
      adb: input.adb,
      path: "/status",
      relay: input.relay,
      token: tokenState.token,
    });
    if (mcpTinyStatusSupportsAgentShape(status)) return tokenState;
  } catch {}

  await runMcpShell(input.relay, input.adb, tinyDeviceStartCommand(tokenState.token));
  try {
    const status = await waitForMcpDeviceTiny({
      adb: input.adb,
      relay: input.relay,
      token: tokenState.token,
    });
    if (mcpTinyStatusSupportsAgentShape(status)) return tokenState;
  } catch {}

  await uploadMcpSessionFile({
    api: input.api(),
    customizeFilePath: MCP_TINY_REMOTE_APK,
    deviceId: input.conn.deviceId,
    filename: basename(bundledTinyApkPath()),
    localFile: bundledTinyApkPath(),
    sessionId: input.conn.sessionId,
  });
  await runMcpShellString(
    input.relay,
    input.adb,
    tinyDeviceInstallCommand(MCP_TINY_REMOTE_APK),
    "Tiny install failed"
  );
  await runMcpShellString(
    input.relay,
    input.adb,
    tinyDeviceStartCommand(tokenState.token),
    "Tiny start failed"
  );
  const status = await waitForMcpDeviceTiny({
    adb: input.adb,
    relay: input.relay,
    token: tokenState.token,
  });
  if (!mcpTinyStatusSupportsAgentShape(status)) {
    throw new Error("Tiny helper does not support agent-shaped observations");
  }
  return tokenState;
}

async function readMcpSnapshotRaw(input: {
  adb: AdbTransport | null;
  // Lazy — see ensureMcpDeviceTiny. Local/already-running Tiny resolves via
  // ensureTinyState without a Gateway client.
  api: () => HandheldApiClient;
  conn: Connection;
  relay: RelayClient | null;
}): Promise<Record<string, unknown>> {
  if (input.conn.tiny || input.conn.adb?.serial) {
    try {
      const tiny = await ensureTinyState(input.conn);
      return await getTinySnapshot(tiny);
    } catch (error) {
      if (!input.relay && !input.adb) throw error;
    }
  }
  const tiny = await ensureMcpDeviceTiny(input);
  return await readMcpTinyJsonFromDevice({
    adb: input.adb,
    path: MCP_TINY_AGENT_SNAPSHOT_PATH,
    relay: input.relay,
    token: tiny.token,
  });
}

function mcpEvidenceRoot(): string {
  const configured = process.env.HANDHELD_EVIDENCE_DIR?.trim();
  return resolve(configured || join(process.cwd(), "evidence"));
}

function mcpAgentSpaceRoots(): {
  projectAgentSpaceDir: string;
  runAgentSpaceDir: string;
} {
  return {
    projectAgentSpaceDir: projectAgentSpaceDirFromEnv(),
    runAgentSpaceDir: runAgentSpaceDirFromEnv(),
  };
}

function mcpListDomainSkills(): Record<string, unknown> {
  const roots = mcpAgentSpaceRoots();
  const runDomainSkillsDir = domainSkillsDir(roots.runAgentSpaceDir);
  const projectDomainSkillsDir = domainSkillsDir(roots.projectAgentSpaceDir);
  return {
    ok: true,
    project: {
      agentSpace: roots.projectAgentSpaceDir,
      domainSkillsDir: projectDomainSkillsDir,
      skills: listDomainSkillFiles(projectDomainSkillsDir).map((skill) => skill.path),
    },
    run: {
      agentSpace: roots.runAgentSpaceDir,
      domainSkillsDir: runDomainSkillsDir,
      skills: listDomainSkillFiles(runDomainSkillsDir).map((skill) => skill.path),
    },
  };
}

export function handleAgentSpaceToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): ReturnType<typeof jsonContent> {
  switch (name) {
    case "list_domain_skills": {
      return jsonContent(mcpListDomainSkills());
    }

    case "read_domain_skill": {
      const roots = mcpAgentSpaceRoots();
      return jsonContent(
        readDomainSkill({
          path: requiredString(args, "path"),
          projectAgentSpaceDir: roots.projectAgentSpaceDir,
          runAgentSpaceDir: roots.runAgentSpaceDir,
          scope: mcpDomainSkillScope(args?.scope),
        })
      );
    }

    case "save_domain_skill_candidate": {
      const roots = mcpAgentSpaceRoots();
      return jsonContent({
        ok: true,
        skill: writeRunDomainSkill({
          body: requiredString(args, "body"),
          packageName: optionalString(args, "packageName"),
          path: optionalString(args, "path"),
          runAgentSpaceDir: roots.runAgentSpaceDir,
          title: optionalString(args, "title"),
        }),
      });
    }

    case "promote_domain_skill": {
      const roots = mcpAgentSpaceRoots();
      return jsonContent({
        ok: true,
        skill: promoteRunDomainSkill({
          overwrite: args?.overwrite === true,
          path: requiredString(args, "path"),
          projectAgentSpaceDir: roots.projectAgentSpaceDir,
          runAgentSpaceDir: roots.runAgentSpaceDir,
        }),
      });
    }

    default:
      throw new Error(`Unsupported agent-space tool: ${name}`);
  }
}

function mcpDomainSkillScope(value: unknown): "project" | "run" {
  if (value === undefined || value === null || value === "") return "run";
  if (value === "run" || value === "project") return value;
  throw new Error("scope must be run or project");
}

function mcpEvidenceSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "state";
}

function mcpEvidencePrefix(label: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${mcpEvidenceSlug(label).slice(0, 48)}`;
}

function writeMcpEvidenceJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    mode: MCP_EVIDENCE_FILE_MODE,
  });
}

async function readMcpSnapshotDocument(input: {
  adb: AdbTransport | null;
  conn: Connection;
  relay: RelayClient | null;
}): Promise<SnapshotDocument> {
  const raw = await readMcpSnapshotRaw({
    adb: input.adb,
    api: () => new HandheldApiClient(),
    conn: input.conn,
    relay: input.relay,
  });
  let snapshot: SnapshotDocument;
  try {
    snapshot = normalizeTinySnapshot({ deviceId: input.conn.deviceId, raw });
  } catch (error) {
    clearLastSnapshot(input.conn.deviceId);
    throw error;
  }
  // Current Tiny folds the foreground activity into the snapshot itself
  // (on-device); only fall back to a host dumpsys for an older Tiny.
  if (!snapshot.activity) {
    try {
      const focus = await runMcpShell(input.relay, input.adb, currentAppCommand());
      if (focus.ok && typeof focus.data === "string") {
        const current = parseCurrentComponent(focus.data);
        if (current.activity) snapshot.activity = current.activity;
        if (current.component) snapshot.component = current.component;
      }
    } catch {
      // best-effort
    }
  }
  saveLastSnapshot(snapshot);
  return snapshot;
}

async function captureMcpEvidence(input: {
  adb: AdbTransport | null;
  conn: Connection;
  includeScreenshot: boolean;
  label: string;
  relay: RelayClient | null;
}): Promise<Record<string, unknown>> {
  const root = mcpEvidenceRoot();
  mkdirSync(root, { mode: MCP_EVIDENCE_DIR_MODE, recursive: true });
  const prefix = mcpEvidencePrefix(input.label);
  const snapshotPath = join(root, `${prefix}-snap.json`);
  const statusPath = join(root, `${prefix}-status.json`);
  const screenPath = join(root, `${prefix}-screen.png`);

  const snapshot = await readMcpSnapshotDocument(input);
  writeMcpEvidenceJson(snapshotPath, {
    ...snapshot,
    nodes: snapshotNodesForDisplay(snapshot, { interactive: false }),
    raw: undefined,
    totalNodeCount: snapshot.nodes.length,
  });

  const status: Record<string, unknown> = {
    deviceId: input.conn.deviceId,
    evidenceDir: root,
    label: input.label,
    ok: true,
    snapshot: snapshotPath,
    status: statusPath,
  };
  try {
    const current = await runMcpShell(input.relay, input.adb, currentAppCommand());
    if (current.ok && typeof current.data === "string") {
      status.currentApp = parseCurrentComponent(current.data);
    } else {
      status.currentAppError = current.error ?? "current_app failed";
    }
  } catch (error) {
    status.currentAppError = error instanceof Error ? error.message : String(error);
  }
  if (input.includeScreenshot) {
    const screenshot = await runWithAdbFallback("screenshot", input.relay, input.adb, (transport) =>
      transport.screenshot()
    );
    if (screenshot.ok && "base64" in screenshot && screenshot.base64) {
      writeFileSync(screenPath, Buffer.from(screenshot.base64, "base64"), {
        mode: MCP_EVIDENCE_FILE_MODE,
      });
      status.screenshot = screenPath;
      status.screenshotMimeType = "image/png";
    } else {
      status.screenshotError = "error" in screenshot ? screenshot.error : "Screenshot failed";
    }
  }
  writeMcpEvidenceJson(statusPath, status);
  return status;
}

function requireOk(result: McpTransportResult, label: string): void {
  if (!result.ok) throw new Error(`${label}: ${result.error ?? "unknown error"}`);
}

function mcpTextResult(result: McpTransportResult & { wait?: unknown }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
}

async function listMcpPackagesAndActivities(
  relay: RelayClient | null,
  adb: AdbTransport | null,
  includeSystem = true
) {
  const packages = await runMcpShell(relay, adb, packageListCommand(includeSystem));
  requireOk(packages, "List packages failed");
  const activities = await runMcpShell(relay, adb, launcherActivitiesCommand());
  return {
    activities: activities.ok && typeof activities.data === "string"
      ? parseLauncherActivities(activities.data)
      : [],
    packages: parsePackageList(String(packages.data ?? "")),
  };
}

async function resolveMcpApp(
  relay: RelayClient | null,
  adb: AdbTransport | null,
  query: string
) {
  const { activities, packages } = await listMcpPackagesAndActivities(relay, adb, true);
  return resolveAppPackage({ activities, packages, query });
}

async function disconnectDevice(deviceId?: string): Promise<string> {
  const conn = resolveConnection(deviceId);
  if (!conn) {
    throw new Error("Not connected");
  }

  // A local connection has no Gateway session to stop (and no API key to do it
  // with) — just drop the saved connection.
  if (!conn.local) {
    const api = new HandheldApiClient();
    await api.stopDevice(conn.deviceId);
  }

  removeConnection(conn.deviceId);
  return conn.deviceId;
}

export async function startMcpServer(deviceId?: string): Promise<void> {
  const origError = console.error;
  console.log = (...args: unknown[]) => origError("[handheld-mcp]", ...args);
  console.error = (...args: unknown[]) => origError("[handheld-mcp]", ...args);

  const server = new Server(
    { name: "handheld", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listVisibleTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let relayToClose: RelayClient | null = null;

    try {
      switch (name) {
        case "devices": {
          const api = new HandheldApiClient();
          const result = await api.listDevices();
          return {
            content: [{ type: "text", text: JSON.stringify(result.devices, null, 2) }],
          };
        }

        case "create_device": {
          const api = new HandheldApiClient();
          const input = { ...(args ?? {}) } as CreateDeviceInput;
          const result = await api.createDevice(input, {
            idempotencyKey: optionalString(args, "idempotencyKey"),
          });
          return jsonContent(result);
        }

        case "proxies": {
          const api = new HandheldApiClient();
          const result = await api.listProxies({
            cursor: optionalString(args, "cursor"),
            groupId: optionalString(args, "groupId"),
            limit: typeof args?.limit === "number" ? args.limit : undefined,
            status:
              args?.status === "unknown" ||
              args?.status === "healthy" ||
              args?.status === "failing"
                ? (args.status as ProxyStatus)
                : undefined,
          });
          return jsonContent(result);
        }

        case "proxy_get": {
          const api = new HandheldApiClient();
          return jsonContent(await api.getProxy(requiredString(args, "proxyId")));
        }

        case "proxy_create": {
          const api = new HandheldApiClient();
          const proxy = requiredString(args, "proxy");
          return jsonContent(await api.createProxy({ ...proxyConfigFromArgs(args), proxy }));
        }

        case "proxy_update": {
          const api = new HandheldApiClient();
          const proxyId = requiredString(args, "proxyId");
          return jsonContent(await api.updateProxy(proxyId, proxyConfigFromArgs(args)));
        }

        case "proxy_check": {
          const api = new HandheldApiClient();
          const proxyId = requiredString(args, "proxyId");
          return jsonContent(
            await api.checkProxy(proxyId, {
              ...(args?.detection && typeof args.detection === "object"
                ? { detection: args.detection as Record<string, unknown> }
                : {}),
              ...(typeof args?.proxyWorking === "boolean"
                ? { proxyWorking: args.proxyWorking }
                : {}),
              ...(optionalString(args, "publicIp") ? { publicIp: optionalString(args, "publicIp") } : {}),
            })
          );
        }

        case "proxy_delete": {
          const api = new HandheldApiClient();
          return jsonContent(await api.deleteProxy(requiredString(args, "proxyId")));
        }

        case "proxy_links": {
          const api = new HandheldApiClient();
          return jsonContent(await api.listProxyLinks(requiredString(args, "proxyId")));
        }

        case "proxy_groups": {
          const api = new HandheldApiClient();
          return jsonContent(await api.listProxyGroups());
        }

        case "proxy_group_create": {
          const api = new HandheldApiClient();
          return jsonContent(
            await api.createProxyGroup({
              color: optionalString(args, "color"),
              name: requiredString(args, "name"),
            })
          );
        }

        case "proxy_group_update": {
          const api = new HandheldApiClient();
          return jsonContent(
            await api.updateProxyGroup(requiredString(args, "groupId"), {
              color: optionalString(args, "color"),
              name: optionalString(args, "name"),
            })
          );
        }

        case "proxy_group_delete": {
          const api = new HandheldApiClient();
          return jsonContent(await api.deleteProxyGroup(requiredString(args, "groupId")));
        }

        case "profiles": {
          const api = new HandheldApiClient();
          return jsonContent(await api.listProfiles());
        }

        case "profile_get": {
          const api = new HandheldApiClient();
          return jsonContent(await api.getProfile(requiredString(args, "profileId")));
        }

        case "profile_create": {
          const api = new HandheldApiClient();
          const bodyArg = args?.body;
          const body =
            bodyArg && typeof bodyArg === "object" && !Array.isArray(bodyArg)
              ? { ...(bodyArg as Record<string, unknown>) }
              : { ...(args ?? {}) };
          delete body.body;
          delete body.idempotencyKey;
          const androidVersion =
            typeof body.androidVersion === "string"
              ? body.androidVersion
              : requiredString(args, "androidVersion");
          return jsonContent(
            await api.createProfile(
              { ...body, androidVersion } as CreateGatewayProfileInput,
              { idempotencyKey: optionalString(args, "idempotencyKey") }
            )
          );
        }

        case "profile_delete": {
          const api = new HandheldApiClient();
          return jsonContent(await api.deleteProfile(requiredString(args, "profileId")));
        }

        case "profile_snapshots": {
          const api = new HandheldApiClient();
          return jsonContent(await api.listProfileSnapshots(requiredString(args, "profileId")));
        }

        case "profile_capture": {
          const api = new HandheldApiClient();
          return jsonContent(
            await api.captureProfileSnapshot(requiredString(args, "profileId"), {
              idempotencyKey: optionalString(args, "idempotencyKey"),
            })
          );
        }

        case "profile_restore": {
          const api = new HandheldApiClient();
          return jsonContent(
            await api.restoreProfileSnapshot(requiredString(args, "profileId"), {
              equipmentId: optionalString(args, "equipmentId"),
              idempotencyKey: optionalString(args, "idempotencyKey"),
            })
          );
        }

        case "profile_job": {
          const api = new HandheldApiClient();
          return jsonContent(
            await api.getProfileSavedStateJob(
              requiredString(args, "profileId"),
              requiredString(args, "jobId"),
            )
          );
        }

        case "profile_reboot": {
          const api = new HandheldApiClient();
          return jsonContent(
            await api.rebootProfile(requiredString(args, "profileId"), {
              idempotencyKey: optionalString(args, "idempotencyKey"),
            })
          );
        }

        case "billing_balance": {
          const api = new HandheldApiClient();
          return jsonContent(await api.getBillingBalance());
        }

        case "billing_usage_state": {
          const api = new HandheldApiClient();
          return jsonContent(await api.getBillingUsageState());
        }

        case "billing_transactions": {
          const api = new HandheldApiClient();
          return jsonContent(
            await api.getBillingTransactions(optionalNumber(args, "limit"))
          );
        }

        case "billing_spend_summary": {
          const api = new HandheldApiClient();
          return jsonContent(
            await api.getBillingSpendSummary({
              windowEndMs: optionalNumber(args, "windowEndMs"),
              windowStartMs: optionalNumber(args, "windowStartMs"),
            })
          );
        }

        case "connect": {
          const local = args?.local === true;
          const targetDeviceId = String(args?.deviceId ?? "");
          // A cloud connect needs a deviceId; a local connect can auto-pick.
          if (!targetDeviceId && !local) {
            return {
              content: [
                {
                  type: "text",
                  text: "deviceId is required for a cloud connect — pass deviceId (see the devices tool), or set local:true to attach to a local adb device (omit deviceId to auto-pick the sole ready one).",
                },
              ],
              isError: true,
            };
          }
          const result = await connectDevice(targetDeviceId, { local });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        }

        case "disconnect": {
          const disconnected = await disconnectDevice(
            typeof args?.deviceId === "string" ? args.deviceId : deviceId
          );
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, deviceId: disconnected }) }],
          };
        }

        case "teach_request": {
          const objective = String(args?.objective ?? "").trim();
          if (!objective) {
            return { content: [{ type: "text", text: "objective is required" }], isError: true };
          }
          const reqDevice = typeof args?.deviceId === "string" ? args.deviceId : deviceId;
          const conn = resolveConnection(reqDevice);
          const targetDeviceId = conn?.deviceId ?? reqDevice;
          const started = startTeachDetached({
            objective,
            deviceId: targetDeviceId,
            package: typeof args?.package === "string" ? args.package : undefined,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...started,
                  status: "waiting",
                  instruction:
                    "A live viewer is opening in the human's browser to demonstrate. This is non-blocking: poll envelopePath (read the JSON file) every ~3s until status is 'ready' (or 'timeout'/'error'). When 'ready', run the teach-from-human skill on trajectoryPath (or bundleZip).",
                }),
              },
            ],
          };
        }

        case "list_domain_skills":
        case "read_domain_skill":
        case "save_domain_skill_candidate":
        case "promote_domain_skill":
          return handleAgentSpaceToolCall(name, args);
      }

      const { relay, adb, conn } = getTransport(deviceId);
      relayToClose = relay;
      switch (name) {
        case "snap": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const snapshot = await readMcpSnapshotDocument({
            adb,
            conn,
            relay,
          });
          if (args?.agent === true) {
            return jsonContent(snapshotForAgent(snapshot));
          }
          const screenshot = args?.screenshot === true
            ? await runWithAdbFallback("screenshot", relay, adb, (transport) =>
                transport.screenshot()
              )
            : null;
          return jsonContent({
            ...snapshot,
            nodes: snapshotNodesForDisplay(snapshot, {
              // Default keeps read-only text; interactive:true returns actionable-only.
              interactive: args?.interactive === true,
            }),
            raw: args?.raw ? snapshot.raw : undefined,
            screenshot: screenshot?.ok
              ? {
                  base64: screenshot.base64,
                  mimeType: "image/png",
              }
            : screenshot
                ? {
                    error: "error" in screenshot ? screenshot.error : "Screenshot failed",
                    ok: false,
                  }
                : undefined,
            totalNodeCount: snapshot.nodes.length,
          });
        }

        case "capture_evidence": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          return jsonContent(
            await captureMcpEvidence({
              adb,
              conn,
              includeScreenshot: args?.screenshot !== false,
              label: optionalString(args, "label") ?? "state",
              relay,
            })
          );
        }

        case "tap":
        case "click":
        case "click_at": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const point = await mcpPointFromArgs(args, conn, { adb, relay });
          const longPress = args?.longPress === true;
          return mcpTextResult(
            await settleMcpGesture(
              conn,
              args,
              { type: longPress ? "longPress" : "tap", x: point.x, y: point.y },
              () => runWithAdbFallback("tap", relay, adb, (transport) => transport.tap({ ...point, longPress }))
            )
          );
        }

        case "click_area": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const point = {
            x: Math.round(((args!.x1 as number) + (args!.x2 as number)) / 2),
            y: Math.round(((args!.y1 as number) + (args!.y2 as number)) / 2),
          };
          return mcpTextResult(
            await settleMcpGesture(
              conn,
              args,
              { type: "tap", x: point.x, y: point.y },
              () => runWithAdbFallback("tap", relay, adb, (transport) => transport.tap(point))
            )
          );
        }

        case "long_press": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const point = await mcpPointFromArgs(args, conn, { adb, relay });
          const duration = optionalNumber(args, "duration") ?? 1000;
          return mcpTextResult(
            await settleMcpGesture(
              conn,
              args,
              { type: "longPress", x: point.x, y: point.y, durationMs: duration },
              () => runWithAdbFallback("tap", relay, adb, (transport) =>
                transport.tap({ ...point, duration, longPress: true })
              )
            )
          );
        }

        case "double_tap": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const point = await mcpPointFromArgs(args, conn, { adb, relay });
          return mcpTextResult(
            await settleMcpGesture(
              conn,
              args,
              { type: "doubleTap", x: point.x, y: point.y },
              () => doubleTapMcp({
                adb,
                intervalMs: optionalNumber(args, "intervalMs") ?? 80,
                point,
                relay,
              })
            )
          );
        }

        case "fill": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const beforeAction = await beginMcpActionWait(conn, args);
          let result: McpTransportResult;
          try {
            result = await focusClearAndTypeMcp({
              adb,
              args: { ...(args ?? {}), clear: true },
              conn,
              relay,
              text: requiredString(args, "text"),
            });
          } catch (err) {
            result = { ok: false, error: (err as Error).message };
          }
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "clear": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const beforeAction = await beginMcpActionWait(conn, args);
          const target = optionalString(args, "target");
          if (target && target !== "focused" && target !== "-") {
            const point = await mcpPointFromArgs({ target }, conn, { adb, relay });
            requireOk(
              await runWithAdbFallback("tap", relay, adb, (transport) => transport.tap(point)),
              "Focus target failed"
            );
            await sleep(150);
          } else if (!(await hasFocusedEditableField(conn.tiny))) {
            // Clearing the focused field with nothing focused is a no-op;
            // fail honestly instead of reporting success. (R3 parity)
            return mcpTextResult({
              ok: false,
              error: "No input field is focused — tap a field first or pass a target ref.",
            });
          }
          const result = await runMcpShell(
            relay,
            adb,
            clearFocusedInputCommand(optionalNumber(args, "repeat") ?? 80)
          );
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "swipe": {
          const x1 = args!.startX as number, y1 = args!.startY as number;
          const x2 = args!.endX as number, y2 = args!.endY as number;
          const duration = args!.duration as number | undefined;
          const settled = await settleMcpGesture(
            conn,
            args,
            { type: "swipe", x1, y1, x2, y2, ...(duration !== undefined ? { durationMs: duration } : {}) },
            () => runWithAdbFallback("swipe", relay, adb, (transport) =>
              transport.swipe({ x1, y1, x2, y2, duration })
            )
          );
          return { content: [{ type: "text", text: JSON.stringify(settled) }], isError: !settled.ok };
        }

        case "type": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await focusClearAndTypeMcp({
            adb,
            args,
            conn,
            relay,
            text: requiredString(args, "text"),
          });
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "key": {
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await runWithAdbFallback("key", relay, adb, (transport) =>
            transport.key(normalizeKeyInput(args!.key as string | number))
          );
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "press_key": {
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await runWithAdbFallback("key", relay, adb, (transport) =>
            transport.key(normalizeKeyInput(args!.key as string | number))
          );
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "back":
        case "home":
        case "recent": {
          const key = name === "back" ? "back" : name === "home" ? "home" : "recent";
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await runWithAdbFallback("key", relay, adb, (transport) =>
            transport.key(normalizeKeyInput(key))
          );
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "system_button": {
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await runWithAdbFallback("key", relay, adb, (transport) =>
            transport.key(normalizeKeyInput(requiredString(args, "button")))
          );
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "keycode": {
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await runWithAdbFallback("key", relay, adb, (transport) =>
            transport.key(optionalNumber(args, "keycode") ?? 0)
          );
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "scroll": {
          const direction = requiredString(args, "direction");
          if (!["up", "down", "left", "right"].includes(direction)) {
            throw new Error("direction must be up, down, left, or right");
          }
          const sizeResult = await runMcpShell(relay, adb, screenSizeCommand());
          requireOk(sizeResult, "Screen size failed");
          const size = parseScreenSize(String(sizeResult.data ?? ""));
          if (!size) throw new Error("Could not read screen size");
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await runWithAdbFallback("swipe", relay, adb, (transport) =>
            transport.swipe({
              ...scrollSwipe({
                direction: direction as "down" | "left" | "right" | "up",
                ...size,
              }),
              duration: optionalNumber(args, "duration") ?? 300,
            })
          );
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "wait": {
          const seconds = optionalNumber(args, "seconds") ?? 1;
          const waitedMs = Math.max(0, seconds * 1000);
          await new Promise((resolve) => setTimeout(resolve, waitedMs));
          return jsonContent({ ok: true, waitedMs });
        }

        case "wait_for": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const condition = requiredString(args, "condition").toLowerCase();
          const timeoutMs = optionalNumber(args, "timeoutMs") ?? 5000;
          if (!["stable", "text", "ref", "change"].includes(condition)) {
            throw new Error("condition must be stable, text, ref, or change");
          }
          if (condition === "stable") {
            const startedAt = Date.now();
            let result: Record<string, unknown>;
            try {
              const tiny = await ensureTinyState(conn);
              result = await waitTinyStable(tiny, { timeoutMs });
            } catch (error) {
              if (!relay && !adb) throw error;
              const tokenState = await ensureMcpDeviceTiny({
                adb,
                api: () => new HandheldApiClient(),
                conn,
                relay,
              });
              result = await readMcpTinyJsonFromDevice({
                adb,
                maxTimeSec: Math.ceil(timeoutMs / 1000) + 6,
                path: tinyWaitForStablePath({ timeoutMs }),
                relay,
                token: tokenState.token,
              });
            }
            // Honor Tiny's verdict: stable:false means it sampled until the
            // device timeout without the UI going quiet — not a success.
            return jsonContent({
              ok: result.stable !== false,
              result,
              waitedMs: Date.now() - startedAt,
            });
          }
          if ((condition === "text" || condition === "ref") && !optionalString(args, "value")) {
            throw new Error(`wait_for ${condition} requires value`);
          }
          return jsonContent(
            await waitForMcpSnapshotCondition({
              condition,
              conn,
              timeoutMs,
              value: optionalString(args, "value"),
            })
          );
        }

        case "list_apps": {
          const { activities, packages } = await listMcpPackagesAndActivities(
            relay,
            adb,
            args?.system === true
          );
          return jsonContent({
            ok: true,
            apps: activities.length > 0
              ? activities
              : packages.map((packageName) => ({ packageName })),
          });
        }

        case "open_app": {
          const app = await resolveMcpApp(relay, adb, requiredString(args, "nameOrPackage"));
          if (!app) throw new Error(`App not found: ${requiredString(args, "nameOrPackage")}`);
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await runMcpShell(relay, adb, startAppCommand(app));
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "launch": {
          const command = launchTargetCommand({
            action: optionalString(args, "action"),
            component: optionalString(args, "component"),
            data: optionalString(args, "data"),
            packageName: optionalString(args, "packageName"),
            target: optionalString(args, "target"),
          });
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await runMcpShell(relay, adb, command);
          // `am start` exits 0 even when the activity is missing or the intent
          // can't resolve — parse its output so a failed launch is not a
          // dishonest success.
          if (result.ok && typeof result.data === "string") {
            const failure = amStartError(result.data);
            if (failure) {
              return mcpTextResult({ ok: false, error: failure, data: result.data });
            }
          }
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "current_app": {
          const result = await runMcpShell(relay, adb, currentAppCommand());
          const current = result.ok && typeof result.data === "string"
            ? parseCurrentComponent(result.data)
            : null;
          return jsonContent({
            ok: result.ok,
            packageName: current?.packageName ?? null,
            activity: current?.activity ?? null,
            component: current?.component ?? null,
            raw: result.data,
            error: result.error,
          });
        }

        case "stop_app": {
          const app = await resolveMcpApp(relay, adb, requiredString(args, "nameOrPackage"));
          if (!app) throw new Error(`App not found: ${requiredString(args, "nameOrPackage")}`);
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await runMcpShell(relay, adb, stopAppCommand(app.packageName));
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        case "screenshot": {
          const result = await runWithAdbFallback("screenshot", relay, adb, (transport) =>
            transport.screenshot()
          );
          if (result.ok && result.base64) {
            return {
              content: [{ type: "image", data: result.base64, mimeType: "image/png" }],
            };
          }
          return { content: [{ type: "text", text: "Screenshot failed" }], isError: true };
        }

        case "shell": {
          const beforeAction = await beginMcpActionWait(conn, args);
          const result = await runWithAdbFallback("shell", relay, adb, (transport) =>
            transport.shell(args!.command as string)
          );
          const settled = await settleMcpResult(beforeAction, result);
          if (!settled.ok) {
            return { content: [{ type: "text", text: JSON.stringify(settled) }], isError: true };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  typeof settled.data === "string"
                    ? settled.data
                    : JSON.stringify(settled.data ?? "", null, 2),
              },
            ],
          };
        }

        case "gps": {
          const transport = pick("gps", relay, adb);
          if (!transport) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const result = await transport.gps(args!.latitude as number, args!.longitude as number);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }

        case "clipboard": {
          const transport = pick("clipboard", relay, adb);
          if (!transport) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const result = await transport.clipboard(
            args!.action as "get" | "set",
            args!.text as string | undefined
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }

        case "copy": {
          const text = requiredString(args, "text");
          let result = await runWithAdbFallback("clipboard", relay, adb, (transport) =>
            transport.clipboard("set", text)
          );
          if (!result.ok && adb) {
            result = await executeSafely(adb, (transport) =>
              transport.clipboard("set", text)
            );
          }
          return mcpTextResult(result);
        }

        case "paste": {
          if (!conn) return { content: [{ type: "text", text: "Not connected — call connect first (connect deviceId, or connect with local:true for a local adb device)." }], isError: true };
          const beforeAction = await beginMcpActionWait(conn, args);
          let result: McpTransportResult;
          try {
            const pasteTarget = optionalString(args, "target");
            if (!pasteTarget && !(await hasFocusedEditableField(conn.tiny))) {
              result = {
                ok: false,
                error: "No input field is focused — tap a field first or pass a target ref.",
              };
            } else {
              await focusMcpTarget({ adb, args, conn, relay });
              result = await pasteClipboardTextMcp({ adb, relay });
            }
          } catch (err) {
            result = { ok: false, error: (err as Error).message };
          }
          return mcpTextResult(await settleMcpResult(beforeAction, result));
        }

        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    } finally {
      await relayToClose?.disconnect().catch(() => null);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
