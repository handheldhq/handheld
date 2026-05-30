package com.example.tinysnapshot.v2;

import org.json.JSONObject;

import java.util.Locale;
import java.util.Map;

final class StabilityService {
  interface SnapshotProvider {
    JSONObject buildSnapshot(Map<String, String> params) throws Exception;
  }

  private final EventLog eventLog;
  private final SnapshotProvider snapshotProvider;

  StabilityService(EventLog eventLog, SnapshotProvider snapshotProvider) {
    this.eventLog = eventLog;
    this.snapshotProvider = snapshotProvider;
  }

  JSONObject waitForStable(Map<String, String> params) throws Exception {
    EventLog.Filter filter = EventLog.Filter.fromParams(params);
    long timeoutMs = Math.max(0, longValue(params, "timeoutMs", "timeout", 1500));
    long quietMs = Math.max(0, longValue(params, "quietMs", "quiet", 150));
    long sampleIntervalMs = Math.max(10, longValue(params, "sampleIntervalMs", "intervalMs", 50));
    int requiredSamples = (int) Math.max(1, longValue(params, "samples", null, 2));
    long minEvents = Math.max(0, longValue(params, "minEvents", null, boolValue(params, "requireEvent", null) ? 1 : 0));
    long minNodes = Math.max(0, longValue(params, "minNodes", null, 1));
    String previousDigest = first(params, "previousDigest", "preDigest");
    boolean requireDigestChange = boolValue(params, "requireDigestChange", null);
    String digestKind = first(params, "digest", null);
    boolean useTreeDigest = "tree".equalsIgnoreCase(digestKind) || "treeDigest".equalsIgnoreCase(digestKind);
    boolean useLayoutDigest = "layout".equalsIgnoreCase(digestKind) || "layoutDigest".equalsIgnoreCase(digestKind);
    // The field to settle/compare on. layoutDigest is filter-independent (safe
    // across snapshots taken with different filters); action/tree are not.
    String digestField = useLayoutDigest ? "layoutDigest" : useTreeDigest ? "treeDigest" : "actionDigest";
    long since = longValue(params, "since", null, eventLog.currentSeq());
    long started = System.currentTimeMillis();
    long deadline = started + timeoutMs;
    long lastSeq = eventLog.currentSeq();
    long lastEventAt = lastSeq > since ? started : 0;
    long eventCount = Math.max(0, lastSeq - since);
    long matchedEventCount = eventLog.countsSince(since, filter).matchedCount;
    String lastDigest = null;
    int sameDigestCount = 0;
    int capturedSamples = 0;
    JSONObject latestSnapshot = null;

    while (System.currentTimeMillis() <= deadline) {
      eventLog.waitForEventOrSample(lastSeq, Math.min(sampleIntervalMs, Math.max(1, deadline - System.currentTimeMillis())));

      latestSnapshot = snapshotProvider.buildSnapshot(params);
      long snapshotSeq = eventLog.currentSeq();
      latestSnapshot.put("eventSeq", snapshotSeq);
      int nodeCount = latestSnapshot.optJSONArray("nodes") == null ? 0 : latestSnapshot.optJSONArray("nodes").length();
      String digest = latestSnapshot.optString(digestField, "");
      capturedSamples += 1;
      if (digest.equals(lastDigest)) {
        sameDigestCount += 1;
      } else {
        lastDigest = digest;
        sameDigestCount = 1;
      }
      if (snapshotSeq > lastSeq) {
        eventCount += snapshotSeq - lastSeq;
        lastSeq = snapshotSeq;
      }
      EventLog.Counts counts = eventLog.countsSince(since, filter);
      eventCount = counts.rawCount;
      matchedEventCount = counts.matchedCount;
      if (counts.lastMatchedTimeMs > 0) {
        lastEventAt = counts.lastMatchedTimeMs;
      }
      boolean digestChanged = previousDigest == null || !previousDigest.equals(digest);
      boolean digestRequirementMet = !requireDigestChange || digestChanged;
      boolean nodeRequirementMet = nodeCount >= minNodes;

      long now = System.currentTimeMillis();
      if (matchedEventCount >= minEvents && nodeRequirementMet && digestRequirementMet && sameDigestCount >= requiredSamples) {
        return stableResult(true, "samples", since, snapshotSeq, eventCount, matchedEventCount, started,
            quietMs, timeoutMs, minEvents, minNodes, requireDigestChange, previousDigest, digestChanged,
            capturedSamples, sameDigestCount, digestField, filter, latestSnapshot);
      }
      if (matchedEventCount >= minEvents && nodeRequirementMet && digestRequirementMet && snapshotSeq > since && lastEventAt > 0 && now - lastEventAt >= quietMs) {
        return stableResult(true, "quiet", since, snapshotSeq, eventCount, matchedEventCount, started,
            quietMs, timeoutMs, minEvents, minNodes, requireDigestChange, previousDigest, digestChanged,
            capturedSamples, sameDigestCount, digestField, filter, latestSnapshot);
      }
    }

    if (latestSnapshot == null) {
      latestSnapshot = snapshotProvider.buildSnapshot(params);
      latestSnapshot.put("eventSeq", eventLog.currentSeq());
    }
    String finalDigest = latestSnapshot.optString(digestField, "");
    boolean finalDigestChanged = previousDigest == null || !previousDigest.equals(finalDigest);
    EventLog.Counts finalCounts = eventLog.countsSince(since, filter);
    return stableResult(false, "timeout", since, eventLog.currentSeq(), finalCounts.rawCount, finalCounts.matchedCount, started,
        quietMs, timeoutMs, minEvents, minNodes, requireDigestChange, previousDigest, finalDigestChanged,
        capturedSamples, sameDigestCount, digestField, filter, latestSnapshot);
  }

