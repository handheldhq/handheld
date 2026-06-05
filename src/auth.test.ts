import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_API_URL,
  generateApiKeyCandidate,
  requireApiKey,
  requireApiUrl,
} from "./auth.js";

describe("published API defaults", () => {
  it("uses the public handheld API domain by default", () => {
    expect(DEFAULT_API_URL).toBe("https://api.handheld.sh");
    expect(DEFAULT_API_URL).not.toContain("workers.dev");
  });
});

describe("generateApiKeyCandidate", () => {
  afterEach(() => {
    delete process.env.HANDHELD_API_KEY;
    delete process.env.MOBILE_USE_API_KEY;
    delete process.env.HANDHELD_API_URL;
    delete process.env.MOBILE_USE_API_URL;
  });

  it("generates Gateway muk_ tokens and only exposes the hash for approval", () => {
    const key = generateApiKeyCandidate();
    expect(key.token).toMatch(/^muk_[0-9a-f]{64}$/);
    expect(key.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.tokenPrefix).toBe(key.token.slice(0, 12));
  });

  it("accepts MCP-provided API keys from the environment", () => {
    process.env.HANDHELD_API_KEY = "muk_env";
    expect(requireApiKey()).toBe("muk_env");
  });

  it("lets environment API URLs override saved config", () => {
    process.env.HANDHELD_API_URL = "https://gateway.local.test ";
    expect(requireApiUrl()).toBe("https://gateway.local.test");
  });
});
