package com.example.tinysnapshot.v2;

import android.view.accessibility.AccessibilityEvent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLDecoder;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

final class EventLog {
  private final int bufferLimit;
  private final Object lock = new Object();
  private long eventSeq = 0;
  private long lastEventTimeMs = 0;
  private int lastEventType = 0;
  private String lastEventPackage = null;
  private String lastEventClass = null;
  private String lastEventText = null;
  private final ArrayDeque<Record> eventBuffer = new ArrayDeque<>();

  EventLog(int bufferLimit) {
    this.bufferLimit = bufferLimit;
  }

  void record(AccessibilityEvent event) {
    if (event == null) {
      return;
    }
    synchronized (lock) {
      eventSeq += 1;
      lastEventTimeMs = System.currentTimeMillis();
      lastEventType = event.getEventType();
      lastEventPackage = string(event.getPackageName());
      lastEventClass = string(event.getClassName());
      lastEventText = event.getText() == null ? null : event.getText().toString();
      eventBuffer.addLast(new Record(
          eventSeq,
          lastEventTimeMs,
          lastEventType,
          lastEventPackage,
          lastEventClass,
          lastEventText));
      while (eventBuffer.size() > bufferLimit) {
        eventBuffer.removeFirst();
      }
      lock.notifyAll();
    }
  }

  long currentSeq() {
    synchronized (lock) {
      return eventSeq;
    }
  }

  JSONObject waitForChange(String query) throws Exception {
    Map<String, String> params = parseQuery(query);
    Filter filter = Filter.fromParams(params);
    long timeoutMs = Math.max(0, longValue(params, "timeoutMs", "timeout", 1000));
    long started = System.currentTimeMillis();
    long since = longValue(params, "since", null, currentSeq());
    synchronized (lock) {
      while (countsSince(since, filter).matchedCount <= 0) {
        long remaining = timeoutMs - (System.currentTimeMillis() - started);
        if (remaining <= 0) {
          break;
        }
        lock.wait(Math.min(remaining, 250));
      }
    }
    JSONObject result = snapshotJson(params);
    Counts counts = countsSince(since, filter);
    result.put("changed", counts.matchedCount > 0);
    result.put("since", since);
    result.put("eventCount", counts.rawCount);
    result.put("matchedEventCount", counts.matchedCount);
    result.put("eventFilter", filter.toJson());
    result.put("waitedMs", System.currentTimeMillis() - started);
    return result;
  }

  JSONObject snapshotJson(String query) throws Exception {
    return snapshotJson(parseQuery(query));
  }

  JSONObject snapshotJson(Map<String, String> params) throws Exception {
    long since = longValue(params, "since", null, 0);
    int limit = (int) Math.max(0, Math.min(bufferLimit, longValue(params, "limit", null, 32)));
    long seq;
    long timeMs;
    int type;
    String packageName;
    String className;
    String text;
    synchronized (lock) {
      seq = eventSeq;
      timeMs = lastEventTimeMs;
      type = lastEventType;
      packageName = lastEventPackage;
      className = lastEventClass;
      text = lastEventText;
    }
    JSONObject event = new JSONObject();
    if (timeMs > 0) {
      event.put("timeMs", timeMs);
    }
    event.put("type", type);
    event.put("typeName", eventTypeName(type));
    put(event, "packageName", packageName);
    put(event, "className", className);
    put(event, "text", text);
    Filter filter = Filter.fromParams(params);
    return new JSONObject()
        .put("seq", seq)
        .put("bufferLimit", bufferLimit)
        .put("eventFilter", filter.toJson())
        .put("events", recordsSinceJson(since, limit, filter))
        .put("event", event);
  }

  JSONArray recordsSinceJson(long since, int limit, Filter filter) throws Exception {
    ArrayList<Record> records = new ArrayList<>();
    synchronized (lock) {
      for (Record record : eventBuffer) {
        if (record.seq > since && filter.matches(record)) {
          records.add(record);
        }
      }
    }
    int start = Math.max(0, records.size() - limit);
    JSONArray events = new JSONArray();
    for (int i = start; i < records.size(); i += 1) {
      events.put(records.get(i).toJson());
    }
    return events;
  }

  Counts countsSince(long since, Filter filter) {
    long rawCount = Math.max(0, currentSeq() - since);
    long matchedCount = 0;
    long lastMatchedSeq = 0;
    long lastMatchedTimeMs = 0;
    synchronized (lock) {
      for (Record record : eventBuffer) {
        if (record.seq > since && filter.matches(record)) {
          matchedCount += 1;
          lastMatchedSeq = record.seq;
          lastMatchedTimeMs = record.timeMs;
        }
      }
    }
    return new Counts(rawCount, matchedCount, lastMatchedSeq, lastMatchedTimeMs);
  }

