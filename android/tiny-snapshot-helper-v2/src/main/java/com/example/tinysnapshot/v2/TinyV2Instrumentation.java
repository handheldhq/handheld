package com.example.tinysnapshot.v2;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public final class TinyV2Instrumentation extends Instrumentation {
  private static final String TAG = "TinyV2";
  private static final int PORT = 6792;
  private static final int EVENT_BUFFER_LIMIT = 128;

  private volatile boolean running = true;
  private String authToken = "";
  private UiAutomation automation;
  private final EventLog eventLog = new EventLog(EVENT_BUFFER_LIMIT);
  private ResponseStore responseStore;
  private volatile HttpServer httpServer;
  private final Object operationLock = new Object();
  // Latest filter-independent layout digest Tiny computed (from any /snapshot).
  // Cached in Tiny state so a client can ask "has the screen changed since I
  // last looked" by comparing against this, without managing digests itself.
  private volatile String lastLayoutDigest;
  private volatile String lastBundleId;
  private volatile String lastAppName;
  private volatile String lastActivity;
  private volatile String lastComponent;
  private volatile long lastSignatureSeq = -1;

  @Override
  public void onCreate(Bundle arguments) {
    super.onCreate(arguments);
    authToken = authTokenFrom(arguments);
    Log.i(TAG, "TinyV2Instrumentation created authEnabled=" + (authToken != null && !authToken.isEmpty()));
    start();
  }

  @Override
  public void onStart() {
    super.onStart();
    if (Build.VERSION.SDK_INT >= 24) {
      automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    } else {
      automation = getUiAutomation();
    }
    enableInteractiveWindowRetrieval(automation);
    automation.setOnAccessibilityEventListener(eventLog::record);
    Log.i(TAG, "TinyV2Instrumentation starting HTTP server on port " + PORT);
    serve();
  }

  private void serve() {
    try {
      HttpServer server = new HttpServer(PORT, new HttpServer.Running() {
        @Override
        public boolean get() {
          return running;
        }
      }, new HttpServer.Handler() {
        @Override
        public void handle(HttpServer.Exchange exchange) throws Exception {
          TinyV2Instrumentation.this.handle(exchange);
        }
      });
      httpServer = server;
      server.serve();
    } catch (Throwable error) {
      Log.e(TAG, "Tiny v2 HTTP server stopped with error", error);
      Bundle result = new Bundle();
      result.putString("ok", "false");
      result.putString("message", error.getMessage() == null ? error.getClass().getName() : error.getMessage());
      finish(1, result);
      return;
    }
    finish(0, new Bundle());
  }

  private void handle(HttpServer.Exchange exchange) throws Exception {
    String method = exchange.method;
    String path = normalizePath(exchange.path);
    String query = exchange.query;
    String body = exchange.body;
    if (!authorized(exchange)) {
      exchange.writeJson(403, new JSONObject()
          .put("ok", false)
          .put("error", new JSONObject()
              .put("type", "tiny_auth_failed")
              .put("message", "Tiny v2 request missing or invalid auth token")));
      return;
    }
    if (isControlPath(path)) {
      handleUnlocked(exchange, method, path, query, body);
      return;
    }
    synchronized (operationLock) {
      handleUnlocked(exchange, method, path, query, body);
    }
  }

  private void handleUnlocked(HttpServer.Exchange exchange, String method, String path, String query, String body) throws Exception {
    if ("/status".equals(path)) {
      JSONObject status = new JSONObject()
          .put("ok", true)
          .put("ready", true)
          .put("version", "2")
          .put("port", PORT)
          .put("eventSeq", eventLog.currentSeq())
          .put("capabilities", new JSONObject()
              .put("snapshot", true)
              .put("observe", true)
              .put("screenshot", true)
              .put("capture", true)
              .put("responseChunks", true)
              .put("events", true)
              .put("waitForChange", true)
              .put("waitForStable", true)
              .put("setText", true)
              .put("setTextWhitespace", true)
              .put("clipboard", true)
              .put("input", true)
              .put("inputSettle", true)
              .put("foregroundSignature", true))
          .put("auth", "token");
      if (lastLayoutDigest != null) {
        status.put("lastLayoutDigest", lastLayoutDigest);
      }
      if (lastSignatureSeq >= 0) {
        status.put("lastSignatureSeq", lastSignatureSeq);
      }
      if (httpServer != null) {
        status.put("server", httpServer.diagnosticsJson());
      }
      responseStore().cleanup();
      exchange.writeJson(200, status);
      return;
    }
    if ("/signature".equals(path)) {
      long started = System.currentTimeMillis();
      JSONObject signature = foregroundSignature(query);
      signature.put("elapsedMs", System.currentTimeMillis() - started);
      exchange.writeJson(200, signature);
      return;
    }
    if ("/shutdown".equals(path)) {
      running = false;
      exchange.writeJson(200, new JSONObject().put("ok", true).put("shutdown", true));
      return;
    }
    if ("/snapshot".equals(path)) {
      long started = System.currentTimeMillis();
      SnapshotService.Options options = SnapshotService.Options.fromQuery(query);
      SnapshotService service = snapshotService();
      JSONObject snapshot = service.buildSnapshot(options);
      service.attachForeground(snapshot);
      long seq = eventLog.currentSeq();
      snapshot.put("eventSeq", seq);
      rememberSignature(snapshot, seq);
      snapshot.put("elapsedMs", System.currentTimeMillis() - started);
      exchange.writeJson(200, responseStore().maybeChunk(snapshot, query));
      return;
    }
    if ("/observe".equals(path)) {
      long started = System.currentTimeMillis();
      SnapshotService.Options options = SnapshotService.Options.fromQuery(query);
      JSONObject snapshot = snapshotService().buildSnapshot(options);
      snapshot.put("eventSeq", eventLog.currentSeq());
      JSONObject observation = snapshotService().shapeObservation(snapshot, SnapshotService.parseQuery(query));
      observation.put("elapsedMs", System.currentTimeMillis() - started);
      exchange.writeJson(200, responseStore().maybeChunk(observation, query));
      return;
    }
    if ("/screenshot".equals(path)) {
      long started = System.currentTimeMillis();
      JSONObject screenshot = snapshotService().buildScreenshot(query);
      screenshot.put("elapsedMs", System.currentTimeMillis() - started);
      exchange.writeJson(200, responseStore().maybeChunk(screenshot, query));
      return;
    }
    if ("/capture".equals(path)) {
      long started = System.currentTimeMillis();
      SnapshotService.Options options = SnapshotService.Options.fromQuery(query);
      SnapshotService service = snapshotService();
      JSONObject capture = service.buildSnapshot(options);
      service.attachForeground(capture);
      long seq = eventLog.currentSeq();
      capture.put("eventSeq", seq);
      rememberSignature(capture, seq);
      capture.put("screenshot", snapshotService().buildScreenshot(query));
      capture.put("elapsedMs", System.currentTimeMillis() - started);
      exchange.writeJson(200, responseStore().maybeChunk(capture, query));
      return;
    }
    if ("/responseChunk".equals(path)) {
      exchange.writeJson(200, responseStore().read(query));
      return;
    }
    if ("/events".equals(path)) {
      exchange.writeJson(200, eventLog.snapshotJson(query));
      return;
    }
    if ("/waitForStable".equals(path)) {
      JSONObject stable = waitForStable(query);
      // Attach foreground to the final settled snapshot too — consumers that read the
      // post-action state from waitForStable (e.g. the handheld-harness act()/settle loop)
      // need activity/component. Once, on the returned snapshot — not per sample.
      JSONObject settled = stable.optJSONObject("snapshot");
      if (settled != null) {
        snapshotService().attachForeground(settled);
        rememberSignature(settled, stable.optLong("eventSeq", eventLog.currentSeq()));
      }
      // Chunk like /snapshot + /input: the settled snapshot can exceed the relay
      // shell's per-response ceiling, so the device-shell settle path needs
      // chunked=1 to reassemble. No-op when the body fits or chunked is absent.
      exchange.writeJson(200, responseStore().maybeChunk(stable, query));
      return;
    }
    if ("/waitForChange".equals(path)) {
      exchange.writeJson(200, eventLog.waitForChange(query));
      return;
    }
    if ("/setText".equals(path)) {
      if (!"POST".equals(method)) {
        exchange.writeJson(405, new JSONObject().put("ok", false).put("message", "/v2/setText requires POST JSON"));
        return;
      }
      try {
        exchange.writeJson(200, setTextService().setText(body));
      } catch (IllegalArgumentException error) {
        exchange.writeJson(400, new JSONObject().put("ok", false).put("message", error.getMessage()));
      }
      return;
    }
    if ("/clipboard".equals(path)) {
      exchange.writeJson(200, runClipboard(method, body));
      return;
    }
    if ("/input".equals(path)) {
      if (!"POST".equals(method)) {
        exchange.writeJson(405, new JSONObject().put("ok", false).put("message", "/v2/input requires POST JSON"));
        return;
      }
      try {
        JSONObject request = (body == null || body.trim().isEmpty()) ? new JSONObject() : new JSONObject(body);
        JSONObject inputResult = request.optBoolean("settle", false)
            ? injectAndSettle(request, body)
            : new InputService(automation).inject(body);
        // Chunk like /snapshot does: injectAndSettle returns a full settled
        // snapshot that can exceed the relay shell's per-response ceiling. With
        // chunked=1 in the query the client reassembles via /responseChunk;
        // without it this is a no-op. (Lets server-side input-with-settle work
        // over the relay device-shell channel for large post-action trees.)
        exchange.writeJson(200, responseStore().maybeChunk(inputResult, query));
      } catch (IllegalArgumentException error) {
        exchange.writeJson(400, new JSONObject().put("ok", false).put("message", error.getMessage()));
      } catch (JSONException error) {
        exchange.writeJson(400, new JSONObject().put("ok", false).put("message", "invalid JSON body: " + error.getMessage()));
      }
      return;
    }
    exchange.writeJson(404, new JSONObject().put("ok", false).put("message", "not found"));
  }

  private static String normalizePath(String path) {
    if (path != null && path.startsWith("/v2/")) {
      return path.substring(3);
    }
    return path;
  }

  private static boolean isControlPath(String path) {
    return "/status".equals(path)
        || "/events".equals(path)
        || "/responseChunk".equals(path)
        || "/shutdown".equals(path);
  }

  private boolean authorized(HttpServer.Exchange exchange) {
    if (authToken == null || authToken.trim().isEmpty()) {
      return false;
    }
    String token = exchange.header("x-mobile-harness-tiny-token");
    if (token == null || token.isEmpty()) {
      String authorization = exchange.header("authorization");
      if (authorization != null && authorization.toLowerCase(Locale.US).startsWith("bearer ")) {
        token = authorization.substring("bearer ".length()).trim();
      }
    }
    return authToken.equals(token);
  }

  private JSONObject waitForStable(String query) throws Exception {
    return stabilityService().waitForStable(SnapshotService.parseQuery(query));
  }

  private JSONObject foregroundSignature(String query) throws Exception {
    Map<String, String> params = SnapshotService.parseQuery(query);
    Long previousSeq = optionalLong(params, "previousEventSeq", "since");
    long currentSeq = eventLog.currentSeq();
    if (previousSeq != null && previousSeq == currentSeq && lastSignatureSeq == currentSeq && lastLayoutDigest != null) {
      return cachedSignature(currentSeq);
    }
    JSONObject signature = snapshotService().buildSignature();
    long seq = eventLog.currentSeq();
    signature.put("eventSeq", seq);
    signature.put("cached", false);
    rememberSignature(signature, seq);
    return signature;
  }

  private JSONObject cachedSignature(long seq) throws Exception {
    JSONObject signature = new JSONObject()
        .put("ok", true)
        .put("backend", "tiny")
        .put("cached", true)
        .put("eventSeq", seq)
        .put("layoutDigest", lastLayoutDigest);
    put(signature, "bundleId", lastBundleId);
    put(signature, "appName", lastAppName);
    put(signature, "activity", lastActivity);
    put(signature, "component", lastComponent);
    return signature;
  }

  private void rememberSignature(JSONObject snapshot, long seq) {
    lastLayoutDigest = nonBlank(snapshot.optString("layoutDigest", null));
    lastBundleId = nonBlank(snapshot.optString("bundleId", null));
    lastAppName = nonBlank(snapshot.optString("appName", null));
    lastActivity = nonBlank(snapshot.optString("activity", null));
    lastComponent = nonBlank(snapshot.optString("component", null));
    lastSignatureSeq = seq;
  }

  private static String nonBlank(String value) {
    return value == null || value.trim().isEmpty() ? null : value;
  }

  private static void put(JSONObject json, String key, Object value) throws Exception {
    if (value != null) json.put(key, value);
  }

  private static Long optionalLong(Map<String, String> params, String primary, String alias) {
    String value = params.get(primary);
    if ((value == null || value.trim().isEmpty()) && alias != null) value = params.get(alias);
    return value == null || value.trim().isEmpty() ? null : Long.parseLong(value.trim());
  }

  /**
   * `/input` with `settle:true`: capture the pre-action action-digest, inject the gesture, then
   * waitForStable gated on the digest *changing* from that baseline (requireDigestChange +
   * minNodes>=1, action digest). Returns the injection result plus `changed` (post digest != pre)
   * and the settled `snapshot` (with foreground activity). Because Tiny computes the pre- and
   * post-digests with the *same* options here, the comparison can't drift across filters — the
   * cross-filter false-"changed" a client can't fully avoid. Runs under operationLock (the caller
   * already holds it), serialized with snapshots. A no-op gesture never changes the digest →
   * `changed:false` + a timeout settle, reported honestly.
   */
  private JSONObject injectAndSettle(JSONObject request, String body) throws Exception {
    SnapshotService service = snapshotService();
    // Settle params — used for BOTH the pre-digest snapshot and waitForStable's internal samples
    // (same filter => consistent digests). Default node set; action digest masks the clock.
    Map<String, String> settleParams = new HashMap<>();
    // Gate on the filter-independent layout digest so the compare can't drift.
    settleParams.put("digest", "layout");
    settleParams.put("minNodes", "1");
    settleParams.put("requireDigestChange", "true");
    settleParams.put("timeoutMs", String.valueOf(Math.max(0, request.optLong("settleTimeoutMs", 1500))));
    settleParams.put("quietMs", String.valueOf(Math.max(0, request.optLong("quietMs", 150))));

    String preDigest = service.buildSnapshot(SnapshotService.Options.fromParams(settleParams))
        .optString("layoutDigest", null);
    if (preDigest != null && !preDigest.isEmpty()) {
      settleParams.put("previousDigest", preDigest);
    }

    JSONObject result = new InputService(automation).inject(body);
    if (!result.optBoolean("ok", false)) {
      return result; // injection rejected (bad type/args) — nothing to settle
    }

    JSONObject stable = stabilityService().waitForStable(settleParams);
    JSONObject settled = stable.optJSONObject("snapshot");
    if (settled != null) {
      service.attachForeground(settled);
      rememberSignature(settled, stable.optLong("eventSeq", eventLog.currentSeq()));
      stable.remove("snapshot"); // hoist the snapshot to the top level, leave settle metadata in `settle`
    }
    result.put("settled", true);
    result.put("changed", stable.optBoolean("digestChanged", false));
    result.put("settle", stable);
    if (settled != null) {
      result.put("snapshot", settled);
    }
    return result;
  }

  private SnapshotService snapshotService() {
    return new SnapshotService(getTargetContext(), automation);
  }

  private ResponseStore responseStore() {
    if (responseStore == null) {
      responseStore = new ResponseStore(getContext());
    }
    return responseStore;
  }

  private StabilityService stabilityService() {
    final SnapshotService snapshots = snapshotService();
    return new StabilityService(eventLog, new StabilityService.SnapshotProvider() {
      @Override
      public JSONObject buildSnapshot(Map<String, String> params) throws Exception {
        return snapshots.buildSnapshot(SnapshotService.Options.fromParams(params));
      }
    });
  }

  private SetTextService setTextService() {
    return new SetTextService(getContext(), snapshotService());
  }

  private JSONObject runClipboard(String method, String body) throws Exception {
    ClipboardService clipboard = new ClipboardService(getContext());
    if ("POST".equals(method)) {
      String text = null;
      if (body != null && !body.trim().isEmpty()) {
        text = new JSONObject(body).optString("text", null);
      }
      return clipboard.set(text);
    }
    return clipboard.get();
  }

  private static void enableInteractiveWindowRetrieval(UiAutomation automation) {
    try {
      AccessibilityServiceInfo serviceInfo = automation.getServiceInfo();
      if (serviceInfo == null) return;
      serviceInfo.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
      automation.setServiceInfo(serviceInfo);
    } catch (RuntimeException ignored) {
    }
  }

  private static String authTokenFrom(Bundle arguments) {
    if (arguments == null) return "";
    String value = arguments.getString("authToken");
    if (value == null) value = arguments.getString("tinyAuthToken");
    return value == null ? "" : value.trim();
  }
}
