export interface TapOpts {
  x: number;
  y: number;
  longPress?: boolean;
  duration?: number;
}

export interface SwipeOpts {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration?: number;
}

export interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type KeyInput = string | number;

export interface ScreenshotResult {
  ok: boolean;
  /** base64-encoded PNG */
  base64?: string;
  /** raw bytes */
  buffer?: Buffer;
}

/**
 * Transport interface — implemented by the relay and ADB transports.
 * Commands are routed to the optimal transport by the router.
 */
export interface Transport {
  readonly name: "relay" | "adb";
  readonly connected: boolean;

  tap(opts: TapOpts): Promise<CommandResult>;
  swipe(opts: SwipeOpts): Promise<CommandResult>;
  type(text: string): Promise<CommandResult>;
  key(key: KeyInput): Promise<CommandResult>;
  screenshot(): Promise<ScreenshotResult>;
  shell(command: string): Promise<CommandResult>;
  clipboard(action: "get" | "set", text?: string): Promise<CommandResult>;
  gps(latitude: number, longitude: number): Promise<CommandResult>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export type TransportCommand =
  | "tap"
  | "swipe"
  | "type"
  | "key"
  | "screenshot"
  | "snapshot_xml"
  | "shell"
  | "clipboard"
  | "gps"
  | "pull"
  | "push"
  | "install";