  private JSONObject stableResult(
      boolean stable,
      String reason,
      long since,
      long eventSeq,
      long eventCount,
      long matchedEventCount,
      long started,
      long quietMs,
      long timeoutMs,
      long minEvents,
      long minNodes,
      boolean requireDigestChange,
      String previousDigest,
      boolean digestChanged,
      int capturedSamples,
      int sameDigestCount,
      String digestField,
      EventLog.Filter filter,
      JSONObject snapshot) throws Exception {
    String digestKind = "layoutDigest".equals(digestField) ? "layout"
        : "treeDigest".equals(digestField) ? "tree" : "action";
    return new JSONObject()
        .put("stable", stable)
        .put("reason", reason)
        .put("since", since)
        .put("eventSeq", eventSeq)
        .put("eventCount", eventCount)
        .put("matchedEventCount", matchedEventCount)
        .put("waitedMs", System.currentTimeMillis() - started)
        .put("quietMs", quietMs)
        .put("timeoutMs", timeoutMs)
        .put("minEvents", minEvents)
        .put("minNodes", minNodes)
        .put("requireDigestChange", requireDigestChange)
        .put("digestChanged", digestChanged)
        .put("samples", capturedSamples)
        .put("sameDigestSamples", sameDigestCount)
        .put("digestKind", digestKind)
        .put("digest", snapshot.optString(digestField, null))
        .put("previousDigest", previousDigest)
        .put("treeDigest", snapshot.optString("treeDigest", null))
        .put("actionDigest", snapshot.optString("actionDigest", null))
        .put("layoutDigest", snapshot.optString("layoutDigest", null))
        .put("eventFilter", filter.toJson())
        .put("events", eventLog.recordsSinceJson(since, 32, filter))
        .put("snapshot", snapshot);
  }

  private static long longValue(Map<String, String> params, String primary, String alias, long fallback) {
    String value = first(params, primary, alias);
    return value == null ? fallback : Long.parseLong(value.trim());
  }

  private static boolean boolValue(Map<String, String> params, String primary, String alias) {
    String value = first(params, primary, alias);
    if (value == null) return false;
    String normalized = value.toLowerCase(Locale.US);
    return "1".equals(normalized) || "true".equals(normalized) || "yes".equals(normalized) || "on".equals(normalized);
  }

  private static String first(Map<String, String> params, String primary, String alias) {
    String value = params.get(primary);
    if (value != null && !value.trim().isEmpty()) return value.trim();
    value = alias == null ? null : params.get(alias);
    return value == null || value.trim().isEmpty() ? null : value.trim();
  }
}
