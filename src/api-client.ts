import { requireApiKey, requireApiUrl } from "./auth.js";

export interface Device {
  deviceId: string;
  status: string;
  activeSessionId?: string | null;
  displayName?: string | null;
  padCode?: string;
  profileId?: string;
  [key: string]: unknown;
}

export interface DeviceDetailResult {
  activeSession: null | {
    adbEnabled: boolean;
    deviceId: string;
    h5?: StartResult["h5"];
    h5Enabled: boolean;
    padCode?: string;
    sessionId: string;
    status: string;
  };
  device: null | {
    currentPadCode?: string | null;
    deviceId: string;
    displayName?: string;
    status: string;
  };
  ok: boolean;
  pad: null | {
    padCode: string;
  };
}

export interface StartResult {
  adb?: {
    adbCommand: string | null;
    expireTime: string | null;
    key: string | null;
    sshCommand: string | null;
    tunnel: {
      localPort: number;
      remoteHost: string;
      remotePort: number;
      sshHost: string;
      sshPort: number;
      sshUser: string;
    } | null;
  } | null;
  adbEndpoint?: string | null;
  deviceId: string;
  h5?: {
    baseUrl: string;
    bridgeUrl?: string;
    padCode?: string;
    relayUrl?: string;
    streamDeviceId?: string;
    token: string;
    viewerUrl?: string;
  } | null;
  sessionId: string;
  ok: boolean;
}

export interface ExecResult {
  ok: boolean;
  taskId?: string;
  output?: string;
}

export interface RelayInfo {
  h5?: StartResult["h5"];
  relayUrl: string;
  sessionId?: string;
}

export type ProxyStatus = "unknown" | "healthy" | "failing";
export type ProxyMode = "standard" | "smart_ip";
export type ProxySmartIpMode = "proxy" | "vpn";

export interface ProxyConfigInput {
  bypassDomainList?: string[];
  bypassIpList?: string[];
  bypassPackageList?: string[];
  groupId?: string | null;
  mode?: ProxyMode;
  proxy?: string;
  remarks?: string;
  smartIpMode?: ProxySmartIpMode;
}

export interface CreateDeviceInput {
  androidVersion?: string;
  clientRequestKey?: string;
  countryCode?: string;
  desiredAndroidVersion?: string;
  displayName?: string;
  idempotencyKey?: string;
  imageId?: string;
  padCode?: string;
  profileId?: string;
  provisioningPlan?: Record<string, unknown>;
  /**
   * Free-form extra fields forwarded to the Gateway as-is. Use this for
   * advanced provisioning flags not surfaced by the typed interface.
   */
  extras?: Record<string, unknown>;
  reset_mode?: string;
}

export interface CreateGatewayProfileInput {
  androidVersion: string;
  androidProps?: Record<string, string>;
  apps?: Array<Record<string, unknown>>;
  brand?: string;
  dedicatedEquipmentId?: string;
  gps?: Record<string, unknown>;
  hideAccessibility?: Record<string, unknown>;
  keepAlive?: Record<string, unknown>;
  language?: Record<string, unknown>;
  oauth?: boolean | Record<string, unknown>;
  oauthRestore?: boolean | Record<string, unknown>;
  playStoreInstall?: Record<string, unknown>;
  proxy?: Record<string, unknown>;
  region?: string;
  snapchat?: boolean;
  templateSlug?: string;
  timezone?: string;
  type?: "ephemeral" | "dedicated";
  /**
   * Free-form extra fields forwarded to the Gateway as-is. Use this for
   * advanced provisioning flags not surfaced by the typed interface.
   */
  extras?: Record<string, unknown>;
}

export interface GatewayProfileSummary {
  id: string;
  type?: string;
  status: string;
  displayName?: string | null;
  metadata?: Record<string, unknown> | null;
  activeSession?: {
    id: string;
    status: string;
    adbEnabled?: boolean;
    connectionMethods?: string[];
    expiresAt?: number | null;
    h5?: StartResult["h5"];
    h5Enabled?: boolean;
    padCode?: string | null;
  } | null;
  capabilities?: {
    canStart?: boolean;
    canStop?: boolean;
    hasActiveSession?: boolean;
  };
  [key: string]: unknown;
}

