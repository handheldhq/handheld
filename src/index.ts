// Public API for programmatic usage
export { HandheldApiClient } from "./api-client.js";
export type {
  Device,
  DeviceDetailResult,
  StartResult,
  ExecResult,
  GatewayUsageBillingState,
  GatewayWalletSpendSummary,
  GatewayWalletTransaction,
  ProfileRebootResult,
  ProfileCaptureResult,
  ProfileRestoreResult,
  ProfileSnapshot,
  RebootJobStatus,
  SavedStateJob,
} from "./api-client.js";

export {
  getConfig,
  setConfig,
  getConnection,
  getConnections,
  getRelayState,
} from "./state.js";
export type { HandheldConfig, Connection, RelayState } from "./state.js";

export { RelayClient } from "./transport/relay/client.js";
export { AdbTransport } from "./transport/adb/client.js";
export { routeCommand, parseAdbArgs } from "./transport/router.js";
export type { Transport, TapOpts, SwipeOpts, CommandResult, ScreenshotResult } from "./transport/types.js";
