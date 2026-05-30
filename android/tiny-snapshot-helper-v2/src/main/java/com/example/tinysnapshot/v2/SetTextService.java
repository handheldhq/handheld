package com.example.tinysnapshot.v2;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLDecoder;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class SetTextService {
  private static final int[] SET_TEXT_RETRY_DELAYS_MS = new int[] {0, 150, 350, 700};

  private final Context context;
  private final SnapshotService snapshotService;

  SetTextService(Context context, SnapshotService snapshotService) {
    this.context = context;
    this.snapshotService = snapshotService;
  }

  JSONObject setText(String body) throws Exception {
    SetTextResult result = performSetText(parseBody(body));
    JSONObject json = new JSONObject()
        .put("ok", result.ok)
        .put("kind", "setText")
        .put("mode", result.mode)
        .put("target", result.target)
        .put("clear", result.clear)
        .put("textLength", result.text == null ? 0 : result.text.length())
        .put("setTextAttempts", result.attempts)
        .put("targetStableId", result.targetStableId)
        .put("password", result.password)
        .put("clipboardSet", result.clipboardSet);
    if (!result.password && result.text != null) {
      json.put("expectedText", result.text);
    }
    if (!result.ok) {
      json.put("reason", result.reason)
          .put("message", result.message);
      if (result.supportedModes != null) json.put("supportedModes", result.supportedModes);
    }
    return json;
  }

  private SetTextResult performSetText(Map<String, String> params) throws Exception {
    String mode = first(params, "mode", null);
    JSONArray supportedModes = supportedSetTextModes();
    if (mode == null || mode.trim().isEmpty()) {
      return SetTextResult.failure("mode_required", "setText requires explicit mode=semantic or mode=paste")
          .withSupportedModes(supportedModes);
    }
    boolean semanticMode = "semantic".equalsIgnoreCase(mode);
    boolean pasteMode = "paste".equalsIgnoreCase(mode);
    if (!semanticMode && !pasteMode) {
      return SetTextResult.failure("unsupported_mode", "unsupported setText mode: " + mode)
          .withMode(mode)
          .withSupportedModes(supportedModes);
    }
    String normalizedMode = semanticMode ? "semantic" : "paste";
    String text = first(params, "text", "value");
    if (text == null) {
      return SetTextResult.failure("missing_text", "setText requires text or value").withMode(normalizedMode);
    }
    String clear = first(params, "clear", null);
    if (clear == null || clear.trim().isEmpty()) clear = "replace";
    if (semanticMode && !"replace".equalsIgnoreCase(clear)) {
      return SetTextResult.failure("unsupported_clear_mode", "semantic setText only supports clear=replace")
          .withMode("semantic")
          .withClear(clear);
    }
    if (pasteMode && !"replace".equalsIgnoreCase(clear) && !"append".equalsIgnoreCase(clear) && !"none".equalsIgnoreCase(clear)) {
      return SetTextResult.failure("unsupported_clear_mode", "paste setText supports clear=replace, clear=append, or clear=none")
          .withMode("paste")
          .withClear(clear);
    }
    String target = first(params, "target", null);
    if (target == null || target.trim().isEmpty()) target = "focused";

    SetTextResult result = null;
    for (int attempt = 0; attempt < SET_TEXT_RETRY_DELAYS_MS.length; attempt++) {
      int delay = SET_TEXT_RETRY_DELAYS_MS[attempt];
      if (delay > 0) SystemClock.sleep(delay);
      List<SnapshotService.TreeNode> roots = snapshotService.captureRootsWithRetry();
      try {
        result = performSetTextOnce(roots, params, target, clear, text, normalizedMode, semanticMode, pasteMode)
            .withAttempts(attempt + 1);
      } finally {
        SnapshotService.recycle(roots);
      }
      if (result.ok || !isRetryableSetTextFailure(result)) {
        return result;
      }
    }
    return result;
  }

  private SetTextResult performSetTextOnce(
      List<SnapshotService.TreeNode> roots,
      Map<String, String> params,
      String target,
      String clear,
      String text,
      String normalizedMode,
      boolean semanticMode,
      boolean pasteMode) {
    SnapshotService.TreeNode node = resolveSetTextTarget(roots, params, target);
    if (node == null) {
      return SetTextResult.failure("target_not_found", "could not resolve setText target")
          .withMode(normalizedMode)
          .withTarget(target)
          .withClear(clear)
          .withText(text);
    }
    AccessibilityNodeInfo info = node.info;
    String type = SnapshotService.className(info);
    boolean editable = info.isEditable() || SnapshotService.isEditableType(type);
    if (!editable) {
      return SetTextResult.failure("target_not_editable", "resolved target is not editable")
          .withMode(normalizedMode)
          .withTarget(target)
          .withClear(clear)
          .withText(text)
          .withNode(info);
    }
    if (!info.isVisibleToUser()) {
      return SetTextResult.failure("target_not_visible", "resolved target is not visible")
          .withMode(normalizedMode)
          .withTarget(target)
          .withClear(clear)
          .withText(text)
          .withNode(info);
    }
    if (!info.isFocused()) {
      info.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
      SystemClock.sleep(100);
    }
    if (semanticMode) {
      Bundle args = new Bundle();
      args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
      if (!info.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
        return SetTextResult.failure("perform_action_failed", "ACTION_SET_TEXT returned false")
            .withMode("semantic")
            .withTarget(target)
            .withClear(clear)
            .withText(text)
            .withNode(info);
      }
    } else {
      if ("replace".equalsIgnoreCase(clear)) {
        Bundle clearArgs = new Bundle();
        clearArgs.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "");
        info.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, clearArgs);
        SystemClock.sleep(50);
      }
      ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
      if (clipboard == null) {
        return SetTextResult.failure("clipboard_unavailable", "ClipboardManager is unavailable")
            .withMode("paste")
            .withTarget(target)
            .withClear(clear)
            .withText(text)
            .withNode(info);
      }
      clipboard.setPrimaryClip(ClipData.newPlainText("tiny-setText", text));
      if (!info.performAction(AccessibilityNodeInfo.ACTION_PASTE)) {
        return SetTextResult.failure("paste_action_failed", "ACTION_PASTE returned false")
            .withMode("paste")
            .withTarget(target)
            .withClear(clear)
            .withText(text)
            .withNode(info)
            .withClipboardSet(true);
      }
    }
    return SetTextResult.success(normalizedMode, target, clear, text, SnapshotService.stableIdOf(info), info.isPassword())
        .withClipboardSet(pasteMode);
  }

  private SnapshotService.TreeNode resolveSetTextTarget(List<SnapshotService.TreeNode> roots, Map<String, String> params, String target) {
    String stableId = first(params, "stableId", null);
    String actionableId = first(params, "actionableId", null);
    String selector = first(params, "selector", "scope");
    boolean hasExplicitIdentity = stableId != null || actionableId != null || selector != null;
    ArrayDeque<SnapshotService.TreeNode> queue = new ArrayDeque<>(roots);
    SnapshotService.TreeNode firstEditable = null;
    while (!queue.isEmpty()) {
      SnapshotService.TreeNode node = queue.removeFirst();
      AccessibilityNodeInfo info = node.info;
      boolean editable = info.isEditable() || SnapshotService.isEditableType(SnapshotService.className(info));
      if (editable && firstEditable == null) firstEditable = node;
      String nodeStableId = SnapshotService.stableIdOf(info);
      if (stableId != null && stableId.equals(nodeStableId)) return node;
      if (actionableId != null && actionableId.equals(nodeStableId)) return node;
      if (selector != null && editable && nodeMatchesSelector(info, selector)) return node;
      if (!hasExplicitIdentity && "focused".equalsIgnoreCase(target) && editable && (info.isFocused() || info.isAccessibilityFocused())) return node;
      queue.addAll(node.children);
    }
    if (!hasExplicitIdentity && "firstEditable".equalsIgnoreCase(target)) return firstEditable;
    return null;
  }

  private static boolean nodeMatchesSelector(AccessibilityNodeInfo info, String selector) {
    if (selector == null || selector.trim().isEmpty()) return false;
    String query = selector.toLowerCase(Locale.US);
    String text = SnapshotService.lower(SnapshotService.string(info.getText()));
    String desc = SnapshotService.lower(SnapshotService.string(info.getContentDescription()));
    String id = SnapshotService.lower(SnapshotService.string(info.getViewIdResourceName()));
    return text.contains(query) || desc.contains(query) || id.contains(query);
  }

  private static boolean isRetryableSetTextFailure(SetTextResult result) {
    return result != null
        && ("target_not_found".equals(result.reason)
            || "target_not_visible".equals(result.reason)
            || "perform_action_failed".equals(result.reason)
            || "paste_action_failed".equals(result.reason));
  }

  private static JSONArray supportedSetTextModes() {
    return new JSONArray().put("semantic").put("paste");
  }

  private static Map<String, String> parseBody(String body) throws Exception {
    if (body == null || body.trim().isEmpty()) {
      return new HashMap<>();
    }
    String trimmed = body.trim();
    if (trimmed.startsWith("{")) {
      JSONObject json = new JSONObject(trimmed);
      HashMap<String, String> result = new HashMap<>();
      Iterator<String> keys = json.keys();
      while (keys.hasNext()) {
        String key = keys.next();
        Object value = json.opt(key);
        if (value != null) result.put(key, String.valueOf(value));
      }
      return result;
    }
    HashMap<String, String> result = new HashMap<>();
    String[] parts = trimmed.split("&");
    for (String part : parts) {
      int equals = part.indexOf('=');
      String key = equals >= 0 ? part.substring(0, equals) : part;
      String value = equals >= 0 ? part.substring(equals + 1) : "true";
      result.put(URLDecoder.decode(key, "UTF-8"), URLDecoder.decode(value, "UTF-8"));
    }
    return result;
  }

  private static String first(Map<String, String> params, String primary, String alias) {
    return SnapshotService.first(params, primary, alias);
  }

  private static final class SetTextResult {
    final boolean ok;
    final String reason;
    final String message;
    final String mode;
    final String target;
    final String clear;
    final String text;
    final String targetStableId;
    final boolean password;
    final int attempts;
    boolean clipboardSet;
    JSONArray supportedModes;

    SetTextResult(boolean ok, String reason, String message, String mode, String target, String clear, String text, String targetStableId, boolean password, int attempts) {
      this.ok = ok;
      this.reason = reason;
      this.message = message;
      this.mode = mode;
      this.target = target;
      this.clear = clear;
      this.text = text;
      this.targetStableId = targetStableId;
      this.password = password;
      this.attempts = attempts;
    }

    static SetTextResult success(String mode, String target, String clear, String text, String targetStableId, boolean password) {
      return new SetTextResult(true, null, null, mode, target, clear, text, targetStableId, password, 1);
    }

    static SetTextResult failure(String reason, String message) {
      return new SetTextResult(false, reason, message, null, null, null, null, null, false, 1);
    }

    SetTextResult withMode(String value) {
      return copy(value, target, clear, text, targetStableId, password);
    }

    SetTextResult withTarget(String value) {
      return copy(mode, value, clear, text, targetStableId, password);
    }

    SetTextResult withClear(String value) {
      return copy(mode, target, value, text, targetStableId, password);
    }

    SetTextResult withText(String value) {
      return copy(mode, target, clear, value, targetStableId, password);
    }

    SetTextResult withNode(AccessibilityNodeInfo info) {
      return copy(mode, target, clear, text, info == null ? targetStableId : SnapshotService.stableIdOf(info), info != null && info.isPassword());
    }

    SetTextResult withSupportedModes(JSONArray modes) {
      supportedModes = modes;
      return this;
    }

    SetTextResult withAttempts(int value) {
      return copy(mode, target, clear, text, targetStableId, password).copyWithAttempts(value);
    }

    SetTextResult withClipboardSet(boolean value) {
      clipboardSet = value;
      return this;
    }

    private SetTextResult copy(String nextMode, String nextTarget, String nextClear, String nextText, String nextStableId, boolean nextPassword) {
      SetTextResult result = new SetTextResult(ok, reason, message, nextMode, nextTarget, nextClear, nextText, nextStableId, nextPassword, attempts);
      result.supportedModes = supportedModes;
      result.clipboardSet = clipboardSet;
      return result;
    }

    private SetTextResult copyWithAttempts(int value) {
      SetTextResult result = new SetTextResult(ok, reason, message, mode, target, clear, text, targetStableId, password, value);
      result.supportedModes = supportedModes;
      result.clipboardSet = clipboardSet;
      return result;
    }
  }
}