export interface GatewaySessionStartResponse {
  job?: {
    id?: string;
    status?: string;
  };
  pendingFields?: string[];
  reason?: string;
  session?: {
    id: string;
    profileId: string;
    status: string;
    adbEnabled?: boolean;
  };
  controlPlaneToken?: string;
  expiresInSeconds?: number;
  adb?: StartResult["adb"];
  tunnel?: {
    expiresAt: string | null;
    host: string | null;
    key: string | null;
    port: number | null;
  } | null;
  h5?: StartResult["h5"];
}

export interface SessionUploadIntent {
  expiresAt: string;
  key: string;
  maxUploadSizeBytes: number;
  persisted: boolean;
  uploadUrl: string;
}

export interface SessionUploadCommitResult {
  fileId: string | null;
  key: string;
  ok: boolean;
  path: string | null;
  persisted: boolean;
  taskId?: string | null;
  taskIds?: string[];
}

export interface ProfileSnapshot {
  createdAt: number;
  id: string;
  restoredAt?: number | null;
  sessionId?: string | null;
  sizeBytes?: number | null;
}

export interface SavedStateJob {
  endedAt?: number | null;
  id: string;
  kind: "profile-capture" | "profile-restore" | string;
  profileId?: string | null;
  startedAt?: number | null;
  status: string;
  updatedAt?: number | null;
}

export type RebootJobStatus =
  | "pending"
  | "running"
  | "cancel-pending"
  | "succeeded"
  | "failed"
  | "canceled"
  | "preempted";

export interface ProfileRebootResult {
  jobId: string;
  status: RebootJobStatus;
}

export interface GatewayWalletSpendSummary {
  debitCount: number;
  spendCents: number;
  windowEndMs: number;
  windowStartMs: number;
}

export interface GatewayUsageBillingState {
  balanceCents: number;
  billingCycleEndMs: number;
  billingCycleStartMs: number;
  freeMinutesRemaining: number;
  freeMinutesUsed: number;
  walletId?: string | null;
}

export interface GatewayWalletTransaction {
  amountCents?: number | null;
  createdAt?: number | string | null;
  createdAtMs?: number | null;
  description?: string | null;
  referenceId?: string | null;
  source?: string | null;
  type?: string | null;
  [key: string]: unknown;
}

export interface ProfileCaptureResult {
  job: SavedStateJob & { reusedRequest?: boolean };
  profile?: Record<string, unknown>;
}

export interface ProfileRestoreResult {
  job: SavedStateJob & { reusedRequest?: boolean };
  profile?: Record<string, unknown>;
  restore?: {
    snapshotId?: string | null;
  };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function apiErrorCode(data: Record<string, unknown>): string {
  const nested = data.error;
  if (nested && typeof nested === "object" && "code" in nested) {
    return String((nested as { code?: unknown }).code ?? "UNKNOWN");
  }
  return (data.code as string) ?? "UNKNOWN";
}

function apiErrorMessage(data: Record<string, unknown>, fallback: string): string {
  const nested = data.error;
  if (nested && typeof nested === "object" && "message" in nested) {
    return String((nested as { message?: unknown }).message ?? fallback);
  }
  return (data.message as string) ?? (data.error as string) ?? fallback;
}

export class HandheldApiClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(opts?: { apiKey?: string; apiUrl?: string }) {
    this.apiKey = opts?.apiKey ?? requireApiKey();
    this.baseUrl = (opts?.apiUrl ?? requireApiUrl()).replace(/\/$/, "");
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  resolveUrl(path: string): string {
    return new URL(path, `${this.baseUrl}/`).toString();
  }

  resolveWebSocketUrl(path: string): string {
    if (/^wss?:\/\//i.test(path)) return path;
    const url = new URL(path, `${this.baseUrl}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  getApiKey(): string {
    return this.apiKey;
  }

  async getDeviceRelayInfo(
    deviceId: string,
    opts?: { ttlMs?: number },
  ): Promise<RelayInfo> {
    const sessionId = await this.resolveActiveSessionId(deviceId);
    // Pin the bridge-token lifetime when the connection requested a longer TTL
    // (per-device `--session-ttl`); the gateway caps it. Absent => 1h default.
    const query = opts?.ttlMs && opts.ttlMs > 0 ? `?ttlMs=${Math.round(opts.ttlMs)}` : "";
    const result = await this.request<{
      h5?: StartResult["h5"];
      relayUrl: string;
      sessionId?: string;
    }>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/relay${query}`,
    );
    return {
      h5: result.h5
        ? {
            ...result.h5,
            relayUrl: result.h5.relayUrl
              ? this.resolveWebSocketUrl(result.h5.relayUrl)
              : undefined,
            viewerUrl: result.h5.viewerUrl
              ? this.resolveUrl(result.h5.viewerUrl)
              : undefined,
          }
        : undefined,
      relayUrl: this.resolveWebSocketUrl(result.relayUrl),
      sessionId: result.sessionId,
    };
  }

  async getDeviceRelayWebSocketUrl(deviceId: string): Promise<string> {
    return (await this.getDeviceRelayInfo(deviceId)).relayUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: object,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok || data.ok === false) {
      throw new ApiError(
        res.status,
        apiErrorCode(data),
        apiErrorMessage(data, `HTTP ${res.status}`),
      );
    }

    return data as T;
  }

