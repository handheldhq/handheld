package com.example.tinysnapshot.v2;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.regex.Pattern;

final class SnapshotDigests {
  private static final Pattern VOLATILE_TIME_PATTERN =
      Pattern.compile("^\\d{1,2}:\\d{2}(:\\d{2})?(\\s?[AP]M)?$", Pattern.CASE_INSENSITIVE);

  private SnapshotDigests() {
  }

  static void addTo(JSONObject result, JSONArray nodes) throws Exception {
    String treeDigest = digestNodes(nodes, false);
    String actionDigest = digestNodes(nodes, true);
    result.put("treeDigest", treeDigest);
    result.put("actionDigest", actionDigest);
    result.put("digests", new JSONObject().put("tree", treeDigest).put("action", actionDigest));
  }

  /**
   * The action digest of a node array — exposed so the caller can hash a
   * full-tree actionable set (the filter-independent "layout" digest), which is
   * the same regardless of the filter (`interactiveOnly`/`compact`/…) a request
   * used. Two snapshots are only safely comparable on this digest, not on the
   * filter-dependent `actionDigest`/`treeDigest`.
   */
  static String actionDigestOf(JSONArray nodes) throws Exception {
    return digestNodes(nodes, true);
  }

  private static String digestNodes(JSONArray nodes, boolean actionOnly) throws Exception {
    ArrayList<String> lines = new ArrayList<>();
    for (int i = 0; i < nodes.length(); i += 1) {
      JSONObject node = nodes.getJSONObject(i);
      if (actionOnly && !isActionDigestNode(node)) {
        continue;
      }
      lines.add(digestLine(node, actionOnly));
    }
    Collections.sort(lines);
    StringBuilder builder = new StringBuilder();
    for (String line : lines) {
      builder.append(line).append('\n');
    }
    return sha256(builder.toString());
  }

  private static boolean isActionDigestNode(JSONObject node) {
    return node.optBoolean("hittable", false)
        || node.optBoolean("editable", false)
        || node.optBoolean("focused", false)
        || node.optBoolean("selected", false)
        || node.optBoolean("scrollable", false);
  }

  private static String digestLine(JSONObject node, boolean actionOnly) {
    JSONObject rect = node.optJSONObject("rect");
    return joinDigestFields(new String[] {
        valueForDigest(node, "stableId"),
        valueForDigest(node, "parentStableId"),
        valueForDigest(node, "identifier"),
        valueForDigest(node, "type"),
        valueForDigest(node, "role"),
        valueForDigest(node, "subrole"),
        valueForDigest(node, "label", actionOnly),
        valueForDigest(node, "value", actionOnly),
        rect == null ? "" : rect.optInt("x", 0) + "," + rect.optInt("y", 0) + ","
            + rect.optInt("width", 0) + "," + rect.optInt("height", 0),
        boolForDigest(node, "enabled"),
        boolForDigest(node, "hittable"),
        boolForDigest(node, "focused"),
        boolForDigest(node, "editable"),
        boolForDigest(node, "checkable"),
        boolForDigest(node, "checked"),
        boolForDigest(node, "selected"),
        boolForDigest(node, "scrollable")
    });
  }

  private static String valueForDigest(JSONObject node, String key) {
    return valueForDigest(node, key, false);
  }

  private static String valueForDigest(JSONObject node, String key, boolean maskVolatile) {
    String value = node.optString(key, "");
    if (maskVolatile && isVolatileDigestValue(value)) {
      return "<volatile>";
    }
    return value == null ? "" : value.replace("\n", " ").replace("|", "\\|");
  }

  private static boolean isVolatileDigestValue(String value) {
    if (value == null) return false;
    return VOLATILE_TIME_PATTERN.matcher(value.trim()).matches();
  }

  private static String boolForDigest(JSONObject node, String key) {
    return node.optBoolean(key, false) ? "1" : "0";
  }

  private static String joinDigestFields(String[] fields) {
    StringBuilder builder = new StringBuilder();
    for (int i = 0; i < fields.length; i += 1) {
      if (i > 0) builder.append('|');
      builder.append(fields[i] == null ? "" : fields[i]);
    }
    return builder.toString();
  }

  private static String sha256(String value) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
    return hex(bytes);
  }

  private static String hex(byte[] bytes) {
    StringBuilder builder = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) {
      builder.append(String.format("%02x", b & 0xff));
    }
    return builder.toString();
  }
}
