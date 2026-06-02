package com.example.tinysnapshot.v2;

import android.app.UiAutomation;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class SnapshotService {
  private static final int DEFAULT_MAX_NODES = 800;
  private static final long UNDEFINED_NODE_ID = (((long) Integer.MAX_VALUE) << 32) | Integer.MAX_VALUE;
  private static final int UNDEFINED_WINDOW_ID = -1;
  private static final Pattern GENERIC_ANDROID_ID_PATTERN =
      Pattern.compile("^[\\w.]+:id/[\\w.-]+$", Pattern.CASE_INSENSITIVE);
  // Matches the "uN pkg/activity" portion of a dumpsys window focus line, e.g.
  // "mFocusedApp=ActivityRecord{... u0 com.android.settings/.Settings}".
  private static final Pattern FOCUS_PATTERN =
      Pattern.compile("\\bu\\d+\\s+([A-Za-z0-9_.]+)/([A-Za-z0-9_.$]+)");

  private final Context targetContext;
  private final UiAutomation automation;

  SnapshotService(Context targetContext, UiAutomation automation) {
    this.targetContext = targetContext;
    this.automation = automation;
  }

  JSONObject buildScreenshot(String query) throws Exception {
    ScreenshotOptions options = ScreenshotOptions.fromQuery(query);
    long started = System.currentTimeMillis();
    Bitmap bitmap = automation.takeScreenshot();
    if (bitmap == null) {
      throw new IllegalStateException("UiAutomation.takeScreenshot returned null");
    }
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    Bitmap.CompressFormat format = options.jpeg ? Bitmap.CompressFormat.JPEG : Bitmap.CompressFormat.PNG;
    bitmap.compress(format, options.quality, bytes);
    int width = bitmap.getWidth();
    int height = bitmap.getHeight();
    bitmap.recycle();
    byte[] raw = bytes.toByteArray();
    JSONObject result = new JSONObject();
    result.put("mimeType", options.jpeg ? "image/jpeg" : "image/png");
    result.put("encoding", "base64");
    result.put("width", width);
    result.put("height", height);
    result.put("byteLength", raw.length);
    result.put("base64Length", Base64.encodeToString(raw, Base64.NO_WRAP).length());
    result.put("data", Base64.encodeToString(raw, Base64.NO_WRAP));
    result.put("captureElapsedMs", System.currentTimeMillis() - started);
    return result;
  }

  JSONObject buildSnapshot(Options options) throws Exception {
    List<TreeNode> roots = captureRootsWithRetry();
    try {
      TreeStats stats = analyze(roots);
      TreeNode scopedRoot = findScopeNode(roots, options.scope);
      List<TreeNode> walkRoots = scopedRoot == null ? roots : singleton(scopedRoot);

      JSONArray nodes = new JSONArray();
      IdentityHashMap<TreeNode, Boolean> interactiveMemo = new IdentityHashMap<>();
      WalkState state = new WalkState(options.maxNodes);
      SnapshotMeta meta = metadataFor(walkRoots);

      for (TreeNode root : walkRoots) {
        walk(root, 0, null, null, null, false, false, options, interactiveMemo, nodes, state);
        if (state.truncated) {
          break;
        }
      }

      JSONObject result = new JSONObject();
      result.put("nodes", nodes);
      result.put("truncated", state.truncated);
      result.put("analysis", new JSONObject().put("rawNodeCount", stats.rawNodeCount).put("maxDepth", stats.maxDepth));
      result.put("surface", "app");
      put(result, "bundleId", meta.packageName);
      put(result, "appName", meta.appName);
      result.put("interactiveOnly", options.interactiveOnly);
      result.put("compact", options.compact);
      result.put("raw", options.raw);
      SnapshotDigests.addTo(result, nodes);
      // Filter-independent "layout" digest: the full-screen actionable set,
      // hashed the same no matter what filter the request used. When the request
      // is already canonical (default full walk, no scope/depth, not truncated)
      // the walked `actionDigest` IS that set — reuse it. Otherwise do one cheap
      // in-memory pass over the captured tree (no extra a11y IPC). This is the
      // only digest two snapshots can be safely compared on across filters.
      boolean canonical = !options.interactiveOnly && !options.compact
          && options.scope == null && options.depth == null && !state.truncated;
      String layoutDigest = canonical
          ? result.optString("actionDigest", null)
          : computeLayoutDigest(roots);
      put(result, "layoutDigest", layoutDigest);
      JSONObject digests = result.optJSONObject("digests");
      if (digests != null && layoutDigest != null) {
        digests.put("layout", layoutDigest);
      }
      if (options.depth != null) {
        result.put("requestedDepth", options.depth);
      }
      put(result, "scope", options.scope);
      return result;
    } finally {
      recycle(roots);
    }
  }

  JSONObject buildSignature() throws Exception {
    List<TreeNode> roots = captureRootsWithRetry();
    try {
      SnapshotMeta meta = metadataFor(roots);
      JSONObject result = new JSONObject()
          .put("ok", true)
          .put("backend", "tiny");
      put(result, "bundleId", meta.packageName);
      put(result, "appName", meta.appName);
      put(result, "layoutDigest", computeLayoutDigest(roots));
      attachForeground(result);
      return result;
    } finally {
      recycle(roots);
    }
  }

  JSONObject shapeObservation(JSONObject snapshot, Map<String, String> params) throws Exception {
    JSONArray rawNodes = snapshot.optJSONArray("nodes");
    JSONArray nodes = new JSONArray();
    if (rawNodes != null) {
      for (int i = 0; i < rawNodes.length(); i += 1) {
        JSONObject raw = rawNodes.optJSONObject(i);
        if (raw != null) {
          nodes.put(toAgentNode(raw, i));
        }
      }
    }

    JSONObject result = new JSONObject()
        .put("ok", true)
        .put("backend", "tiny")
        .put("nodes", nodes)
        .put("nodeCount", nodes.length())
        .put("truncated", snapshot.optBoolean("truncated", false))
        .put("interactiveOnly", snapshot.optBoolean("interactiveOnly", false))
        .put("compact", snapshot.optBoolean("compact", false));
    put(result, "bundleId", snapshot.optString("bundleId", null));
    put(result, "appName", snapshot.optString("appName", null));
    put(result, "eventSeq", snapshot.has("eventSeq") ? snapshot.opt("eventSeq") : null);
    put(result, "treeDigest", snapshot.optString("treeDigest", null));
    put(result, "actionDigest", snapshot.optString("actionDigest", null));
    if (snapshot.has("analysis")) {
      result.put("analysis", snapshot.optJSONObject("analysis"));
    }
    if (boolParam(params, "text", "includeText")) {
      result.put("text", compactText(nodes));
    }
    return result;
  }

  private static JSONObject toAgentNode(JSONObject raw, int index) throws Exception {
    JSONObject node = new JSONObject()
        .put("ref", "@e" + (index + 1));
    put(node, "role", raw.optString("role", null));
    put(node, "label", raw.optString("label", null));
    put(node, "value", raw.optString("value", null));
    put(node, "identifier", raw.optString("identifier", null));
    put(node, "bundleId", raw.optString("bundleId", null));
    put(node, "stableId", raw.optString("stableId", null));
    put(node, "parentStableId", raw.optString("parentStableId", null));
    put(node, "actionableId", raw.optString("actionableId", null));
    if (raw.has("windowId")) {
      node.put("windowId", raw.opt("windowId"));
    }
    if (raw.has("depth")) {
      node.put("depth", raw.opt("depth"));
    }
    JSONObject rect = raw.optJSONObject("rect");
    if (rect != null) {
      node.put("bounds", new JSONObject()
          .put("left", rect.optInt("x"))
          .put("top", rect.optInt("y"))
          .put("right", rect.optInt("x") + Math.max(0, rect.optInt("width")))
          .put("bottom", rect.optInt("y") + Math.max(0, rect.optInt("height"))));
    }
    putTrue(node, raw, "hittable");
    putTrue(node, raw, "longPressable");
    putTrue(node, raw, "focusable");
    putTrue(node, raw, "focused");
    putTrue(node, raw, "editable");
    putTrue(node, raw, "selected");
    putTrue(node, raw, "checkable");
    putTrue(node, raw, "checked");
    putTrue(node, raw, "scrollable");
    if (raw.has("enabled") && !raw.optBoolean("enabled", true)) {
      node.put("enabled", false);
    }
    return node;
  }

  private static void putTrue(JSONObject target, JSONObject source, String key) throws Exception {
    if (source.optBoolean(key, false)) {
      target.put(key, true);
    }
  }

  private static boolean boolParam(Map<String, String> params, String primary, String alias) {
    String value = first(params, primary, alias);
    if (value == null) return false;
    String normalized = value.trim().toLowerCase(Locale.US);
    return "1".equals(normalized) || "true".equals(normalized) || "yes".equals(normalized) || "on".equals(normalized);
  }

  private static String compactText(JSONArray nodes) throws Exception {
    StringBuilder builder = new StringBuilder();
    for (int i = 0; i < nodes.length(); i += 1) {
      JSONObject node = nodes.getJSONObject(i);
      if (builder.length() > 0) builder.append('\n');
      builder.append(node.optString("ref"));
      builder.append(" [").append(node.optString("role", "node")).append("]");
      String label = firstNonBlank(node.optString("label", null), node.optString("value", null));
      if (label != null) {
        builder.append(' ').append(label);
      }
      appendFlag(builder, node, "hittable");
      appendFlag(builder, node, "focused");
      appendFlag(builder, node, "editable");
      appendFlag(builder, node, "scrollable");
      appendFlag(builder, node, "checked");
    }
    return builder.toString();
  }

  private static void appendFlag(StringBuilder builder, JSONObject node, String key) {
    if (node.optBoolean(key, false)) {
      builder.append(' ').append(key);
    }
  }

  List<TreeNode> captureRootsWithRetry() {
    List<TreeNode> roots = new ArrayList<>();
    for (int attempt = 0; attempt < 6; attempt += 1) {
      recycle(roots);
      roots = captureRoots();
      if (!roots.isEmpty() && (attempt > 0 || hasUsableRootSet(roots))) {
        return roots;
      }
      try {
        Thread.sleep(50);
      } catch (InterruptedException ignored) {
        Thread.currentThread().interrupt();
        return roots;
      }
    }
    return roots;
  }

  private static boolean hasUsableRootSet(List<TreeNode> roots) {
    if (roots.isEmpty()) {
      return false;
    }
    int nodeCount = 0;
    for (TreeNode root : roots) {
      nodeCount += countNodes(root, 20);
      if (nodeCount >= 2) {
        return true;
      }
    }
    return false;
  }

  private static int countNodes(TreeNode node, int limit) {
    int count = 1;
    for (TreeNode child : node.children) {
      if (count >= limit) {
        break;
      }
      count += countNodes(child, limit - count);
    }
    return count;
  }

  private List<TreeNode> captureRoots() {
    List<TreeNode> roots = new ArrayList<>();
    try {
      List<AccessibilityWindowInfo> windows = automation.getWindows();
      for (AccessibilityWindowInfo window : windows) {
        AccessibilityNodeInfo root = null;
        try {
          root = window.getRoot();
          if (root != null) {
            roots.add(buildTree(root, window, null));
          }
        } catch (RuntimeException ignored) {
        } finally {
          if (root != null) {
            root.recycle();
          }
          window.recycle();
        }
      }
    } catch (RuntimeException ignored) {
    }
    addActiveRootIfMissing(roots);
    return roots;
  }

  private void addActiveRootIfMissing(List<TreeNode> roots) {
    AccessibilityNodeInfo root = automation.getRootInActiveWindow();
    if (root == null) {
      return;
    }
    TreeNode active = null;
    try {
      active = buildTree(root, null, null);
      if (hasEquivalentRoot(roots, active)) {
        active.recycle();
        active = null;
        return;
      }
      roots.add(active);
      active = null;
    } catch (RuntimeException ignored) {
    } finally {
      if (active != null) {
        active.recycle();
      }
      root.recycle();
    }
  }

  private static boolean hasEquivalentRoot(List<TreeNode> roots, TreeNode candidate) {
    String candidateId = stableIdOf(candidate.info);
    String candidatePackage = string(candidate.info.getPackageName());
    for (TreeNode root : roots) {
      String rootId = stableIdOf(root.info);
      if (candidateId != null && candidateId.equals(rootId)) {
        return true;
      }
      if (candidateId == null && candidatePackage != null && candidatePackage.equals(string(root.info.getPackageName()))) {
        return true;
      }
    }
    return false;
  }

  private TreeNode buildTree(AccessibilityNodeInfo source, AccessibilityWindowInfo window, TreeNode parent) {
    AccessibilityNodeInfo copy = AccessibilityNodeInfo.obtain(source);
    TreeNode node = new TreeNode(copy, window, parent);
    for (int i = 0; i < source.getChildCount(); i += 1) {
      AccessibilityNodeInfo child = source.getChild(i);
      if (child == null) {
        continue;
      }
      try {
        node.children.add(buildTree(child, window, node));
      } catch (RuntimeException ignored) {
      } finally {
        child.recycle();
      }
    }
    return node;
  }

  private void walk(
      TreeNode node,
      int depth,
      Integer parentIndex,
      String parentStableId,
      String actionableAncestorId,
      boolean ancestorHittable,
      boolean ancestorCollection,
      Options options,
      IdentityHashMap<TreeNode, Boolean> interactiveMemo,
      JSONArray result,
      WalkState state) throws Exception {
    if (state.truncated || result.length() >= state.maxNodes) {
      state.truncated = true;
      return;
    }
    if (options.depth != null && depth > options.depth) {
      return;
    }

    boolean descendantHittable = hasInteractiveDescendant(node, interactiveMemo);
    boolean include = options.raw || shouldInclude(node, options, ancestorHittable, descendantHittable, ancestorCollection);
    String stableId = stableIdOf(node.info);
    String actionableId = isHittable(node.info) ? stableId : actionableAncestorId;
    Integer currentIndex = parentIndex;
    if (include) {
      currentIndex = result.length();
      result.put(toJson(node, depth, parentIndex, parentStableId, actionableId, currentIndex));
    }

    boolean nextAncestorHittable = ancestorHittable || isHittable(node.info);
    boolean nextAncestorCollection = ancestorCollection || isCollectionContainerType(className(node.info));
    for (TreeNode child : node.children) {
      walk(child, depth + 1, currentIndex, stableId, actionableId, nextAncestorHittable,
          nextAncestorCollection, options, interactiveMemo, result, state);
      if (state.truncated) {
        return;
      }
    }
  }

  private JSONObject toJson(
      TreeNode node,
      int depth,
      Integer parentIndex,
      String parentStableId,
      String actionableId,
      int index) throws Exception {
    AccessibilityNodeInfo info = node.info;
    JSONObject json = new JSONObject();
    String type = className(info);
    boolean password = info.isPassword();
    String text = password ? "[redacted]" : string(info.getText());
    String desc = password ? "[redacted]" : string(info.getContentDescription());
    String label = password ? "[redacted]" : firstNonBlank(text, desc);
    String packageName = string(info.getPackageName());
    Rect bounds = new Rect();
    info.getBoundsInScreen(bounds);

    json.put("index", index);
    put(json, "type", type);
    put(json, "role", roleOf(type, info));
    put(json, "subrole", subroleOf(type, info));
    put(json, "label", label);
    put(json, "value", text);
    put(json, "identifier", string(info.getViewIdResourceName()));
    put(json, "bundleId", packageName);
    put(json, "stableId", stableIdOf(info));
    put(json, "parentStableId", parentStableId);
    put(json, "actionableId", actionableId);
    json.put("windowId", info.getWindowId());
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && node.window != null) {
      json.put("displayId", node.window.getDisplayId());
    }
    put(json, "windowTitle", node.window == null ? null : string(node.window.getTitle()));
    json.put("surface", "app");
    json.put("rect", new JSONObject()
        .put("x", bounds.left)
        .put("y", bounds.top)
        .put("width", Math.max(0, bounds.right - bounds.left))
        .put("height", Math.max(0, bounds.bottom - bounds.top)));
    json.put("enabled", info.isEnabled());
    json.put("checkable", info.isCheckable());
    json.put("checked", info.isChecked());
    json.put("selected", info.isSelected());
    json.put("focused", info.isFocused() || info.isAccessibilityFocused());
    json.put("hittable", isHittable(info));
    json.put("longClickable", info.isLongClickable());
    json.put("longPressable", info.isLongClickable());
    json.put("focusable", info.isFocusable());
    json.put("scrollable", info.isScrollable());
    json.put("editable", isEditableType(type));
    if (password) {
      json.put("redacted", true);
    }
    HiddenContent hidden = hiddenContentOf(info, node);
    if (hidden.above) {
      json.put("hiddenContentAbove", true);
    }
    if (hidden.below) {
      json.put("hiddenContentBelow", true);
    }
    json.put("depth", depth);
    if (parentIndex != null) {
      json.put("parentIndex", parentIndex);
    }
    return json;
  }

  private boolean shouldInclude(TreeNode node, Options options, boolean ancestorHittable, boolean descendantHittable, boolean ancestorCollection) {
    String type = normalize(className(node.info));
    String label = firstNonBlank(string(node.info.getText()), string(node.info.getContentDescription()));
    String identifier = string(node.info.getViewIdResourceName());
    boolean hasMeaningfulText = label != null && !isGenericAndroidId(label);
    boolean hasMeaningfulId = identifier != null && !isGenericAndroidId(identifier);
    boolean structural = isStructuralAndroidType(type);
    boolean visual = "imageview".equals(type) || "imagebutton".equals(type);
    boolean hittable = isHittable(node.info);

    if (options.interactiveOnly) {
      if (hittable) {
        return true;
      }
      if (isScrollableType(type) && descendantHittable) {
        return true;
      }
      if (!hasMeaningfulText && !hasMeaningfulId) {
        return false;
      }
      if (visual) {
        return false;
      }
      if (structural && !ancestorCollection) {
        return false;
      }
      return ancestorHittable || descendantHittable || ancestorCollection;
    }
    if (options.compact) {
      return hasMeaningfulText || hasMeaningfulId || hittable;
    }
    if (structural || visual) {
      return hittable || hasMeaningfulText || (hasMeaningfulId && descendantHittable) || descendantHittable;
    }
    return true;
  }

  private static boolean hasInteractiveDescendant(TreeNode node, IdentityHashMap<TreeNode, Boolean> memo) {
    Boolean cached = memo.get(node);
    if (cached != null) {
      return cached;
    }
    for (TreeNode child : node.children) {
      if (isHittable(child.info) || hasInteractiveDescendant(child, memo)) {
        memo.put(node, true);
        return true;
      }
    }
    memo.put(node, false);
    return false;
  }

  private static boolean isHittable(AccessibilityNodeInfo info) {
    return info.isClickable();
  }

  private static String roleOf(String type, AccessibilityNodeInfo info) {
    String normalized = normalize(type);
    if (normalized.contains("button")) return "button";
    if (normalized.contains("edittext") || normalized.contains("autocompletetextview")) return "textbox";
    if (normalized.contains("checkbox")) return "checkbox";
    if (normalized.contains("switch")) return "switch";
    if (normalized.contains("radiobutton")) return "radio";
    if (normalized.contains("seekbar")) return "slider";
    if (normalized.contains("image")) return "image";
    if (normalized.contains("textview")) return "text";
    if (isScrollableType(normalized)) return "scroll";
    if (info.isClickable()) return "button";
    return null;
  }

  private static String subroleOf(String type, AccessibilityNodeInfo info) {
    if (info.isPassword()) return "password";
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.isHeading()) return "heading";
    if (info.getRangeInfo() != null) return "range";
    return null;
  }

  private static HiddenContent hiddenContentOf(AccessibilityNodeInfo info, TreeNode node) {
    if (!info.isScrollable() && !isScrollableType(className(info))) {
      return HiddenContent.NONE;
    }
    boolean above = canScrollBackward(info);
    boolean below = canScrollForward(info);
    Rect viewport = new Rect();
    info.getBoundsInScreen(viewport);
    if (viewport.width() <= 0 || viewport.height() <= 0) {
      return new HiddenContent(above, below);
    }
    DescendantGeometry descendants = descendantGeometryOf(node);
    if (descendants.hasBounds) {
      if (descendants.minBottom <= viewport.top) above = true;
      if (descendants.maxTop >= viewport.bottom) below = true;
    }
    return new HiddenContent(above, below);
  }

  private static DescendantGeometry descendantGeometryOf(TreeNode node) {
    if (node.descendantGeometry != null) {
      return node.descendantGeometry;
    }
    boolean hasBounds = false;
    int minBottom = Integer.MAX_VALUE;
    int maxTop = Integer.MIN_VALUE;
    Rect rect = new Rect();
    for (TreeNode child : node.children) {
      child.info.getBoundsInScreen(rect);
      if (rect.width() > 0 && rect.height() > 0) {
        hasBounds = true;
        minBottom = Math.min(minBottom, rect.bottom);
        maxTop = Math.max(maxTop, rect.top);
      }
      DescendantGeometry childGeometry = descendantGeometryOf(child);
      if (childGeometry.hasBounds) {
        hasBounds = true;
        minBottom = Math.min(minBottom, childGeometry.minBottom);
        maxTop = Math.max(maxTop, childGeometry.maxTop);
      }
    }
    node.descendantGeometry = hasBounds
        ? new DescendantGeometry(true, minBottom, maxTop)
        : DescendantGeometry.EMPTY;
    return node.descendantGeometry;
  }

  private static boolean canScrollBackward(AccessibilityNodeInfo info) {
    if ((info.getActions() & AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) != 0) return true;
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || info.getActionList() == null) return false;
    return info.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP)
        || info.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT);
  }

  private static boolean canScrollForward(AccessibilityNodeInfo info) {
    if ((info.getActions() & AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) != 0) return true;
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || info.getActionList() == null) return false;
    return info.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN)
        || info.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT);
  }

  private static TreeStats analyze(List<TreeNode> roots) {
    int rawNodeCount = 0;
    int maxDepth = 0;
    ArrayDeque<TreeDepth> stack = new ArrayDeque<>();
    for (TreeNode root : roots) stack.push(new TreeDepth(root, 0));
    while (!stack.isEmpty()) {
      TreeDepth current = stack.pop();
      rawNodeCount += 1;
      maxDepth = Math.max(maxDepth, current.depth);
      for (TreeNode child : current.node.children) stack.push(new TreeDepth(child, current.depth + 1));
    }
    return new TreeStats(rawNodeCount, maxDepth);
  }

  private TreeNode findScopeNode(List<TreeNode> roots, String scope) {
    if (scope == null || scope.trim().isEmpty()) return null;
    String query = scope.toLowerCase(Locale.US);
    ArrayDeque<TreeNode> queue = new ArrayDeque<>(roots);
    while (!queue.isEmpty()) {
      TreeNode node = queue.removeFirst();
      String label = lower(firstNonBlank(string(node.info.getText()), string(node.info.getContentDescription())));
      String value = lower(string(node.info.getText()));
      String identifier = lower(string(node.info.getViewIdResourceName()));
      if (label.contains(query) || value.contains(query) || identifier.contains(query)) return node;
      queue.addAll(node.children);
    }
    return null;
  }

  private SnapshotMeta metadataFor(List<TreeNode> roots) {
    if (roots.isEmpty()) return new SnapshotMeta(null, null);
    String packageName = string(roots.get(0).info.getPackageName());
    return new SnapshotMeta(packageName, appName(packageName));
  }

  private String appName(String packageName) {
    if (packageName == null) return null;
    try {
      PackageManager manager = targetContext.getPackageManager();
      ApplicationInfo info = manager.getApplicationInfo(packageName, 0);
      return string(manager.getApplicationLabel(info));
    } catch (PackageManager.NameNotFoundException ignored) {
      return null;
    }
  }

  static String stableIdOf(AccessibilityNodeInfo info) {
    try {
      long sourceNodeId = (Long) getField("mSourceNodeId", info);
      int windowId = info.getWindowId();
      if (sourceNodeId == UNDEFINED_NODE_ID || windowId == UNDEFINED_WINDOW_ID) return null;
      String source = String.format("%016x", sourceNodeId);
      String window = String.format("%016x", windowId);
      return String.format("%s-%s-%s-%s-%s",
          window.substring(0, 8), window.substring(8, 12), window.substring(12, 16),
          source.substring(0, 4), source.substring(4, 16));
    } catch (Throwable ignored) {
      return null;
    }
  }

  private static Object getField(String name, Object target) throws Exception {
    Field field = target.getClass().getDeclaredField(name);
    field.setAccessible(true);
    return field.get(target);
  }

  static void recycle(List<TreeNode> roots) {
    for (TreeNode root : roots) root.recycle();
  }

  private static <T> List<T> singleton(T value) {
    ArrayList<T> values = new ArrayList<>();
    values.add(value);
    return values;
  }

  static boolean isEditableType(String type) {
    String normalized = normalize(type);
    return normalized.contains("edittext") || normalized.contains("autocompletetextview");
  }

  private static boolean isCollectionContainerType(String type) {
    String normalized = normalize(type);
    return normalized.contains("recyclerview") || normalized.contains("listview") || normalized.contains("gridview");
  }

  private static boolean isScrollableType(String type) {
    String normalized = normalize(type);
    return normalized.contains("scroll") || normalized.contains("recyclerview")
        || normalized.contains("listview") || normalized.contains("gridview")
        || normalized.contains("collectionview") || "table".equals(normalized);
  }

  private static boolean isStructuralAndroidType(String type) {
    String shortName = type.contains(".") ? type.substring(type.lastIndexOf('.') + 1) : type;
    return shortName.contains("layout") || "viewgroup".equals(shortName) || "view".equals(shortName);
  }

  private static boolean isGenericAndroidId(String value) {
    if (value == null || value.trim().isEmpty()) return false;
    return GENERIC_ANDROID_ID_PATTERN.matcher(value.trim()).matches();
  }

  static String className(AccessibilityNodeInfo info) {
    return string(info.getClassName());
  }

  static String string(CharSequence value) {
    if (value == null) return null;
    String text = value.toString();
    return text.trim().isEmpty() ? null : text;
  }

  private static String firstNonBlank(String first, String second) {
    return first != null ? first : second;
  }

  private static String normalize(String value) {
    return value == null ? "" : value.toLowerCase(Locale.US);
  }

  static String lower(String value) {
    return value == null ? "" : value.toLowerCase(Locale.US);
  }

  private static void put(JSONObject json, String key, Object value) throws Exception {
    if (value != null) json.put(key, value);
  }

  /**
   * The filter-independent layout digest: hash the full-screen actionable node
   * set, ignoring `interactiveOnly`/`compact`/`scope`/`depth`/`maxNodes`. Runs a
   * second pass over the already-captured in-memory tree (no extra a11y IPC),
   * so two snapshots taken with different filters still produce the same digest.
   */
  private String computeLayoutDigest(List<TreeNode> roots) throws Exception {
    JSONArray actionable = new JSONArray();
    for (TreeNode root : roots) {
      collectActionable(root, null, actionable);
    }
    return SnapshotDigests.actionDigestOf(actionable);
  }

  private void collectActionable(TreeNode node, String parentStableId, JSONArray out) throws Exception {
    if (isActionable(node.info)) {
      out.put(toJson(node, 0, null, parentStableId, null, out.length()));
    }
    String stableId = stableIdOf(node.info);
    for (TreeNode child : node.children) {
      collectActionable(child, stableId, out);
    }
  }

  // Mirrors SnapshotDigests.isActionDigestNode, but read from the node directly
  // so we only build JSON for nodes the action digest actually keeps.
  private static boolean isActionable(AccessibilityNodeInfo info) {
    return isHittable(info)
        || isEditableType(className(info))
        || info.isFocused() || info.isAccessibilityFocused()
        || info.isSelected()
        || info.isScrollable();
  }

  /**
   * Fold the foreground package/activity into a snapshot. Tiny's node tree only
   * exposes each window's package, not the activity, so we read it on-device via
   * the resident UiAutomation's shell (no host round-trip). Best-effort: a
   * failed/empty lookup just leaves activity/component off. Call this only on
   * the returned snapshot — never inside the waitForStable sampling loop.
   */
  void attachForeground(JSONObject snapshot) {
    try {
      // NOTE: UiAutomation.executeShellCommand does NOT run a shell, so pipes/`grep` are
      // mis-parsed (the `| grep ...` becomes args to dumpsys and the call returns nothing).
      // Pass the full `dumpsys window` output to parseFocus, which already line-filters for
      // mFocusedApp/mCurrentFocus.
      String[] component = parseFocus(runShell("dumpsys window"));
      if (component == null) return;
      put(snapshot, "activity", component[1]);
      put(snapshot, "component", component[0] + "/" + component[1]);
    } catch (Throwable ignored) {
      // best-effort; leave activity/component unset
    }
  }

  private String runShell(String command) {
    try {
      ParcelFileDescriptor pfd = automation.executeShellCommand(command);
      try (InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd)) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = in.read(buffer)) >= 0) {
          out.write(buffer, 0, read);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
      }
    } catch (Throwable t) {
      return null;
    }
  }

  // Returns {packageName, fully-qualified activity} from dumpsys focus lines, or
  // null. Prefers mFocusedApp (the canonical foreground ActivityRecord — stays
  // correct when a dialog owns mCurrentFocus); falls back to mCurrentFocus.
  private static String[] parseFocus(String dump) {
    if (dump == null) return null;
    String[] lines = dump.split("\n");
    String[] component = firstMatchingFocus(lines, "mFocusedApp");
    if (component == null) component = firstMatchingFocus(lines, "mCurrentFocus");
    return component;
  }

  private static String[] firstMatchingFocus(String[] lines, String key) {
    for (String line : lines) {
      if (line == null || !line.contains(key)) continue;
      String[] component = matchFocus(line);
      if (component != null) return component;
    }
    return null;
  }

  private static String[] matchFocus(String line) {
    if (line == null) return null;
    Matcher matcher = FOCUS_PATTERN.matcher(line);
    if (!matcher.find()) return null;
    String packageName = matcher.group(1);
    String raw = matcher.group(2);
    String activity = raw.startsWith(".")
        ? packageName + raw
        : (raw.contains(".") ? raw : packageName + "." + raw);
    return new String[] { packageName, activity };
  }

  static Map<String, String> parseQuery(String query) throws Exception {
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

  static String first(Map<String, String> params, String primary, String alias) {
    String value = params.get(primary);
    if (value != null && !value.trim().isEmpty()) return value.trim();
    value = alias == null ? null : params.get(alias);
    return value == null || value.trim().isEmpty() ? null : value.trim();
  }

  private static final class ScreenshotOptions {
    final boolean jpeg;
    final int quality;

    ScreenshotOptions(boolean jpeg, int quality) {
      this.jpeg = jpeg;
      this.quality = Math.max(1, Math.min(100, quality));
    }

    static ScreenshotOptions fromQuery(String query) throws Exception {
      Map<String, String> params = parseQuery(query);
      String format = first(params, "format", "f");
      Integer quality = integer(params, "quality", "q");
      return new ScreenshotOptions("jpeg".equalsIgnoreCase(format) || "jpg".equalsIgnoreCase(format), quality == null ? 80 : quality);
    }

    private static Integer integer(Map<String, String> params, String primary, String alias) {
      String value = first(params, primary, alias);
      return value == null ? null : Integer.parseInt(value.trim());
    }
  }

  static final class Options {
    final boolean interactiveOnly;
    final boolean compact;
    final boolean raw;
    final Integer depth;
    final String scope;
    final int maxNodes;

    Options(boolean interactiveOnly, boolean compact, boolean raw, Integer depth, String scope, int maxNodes) {
      this.interactiveOnly = interactiveOnly;
      this.compact = compact;
      this.raw = raw;
      this.depth = depth;
      this.scope = scope;
      this.maxNodes = maxNodes <= 0 ? DEFAULT_MAX_NODES : maxNodes;
    }

    static Options fromQuery(String query) throws Exception {
      Map<String, String> params = parseQuery(query);
      return fromParams(params);
    }

    static Options fromParams(Map<String, String> params) throws Exception {
      Integer maxNodes = integer(params, "maxNodes", "limit");
      return new Options(
          bool(params, "interactiveOnly", "i"),
          bool(params, "compact", "c"),
          bool(params, "raw", null),
          integer(params, "depth", "d"),
          first(params, "scope", "s"),
          maxNodes == null ? DEFAULT_MAX_NODES : maxNodes);
    }

    private static boolean bool(Map<String, String> params, String primary, String alias) {
      String value = first(params, primary, alias);
      if (value == null) return false;
      String normalized = value.trim().toLowerCase(Locale.US);
      return "1".equals(normalized) || "true".equals(normalized) || "yes".equals(normalized) || "on".equals(normalized);
    }

    private static Integer integer(Map<String, String> params, String primary, String alias) {
      String value = first(params, primary, alias);
      return value == null ? null : Integer.parseInt(value.trim());
    }
  }

  static final class TreeNode {
    final AccessibilityNodeInfo info;
    final AccessibilityWindowInfo window;
    final TreeNode parent;
    final List<TreeNode> children = new ArrayList<>();
    DescendantGeometry descendantGeometry;

    TreeNode(AccessibilityNodeInfo info, AccessibilityWindowInfo window, TreeNode parent) {
      this.info = info;
      this.window = window;
      this.parent = parent;
    }

    void recycle() {
      for (TreeNode child : children) child.recycle();
      info.recycle();
    }
  }

  private static final class TreeDepth {
    final TreeNode node;
    final int depth;

    TreeDepth(TreeNode node, int depth) {
      this.node = node;
      this.depth = depth;
    }
  }

  private static final class TreeStats {
    final int rawNodeCount;
    final int maxDepth;

    TreeStats(int rawNodeCount, int maxDepth) {
      this.rawNodeCount = rawNodeCount;
      this.maxDepth = maxDepth;
    }
  }

  private static final class WalkState {
    final int maxNodes;
    boolean truncated = false;

    WalkState(int maxNodes) {
      this.maxNodes = maxNodes;
    }
  }

  private static final class HiddenContent {
    static final HiddenContent NONE = new HiddenContent(false, false);
    final boolean above;
    final boolean below;

    HiddenContent(boolean above, boolean below) {
      this.above = above;
      this.below = below;
    }
  }

  private static final class DescendantGeometry {
    static final DescendantGeometry EMPTY = new DescendantGeometry(false, 0, 0);
    final boolean hasBounds;
    final int minBottom;
    final int maxTop;

    DescendantGeometry(boolean hasBounds, int minBottom, int maxTop) {
      this.hasBounds = hasBounds;
      this.minBottom = minBottom;
      this.maxTop = maxTop;
    }
  }

  private static final class SnapshotMeta {
    final String packageName;
    final String appName;

    SnapshotMeta(String packageName, String appName) {
      this.packageName = packageName;
      this.appName = appName;
    }
  }
}