  private async requestWithHeaders<T>(
    method: string,
    path: string,
    body?: object,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok || data.ok === false) {
      throw new ApiError(
        res.status,
        apiErrorCode(data),
        apiErrorMessage(data, `HTTP ${res.status}`),
      );
    }

    return data as T;
  }

  private queryPath(path: string, params?: Record<string, string | number | undefined>): string {
    if (!params) return path;
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return `${url.pathname}${url.search}`;
  }

  private profileToDevice(profile: GatewayProfileSummary): Device {
    return {
      ...profile,
      activeSessionId: profile.activeSession?.id ?? null,
      deviceId: profile.id,
      displayName: profile.displayName ?? null,
      profileId: profile.id,
      status: profile.activeSession?.status === "active" ? "active" : profile.status,
    };
  }

  private profileToDeviceDetail(profile: GatewayProfileSummary): DeviceDetailResult {
    const h5 = profile.activeSession?.h5 ?? null;
    const h5Enabled =
      profile.activeSession?.h5Enabled === true ||
      profile.activeSession?.connectionMethods?.includes("h5") === true ||
      typeof h5?.relayUrl === "string";
    return {
      activeSession: profile.activeSession
        ? {
            adbEnabled: profile.activeSession.adbEnabled ?? false,
            deviceId: profile.id,
            h5,
            h5Enabled,
            padCode: profile.activeSession.padCode ?? h5?.padCode ?? h5?.streamDeviceId,
            sessionId: profile.activeSession.id,
            status: profile.activeSession.status,
          }
        : null,
      device: {
        deviceId: profile.id,
        displayName: profile.displayName ?? undefined,
        status: profile.activeSession?.status === "active" ? "active" : profile.status,
      },
      ok: true,
      pad: null,
    };
  }

  async resolveActiveSessionId(profileId: string): Promise<string> {
    const detail = await this.getProfile(profileId);
    const profile = (detail.profile ?? detail) as GatewayProfileSummary;
    const activeSession = profile.activeSession;
    if (!activeSession?.id) {
      throw new ApiError(409, "CONFLICT", "Profile does not have an active session");
    }
    return activeSession.id;
  }

  // Profile/session lifecycle. Device-named methods remain compatibility
  // aliases for existing CLI/MCP consumers.
  async listDevices(): Promise<{ ok: boolean; devices: Device[] }> {
    const result = await this.listProfiles();
    const profiles = ((result.profiles ?? []) as GatewayProfileSummary[]);
    return { ok: true, devices: profiles.map((profile) => this.profileToDevice(profile)) };
  }

