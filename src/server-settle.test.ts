import { afterEach, describe, expect, it, vi } from "vitest";
import { tryServerSettle } from "./server-settle.js";
import type { Connection } from "./state.js";
import type { TinyInputOptions } from "./tiny-helper.js";

const conn = { deviceId: "d" } as unknown as Connection;
const gesture = { type: "tap", x: 1, y: 1 } as unknown as TinyInputOptions;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tryServerSettle — sent-but-unsettled handling (H3)", () => {
  it("does not report an unacknowledged abort/timeout as settleInconclusive", async () => {
    const abort = async (): Promise<Record<string, unknown>> => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    expect(await tryServerSettle(conn, gesture, { enabled: true }, abort)).toBeNull();
  });

  it("reports a confirmed post-inject abort/timeout as success+settleInconclusive (no double-fire)", async () => {
    const abort = async (): Promise<Record<string, unknown>> => {
      const err = Object.assign(new Error("This operation was aborted"), {
        injected: true,
        name: "AbortError",
      });
      throw err;
    };
    const res = await tryServerSettle(conn, gesture, { enabled: true }, abort);
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(true); // NOT a failure — the gesture already fired
    expect(res!.settleInconclusive).toBe(true);
  });

  it("treats a direct Tiny abort as sent-but-unsettled instead of retryable", async () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw err;
    }));

    const res = await tryServerSettle(
      {
        deviceId: "d",
        tiny: {
          baseUrl: "http://127.0.0.1:6792",
          port: 6792,
          status: "ready",
        },
      } as unknown as Connection,
      gesture,
      { enabled: true }
    );

    expect(res).not.toBeNull();
    expect(res!.ok).toBe(true);
    expect(res!.settleInconclusive).toBe(true);
  });

  it("falls back (null) when the call failed before reaching the device", async () => {
    const refused = async (): Promise<Record<string, unknown>> => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    };
    expect(await tryServerSettle(conn, gesture, { enabled: true }, refused)).toBeNull();
  });

  it("surfaces a genuinely unexpected error as a failure", async () => {
    const boom = async (): Promise<Record<string, unknown>> => {
      throw new Error("kaboom unexpected");
    };
    const res = await tryServerSettle(conn, gesture, { enabled: true }, boom);
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(false);
    expect(res!.error).toContain("kaboom");
  });
});
