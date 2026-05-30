package com.example.tinysnapshot.v2;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;

import org.json.JSONObject;

/**
 * System clipboard get/set from inside the instrumentation. `cmd clipboard` is
 * unimplemented on API 31+, so the host can't manage the clipboard over ADB;
 * doing it in-process via ClipboardManager is the reliable path.
 *
 * Note: reading the clipboard (get) is restricted to the foreground app or the
 * default IME on API 29+, so get may return no text from this background
 * instrumentation — that limitation is reported via `restricted`. Setting the
 * clipboard works (the same call backs paste-mode setText).
 */
final class ClipboardService {
  private final Context context;

  ClipboardService(Context context) {
    this.context = context;
  }

  JSONObject get() throws Exception {
    ClipboardManager clipboard = clipboardManager();
    if (clipboard == null) {
      return new JSONObject().put("ok", false).put("reason", "clipboard_unavailable");
    }
    ClipData clip = clipboard.getPrimaryClip();
    if (clip == null || clip.getItemCount() == 0) {
      // Either genuinely empty, or the API 29+ read restriction hid it.
      return new JSONObject()
          .put("ok", true)
          .put("hasText", false)
          .put("restricted", !clipboard.hasPrimaryClip());
    }
    CharSequence text = clip.getItemAt(0).coerceToText(context);
    return new JSONObject()
        .put("ok", true)
        .put("hasText", text != null)
        .put("text", text == null ? "" : text.toString());
  }

  JSONObject set(String text) throws Exception {
    if (text == null) {
      return new JSONObject().put("ok", false).put("reason", "missing_text");
    }
    ClipboardManager clipboard = clipboardManager();
    if (clipboard == null) {
      return new JSONObject().put("ok", false).put("reason", "clipboard_unavailable");
    }
    clipboard.setPrimaryClip(ClipData.newPlainText("tiny-clipboard", text));
    return new JSONObject().put("ok", true).put("textLength", text.length());
  }

  private ClipboardManager clipboardManager() {
    return (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
  }
}