  void waitForEventOrSample(long lastSeq, long timeoutMs) {
    synchronized (lock) {
      if (eventSeq > lastSeq || timeoutMs <= 0) {
        return;
      }
      try {
        lock.wait(timeoutMs);
      } catch (InterruptedException ignored) {
        Thread.currentThread().interrupt();
      }
    }
  }

  private static Map<String, String> parseQuery(String query) throws Exception {
    HashMap<String, String> result = new HashMap<>();
    if (query == null || query.isEmpty()) return result;
    String[] parts = query.split("&");
    for (String part : parts) {
      int equals = part.indexOf('=');
      String key = equals >= 0 ? part.substring(0, equals) : part;
      String value = equals >= 0 ? part.substring(equals + 1) : "true";
      result.put(URLDecoder.decode(key, "UTF-8"), URLDecoder.decode(value, "UTF-8"));
    }
    return result;
  }

  private static long longValue(Map<String, String> params, String primary, String alias, long fallback) {
    String value = first(params, primary, alias);
    return value == null ? fallback : Long.parseLong(value.trim());
  }

  private static String first(Map<String, String> params, String primary, String alias) {
    String value = params.get(primary);
    if (value != null && !value.trim().isEmpty()) return value.trim();
    value = alias == null ? null : params.get(alias);
    return value == null || value.trim().isEmpty() ? null : value.trim();
  }

  private static void put(JSONObject json, String key, Object value) throws Exception {
    if (value != null) json.put(key, value);
  }

  private static String string(CharSequence value) {
    if (value == null) return null;
    String text = value.toString();
    return text.trim().isEmpty() ? null : text;
  }

  private static String eventTypeName(int type) {
    try {
      return AccessibilityEvent.eventTypeToString(type);
    } catch (RuntimeException ignored) {
      return Integer.toString(type);
    }
  }

  private static final class Record {
    final long seq;
    final long timeMs;
    final int type;
    final String packageName;
    final String className;
    final String text;

    Record(long seq, long timeMs, int type, String packageName, String className, String text) {
      this.seq = seq;
      this.timeMs = timeMs;
      this.type = type;
      this.packageName = packageName;
      this.className = className;
      this.text = text;
    }

    JSONObject toJson() throws Exception {
      JSONObject event = new JSONObject()
          .put("seq", seq)
          .put("timeMs", timeMs)
          .put("type", type)
          .put("typeName", eventTypeName(type));
      put(event, "packageName", packageName);
      put(event, "className", className);
      put(event, "text", text);
      return event;
    }
  }

  static final class Filter {
    final String packageName;
    final ArrayList<String> typeTokens;

    Filter(String packageName, ArrayList<String> typeTokens) {
      this.packageName = packageName == null || packageName.trim().isEmpty() ? null : packageName.trim();
      this.typeTokens = typeTokens;
    }

    static Filter fromParams(Map<String, String> params) {
      String packageName = first(params, "package", "pkg");
      String eventTypes = first(params, "eventTypes", "types");
      ArrayList<String> tokens = new ArrayList<>();
      if (eventTypes != null) {
        for (String token : eventTypes.split(",")) {
          String normalized = token.trim();
          if (!normalized.isEmpty()) {
            tokens.add(normalized.toLowerCase(Locale.US));
          }
        }
      }
      return new Filter(packageName, tokens);
    }

    boolean matches(Record record) {
      if (packageName != null && !packageName.equals(record.packageName)) {
        return false;
      }
      if (typeTokens.isEmpty()) {
        return true;
      }
      String typeNumber = Integer.toString(record.type);
      String typeName = eventTypeName(record.type).toLowerCase(Locale.US);
      for (String token : typeTokens) {
        if (token.equals(typeNumber) || token.equals(typeName) || typeName.endsWith(token)) {
          return true;
        }
      }
      return false;
    }

    JSONObject toJson() throws Exception {
      JSONObject json = new JSONObject();
      put(json, "packageName", packageName);
      if (!typeTokens.isEmpty()) {
        JSONArray types = new JSONArray();
        for (String token : typeTokens) {
          types.put(token);
        }
        json.put("eventTypes", types);
      }
      return json;
    }
  }

  static final class Counts {
    final long rawCount;
    final long matchedCount;
    final long lastMatchedSeq;
    final long lastMatchedTimeMs;

    Counts(long rawCount, long matchedCount, long lastMatchedSeq, long lastMatchedTimeMs) {
      this.rawCount = rawCount;
      this.matchedCount = matchedCount;
      this.lastMatchedSeq = lastMatchedSeq;
      this.lastMatchedTimeMs = lastMatchedTimeMs;
    }
  }
}
