import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { HandheldApiClient } from "../api-client.js";
import type { Connection } from "../state.js";
import type { AdbTransport } from "../transport/adb/client.js";
import type { CommandResult, Transport } from "../transport/types.js";
import {
  bundledTinyApkPath,
  ensureTinyToken,
  TINY_PACKAGE,
  tinyDeviceInstallCommand,
  tinyDeviceRequestCommand,
  tinyDeviceStartCommand,
  tinyDeviceUninstallCommand,
  tinySupportsRequiredAgentShape,
} from "../tiny-helper.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const TINY_REMOTE_APK = "/data/local/tmp/handheld-tiny-snapshot-helper.apk";

// Full Tiny snapshots can stall on Settings; bounded actionable refs stay fast.
// Use /snapshot so the relay path matches local: same node shape plus layoutDigest.
export const TINY_AGENT_SNAPSHOT_PATH =
  "/snapshot?interactiveOnly=1&compact=1&maxNodes=300&chunked=1&maxChars=32768";

function assertOk(result: CommandResult, label: string): void {
  if (!result.ok) {
    throw new Error(`${label}: ${result.error ?? "unknown error"}`);
  }
}

export async function runTinyShell(
  relay: Transport | null,
  adb: AdbTransport | null,
  command: string
): Promise<CommandResult> {
  if (relay) {
    try {
      const result = await relay.shell(command);
      if (result.ok || !adb) return result;
    } catch (error) {
      if (!adb) {
        return { ok: false, error: (error as Error).message };
      }
    }
  }
  if (adb) return await adb.shell(command);
  return { ok: false, error: "No relay or ADB transport available" };
}

export async function runShellString(
  relay: Transport | null,
  adb: AdbTransport | null,
  command: string,
  label: string
): Promise<string> {
  const result = await runTinyShell(relay, adb, command);
  assertOk(result, label);
  return String(result.data ?? "");
}

export async function uploadSessionFile(input: {
  api: HandheldApiClient;
  autoInstall?: boolean;
  chmod?: string;
  contentType?: string;
  customizeFilePath?: string;
  deviceId: string;
  filename?: string;
  libraryPath?: string;
  localFile: string;
  packageName?: string;
  persist?: boolean;
  sessionId?: string;
}) {
  const sessionId =
    input.sessionId || await input.api.resolveActiveSessionId(input.deviceId);
  const size = statSync(input.localFile).size;
  const filename = input.filename ?? basename(input.localFile);
  const intent = await input.api.createSessionUploadIntent(sessionId, {
    filename,
    persist: input.persist,
    size,
  });
  const bytes = readFileSync(input.localFile);
  const put = await fetch(intent.uploadUrl, {
    body: bytes,
    method: "PUT",
  });
  if (!put.ok) {
    throw new Error(`Upload failed with HTTP ${put.status}`);
  }
  return await input.api.commitSessionUpload(sessionId, {
    autoInstall: input.autoInstall,
    chmod: input.chmod,
    contentType: input.contentType,
    customizeFilePath: input.customizeFilePath,
    filename,
    key: intent.key,
    libraryPath: input.libraryPath,
    packageName: input.packageName,
  });
}

function parseTinyShellJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("Tiny returned empty shell output");
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tiny returned non-object shell output");
  }
  return parsed as Record<string, unknown>;
}

function isTinyChunkEnvelope(value: Record<string, unknown>): boolean {
  return value.chunked === true && typeof value.id === "string" && typeof value.data === "string";
}

function chunkNextOffset(value: Record<string, unknown>): number | null {
  const raw = value.nextOffset;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : null;
}

function isTransientTinyRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ADB command timed out|timed out waiting for shell|Relay request timed out|closed before .* completed/i
    .test(message);
}

export async function readTinyJsonFromDevice(input: {
  adb: AdbTransport | null;
  body?: string;
  maxTimeSec?: number;
  method?: string;
  path: string;
  relay: Transport | null;
  token: string;
}): Promise<Record<string, unknown>> {
  const attempts =
    !input.method || input.method.toUpperCase() === "GET"
      ? (/^\/(snapshot|observe|capture)\b/.test(input.path) ? 3 : 1)
      : 1;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const parsed = parseTinyShellJson(
        await runShellString(
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
      return isTinyChunkEnvelope(parsed)
        ? await readTinyChunkedJsonFromDevice({
            adb: input.adb,
            first: parsed,
            relay: input.relay,
            token: input.token,
          })
        : parsed;
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientTinyRequestError(error)) break;
      await runTinyShell(input.relay, input.adb, tinyDeviceStartCommand(input.token)).catch(
        () => undefined
      );
      await sleep(750);
    }
  }
  throw lastError;
}

