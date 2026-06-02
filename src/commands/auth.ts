import { spawn } from "node:child_process";
import type { Command } from "commander";
import {
  DEFAULT_API_URL,
  generateApiKeyCandidate,
  requireApiUrl,
} from "../auth.js";
import { ApiError, HandheldApiClient } from "../api-client.js";
import {
  createProjectHarnessWorkspace,
  type ProjectHarnessWorkspace,
} from "../harness-workspace.js";
import { getConfig, setConfig } from "../state.js";
import { maskApiKey } from "../redact.js";
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

export type ConfiguredApiAuth = {
  apiKey: string;
  source: "env" | "config";
};

/**
 * An already-available API key, from env first or legacy saved config, or null.
 * Unlike requireApiKey it never throws. Lets init skip browser sign-in without
 * opening a browser. Env-sourced account keys are then persisted as the
 * user's global fallback config key.
 */
export function configuredApiAuth(): ConfiguredApiAuth | null {
  const envKey =
    process.env.HANDHELD_API_KEY ?? process.env.MOBILEUSE_API_KEY ?? null;
  if (envKey && envKey.trim()) {
    return { apiKey: envKey.trim(), source: "env" };
  }
  const saved = getConfig().apiKey;
  return saved && saved.trim() ? { apiKey: saved.trim(), source: "config" } : null;
}

export function configuredApiKey(): string | null {
  return configuredApiAuth()?.apiKey ?? null;
}

async function reportDeviceCodeHandoff(input: {
  apiKey: string;
  apiUrl: string;
  deviceCode?: string;
  deviceId?: string;
  error?: string;
  status: HandoffStatus;
}): Promise<void> {
  // The handoff exists only to redirect the browser sign-in tab to the device's
  // live view. With a pre-configured key there is no such tab — nothing to hand
  // off — so skip it entirely.
  if (!input.deviceCode) return;
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
  deviceCode?: string;
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
    .description("manage Handheld configuration (~/.handheld/config.json): api-key, api-url, default-device, output");

  config
    .command("set <key> <value>")
    .description(
      "set a config value (keys: api-key, api-url, default-device, output)"
    )
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld config set <key> <value>     # key: api-key | api-url | default-device | output

Examples:
  handheld config set api-key hk_live_...      # optional legacy convenience; env is preferred
  handheld config set default-device prof_abc  # so bare \`connect\`/\`run\` target this device
  handheld config set output json              # default every command to JSON

Caveats:
  - Values are written to ~/.handheld/config.json. The api-key is masked when printed back by \`config get\`.
  - For agents/CI, prefer HANDHELD_API_KEY so the key never has to be written to disk.`
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
        `Set ${key} = ${key === "api-key" ? maskApiKey(value) : value}`
      );
    });

  config
    .command("get [key]")
    .description("show config values (all keys, or one; api-key is masked)")
    .option("--raw", "print api-key unmasked when requesting that key explicitly")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld config get [key] [--raw]     # omit key to dump all (api-key masked)

Examples:
  handheld config get                  # show every configured value
  handheld config get default-device   # print just the default device id
  handheld config get api-key --raw    # print a stored legacy key only when needed

