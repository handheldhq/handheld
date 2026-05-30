import { spawn } from "node:child_process";
import type { Command } from "commander";
import {
  DEFAULT_API_URL,
  generateApiKeyCandidate,
  requireApiUrl,
} from "../auth.js";
import { ApiError, HandheldApiClient } from "../api-client.js";
import { getConfig, setConfig } from "../state.js";
import { connectDevice } from "./connect.js";

interface DeviceCodeResponse {
  deviceCode: string;
  expiresInSeconds?: number;
  expiresIn?: number;
  interval?: number;
  ok: boolean;
  pollIntervalSeconds?: number;
  userCode?: string;
  verificationUrl: string;
}

type PollResponse =
  | { ok: boolean; status: "pending" | "expired" | "consumed" }
  | {
      apiKeyPrefix?: string;
      apiUrl: string;
      ok: boolean;
      orgId?: string;
      status: "approved";
    };

type LoginIntent = "login" | "init";
type HandoffStatus =
  | "pending"
  | "provisioning"
  | "starting"
  | "ready"
  | "error";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openUrl(url: string): boolean {
  const isWin = process.platform === "win32";
  const command = isWin
    ? "cmd"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  const args = isWin ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function resolveLoginApiUrl(raw?: string): string {
  const explicit = raw?.trim();
  return (explicit || requireApiUrl()).replace(/\/$/, "");
}

async function postJson<T>(
  apiUrl: string,
  path: string,
  body: object,
  apiKey?: string
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "content-type": "application/json",
    },
    method: "POST",
  });
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || data.ok === false) {
    const nested = data.error;
    const message =
      nested && typeof nested === "object" && "message" in nested
        ? String((nested as { message?: unknown }).message)
        : String(data.message ?? `HTTP ${response.status}`);
    throw new Error(message);
  }
  return data as T;
}

async function reportDeviceCodeHandoff(input: {
  apiKey: string;
  apiUrl: string;
  deviceCode: string;
  deviceId?: string;
  error?: string;
  status: HandoffStatus;
}): Promise<void> {
  await postJson(
    input.apiUrl,
    "/cli/device-code/handoff",
    {
      deviceCode: input.deviceCode,
      deviceId: input.deviceId,
      error: input.error,
      status: input.status,
    },
    input.apiKey
  );
}

async function configureManually(): Promise<void> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const defaultApiUrl = requireApiUrl();
  const apiKey = await rl.question("API key: ");
  const apiUrl = await rl.question(`API URL (${defaultApiUrl}): `);
  rl.close();

  if (apiKey.trim()) setConfig({ apiKey: apiKey.trim() });
  setConfig({ apiUrl: apiUrl.trim() || defaultApiUrl });
  console.log("Configured.");
}

async function loginWithDeviceCode(opts: {
  apiUrl?: string;
  intent?: LoginIntent;
  json?: boolean;
  open?: boolean;
}): Promise<{ apiKey: string; apiUrl: string; deviceCode: string }> {
  const apiUrl = resolveLoginApiUrl(opts.apiUrl);
  const candidate = generateApiKeyCandidate();
  const deviceCode = await postJson<DeviceCodeResponse>(
    apiUrl,
    "/cli/device-code",
    {
      intent: opts.intent ?? "login",
      tokenHash: candidate.tokenHash,
      tokenPrefix: candidate.tokenPrefix,
    }
  );
  const expiresInSeconds =
    deviceCode.expiresInSeconds ?? deviceCode.expiresIn ?? 10 * 60;
  const pollIntervalSeconds =
    deviceCode.pollIntervalSeconds ?? deviceCode.interval ?? 2;

  if (!opts.json) {
    console.log("Open this URL to finish signing in:");
    console.log(deviceCode.verificationUrl);
    if (deviceCode.userCode) {
      console.log(`Code: ${deviceCode.userCode}`);
    }
  }

  if (opts.open !== false) {
    openUrl(deviceCode.verificationUrl);
  }

  const deadline = Date.now() + expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(pollIntervalSeconds * 1000);
    const poll = await postJson<PollResponse>(apiUrl, "/cli/device-code/poll", {
      deviceCode: deviceCode.deviceCode,
    });

    if (poll.status === "pending") {
      if (!opts.json) process.stdout.write(".");
      continue;
    }
    if (poll.status === "approved") {
      setConfig({ apiKey: candidate.token, apiUrl: poll.apiUrl });
      if (!opts.json) {
        console.log("\nSigned in.");
        console.log(
          `API key: ${poll.apiKeyPrefix ?? candidate.tokenPrefix}...`
        );
      }
      return {
        apiKey: candidate.token,
        apiUrl: poll.apiUrl,
        deviceCode: deviceCode.deviceCode,
      };
    }
    if (poll.status === "expired") {
      throw new Error("Login code expired. Run `handheld login` again.");
    }
    throw new Error(
      "Login code was already used. Run `handheld login` again."
    );
  }

  throw new Error("Timed out waiting for browser approval.");
}