async function readTinyChunkedJsonFromDevice(input: {
  adb: AdbTransport | null;
  first: Record<string, unknown>;
  relay: Transport | null;
  token: string;
}): Promise<Record<string, unknown>> {
  const id = String(input.first.id);
  let text = String(input.first.data ?? "");
  let eof = input.first.eof === true;
  let nextOffset = chunkNextOffset(input.first);
  let reads = 0;
  while (!eof && nextOffset !== null) {
    reads += 1;
    if (reads > 128) {
      throw new Error(`Tiny chunked response ${id} did not finish`);
    }
    const chunk = parseTinyShellJson(
      await runShellString(
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
    nextOffset = chunkNextOffset(chunk);
  }
  return parseTinyShellJson(text);
}

export async function waitForDeviceTiny(input: {
  adb: AdbTransport | null;
  relay: Transport | null;
  token: string;
}): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;
  while (Date.now() <= deadline) {
    try {
      const status = await readTinyJsonFromDevice({
        adb: input.adb,
        path: "/status",
        relay: input.relay,
        token: input.token,
      });
      return status;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Tiny helper did not become ready: ${message}`);
}

async function tinyPackageInstalled(
  relay: Transport | null,
  adb: AdbTransport | null
): Promise<boolean> {
  try {
    const result = await runTinyShell(relay, adb, `pm list packages ${TINY_PACKAGE}`);
    return result.ok && typeof result.data === "string" && result.data.includes(TINY_PACKAGE);
  } catch {
    return false;
  }
}

export async function ensureDeviceTiny(input: {
  adb: AdbTransport | null;
  api: () => HandheldApiClient;
  connection: Connection;
  force?: boolean;
  onProgress?: (message: string) => void;
  relay: Transport | null;
}): Promise<{ token: string }> {
  const tokenState = ensureTinyToken();
  if (input.force) {
    input.onProgress?.("Force reinstall: uninstalling existing Tiny...");
    await runTinyShell(input.relay, input.adb, tinyDeviceUninstallCommand()).catch(() => undefined);
  } else {
    try {
      const status = await readTinyJsonFromDevice({
        adb: input.adb,
        path: "/status",
        relay: input.relay,
        token: tokenState.token,
      });
      if (tinySupportsRequiredAgentShape(status)) return tokenState;
    } catch {}

    if (await tinyPackageInstalled(input.relay, input.adb)) {
      await runTinyShell(input.relay, input.adb, tinyDeviceStartCommand(tokenState.token));
      try {
        const status = await waitForDeviceTiny({
          adb: input.adb,
          relay: input.relay,
          token: tokenState.token,
        });
        if (tinySupportsRequiredAgentShape(status)) return tokenState;
      } catch {}
    }
  }

  input.onProgress?.(
    "Getting Tiny installed on the device. First snapshot can take up to 30 seconds..."
  );
  await uploadSessionFile({
    api: input.api(),
    customizeFilePath: TINY_REMOTE_APK,
    deviceId: input.connection.deviceId,
    filename: basename(bundledTinyApkPath()),
    localFile: bundledTinyApkPath(),
  });
  await runShellString(
    input.relay,
    input.adb,
    tinyDeviceInstallCommand(TINY_REMOTE_APK),
    "Tiny install failed"
  );
  input.onProgress?.("Tiny installed. Starting snapshot service...");
  await runShellString(
    input.relay,
    input.adb,
    tinyDeviceStartCommand(tokenState.token),
    "Tiny start failed"
  );
  const status = await waitForDeviceTiny({
    adb: input.adb,
    relay: input.relay,
    token: tokenState.token,
  });
  if (!tinySupportsRequiredAgentShape(status)) {
    throw new Error("Tiny helper does not support agent-shaped observations");
  }
  return tokenState;
}