  async createDevice(
    input: CreateDeviceInput,
    opts?: { idempotencyKey?: string },
  ): Promise<Record<string, unknown>> {
    return this.createProfile(input as CreateGatewayProfileInput, {
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  async prepareInitDevice(input: {
    clientRequestKey?: string;
    displayName?: string;
  }): Promise<Record<string, unknown>> {
    return this.request("POST", "/cli/init-device", input);
  }

  async getDevice(deviceId: string): Promise<DeviceDetailResult> {
    const result = await this.getProfile(deviceId);
    const profile = (result.profile ?? result) as GatewayProfileSummary;
    return this.profileToDeviceDetail(profile);
  }

  async startDevice(
    deviceId: string,
    opts?: { enableAdb?: boolean; enableH5?: boolean },
  ): Promise<StartResult> {
    const result = await this.request<GatewaySessionStartResponse>(
      "POST",
      `/profiles/${encodeURIComponent(deviceId)}/sessions`,
      {
        enableAdb: opts?.enableAdb ?? true,
        enableH5: opts?.enableH5 ?? true,
      },
    );
    if (!result.session?.id) {
      const jobId = result.job?.id;
      throw new ApiError(
        202,
        "SESSION_START_PENDING",
        jobId
          ? `Session start is pending on job ${jobId}`
          : "Session start is pending",
      );
    }
    return {
      adb: result.adb ?? null,
      adbEndpoint: result.tunnel?.host && result.tunnel.port
        ? `${result.tunnel.host}:${result.tunnel.port}`
        : null,
      deviceId,
      h5: result.h5
        ? {
            ...result.h5,
            relayUrl: result.h5.relayUrl
              ? this.resolveWebSocketUrl(result.h5.relayUrl)
              : undefined,
            viewerUrl: result.h5.viewerUrl
              ? this.resolveUrl(result.h5.viewerUrl)
              : undefined,
          }
        : null,
      ok: true,
      sessionId: result.session.id,
    };
  }

  async stopDevice(deviceId: string): Promise<{ ok: boolean }> {
    const sessionId = await this.resolveActiveSessionId(deviceId);
    return this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/stop`);
  }

  async recoverSessionAdb(sessionId: string): Promise<StartResult["adb"]> {
    const result = await this.request<{ adb?: StartResult["adb"] }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/adb/recover`,
    );
    return result.adb ?? null;
  }

  // Device control aliases over active Gateway sessions.
  async exec(
    deviceId: string,
    command: string,
  ): Promise<ExecResult> {
    const sessionId = await this.resolveActiveSessionId(deviceId);
    return this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/exec`, { command });
  }

  async createSessionUploadIntent(
    sessionId: string,
    input: { filename: string; persist?: boolean; size: number },
  ): Promise<SessionUploadIntent> {
    return this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/uploads/intent`, input);
  }

  async commitSessionUpload(
    sessionId: string,
    input: {
      autoInstall?: boolean;
      chmod?: string;
      contentType?: string;
      customizeFilePath?: string;
      filename?: string;
      key: string;
      libraryPath?: string;
      md5?: string;
      packageName?: string;
    },
  ): Promise<SessionUploadCommitResult> {
    return this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/uploads/commit`, input);
  }

  async uploadUrl(
    deviceId: string,
    opts: {
      url: string;
      fileName: string;
      remotePath?: string;
      autoInstall?: boolean;
    },
  ): Promise<{ ok: boolean; taskId?: string }> {
    const packageName = opts.fileName.endsWith(".apk")
      ? opts.fileName.replace(/\.apk$/i, "")
      : opts.fileName;
    const result = await this.request<Record<string, unknown>>(
      "POST",
      `/profiles/${encodeURIComponent(deviceId)}/apply-config`,
      {
        apply: ["app-installs"],
        applyMode: "now-if-active",
        patch: {
          appInstallRequests: [
            {
              apkUrl: opts.url,
              packageName,
            },
          ],
        },
      },
    );
    return {
      ok: true,
      taskId: typeof result.job === "object" && result.job
        ? String((result.job as { id?: unknown }).id ?? "")
        : undefined,
    };
  }

  async setProxy(
    deviceId: string,
    proxy: string | null,
  ): Promise<{ ok: boolean }> {
    await this.request("POST", `/profiles/${encodeURIComponent(deviceId)}/apply-config`, {
      apply: ["proxy"],
      applyMode: "now-if-active",
      patch: { proxyId: proxy },
    });
    return { ok: true };
  }

  async setGps(
    deviceId: string,
    latitude: number,
    longitude: number,
  ): Promise<{ ok: boolean }> {
    await this.request("POST", `/profiles/${encodeURIComponent(deviceId)}/apply-config`, {
      apply: ["gps"],
      applyMode: "now-if-active",
      patch: { gps: { latitude, longitude } },
    });
    return { ok: true };
  }

  async listProfiles(): Promise<Record<string, unknown>> {
    return this.request("GET", "/profiles?view=summary");
  }

  async getProfile(profileId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/profiles/${encodeURIComponent(profileId)}?view=summary`);
  }

  async listProfileSnapshots(profileId: string): Promise<{ snapshots: ProfileSnapshot[] }> {
    return this.request("GET", `/profiles/${encodeURIComponent(profileId)}/snapshots`);
  }

