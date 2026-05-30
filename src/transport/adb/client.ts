import { execFileSync } from "node:child_process";
import type {
  Transport,
  TapOpts,
  SwipeOpts,
  CommandResult,
  ScreenshotResult,
  KeyInput,
} from "../types.js";
import { normalizeKeyInput } from "../../device-actions.js";
import {
  encodeAdbInputText,
  isShellCommandUnsupported,
  quoteDeviceShellArg,
} from "./text.js";

const ADB_CLIPBOARD_UNSUPPORTED =
  "Clipboard is not available over the ADB transport on this device " +
  "(Android `cmd clipboard` is unimplemented and no Clipper receiver responded). " +
  "Use the relay transport, or paste into a focused field.";

/**
 * ADB transport — executes commands via `adb -s <serial> shell ...`
 * Used for file operations and as fallback when the relay is unavailable.
 */
export class AdbTransport implements Transport {
  readonly name = "adb" as const;
  private _connected = false;

  constructor(private serial: string) {}

  get connected(): boolean {
    return this._connected;
  }

  private exec(args: string[], timeoutMs = 30_000): string {
    try {
      return execFileSync("adb", ["-s", this.serial, ...args], {
        encoding: "utf-8",
        timeout: timeoutMs,
        // Capture stderr instead of letting execFileSync inherit it to the
        // parent terminal. Without this, a failing adb command prints its
        // error live AND we re-throw `err.stderr` below — so the message
        // surfaces twice.
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new Error(err.stderr?.trim() || err.message || "adb command failed");
    }
  }

  private execBinary(args: string[], timeoutMs = 30_000): Buffer {
    return execFileSync("adb", ["-s", this.serial, ...args], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      // Keep stdout as the returned Buffer; capture stderr so a failure does
      // not leak the raw adb error to the terminal (see exec()).
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async connect(): Promise<void> {
    this.exec(["wait-for-device"]);
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    try {
      execFileSync("adb", ["disconnect", this.serial], { encoding: "utf-8" });
    } catch {}
    this._connected = false;
  }

  async tap(opts: TapOpts): Promise<CommandResult> {
    if (opts.longPress || opts.duration) {
      const dur = opts.duration ?? 1000;
      this.exec([
        "shell",
        "input",
        "swipe",
        String(opts.x),
        String(opts.y),
        String(opts.x),
        String(opts.y),
        String(dur),
      ]);
    } else {
      this.exec(["shell", "input", "tap", String(opts.x), String(opts.y)]);
    }
    return { ok: true };
  }

  async swipe(opts: SwipeOpts): Promise<CommandResult> {
    const dur = opts.duration ?? 300;
    this.exec([
      "shell",
      "input",
      "swipe",
      String(opts.x1),
      String(opts.y1),
      String(opts.x2),
      String(opts.y2),
      String(dur),
    ]);
    return { ok: true };
  }

  async type(text: string): Promise<CommandResult> {
    this.exec(["shell", "input", "text", encodeAdbInputText(text)]);
    return { ok: true };
  }

  async key(key: KeyInput): Promise<CommandResult> {
    const normalized = normalizeKeyInput(key);
    const keyMap: Record<string, number> = {
      back: 4,
      home: 3,
      enter: 66,
      menu: 82,
    };
    this.exec([
      "shell",
      "input",
      "keyevent",
      String(typeof normalized === "number" ? normalized : (keyMap[normalized] ?? normalized)),
    ]);
    return { ok: true };
  }

  async screenshot(): Promise<ScreenshotResult> {
    const buffer = this.execBinary(["exec-out", "screencap", "-p"]);
    return {
      ok: true,
      buffer,
      base64: buffer.toString("base64"),
    };
  }

  async shell(command: string): Promise<CommandResult> {
    const output = this.exec(["shell", command]);
    return { ok: true, data: output };
  }

  async clipboard(action: "get" | "set", text?: string): Promise<CommandResult> {
    if (action === "get") {
      // `2>&1` so the unsupported-command notice (emitted on stderr, which
      // `exec` does not capture) lands in the output we inspect.
      const output = this.exec(["shell", "cmd clipboard get text 2>&1"]);
      if (isShellCommandUnsupported(output)) {
        return { ok: false, error: ADB_CLIPBOARD_UNSUPPORTED };
      }
      return { ok: true, data: normalizeAndroidClipboardText(output) };
    }
    if (text === undefined) return { ok: false, error: "Clipboard set requires text" };

    // Primary: `cmd clipboard set`. On API 31+ this is unimplemented and prints
    // "No shell command implementation." to stderr with exit 0 — not a throw —
    // so we merge stderr (`2>&1`) and inspect the output, not just catch.
    try {
      const output = this.exec([
        "shell",
        `cmd clipboard set text ${quoteDeviceShellArg(text)} 2>&1`,
      ]);
      if (!isShellCommandUnsupported(output)) return { ok: true };
    } catch {
      // fall through to the broadcast fallback
    }

    // Fallback: Clipper-style broadcast (only works when a receiver is
    // installed). A receiver that handled it returns RESULT_OK (result=-1);
    // with no receiver `am broadcast` reports result=0 and nothing was copied.
    try {
      const output = this.exec([
        "shell",
        `am broadcast -a clipper.set -e text ${quoteDeviceShellArg(text)} 2>&1`,
      ]);
      if (/result=-1/.test(output)) return { ok: true };
    } catch {
      // fall through to an honest failure
    }

    return { ok: false, error: ADB_CLIPBOARD_UNSUPPORTED };
  }

  async gps(latitude: number, longitude: number): Promise<CommandResult> {
    // GPS spoofing via ADB requires mock location provider
    return { ok: false, error: "GPS not supported via ADB transport — use relay" };
  }

  // ADB-specific file operations
  async pull(remote: string, local: string): Promise<CommandResult> {
    this.exec(["pull", remote, local]);
    return { ok: true };
  }

  async push(local: string, remote: string): Promise<CommandResult> {
    this.exec(["push", local, remote]);
    return { ok: true };
  }

  async install(apkPath: string): Promise<CommandResult> {
    this.exec(["install", "-r", apkPath], 120_000);
    return { ok: true };
  }
}

function normalizeAndroidClipboardText(output: string): string {
  const normalized = output.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const prefixed = normalized.match(/^clipboard text:\s*(.*)$/i);
  if (prefixed) return prefixed[1] ?? "";
  if (normalized.trim().toLowerCase() === "null") return "";
  return normalized;
}
