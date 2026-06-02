import { writeSync } from "node:fs";
import { getAuthorizationHeaders } from "../auth.js";
import { getActiveConnection, getConnections, getRelayState } from "../state.js";
import { requestRelayDaemon } from "../transport/relay/daemon.js";
import {
  RelayClient,
  relaySwipeShellCommand,
  relayTapShellCommand,
} from "../transport/relay/client.js";
import { parseAdbArgs } from "../transport/router.js";

function writeAndExit(chunk: string | Uint8Array, ok: boolean): never {
  const buffer =
    typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
  writeSync(process.stdout.fd, buffer);
  process.exit(ok ? 0 : 1);
}

export async function runRouteCommand(input: {
  adbArgs: string[];
  check?: boolean;
  serial?: string;
}): Promise<never | void> {
  const serial = input.serial ?? "";
  const adbArgs = input.adbArgs ?? [];

  const conn = serial
    ? getConnections().find((connection) => connection.adb?.serial === serial)
    : getActiveConnection();
  const relayState = conn ? getRelayState(conn) : null;

  if (!(relayState?.connected && relayState.relayUrl)) {
    process.exit(1);
  }

  const parsed = parseAdbArgs(adbArgs);
  if (!parsed) {
    process.exit(1);
  }

  if (input.check) {
    process.exit(0);
  }

  if (relayState.socketPath) {
    try {
      const daemonResponse =
        parsed.command === "tap"
          ? await requestRelayDaemon(relayState.socketPath, {
              action: "shell",
              args: { command: relayTapShellCommand(parsed.args as any) },
            })
          : parsed.command === "swipe"
            ? await requestRelayDaemon(relayState.socketPath, {
                action: "shell",
                args: { command: relaySwipeShellCommand(parsed.args as any) },
              })
            : await requestRelayDaemon(relayState.socketPath, {
                action: parsed.command,
                args: parsed.args as Record<string, unknown>,
              });

      switch (parsed.command) {
        case "snapshot_xml":
          if (daemonResponse.ok && typeof daemonResponse.data === "string") {
            writeAndExit(daemonResponse.data, true);
          }
          process.exit(daemonResponse.ok ? 0 : 1);
          break;
        case "screenshot":
          if (daemonResponse.ok && typeof daemonResponse.data === "string") {
            writeAndExit(Buffer.from(daemonResponse.data, "base64"), true);
          }
          process.exit(daemonResponse.ok ? 0 : 1);
          break;
        case "shell":
          if (daemonResponse.ok && typeof daemonResponse.data === "string") {
            writeAndExit(daemonResponse.data, true);
          }
          process.exit(daemonResponse.ok ? 0 : 1);
          break;
        default:
          if (!daemonResponse.ok) {
            process.exit(1);
          }
          process.exit(0);
      }
    } catch {
      // Fall through to direct relay request if the local daemon is stale.
    }
  }

  const relay = new RelayClient(
    relayState.relayUrl,
    getAuthorizationHeaders()
  );

  try {
    let result;
    switch (parsed.command) {
      case "tap":
        result = await relay.tap(parsed.args as any);
        break;
      case "swipe":
        result = await relay.swipe(parsed.args as any);
        break;
      case "type":
        result = await relay.type(parsed.args.text as string);
        break;
      case "key":
        result = await relay.key((parsed.args.key ?? parsed.args.keyCode) as any);
        break;
      case "shell":
        result = await relay.shell(parsed.args.command as string);
        break;
      case "snapshot_xml":
        result = await relay.snapshotXml();
        if (result.ok && typeof result.data === "string") {
          writeAndExit(result.data, true);
        }
        process.exit(1);
        break;
      case "screenshot": {
        const screenshot = await relay.screenshot();
        if (screenshot.ok && screenshot.buffer) {
          writeAndExit(screenshot.buffer, true);
        }
        process.exit(screenshot.ok ? 0 : 1);
        break;
      }
      default:
        process.exit(1);
    }

    if (result && !result.ok) {
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exit(1);
  } finally {
    await relay.disconnect();
  }
}
