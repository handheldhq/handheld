import { describe, expect, it } from "vitest";
import { buildExternalLiveUrl } from "./connect.js";

describe("connect --headed external viewer URL", () => {
  it("points the app shell at the current session", () => {
    expect(
      buildExternalLiveUrl({
        appUrl: "http://localhost:3000",
        deviceId: "dev_1",
        sessionId: "session_1",
      }),
    ).toBe("http://localhost:3000/live/dev_1?sessionId=session_1");
  });

  it("encodes device and session ids", () => {
    expect(
      buildExternalLiveUrl({
        appUrl: "https://cloud.handheld.sh/",
        deviceId: "dev/one",
        sessionId: "session one",
      }),
    ).toBe("https://cloud.handheld.sh/live/dev%2Fone?sessionId=session+one");
  });
});