export function isTerminalDeviceFailureStatus(status: string): boolean {
  return ["archived", "deleted", "error", "failed", "needs_repair"].includes(status);
}

async function waitForDeviceReady(
  api: HandheldApiClient,
  deviceId: string,
  opts: { json?: boolean }
): Promise<void> {
  const deadline = Date.now() + 4 * 60 * 1000;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const detail = await api.getDevice(deviceId);
    const device = detail.device as
      | ({ lastError?: string | null; status?: string } & Record<
          string,
          unknown
        >)
      | null;
    const status = device?.status ?? "unknown";
    lastStatus = status;
    if ((status === "ready" || status === "active") && !device?.lastError) {
      if (!opts.json && status !== "active") process.stdout.write("\n");
      return;
    }
    if (isTerminalDeviceFailureStatus(status) || device?.lastError) {
      throw new Error(
        device?.lastError ?? `Device ${deviceId} settled in ${status}`
      );
    }
    if (!opts.json) process.stdout.write(".");
    await sleep(5000);
  }
  throw new Error(
    `Timed out waiting for ${deviceId} to become ready (${lastStatus})`
  );
}

async function startDeviceForInit(
  api: HandheldApiClient,
  deviceId: string,
  opts: { withAdb?: boolean } = {}
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const detail = await api.getDevice(deviceId).catch(() => null);
    if (
      detail?.device?.status === "active" &&
      detail.activeSession?.status === "active"
    ) {
      return;
    }

    try {
      await api.startDevice(deviceId, {
        enableAdb: opts.withAdb === true,
        enableH5: true,
      });
      return;
    } catch (err) {
      const retryable =
        err instanceof ApiError &&
        (err.code === "DEVICE_BUSY" ||
          err.code === "DEVICE_ERROR" ||
          err.status === 409 ||
          err.status >= 500 ||
          /maintenance|维护中/i.test(err.message));
      if (!retryable) {
        throw err;
      }
      if (!opts.withAdb) {
        if (attempt === 3) throw err;
        await sleep(5000);
        continue;
      }
      await api.startDevice(deviceId, { enableAdb: false, enableH5: true });
      return;
    }
  }
}

async function ensureTrialDevice(
  api: HandheldApiClient,
  opts: { displayName?: string; json?: boolean }
): Promise<string | null> {
  if (!opts.json) {
    console.log("Claiming a warm trial cloud phone...");
  }

  const requestKey = `handheld-init-${Date.now()}`;
  const result = await api.prepareInitDevice({
    clientRequestKey: requestKey,
    displayName: opts.displayName ?? "Trial phone",
  });
  const deviceId =
    typeof result.deviceId === "string"
      ? result.deviceId
      : typeof (result.device as { deviceId?: unknown } | undefined)
            ?.deviceId === "string"
        ? (result.device as { deviceId: string }).deviceId
        : null;
  if (deviceId) {
    setConfig({ defaultDevice: deviceId });
  }
  return deviceId;
}

async function prepareInitDevice(input: {
  apiKey: string;
  apiUrl: string;
  deviceCode: string;
  json?: boolean;
  withAdb?: boolean;
}): Promise<string | null> {
  await reportDeviceCodeHandoff({ ...input, status: "provisioning" });
  const api = new HandheldApiClient({
    apiKey: input.apiKey,
    apiUrl: input.apiUrl,
  });
  const deviceId = await ensureTrialDevice(api, { json: input.json });
  if (!deviceId) return null;
  await reportDeviceCodeHandoff({
    ...input,
    deviceId,
    status: "provisioning",
  });
  await waitForDeviceReady(api, deviceId, { json: input.json });
  await reportDeviceCodeHandoff({
    ...input,
    deviceId,
    status: "starting",
  });
  await startDeviceForInit(api, deviceId, { withAdb: input.withAdb });
  await reportDeviceCodeHandoff({
    ...input,
    deviceId,
    status: "ready",
  });
  return deviceId;
}

