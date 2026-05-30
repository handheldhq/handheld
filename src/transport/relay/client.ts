import WebSocket from "ws";
import type {
  Transport,
  TapOpts,
  SwipeOpts,
  CommandResult,
  ScreenshotResult,
  KeyInput,
} from "../types.js";
import { normalizeKeyInput } from "../../device-actions.js";
import type {
  RelayMessage,
  RelayRequest,
  RelayResponse,
  RelayStatus,
} from "./protocol.js";

function intArg(value: number): number {
  return Math.round(Number.isFinite(value) ? value : 0);
}

export function relayTapShellCommand(opts: TapOpts): string {
  if (opts.longPress || opts.duration) {
    const duration = intArg(opts.duration ?? 1000);
    return [
      "input",
      "swipe",
      String(intArg(opts.x)),
      String(intArg(opts.y)),
      String(intArg(opts.x)),
      String(intArg(opts.y)),
      String(duration),
    ].join(" ");
  }
  return ["input", "tap", String(intArg(opts.x)), String(intArg(opts.y))].join(" ");
}

export function relaySwipeShellCommand(opts: SwipeOpts): string {
  return [
    "input",
    "swipe",
    String(intArg(opts.x1)),
    String(intArg(opts.y1)),
    String(intArg(opts.x2)),
    String(intArg(opts.y2)),
    String(intArg(opts.duration ?? 300)),
  ].join(" ");
}

export class RelayClient implements Transport {
  readonly name = "relay" as const;
  private _connected = false;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (response: RelayResponse) => void;
    }
  >();

  constructor(
    private relayUrl: string,
    private headers?: Record<string, string>
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  private async ensureConnected(): Promise<void> {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return this.connectPromise ?? Promise.resolve();
    }

    this.socket = new WebSocket(this.relayUrl, {
      headers: this.headers,
    });

    this.connectPromise = new Promise((resolve, reject) => {
      const socket = this.socket as WebSocket;

      const cleanup = () => {
        socket.off("open", handleOpen);
        socket.off("error", handleError);
      };

      const handleOpen = () => {
        cleanup();
        this._connected = true;
        resolve();
      };

      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };

      socket.on("open", handleOpen);
      socket.on("error", handleError);
      socket.on("message", (message: WebSocket.RawData) => {
        this.handleMessage(message.toString());
      });
      socket.on("close", () => {
        this._connected = false;
        this.socket = null;
        this.connectPromise = null;

        for (const [requestId, pending] of this.pending.entries()) {
          pending.reject(
            new Error(`Relay socket closed before ${requestId} completed`)
          );
          this.pending.delete(requestId);
        }
      });
    });

    return this.connectPromise;
  }

  private handleMessage(rawMessage: string) {
    let message: RelayMessage;
    try {
      message = JSON.parse(rawMessage) as RelayMessage;
    } catch {
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(message.requestId);
    pending.resolve(message);
  }

  private async request(
    action: RelayRequest["action"],
    args?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<RelayResponse> {
    await this.ensureConnected();

    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Relay request timed out: ${action}`));
      }, 30_000);

      this.pending.set(requestId, {
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
      });

      this.socket?.send(
        JSON.stringify({
          action,
          args,
          requestId,
          timeoutMs,
          type: "request",
        } satisfies RelayRequest)
      );
    });
  }

  async connect(): Promise<void> {
    await this.ensureConnected();
    const status = await this.getStatus();
    if (!status.active) {
      throw new Error("Relay session is not active");
    }
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    this._connected = false;

    for (const [requestId, pending] of this.pending.entries()) {
      pending.reject(new Error(`Relay disconnected before ${requestId} completed`));
      this.pending.delete(requestId);
    }

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
  }

  async getStatus(): Promise<RelayStatus> {
    const response = await this.request("status");
    if (!response.ok || !response.data || typeof response.data !== "object") {
      throw new Error(response.error ?? "Relay status unavailable");
    }
    return response.data as RelayStatus;
  }

  async tap(opts: TapOpts): Promise<CommandResult> {
    return await this.shell(relayTapShellCommand(opts));
  }

  async swipe(opts: SwipeOpts): Promise<CommandResult> {
    return await this.shell(relaySwipeShellCommand(opts));
  }

  async type(text: string): Promise<CommandResult> {
    const response = await this.request("type", { text });
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async key(key: KeyInput): Promise<CommandResult> {
    const response = await this.request("key", { key: normalizeKeyInput(key) });
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async screenshot(): Promise<ScreenshotResult> {
    const response = await this.request("screenshot");
    if (!response.ok || typeof response.data !== "string") {
      return { ok: false };
    }
    return {
      ok: true,
      base64: response.data,
      buffer: Buffer.from(response.data, "base64"),
    };
  }

  async shell(command: string): Promise<CommandResult> {
    const response = await this.request("shell", { command });
    if (
      response.ok &&
      response.data &&
      typeof response.data === "object" &&
      "output" in response.data
    ) {
      return {
        ok: true,
        data: (response.data as { output?: unknown }).output,
      };
    }
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async snapshotXml(timeoutMs = 30_000): Promise<CommandResult> {
    const response = await this.request("snapshot_xml", undefined, timeoutMs);
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async clipboard(action: "get" | "set", text?: string): Promise<CommandResult> {
    const response = await this.request("clipboard", { action, text });
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async gps(latitude: number, longitude: number): Promise<CommandResult> {
    const response = await this.request("gps", { latitude, longitude });
    return { ok: response.ok, data: response.data, error: response.error };
  }
}
