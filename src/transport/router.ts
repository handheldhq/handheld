import type { TransportCommand } from "./types.js";

const RELAY_COMMANDS = new Set<TransportCommand>([
  "tap",
  "swipe",
  "type",
  "key",
  "screenshot",
  "snapshot_xml",
  "shell",
  "clipboard",
  "gps",
]);

const ADB_ONLY_COMMANDS = new Set<TransportCommand>([
  "pull",
  "push",
  "install",
]);

export function routeCommand(
  command: TransportCommand,
  relayConnected: boolean
): "relay" | "adb" {
  if (ADB_ONLY_COMMANDS.has(command)) return "adb";
  if (RELAY_COMMANDS.has(command) && relayConnected) return "relay";
  return "adb";
}

export interface ParsedAdbCommand {
  transport: "relay";
  command: TransportCommand;
  args: Record<string, unknown>;
}

const ADB_RELAY_PATTERNS: Array<{
  pattern: RegExp;
  parse: (match: RegExpMatchArray) => ParsedAdbCommand;
}> = [
  {
    pattern: /^shell\s+input\s+tap\s+(\d+)\s+(\d+)/,
    parse: (match) => ({
      transport: "relay",
      command: "tap",
      args: { x: Number(match[1]), y: Number(match[2]) },
    }),
  },
  {
    pattern:
      /^shell\s+input\s+swipe\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?/,
    parse: (match) => ({
      transport: "relay",
      command: "swipe",
      args: {
        x1: Number(match[1]),
        y1: Number(match[2]),
        x2: Number(match[3]),
        y2: Number(match[4]),
        duration: match[5] ? Number(match[5]) : undefined,
      },
    }),
  },
  {
    pattern: /^shell\s+input\s+text\s+(.+)/,
    parse: (match) => ({
      transport: "relay",
      command: "type",
      args: { text: match[1].replace(/^["']|["']$/g, "") },
    }),
  },
  {
    pattern: /^shell\s+input\s+keyevent\s+(\d+|KEYCODE_\w+)/,
    parse: (match) => {
      const keyMap: Record<string, string> = {
        "4": "back",
        "3": "home",
        "66": "enter",
        "82": "menu",
        KEYCODE_BACK: "back",
        KEYCODE_HOME: "home",
        KEYCODE_ENTER: "enter",
        KEYCODE_MENU: "menu",
      };
      const key = keyMap[match[1]];
      if (!key) {
        return {
          transport: "relay",
          command: "key",
          args: { keyCode: match[1] },
        };
      }
      return {
        transport: "relay",
        command: "key",
        args: { key },
      };
    },
  },
  {
    pattern: /^exec-out\s+uiautomator\s+dump\s+\/dev\/tty$/,
    parse: () => ({
      transport: "relay",
      command: "snapshot_xml",
      args: {},
    }),
  },
  {
    pattern: /^exec-out\s+screencap\s+-p/,
    parse: () => ({
      transport: "relay",
      command: "screenshot",
      args: {},
    }),
  },
  {
    pattern: /^shell\s+screencap\s+-p/,
    parse: () => ({
      transport: "relay",
      command: "screenshot",
      args: {},
    }),
  },
  {
    pattern: /^shell\s+(.+)/,
    parse: (match) => ({
      transport: "relay",
      command: "shell",
      args: { command: match[1] },
    }),
  },
];

export function parseAdbArgs(args: string[]): ParsedAdbCommand | null {
  const command = args.join(" ");
  for (const { pattern, parse } of ADB_RELAY_PATTERNS) {
    const match = command.match(pattern);
    if (match) {
      return parse(match);
    }
  }
  return null;
}
