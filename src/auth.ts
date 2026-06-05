import { createHash, randomBytes } from "node:crypto";
import { getConfig } from "./state.js";

export const DEFAULT_API_URL = "https://api.handheld.sh";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function requireApiKey(): string {
  const envKey =
    process.env.HANDHELD_API_KEY ?? process.env.MOBILEUSE_API_KEY ?? null;
  if (envKey?.trim()) return envKey.trim();

  const config = getConfig();
  if (!config.apiKey) {
    throw new AuthError(
      "No API key configured. Set HANDHELD_API_KEY for cloud devices, or run `handheld login` to store a local key."
    );
  }
  return config.apiKey;
}

export function requireApiUrl(): string {
  const envUrl =
    process.env.HANDHELD_API_URL ?? process.env.MOBILEUSE_API_URL ?? null;
  if (envUrl?.trim()) return envUrl.trim();

  const config = getConfig();
  return config.apiUrl ?? DEFAULT_API_URL;
}

export function getAuthorizationHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireApiKey()}`,
  };
}

export interface GeneratedApiKeyCandidate {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export function generateApiKeyCandidate(): GeneratedApiKeyCandidate {
  const token = `muk_${randomBytes(32).toString("hex")}`;
  return {
    token,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    tokenPrefix: token.slice(0, 12),
  };
}

export function getResolvedDevice(cliDevice?: string): string | undefined {
  if (cliDevice) return cliDevice;
  const config = getConfig();
  return config.defaultDevice;
}