  async rebootProfile(
    profileId: string,
    opts?: { idempotencyKey?: string },
  ): Promise<ProfileRebootResult> {
    return this.requestWithHeaders(
      "POST",
      `/profiles/${encodeURIComponent(profileId)}/reboot`,
      undefined,
      {
        ...(opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
    );
  }

  async rebootDevice(
    deviceId: string,
    opts?: { idempotencyKey?: string },
  ): Promise<ProfileRebootResult> {
    return this.rebootProfile(deviceId, opts);
  }

  async getBillingBalance(): Promise<{ balanceCents: number }> {
    return this.request("GET", "/billing/balance");
  }

  async getBillingUsageState(): Promise<GatewayUsageBillingState> {
    return this.request("GET", "/billing/usage-state");
  }

  async getBillingTransactions(limit?: number): Promise<{ transactions: GatewayWalletTransaction[] }> {
    return this.request(
      "GET",
      this.queryPath("/billing/transactions", { limit }),
    );
  }

  async getBillingSpendSummary(args?: {
    windowEndMs?: number;
    windowStartMs?: number;
  }): Promise<GatewayWalletSpendSummary> {
    return this.request(
      "GET",
      this.queryPath("/billing/spend-summary", args),
    );
  }

  async captureProfileSnapshot(
    profileId: string,
    opts?: { idempotencyKey?: string },
  ): Promise<ProfileCaptureResult> {
    return this.requestWithHeaders(
      "POST",
      `/profiles/${encodeURIComponent(profileId)}/capture`,
      undefined,
      {
        ...(opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
    );
  }

  async restoreProfileSnapshot(
    profileId: string,
    opts?: { equipmentId?: string; idempotencyKey?: string },
  ): Promise<ProfileRestoreResult> {
    return this.requestWithHeaders(
      "POST",
      `/profiles/${encodeURIComponent(profileId)}/restore`,
      opts?.equipmentId ? { equipmentId: opts.equipmentId } : undefined,
      {
        ...(opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
    );
  }

  async getProfileSavedStateJob(
    profileId: string,
    jobId: string,
  ): Promise<{ job: SavedStateJob }> {
    return this.request(
      "GET",
      `/profiles/${encodeURIComponent(profileId)}/jobs/${encodeURIComponent(jobId)}`,
    );
  }

  async createProfile(
    input: CreateGatewayProfileInput,
    opts?: { idempotencyKey?: string },
  ): Promise<Record<string, unknown>> {
    // Flatten extras into the top-level body so callers can forward
    // advanced provisioning flags without making them part of the public
    // typed surface. Explicit typed fields win over duplicate extras.
    const { extras, ...rest } = input;
    const body = { ...(extras ?? {}), ...rest } as Record<string, unknown>;
    return this.requestWithHeaders("POST", "/profiles", body, {
      ...(opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
    });
  }

  // Proxy management
  async listProxies(opts?: {
    cursor?: string;
    groupId?: string;
    limit?: number;
    status?: ProxyStatus;
  }): Promise<Record<string, unknown>> {
    return this.request("GET", this.queryPath("/proxies", opts));
  }

  async getProxy(proxyId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/proxies/${encodeURIComponent(proxyId)}`);
  }

  async createProxy(input: ProxyConfigInput & { proxy: string }): Promise<Record<string, unknown>> {
    return this.request("POST", "/proxies", input);
  }

  async updateProxy(proxyId: string, input: ProxyConfigInput): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/proxies/${encodeURIComponent(proxyId)}`, input);
  }

  async checkProxy(
    proxyId: string,
    input?: {
      detection?: Record<string, unknown>;
      proxyWorking?: boolean;
      publicIp?: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/proxies/${encodeURIComponent(proxyId)}/check`, input ?? {});
  }

  async deleteProxy(proxyId: string): Promise<Record<string, unknown>> {
    return this.request("DELETE", `/proxies/${encodeURIComponent(proxyId)}`);
  }

  async listProxyLinks(proxyId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/proxies/${encodeURIComponent(proxyId)}/links`);
  }

  async listProxyGroups(): Promise<Record<string, unknown>> {
    return this.request("GET", "/proxies/groups");
  }

  async createProxyGroup(input: {
    color?: string;
    name: string;
  }): Promise<Record<string, unknown>> {
    return this.request("POST", "/proxies/groups", input);
  }

  async updateProxyGroup(
    groupId: string,
    input: { color?: string; name?: string },
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/proxies/groups/${encodeURIComponent(groupId)}`, input);
  }

  async deleteProxyGroup(groupId: string): Promise<Record<string, unknown>> {
    return this.request("DELETE", `/proxies/groups/${encodeURIComponent(groupId)}`);
  }

  async deleteProfile(profileId: string): Promise<Record<string, unknown>> {
    return this.request("DELETE", `/profiles/${encodeURIComponent(profileId)}`);
  }
}
