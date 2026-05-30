import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  TINY_PACKAGE,
  TINY_LEGACY_PACKAGE,
  bundledTinyApkPath,
  tinyDeviceInstallCommand,
  tinyDeviceRequestCommand,
  tinyDeviceStartCommand,
  tinySetTextBody,
} from "./tiny-helper.js";

const SOURCE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../android/tiny-snapshot-helper-v2",
);
const TINY_SHA256 =
  "631aba408d12a586aa8ebffaaadfb32afe83d5bb7d04f6bc9ce9ca6120fe6a08";

function helperSource(name: string): string {
  return readFileSync(
    resolve(SOURCE_ROOT, "src/main/java/com/example/tinysnapshot/v2", name),
    "utf8",
  );
}

describe("Tiny device commands", () => {
  it("installs the helper with test APK support", () => {
    const command = tinyDeviceInstallCommand("/data/local/tmp/tiny helper.apk");

    expect(command).toContain("pm install -r -t");
    expect(command).toContain("/data/local/tmp/tiny helper.apk");
    expect(command).toContain(`pm uninstall '${TINY_PACKAGE}'`);
  });

  it("starts instrumentation with an auth token", () => {
    const command = tinyDeviceStartCommand("tok'en");

    expect(command).toContain("am instrument -w");
    expect(command).toContain("-e authToken");
    expect(command).toContain("com.example.tinysnapshot.v2/.TinyV2Instrumentation");
    expect(command).toContain(`am force-stop '${TINY_LEGACY_PACKAGE}'`);
    expect(command).toContain("'tok'\\''en'");
  });

  it("builds authenticated localhost curl requests", () => {
    expect(tinyDeviceRequestCommand("/snapshot", "token")).toBe(
      "curl -sf --max-time 5 -H 'X-Mobile-Harness-Tiny-Token: token' 'http://127.0.0.1:6792/v2/snapshot'",
    );
  });
});

describe("Tiny semantic setText (deterministic text entry, F6)", () => {
  it("defaults to a focused semantic replace when no target is given", () => {
    expect(JSON.parse(tinySetTextBody({ text: "battery" }))).toEqual({
      mode: "semantic",
      text: "battery",
      clear: "replace",
      target: "focused",
    });
  });

  it("targets a resolved node by stableId", () => {
    const body = JSON.parse(tinySetTextBody({ text: "hi", stableId: "abc-123" }));
    expect(body).toMatchObject({ mode: "semantic", stableId: "abc-123", clear: "replace" });
    // stableId target must not also send the focused fallback.
    expect(body.target).toBeUndefined();
  });

  it("relies on a setText surface the bundled APK actually implements", () => {
    const setText = helperSource("SetTextService.java");
    expect(setText).toContain("ACTION_SET_TEXT");
    expect(setText.toLowerCase()).toContain("semantic");
  });
});

describe("bundled Tiny helper provenance", () => {
  it("keeps the APK expected by the mobile-harness Tiny source import", () => {
    const hash = createHash("sha256")
      .update(readFileSync(bundledTinyApkPath()))
      .digest("hex");

    expect(hash).toBe(TINY_SHA256);
  });

  it("keeps the helper bound to loopback with token auth", () => {
    const server = helperSource("HttpServer.java");
    const instrumentation = helperSource("TinyV2Instrumentation.java");

    expect(server).toContain('InetAddress.getByName("127.0.0.1")');
    expect(server).not.toContain("server.bind(new InetSocketAddress(port))");
    expect(instrumentation).toContain("authTokenFrom");
    expect(instrumentation.toLowerCase()).toContain(
      "x-mobile-harness-tiny-token".toLowerCase(),
    );
    expect(instrumentation).toContain("tiny_auth_failed");
  });

  it("keeps password redaction and bounded response chunk support", () => {
    const snapshots = helperSource("SnapshotService.java");
    const responses = helperSource("ResponseStore.java");

    expect(snapshots).toContain("info.isPassword()");
    expect(snapshots).toContain('"[redacted]"');
    expect(responses).toContain("responseChunk");
    expect(responses).toContain("maxChars");
  });

  it("reads the request body as Content-Length bytes, decoded UTF-8", () => {
    // Reading the body as char[Content-Length] via a decoding reader stalls on
    // multibyte UTF-8 (byte count > char count) — setText with accents/CJK/emoji
    // then times out. The body must be read as bytes and decoded UTF-8.
    const server = helperSource("HttpServer.java");
    expect(server).toContain("new byte[length]");
    expect(server).toContain("StandardCharsets.UTF_8");
    expect(server).not.toContain("new char[length]");
  });

  it("folds toggle state (checked/checkable) into the stability digest", () => {
    // Without `checked` in the digest, a checkbox/switch/toggle tap produces an
    // identical digest, so waitForStable/requireDigestChange go blind to it.
    const digests = helperSource("SnapshotDigests.java");
    expect(digests).toContain('boolForDigest(node, "checked")');
    expect(digests).toContain('boolForDigest(node, "checkable")');
    expect(digests).toContain('boolForDigest(node, "focused")');
  });

  it("exposes an in-process clipboard endpoint with the read-restriction flag", () => {
    // `cmd clipboard` is unimplemented on API 31+, so copy/paste need the
    // in-process ClipboardManager. Read is restricted on API 29+ → `restricted`.
    const instrumentation = helperSource("TinyV2Instrumentation.java");
    const clip = helperSource("ClipboardService.java");
    expect(instrumentation).toContain('.put("clipboard", true)');
    expect(instrumentation).toContain('"/clipboard".equals(path)');
    expect(clip).toContain("setPrimaryClip");
    expect(clip).toContain("getPrimaryClip");
    expect(clip).toContain('"restricted"');
  });
});
