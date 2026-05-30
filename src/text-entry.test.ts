import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tiny-helper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tiny-helper.js")>();
  return { ...actual, tinySetText: vi.fn() };
});

import { typeViaTinySetText } from "./text-entry.js";
import { tinySetText } from "./tiny-helper.js";
import type { TinyState } from "./state.js";

const tinySetTextMock = vi.mocked(tinySetText);
const tiny: TinyState = {
  baseUrl: "http://127.0.0.1:6792",
  port: 6792,
  status: "ready",
  tokenFile: "/tmp/tiny.token",
};

beforeEach(() => tinySetTextMock.mockReset());

describe("typeViaTinySetText", () => {
  it("returns ok when setText succeeds", async () => {
    tinySetTextMock.mockResolvedValue({ ok: true });
    await expect(typeViaTinySetText({ deviceId: "emu", text: "hi", tiny })).resolves.toEqual({
      ok: true,
    });
  });

  it("surfaces a Tiny rejection (no field focused) instead of masking it", async () => {
    // Without this, the caller falls back to key injection and reports a false
    // success when there is nothing to type into. waitForFieldMs:0 skips the
    // focus-wait retry so the terminal failure surfaces immediately.
    tinySetTextMock.mockResolvedValue({ ok: false, reason: "target_not_found" });
    await expect(
      typeViaTinySetText({ deviceId: "emu", text: "hi", tiny, waitForFieldMs: 0 })
    ).resolves.toEqual({ ok: false, reason: "target_not_found" });
  });

  it("waits out a brief target_not_found until the field focuses", async () => {
    // Models a field that focuses a moment after navigation: first attempt has
    // no target, the next succeeds.
    tinySetTextMock
      .mockResolvedValueOnce({ ok: false, reason: "target_not_found" })
      .mockResolvedValue({ ok: true });
    await expect(
      typeViaTinySetText({ deviceId: "emu", text: "hi", tiny, waitForFieldMs: 1_000 })
    ).resolves.toEqual({ ok: true });
    expect(tinySetTextMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not retry a non-target failure", async () => {
    tinySetTextMock.mockResolvedValue({ ok: false });
    const r = await typeViaTinySetText({ deviceId: "emu", text: "hi", tiny });
    expect(r).toEqual({ ok: false, reason: "set_text_failed" });
    expect(tinySetTextMock.mock.calls.length).toBe(1);
  });
});
