export interface RelayRequest {
  action:
    | "clipboard"
    | "gps"
    | "key"
    | "screenshot"
    | "snapshot_xml"
    | "shell"
    | "status"
    | "swipe"
    | "tap"
    | "type";
  args?: Record<string, unknown>;
  requestId: string;
  timeoutMs?: number;
  type: "request";
}

export interface RelayResponse {
  data?: unknown;
  error?: string;
  ok: boolean;
  requestId: string;
  type: "response";
}

export interface RelayStatus {
  active: boolean;
  browserConnected?: boolean;
  browserLastSeenAt?: string | null;
  commandCount: number;
  lastRtt?: number | null;
  sdkConnected?: boolean;
}

export interface RelayMessage extends RelayResponse {}
