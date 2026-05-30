import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandheldApiClient } from "./api-client.js";

const calls: Array<{ body?: unknown; method: string; path: string }> = [];

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function jsonStatus(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("HandheldApiClient Gateway-native routes", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ body, method: init?.method ?? "GET", path: `${url.pathname}${url.search}` });

        if (url.pathname === "/profiles" && url.search === "?view=summary") {
          return json({
            profiles: [
              {
                id: "prof_1",
                status: "ready",
                displayName: "QA",
                activeSession: { id: "sess_1", status: "active" },
              },
            ],
          });
        }
        if (url.pathname === "/profiles/prof_1") {
          return json({
            profile: {
              id: "prof_1",
              status: "ready",
              activeSession: {
                id: "sess_1",
                status: "active",
                h5Enabled: true,
                h5: {
                  relayUrl: "/webrtc/relay/cv_1?role=cli",
                  streamDeviceId: "stream_1",
                  viewerUrl: "/live/cv_1",
                },
              },
            },
          });
        }
        if (url.pathname === "/profiles/prof_1/sessions") {
          return json({
            session: {
              id: "sess_new",
              profileId: "prof_1",
              status: "active",
            },
            adb: {
              adbCommand: "adb connect 127.0.0.1:9057",
              expireTime: "2026-04-30T00:00:00Z",
              key: "secret_key",
              sshCommand: "ssh user@host -p 1824 -L 127.0.0.1:9057:adb-proxy:14348 -N",
              tunnel: {
                localPort: 9057,
                remoteHost: "adb-proxy",
                remotePort: 14348,
                sshHost: "host",
                sshPort: 1824,
                sshUser: "user",
              },
            },
            tunnel: {
              expiresAt: "2026-04-30T00:00:00Z",
              host: "127.0.0.1",
              key: "secret_key",
              port: 9057,
            },
            h5: {
              baseUrl: "https://h5.test",
              relayUrl: "/webrtc/relay/cv_new?role=cli",
              streamDeviceId: "stream_1",
              token: "cv_new",
              viewerUrl: "/live/cv_new",
            },
          });
        }
        if (url.pathname === "/profiles/prof_pending/sessions") {
          return jsonStatus({
            job: { id: "job_pending", status: "pending" },
            profile: { id: "prof_pending" },
            reason: "pending-profile-config-apply",
          }, 202);
        }
        if (url.pathname === "/billing/balance") {
          return json({ balanceCents: 175 });
        }
        if (url.pathname === "/billing/usage-state") {
          return json({
            balanceCents: 175,
            billingCycleEndMs: 2000,
            billingCycleStartMs: 1000,
            freeMinutesRemaining: 42,
            freeMinutesUsed: 138,
            walletId: "wallet_1",
          });
        }
        if (url.pathname === "/billing/transactions") {
          return json({ transactions: [{ amountCents: 25, type: "debit" }] });
        }
        if (url.pathname === "/billing/spend-summary") {
          return json({
            debitCount: 1,
            spendCents: 25,
            windowEndMs: 2000,
            windowStartMs: 1000,
          });
        }
        if (url.pathname === "/profiles/prof_1/snapshots") {
          return json({
            snapshots: [
              {
                id: "snap_head",
                createdAt: 1000,
                sessionId: "sess_1",
                sizeBytes: 123_000_000,
                restoredAt: null,
              },
            ],
          });
        }
        if (url.pathname === "/profiles/prof_1/capture") {
          return json({
            job: {
              id: "job_capture",
              kind: "profile-capture",
              profileId: "prof_1",
              status: "pending",
            },
            profile: { id: "prof_1", status: "saving" },
          });
        }
        if (url.pathname === "/profiles/prof_1/restore") {
          return json({
            job: {
              id: "job_restore",
              kind: "profile-restore",
              profileId: "prof_1",
              status: "pending",
            },
            profile: { id: "prof_1", status: "restoring" },
            restore: { snapshotId: "snap_head" },
          });
        }
        if (url.pathname === "/profiles/prof_1/jobs/job_restore") {
          return json({
            job: {
              id: "job_restore",
              kind: "profile-restore",
              profileId: "prof_1",
              status: "running",
              updatedAt: 2000,
            },
          });
        }
        if (url.pathname === "/sessions/sess_1/relay") {
          return json({
            h5: {
              baseUrl: "https://h5.test",
              relayUrl: "/webrtc/relay/cv_1?role=cli",
              streamDeviceId: "stream_1",
              token: "cv_1",
              viewerUrl: "/live/cv_1",
            },
            relayUrl: "wss://gateway.test/webrtc/relay/cv_1?role=cli",
            sessionId: "sess_1",
          });
        }
        if (url.pathname === "/sessions/sess_1/adb/recover") {
          return json({
            adb: {
              adbCommand: "adb connect 127.0.0.1:9058",
              expireTime: "2026-04-30T00:00:00Z",
              key: "fresh_key",
              sshCommand: "ssh user@host -p 1824 -L 127.0.0.1:9058:adb-proxy:14348 -N",
              tunnel: {
                localPort: 9058,
                remoteHost: "adb-proxy",
                remotePort: 14348,
                sshHost: "host",
                sshPort: 1824,
                sshUser: "user",
              },
            },
          });
        }
        if (url.pathname === "/sessions/sess_1/exec") {
          return json({ ok: true, taskId: "task_1", taskIds: ["task_1"] });
        }
        if (url.pathname === "/sessions/sess_1/stop") {
          return json({ ok: true });
        }
        if (url.pathname === "/sessions/sess_1/uploads/intent") {
          return json({
            expiresAt: "2026-05-05T10:00:00.000Z",
            key: "uploads/org/sess_1/file.txt",
            maxUploadSizeBytes: 100,
            persisted: false,
            uploadUrl: "https://upload.test/file.txt",
          });
        }
        if (url.pathname === "/sessions/sess_1/uploads/commit") {
          return json({
            fileId: null,
            key: body?.key,
            ok: true,
            path: "/sdcard/Download/file.txt",
            persisted: false,
            taskId: "task_2",
          });
        }
        return json({ ok: true });
      }),
    );
  });

  it("maps device aliases to Gateway profile/session routes", async () => {
    const api = new HandheldApiClient({ apiKey: "muk_test", apiUrl: "https://gateway.test" });

    await expect(api.listDevices()).resolves.toMatchObject({
      devices: [{ deviceId: "prof_1", activeSessionId: "sess_1" }],
    });
    await expect(api.startDevice("prof_1", { enableH5: true })).resolves.toMatchObject({
      deviceId: "prof_1",
      sessionId: "sess_new",
      adb: {
        sshCommand: "ssh user@host -p 1824 -L 127.0.0.1:9057:adb-proxy:14348 -N",
      },
      h5: {
        relayUrl: "wss://gateway.test/webrtc/relay/cv_new?role=cli",
        viewerUrl: "https://gateway.test/live/cv_new",
      },
    });
    await expect(api.exec("prof_1", "echo ok")).resolves.toMatchObject({
      taskId: "task_1",
    });
    await expect(api.stopDevice("prof_1")).resolves.toEqual({ ok: true });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /profiles?view=summary",
      "POST /profiles/prof_1/sessions",
      "GET /profiles/prof_1?view=summary",
      "POST /sessions/sess_1/exec",
      "GET /profiles/prof_1?view=summary",
      "POST /sessions/sess_1/stop",
    ]);
    expect(calls[1]?.body).toMatchObject({ enableAdb: true, enableH5: true });
    expect(calls.map((call) => call.path).join("\n")).not.toMatch(/\/devices|\/v2\/profiles/);
  });

  it("resolves Gateway relay URLs without downgrading absolute WebSocket URLs", async () => {
    const api = new HandheldApiClient({ apiKey: "muk_test", apiUrl: "https://gateway.test" });

    await expect(api.getDevice("prof_1")).resolves.toMatchObject({
      activeSession: {
        h5Enabled: true,
        h5: {
          relayUrl: "/webrtc/relay/cv_1?role=cli",
        },
        padCode: "stream_1",
      },
    });
    await expect(api.getDeviceRelayWebSocketUrl("prof_1")).resolves.toBe(
      "wss://gateway.test/webrtc/relay/cv_1?role=cli",
    );
    await expect(api.getDeviceRelayInfo("prof_1")).resolves.toMatchObject({
      h5: {
        viewerUrl: "https://gateway.test/live/cv_1",
      },
      relayUrl: "wss://gateway.test/webrtc/relay/cv_1?role=cli",
      sessionId: "sess_1",
    });
    expect(api.resolveWebSocketUrl("wss://relay.example/ws")).toBe(
      "wss://relay.example/ws",
    );
  });

  it("flattens profile creation extras without overriding typed fields", async () => {
    const api = new HandheldApiClient({ apiKey: "muk_test", apiUrl: "https://gateway.test" });

    await expect(
      api.createProfile({
        androidVersion: "13",
        extras: { customLaunchFlag: true, templateSlug: "from-extra" },
        region: "US",
        templateSlug: "typed-template",
        type: "ephemeral",
      }),
    ).resolves.toEqual({ ok: true });

    expect(calls.at(-1)).toEqual({
      body: {
        androidVersion: "13",
        customLaunchFlag: true,
        region: "US",
        templateSlug: "typed-template",
        type: "ephemeral",
      },
      method: "POST",
      path: "/profiles",
    });
  });

  it("exposes Gateway saved-state snapshot routes", async () => {
    const api = new HandheldApiClient({ apiKey: "muk_test", apiUrl: "https://gateway.test" });

    await expect(api.listProfileSnapshots("prof_1")).resolves.toMatchObject({
      snapshots: [{ id: "snap_head", sessionId: "sess_1" }],
    });
    await expect(
      api.captureProfileSnapshot("prof_1", { idempotencyKey: "capture-1" }),
    ).resolves.toMatchObject({
      job: { id: "job_capture", kind: "profile-capture" },
    });
    await expect(
      api.restoreProfileSnapshot("prof_1", {
        equipmentId: "eq_1",
        idempotencyKey: "restore-1",
      }),
    ).resolves.toMatchObject({
      job: { id: "job_restore", kind: "profile-restore" },
      restore: { snapshotId: "snap_head" },
    });
    await expect(api.getProfileSavedStateJob("prof_1", "job_restore")).resolves.toMatchObject({
      job: { id: "job_restore", status: "running" },
    });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /profiles/prof_1/snapshots",
      "POST /profiles/prof_1/capture",
      "POST /profiles/prof_1/restore",
      "GET /profiles/prof_1/jobs/job_restore",
    ]);
    expect(calls[2]?.body).toEqual({ equipmentId: "eq_1" });
  });

  it("surfaces pending session starts without dereferencing a missing session", async () => {
    const api = new HandheldApiClient({ apiKey: "muk_test", apiUrl: "https://gateway.test" });

    await expect(api.startDevice("prof_pending")).rejects.toMatchObject({
      code: "SESSION_START_PENDING",
      status: 202,
    });
  });

  it("exposes Gateway billing read routes for API-key clients", async () => {
    const api = new HandheldApiClient({ apiKey: "muk_test", apiUrl: "https://gateway.test" });

    await expect(api.getBillingBalance()).resolves.toEqual({ balanceCents: 175 });
    await expect(api.getBillingUsageState()).resolves.toMatchObject({
      freeMinutesRemaining: 42,
      freeMinutesUsed: 138,
    });
    await expect(api.getBillingTransactions(5)).resolves.toMatchObject({
      transactions: [{ amountCents: 25 }],
    });
    await expect(
      api.getBillingSpendSummary({ windowStartMs: 1000, windowEndMs: 2000 }),
    ).resolves.toMatchObject({ spendCents: 25 });
  });

  it("recovers ADB credentials on an existing Gateway session", async () => {
    const api = new HandheldApiClient({ apiKey: "muk_test", apiUrl: "https://gateway.test" });

    await expect(api.recoverSessionAdb("sess_1")).resolves.toMatchObject({
      key: "fresh_key",
      tunnel: {
        localPort: 9058,
      },
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /sessions/sess_1/adb/recover",
    ]);
  });

  it("uses session upload routes for file transfer", async () => {
    const api = new HandheldApiClient({ apiKey: "muk_test", apiUrl: "https://gateway.test" });

    const intent = await api.createSessionUploadIntent("sess_1", {
      filename: "file.txt",
      size: 10,
    });
    const committed = await api.commitSessionUpload("sess_1", {
      key: intent.key,
      filename: "file.txt",
    });

    expect(committed).toMatchObject({
      path: "/sdcard/Download/file.txt",
      taskId: "task_2",
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /sessions/sess_1/uploads/intent",
      "POST /sessions/sess_1/uploads/commit",
    ]);
  });
});
