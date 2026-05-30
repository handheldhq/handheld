package com.example.tinysnapshot.v2;

import android.content.Context;
import android.os.SystemClock;

import org.json.JSONObject;

import java.io.File;
import java.io.RandomAccessFile;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

final class ResponseStore {
  private static final long TTL_MS = 5L * 60L * 1000L;
  private static final int MAX_ARTIFACTS = 32;
  private static final long MAX_STORE_BYTES = 16L * 1024L * 1024L;
  private static final int DEFAULT_CHARS = 2400;
  private static final int MAX_CHARS = 32 * 1024;
  private static final Pattern ID_PATTERN = Pattern.compile("^[A-Za-z0-9_.-]+$");

  private final Context context;

  ResponseStore(Context context) {
    this.context = context;
  }

  void cleanup() {
    try {
      File dir = outputDir();
      File[] files = dir.listFiles();
      if (files == null || files.length == 0) {
        return;
      }
      long now = System.currentTimeMillis();
      ArrayList<File> outputFiles = new ArrayList<>();
      for (File file : files) {
        if (!file.isFile()) {
          continue;
        }
        if (!file.getName().endsWith(".json")) {
          file.delete();
          continue;
        }
        if (now - file.lastModified() > TTL_MS) {
          file.delete();
          continue;
        }
        outputFiles.add(file);
      }
      Collections.sort(outputFiles, LAST_MODIFIED_ASC);
      while (outputFiles.size() > MAX_ARTIFACTS) {
        outputFiles.remove(0).delete();
      }
      long total = 0;
      for (File file : outputFiles) {
        total += file.length();
      }
      while (total > MAX_STORE_BYTES && !outputFiles.isEmpty()) {
        File oldest = outputFiles.remove(0);
        long size = oldest.length();
        if (oldest.delete()) {
          total -= size;
        } else {
          break;
        }
      }
    } catch (Throwable ignored) {
    }
  }

  JSONObject maybeChunk(JSONObject payload, String query) throws Exception {
    Map<String, String> params = parseQuery(query);
    if (!boolValue(params, "chunked", "chunk")) {
      return payload;
    }
    String json = payload.toString();
    int maxChars = maxChars(params);
    if (json.length() <= maxChars) {
      return payload;
    }
    String id = store(json);
    return read(id, 0, maxChars)
        .put("created", true)
        .put("path", "/responseChunk");
  }

  JSONObject read(String query) throws Exception {
    Map<String, String> params = parseQuery(query);
    String id = first(params, "id", null);
    if (!isValidId(id)) {
      return new JSONObject().put("ok", false).put("message", "invalid response chunk id");
    }
    return read(id, intValue(params, "offset", null, 0), maxChars(params));
  }

  private JSONObject read(String id, int offset, int maxChars) throws Exception {
    if (!isValidId(id)) {
      return new JSONObject().put("ok", false).put("message", "invalid response chunk id");
    }
    File file = outputFile(id);
    if (!file.exists()) {
      return new JSONObject().put("ok", false).put("message", "response chunk not found").put("id", id);
    }
    String json = readFile(file);
    file.setLastModified(System.currentTimeMillis());
    int safeOffset = Math.max(0, Math.min(offset, json.length()));
    int end = Math.min(json.length(), safeOffset + maxChars);
    boolean eof = end >= json.length();
    JSONObject result = new JSONObject()
        .put("ok", true)
        .put("chunked", true)
        .put("truncated", !eof)
        .put("id", id)
        .put("offset", safeOffset)
        .put("chars", end - safeOffset)
        .put("totalChars", json.length())
        .put("eof", eof)
        .put("dataEncoding", "utf8")
        .put("data", json.substring(safeOffset, end))
        .put("sha256", sha256(json.getBytes(StandardCharsets.UTF_8)));
    if (!eof) {
      result.put("nextOffset", end)
          .put("readUrl", "/responseChunk?id=" + id + "&offset=" + end + "&maxChars=" + maxChars);
    }
    return result;
  }

  private String store(String json) throws Exception {
    cleanup();
    String id = "response-" + SystemClock.elapsedRealtime() + "-" + UUID.randomUUID().toString().replace("-", "");
    File file = outputFile(id);
    try (RandomAccessFile output = new RandomAccessFile(file, "rw")) {
      output.setLength(0);
      output.write(json.getBytes(StandardCharsets.UTF_8));
    }
    return id;
  }

  private File outputDir() {
    File dir = new File(context.getCacheDir(), "response-chunks");
    if (!dir.exists()) {
      dir.mkdirs();
    }
    return dir;
  }

  private File outputFile(String id) {
    if (!isValidId(id)) {
      throw new IllegalArgumentException("invalid response chunk id");
    }
    return new File(outputDir(), id + ".json");
  }

  private static final Comparator<File> LAST_MODIFIED_ASC = new Comparator<File>() {
    @Override
    public int compare(File left, File right) {
      long delta = left.lastModified() - right.lastModified();
      if (delta < 0) return -1;
      if (delta > 0) return 1;
      return left.getName().compareTo(right.getName());
    }
  };

  private static boolean isValidId(String id) {
    return id != null && ID_PATTERN.matcher(id).matches();
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

  private static int maxChars(Map<String, String> params) {
    return Math.max(256, Math.min(MAX_CHARS, intValue(params, "maxChars", "maxBytes", DEFAULT_CHARS)));
  }

  private static int intValue(Map<String, String> params, String primary, String alias, int fallback) {
    String value = first(params, primary, alias);
    return value == null ? fallback : Integer.parseInt(value.trim());
  }

  private static boolean boolValue(Map<String, String> params, String primary, String alias) {
    String value = first(params, primary, alias);
    if (value == null) return false;
    String normalized = value.toLowerCase();
    return "1".equals(normalized) || "true".equals(normalized) || "yes".equals(normalized) || "on".equals(normalized);
  }

  private static String first(Map<String, String> params, String primary, String alias) {
    String value = params.get(primary);
    if (value != null && !value.trim().isEmpty()) return value.trim();
    value = alias == null ? null : params.get(alias);
    return value == null || value.trim().isEmpty() ? null : value.trim();
  }

  private static String readFile(File file) throws Exception {
    try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
      byte[] data = new byte[(int) input.length()];
      input.readFully(data);
      return new String(data, StandardCharsets.UTF_8);
    }
  }

  private static String sha256(byte[] data) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    digest.update(data);
    byte[] bytes = digest.digest();
    StringBuilder builder = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) {
      builder.append(String.format("%02x", b & 0xff));
    }
    return builder.toString();
  }
}