export function registerAuthCommands(program: Command): void {
  const config = program
    .command("config")
    .description("manage Handheld configuration");

  config
    .command("set <key> <value>")
    .description(
      "set a config value (api-key, api-url, default-device, output)"
    )
    .action((key: string, value: string) => {
      const keyMap: Record<string, string> = {
        "api-key": "apiKey",
        "api-url": "apiUrl",
        "default-device": "defaultDevice",
        output: "output",
      };
      const configKey = keyMap[key];
      if (!configKey) {
        console.error(`Unknown config key: ${key}`);
        console.error("Valid keys: api-key, api-url, default-device, output");
        process.exit(1);
      }
      setConfig({ [configKey]: value });
      console.log(
        `Set ${key} = ${key === "api-key" ? value.slice(0, 8) + "..." : value}`
      );
    });

  config
    .command("get [key]")
    .description("show config values")
    .action((key?: string) => {
      const cfg = getConfig();
      if (key) {
        const keyMap: Record<string, string> = {
          "api-key": "apiKey",
          "api-url": "apiUrl",
          "default-device": "defaultDevice",
          output: "output",
        };
        const val = cfg[keyMap[key] as keyof typeof cfg];
        if (val) console.log(val);
        else console.error(`Not set: ${key}`);
      } else {
        // Show all (mask API key)
        const display = { ...cfg };
        if (display.apiKey) {
          display.apiKey = display.apiKey.slice(0, 8) + "...";
        }
        console.log(JSON.stringify(display, null, 2));
      }
    });

  program
    .command("login")
    .description("sign in through the browser and store an org API key")
    .option(
      "--api-url <url>",
      `API URL (overrides HANDHELD_API_URL env and config; default ${DEFAULT_API_URL})`
    )
    .option("--manual", "paste an API key instead of using browser login")
    .option("--no-open", "print the login URL without opening a browser")
    .action(
      async (opts: { apiUrl?: string; manual?: boolean; open?: boolean }) => {
        try {
          if (opts.manual) {
            await configureManually();
            return;
          }
          await loginWithDeviceCode({
            apiUrl: opts.apiUrl,
            intent: "login",
            json: program.opts().json,
            open: opts.open,
          });
        } catch (err) {
          console.error("Login failed:", (err as Error).message);
          process.exit(1);
        }
      }
    );

  program
    .command("init")
    .alias("i")
    .description("sign in and prepare a trial cloud phone")
    .option(
      "--api-url <url>",
      `API URL (overrides HANDHELD_API_URL env and config; default ${DEFAULT_API_URL})`
    )
    .option("--no-device", "only sign in; do not create or select a device")
    .option("--no-connect", "do not connect transports after the device starts")
    .option("--no-open", "print the login URL without opening a browser")
    .option("--with-adb", "also request provider ADB during init/connect")
    .option(
      "--session-ttl <hours>",
      "relay session lifetime in hours for this device (default 1; capped server-side)",
      parseFloat
    )
    .action(
      async (opts: {
        apiUrl?: string;
        connect?: boolean;
        device?: boolean;
        open?: boolean;
        withAdb?: boolean;
        sessionTtl?: number;
      }) => {
        const json = program.opts().json;
        try {
          const login = await loginWithDeviceCode({
            apiUrl: opts.apiUrl,
            intent: opts.device === false ? "login" : "init",
            json,
            open: opts.open,
          });
          let deviceId: string | null = null;
          let connection: Awaited<ReturnType<typeof connectDevice>> | null =
            null;
          try {
            deviceId =
              opts.device === false
                ? null
                : await prepareInitDevice({
                    apiKey: login.apiKey,
                    apiUrl: login.apiUrl,
                    deviceCode: login.deviceCode,
                    json,
                    withAdb: opts.withAdb,
                  });
            if (deviceId && opts.connect !== false) {
              connection = await connectDevice({
                api: new HandheldApiClient({
                  apiKey: login.apiKey,
                  apiUrl: login.apiUrl,
                }),
                deviceId,
                json,
                ...(opts.sessionTtl && opts.sessionTtl > 0
                  ? { sessionTtlMs: Math.round(opts.sessionTtl * 60 * 60 * 1000) }
                  : {}),
                webrtcOnly: opts.withAdb !== true,
                withAdb: opts.withAdb,
              });
            }
          } catch (err) {
            await reportDeviceCodeHandoff({
              apiKey: login.apiKey,
              apiUrl: login.apiUrl,
              deviceCode: login.deviceCode,
              deviceId: deviceId ?? undefined,
              error:
                err instanceof Error
                  ? err.message
                  : "Device preparation failed",
              status: "error",
            }).catch(() => undefined);
            throw err;
          }

          if (json) {
            console.log(
              JSON.stringify(
                {
                  apiUrl: login.apiUrl,
                  connected: connection
                    ? {
                        adb: connection.adb,
                        relay: {
                          connected: connection.relay.connected,
                          viewerUrl: connection.relay.viewerUrl,
                        },
                        tiny: connection.tiny
                          ? {
                              baseUrl: connection.tiny.baseUrl,
                              port: connection.tiny.port,
                              status: connection.tiny.status,
                            }
                          : null,
                      }
                    : null,
                  defaultDevice: deviceId,
                  ok: true,
                },
                null,
                2
              )
            );
            return;
          }

          if (deviceId) {
            console.log(`Default device: ${deviceId}`);
            if (connection?.relay.viewerUrl) {
              console.log(`Live view: ${connection.relay.viewerUrl}`);
            }
            console.log("Ready: handheld tap, handheld swipe, handheld snap, and handheld shell can use this device.");
          } else {
            console.log("Next: handheld devices");
          }
        } catch (err) {
          console.error("Init failed:", (err as Error).message);
          process.exit(1);
        }
      }
    );

  program
    .command("create")
    .description("prepare a new trial cloud phone using the configured API key")
    .option(
      "--api-url <url>",
      `API URL (overrides HANDHELD_API_URL env and config; default ${DEFAULT_API_URL})`
    )
    .option("--display-name <name>", "device display name", "Trial phone")
    .option("--no-connect", "do not connect transports after the device starts")
    .option("--with-adb", "also request provider ADB during create/connect")
    .action(
      async (opts: {
        apiUrl?: string;
        connect?: boolean;
        displayName?: string;
        withAdb?: boolean;
      }) => {
        const json = program.opts().json;
        try {
          const api = new HandheldApiClient({ apiUrl: opts.apiUrl });
          if (opts.apiUrl) setConfig({ apiUrl: api.getBaseUrl() });

          const deviceId = await ensureTrialDevice(api, {
            displayName: opts.displayName,
            json,
          });
          if (!deviceId) {
            throw new Error("Gateway did not return a device id");
          }

          await waitForDeviceReady(api, deviceId, { json });
          await startDeviceForInit(api, deviceId, { withAdb: opts.withAdb });

          const connection =
            opts.connect === false
              ? null
              : await connectDevice({
                  api,
                  deviceId,
                  json,
                  webrtcOnly: opts.withAdb !== true,
                  withAdb: opts.withAdb,
                });

          if (json) {
            console.log(
              JSON.stringify(
                {
                  apiUrl: api.getBaseUrl(),
                  connected: connection
                    ? {
                        adb: connection.adb,
                        relay: {
                          connected: connection.relay.connected,
                          viewerUrl: connection.relay.viewerUrl,
                        },
                        tiny: connection.tiny
                          ? {
                              baseUrl: connection.tiny.baseUrl,
                              port: connection.tiny.port,
                              status: connection.tiny.status,
                            }
                          : null,
                      }
                    : null,
                  defaultDevice: deviceId,
                  ok: true,
                },
                null,
                2
              )
            );
            return;
          }

          console.log(`Default device: ${deviceId}`);
          if (connection?.relay.viewerUrl) {
            console.log(`Live view: ${connection.relay.viewerUrl}`);
          }
          console.log("Ready: handheld tap, handheld swipe, handheld snap, and handheld shell can use this device.");
        } catch (err) {
          console.error("Create failed:", (err as Error).message);
          process.exit(1);
        }
      }
    );
}