Caveats:
  - "Not set: <key>" means the value is absent — set HANDHELD_API_KEY for cloud auth, set the config value, or sign in with \`handheld login\`.
  - --raw only affects \`api-key\` when requested explicitly; full config dumps keep secrets masked.`
    )
    .action((key: string | undefined, options: { raw?: boolean }) => {
      const cfg = getConfig();
      if (key) {
        const keyMap: Record<string, string> = {
          "api-key": "apiKey",
          "api-url": "apiUrl",
          "default-device": "defaultDevice",
          output: "output",
        };
        const val = cfg[keyMap[key] as keyof typeof cfg];
        if (val) {
          console.log(key === "api-key" && !options.raw ? maskApiKey(String(val)) : val);
        } else {
          console.error(`Not set: ${key}`);
          console.error("Hint: for cloud auth set HANDHELD_API_KEY, or use `handheld login` / `handheld config set " + key + " <value>`.");
        }
      } else {
        // Show all (mask API key)
        const display = { ...cfg };
        if (display.apiKey) {
          display.apiKey = maskApiKey(display.apiKey);
        }
        console.log(JSON.stringify(display, null, 2));
      }
    });

  program
    .command("login")
    .description("sign in via browser device-code and store an org API key (--manual to paste a key; --no-open for headless)")
    .option(
      "--api-url <url>",
      `API URL (overrides HANDHELD_API_URL env and config; default ${DEFAULT_API_URL})`
    )
    .option("--manual", "paste an API key instead of using browser login")
    .option("--no-open", "print the login URL without opening a browser")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld login [--api-url <url>] [--manual] [--no-open]

Examples:
  handheld login                       # browser device-code flow, stores a local key in ~/.handheld/config.json
  handheld login --no-open             # headless/SSH: print the URL + code to open elsewhere
  handheld login --manual              # paste an existing API key + URL instead

Caveats:
  - Browser flow polls until you approve; it times out (~10m) or errors if the code expires — just re-run.
  - CI/agents can skip this entirely: set HANDHELD_API_KEY and the cloud commands work headlessly without writing a key to config.
  - Not needed for \`handheld connect --local\` — local adb devices require no key.`
    )
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
          console.error("Hint: re-run `handheld login` (codes expire). On a headless host use `handheld login --no-open`, or skip login by setting HANDHELD_API_KEY.");
          process.exit(1);
        }
      }
    );

  program
    .command("init")
    .alias("i")
    .description("first-run setup: sign in, claim/connect a phone, open the viewer, and scaffold an agent workspace")
    .option(
      "--api-url <url>",
      `API URL (overrides HANDHELD_API_URL env and config; default ${DEFAULT_API_URL})`
    )
    .option("--no-device", "only sign in; do not create or select a device")
    .option("--no-connect", "do not connect transports after the device starts")
    .option("--workspace <path>", "project directory to scaffold for agent phone work (default current directory)")
    .option("--workspace-template <name>", "agent workspace template to scaffold (harness)", "harness")
    .option("--no-harness-workspace", "skip project-local harness workspace scaffolding")
    .option("--no-open", "print the login URL without opening a browser")
    .option("--with-adb", "also request provider ADB during init/connect")
    .option(
      "--session-ttl <hours>",
      "relay session lifetime in hours for this device (default 1; capped server-side)",
      parseFloat
    )
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld init [--api-url <url>] [--workspace <path>] [--no-harness-workspace] [--no-device] [--no-connect] [--no-open] [--with-adb] [--session-ttl <hours>]

Examples:
  handheld init                              # browser sign-in, claim/connect a phone, scaffold this project for agents
  HANDHELD_API_KEY=hk_... handheld init      # agent/CI path: no browser; stores the global key
  handheld init --workspace ~/my-app          # scaffold a specific project directory
  handheld init --with-adb                   # also bring up the ADB transport, not just relay
  handheld init --no-device                  # sign in and scaffold workspace, but do not claim a phone

