import { describe, expect, it } from "vitest";
import { configForDisplay } from "./status.js";

describe("doctor config display", () => {
  it("masks API keys in diagnostic config output", () => {
    expect(
      configForDisplay({
        apiKey: "muk_secret_value",
        apiUrl: "https://api.test",
      })
    ).toEqual({
      apiKey: "muk_secr...",
      apiUrl: "https://api.test",
    });
  });
});
