import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isPosix = process.platform !== "win32";
const mode = (path: string): number => statSync(path).mode & 0o777;

describe("config permission repair", () => {
  let home: string;
  let muHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "handheld-state-test-"));
    process.env.HOME = home;
    muHome = join(home, ".handheld");
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(!isPosix)(
    "repairs a pre-existing world-readable config on read",
    async () => {
      mkdirSync(muHome, { recursive: true, mode: 0o755 });
      chmodSync(muHome, 0o755);
      const configPath = join(muHome, "config.json");
      writeFileSync(configPath, JSON.stringify({ apiUrl: "https://x" }));
      chmodSync(configPath, 0o644);

      const state = await import("./state.js");
      const config = state.getConfig();

      expect(config.apiUrl).toBe("https://x");
      expect(mode(configPath)).toBe(0o600);
      expect(mode(muHome)).toBe(0o700);
    }
  );

  it.skipIf(!isPosix)(
    "repairs existing connections and key files plus dirs on write",
    async () => {
      mkdirSync(join(muHome, "keys"), { recursive: true, mode: 0o755 });
      chmodSync(muHome, 0o755);
      chmodSync(join(muHome, "keys"), 0o755);
      const connectionsPath = join(muHome, "connections.json");
      writeFileSync(connectionsPath, JSON.stringify([]));
      chmodSync(connectionsPath, 0o644);
      const keyPath = join(muHome, "keys", "dev_old.key");
      writeFileSync(keyPath, "private\n");
      chmodSync(keyPath, 0o644);

      const state = await import("./state.js");
      // Any write path triggers ensureMuHome -> repairExistingPermissions.
      state.setConfig({ apiUrl: "https://y" });

      expect(mode(muHome)).toBe(0o700);
      expect(mode(join(muHome, "keys"))).toBe(0o700);
      expect(mode(connectionsPath)).toBe(0o600);
      expect(mode(keyPath)).toBe(0o600);
      expect(mode(join(muHome, "config.json"))).toBe(0o600);
    }
  );

  it("falls back to the first connection when defaultDevice is stale", async () => {
    const state = await import("./state.js");
    state.setConfig({ defaultDevice: "missing-device" });
    state.saveConnection({
      adb: { serial: "", sshPid: 0, tunnelPort: 0 },
      connectedAt: new Date(0).toISOString(),
      deviceId: "active-device",
      padCode: "pad",
      relay: { connected: true, relayUrl: "wss://relay" },
      sessionId: "session",
    });

    expect(state.getActiveConnection()?.deviceId).toBe("active-device");
  });
});