Caveats:
  - With HANDHELD_API_KEY present it skips the browser entirely and saves that account key in ~/.handheld/config.json.
  - Saved config keys remain the global fallback; workspace/project config can override later when present.
  - Without a key it opens a browser device-code flow; use --no-open on a headless host.
  - Claims a TRIAL cloud phone, sets it as default-device, connects it, and opens the live viewer when available.
  - Scaffolds a project-local harness workspace by default: .handheld/, agent-workspace/, helpers, skills, and evidence.
  - For a LOCAL adb device you don't need init at all — just \`handheld connect --local\`.`
    )
    .action(
      async (opts: {
        apiUrl?: string;
        connect?: boolean;
        device?: boolean;
        harnessWorkspace?: boolean;
        open?: boolean;
        withAdb?: boolean;
        sessionTtl?: number;
        workspace?: string;
        workspaceTemplate?: string;
      }) => {
        const json = program.opts().json;
        try {
          // If a key is already available (env or saved config), skip browser
          // sign-in and provision directly. Env auth bootstraps the global
          // account key, so persist it once in ~/.handheld/config.json.
          const existingAuth = configuredApiAuth();
          const login = existingAuth
            ? {
                apiKey: existingAuth.apiKey,
                apiUrl: resolveLoginApiUrl(opts.apiUrl),
                deviceCode: "",
              }
            : await loginWithDeviceCode({
                apiUrl: opts.apiUrl,
                intent: opts.device === false ? "login" : "init",
                json,
                open: opts.open,
              });
          if (existingAuth) {
            setConfig({ apiKey: login.apiKey, apiUrl: login.apiUrl });
            if (!json) {
              console.log(
                `Using ${existingAuth.source === "env" ? "env API key" : "configured API key"} (${login.apiKey.slice(0, 8)}…) — skipping browser sign-in.`
              );
            }
          }
          let deviceId: string | null = null;
          let connection: Awaited<ReturnType<typeof connectDevice>> | null =
            null;
          let workspace: ProjectHarnessWorkspace | null = null;
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
            if (opts.harnessWorkspace !== false) {
              const workspaceTemplate = (opts.workspaceTemplate ?? "harness").trim().toLowerCase();
              if (workspaceTemplate !== "harness") {
                throw new Error('unsupported workspace template "' + opts.workspaceTemplate + '". Supported templates: harness');
              }
              workspace = createProjectHarnessWorkspace({
                apiUrl: login.apiUrl,
                deviceId,
                rootDir: opts.workspace,
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
                  workspace: workspace
                    ? {
                        agentWorkspace: workspace.agentWorkspaceDir,
                        evidence: workspace.evidenceDir,
                        mcpConfig: workspace.mcpConfigPath,
                        root: workspace.rootDir,
                        runs: workspace.runsDir,
                      }
                    : null,
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
          if (workspace) {
            console.log(`Workspace: ${workspace.rootDir}`);
            console.log(`Agent workspace: ${workspace.agentWorkspaceDir}`);
            console.log(`MCP config: ${workspace.mcpConfigPath}`);
            console.log('Next: handheld run "Open Settings and tell me what you see" --workspace-template harness');
          }
        } catch (err) {
          console.error("Init failed:", (err as Error).message);
          console.error("Hint: check auth (prefer HANDHELD_API_KEY, or use `handheld login`) and balance (`handheld billing`); retry — trial pool hardware can be momentarily unavailable.");
          process.exit(1);
        }
      }
    );

  program
    .command("create")
    .description("claim + start a new trial cloud phone with an available API key (no browser sign-in)")
    .option(
      "--api-url <url>",
      `API URL (overrides HANDHELD_API_URL env and config; default ${DEFAULT_API_URL})`
    )
    .option("--display-name <name>", "device display name", "Trial phone")
    .option("--no-connect", "do not connect transports after the device starts")
    .option("--with-adb", "also request provider ADB during create/connect")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld create [--api-url <url>] [--display-name <name>] [--no-connect] [--with-adb]

Examples:
  handheld create                              # claim + start + connect a trial phone
  handheld create --display-name "qa-bot"      # give it a name in the dashboard
  handheld create --no-connect                 # provision only; connect later with \`handheld connect <id>\`

Caveats:
  - Needs an API key already available (prefer HANDHELD_API_KEY, or use \`handheld login\`); unlike \`init\` it never opens a browser.
  - \`init\` is the interactive sibling (it can sign you in first); \`create\` is the headless provisioner.
  - Sets the new phone as default-device and connects relay by default (--with-adb adds the ADB transport).`
    )
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
          console.error("Hint: confirm HANDHELD_API_KEY is set, or a local login key exists, and you have balance (`handheld billing`); retry if pool hardware was busy.");
          process.exit(1);
        }
      }
    );
}
