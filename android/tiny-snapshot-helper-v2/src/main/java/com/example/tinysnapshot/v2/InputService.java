package com.example.tinysnapshot.v2;

import android.app.UiAutomation;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Random;

/**
 * Pointer injection from inside the resident instrumentation, via the live
 * UiAutomation. Unlike a one-shot `am instrument` gesture helper (which crashes on
 * the getUiAutomation/finish disconnect race), Tiny holds one UiAutomation for its
 * whole life, so taps/swipes/multi-touch all inject from the same owner — no
 * second instrumentation, no UiAutomation contention.
 *
 * Single source of truth for all pointer input. Supports humanized strokes (cubic
 * bezier paths, ease-in-out velocity, positional jitter, variable dwell/pressure)
 * so emitted MotionEvents resemble a finger, not a teleport. humanize defaults on;
 * humanize=false gives deterministic straight/linear strokes for tests.
 */
final class InputService {
  private static final int MOVE_FRAME_MS = 12;        // ~83 Hz move sampling
  private static final int MIN_DURATION_MS = 1;
  private static final int MAX_DURATION_MS = 60_000;
  private static final int DEFAULT_RADIUS = 160;
  private static final int MIN_RADIUS = 24;
  private static final int MAX_RADIUS = 1200;

  private final UiAutomation automation;

  InputService(UiAutomation automation) {
    this.automation = automation;
  }

  JSONObject inject(String body) throws Exception {
    JSONObject p = (body == null || body.trim().isEmpty()) ? new JSONObject() : new JSONObject(body);
    String type = p.optString("type", "").trim();
    boolean humanize = p.optBoolean("humanize", true);
    long seed = p.has("seed") ? p.getLong("seed") : System.nanoTime();
    Random rng = new Random(seed);
    long started = System.currentTimeMillis();
    int events;
    switch (type) {
      case "tap": events = tap(p, humanize, rng); break;
      case "longPress": events = longPress(p, humanize, rng); break;
      case "swipe":
      case "scroll": events = swipe(p, humanize, rng); break;
      case "path": events = path(p, humanize, rng); break;
      case "pinch":
      case "rotate":
      case "transform": events = gesture(type, p, humanize, rng); break;
      default:
        return new JSONObject().put("ok", false).put("reason", "unsupported_type")
            .put("message", "unsupported input type: " + (type.isEmpty() ? "(missing)" : type));
    }
    return new JSONObject()
        .put("ok", true).put("kind", "input").put("type", type)
        .put("injectedEvents", events).put("humanized", humanize).put("seed", seed)
        .put("elapsedMs", System.currentTimeMillis() - started);
  }

  // --- single-pointer actions ---
  private int tap(JSONObject p, boolean humanize, Random rng) throws JSONException {
    double x = p.getDouble("x"), y = p.getDouble("y");
    long dwell = p.has("durationMs") ? clampDuration(p.getLong("durationMs"))
        : (humanize ? 40 + rng.nextInt(80) : 30);
    if (humanize) { x += jitter(rng, 2.0); y += jitter(rng, 2.0); }
    long downTime = SystemClock.uptimeMillis();
    int n = 0;
    inject(action(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, pressure(humanize, rng)), true); n++;
    // a tiny intra-press wobble reads more human than a perfectly still hold
    if (humanize && dwell > 50) {
      long mid = downTime + dwell / 2;
      paceTo(mid);
      inject(action(downTime, mid, MotionEvent.ACTION_MOVE, x + jitter(rng, 1.0), y + jitter(rng, 1.0), pressure(humanize, rng)), false); n++;
    }
    paceTo(downTime + dwell);  // real dwell so the timestamp gap is real arrival-time too
    inject(action(downTime, downTime + dwell, MotionEvent.ACTION_UP, x, y, 1.0f), true); n++;
    return n;
  }

  private int longPress(JSONObject p, boolean humanize, Random rng) throws JSONException {
    double x = p.getDouble("x"), y = p.getDouble("y");
    long dur = clampDuration(p.has("durationMs") ? p.getLong("durationMs") : 700);
    long downTime = SystemClock.uptimeMillis();
    int n = 0;
    inject(action(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, pressure(humanize, rng)), true); n++;
    // keep the stream alive with small holds so the gesture isn't treated as a tap
    int holds = (int) Math.max(2, dur / 100);
    for (int i = 1; i < holds; i++) {
      double jx = humanize ? x + jitter(rng, 1.5) : x;
      double jy = humanize ? y + jitter(rng, 1.5) : y;
      long et = downTime + dur * i / holds;
      paceTo(et);  // real hold so the OS long-press timer (≈500ms) actually fires
      inject(action(downTime, et, MotionEvent.ACTION_MOVE, jx, jy, pressure(humanize, rng)), false); n++;
    }
    paceTo(downTime + dur);
    inject(action(downTime, downTime + dur, MotionEvent.ACTION_UP, x, y, 1.0f), true); n++;
    return n;
  }

  private int swipe(JSONObject p, boolean humanize, Random rng) throws JSONException {
    double x1 = p.getDouble("x1"), y1 = p.getDouble("y1");
    double x2 = p.getDouble("x2"), y2 = p.getDouble("y2");
    long dur = clampDuration(p.has("durationMs") ? p.getLong("durationMs") : 250);
    double[][] pts = humanize ? bezierStroke(x1, y1, x2, y2, dur, rng)
        : linearStroke(x1, y1, x2, y2, dur);
    return stroke(pts, dur, humanize, rng);
  }

  private int path(JSONObject p, boolean humanize, Random rng) throws JSONException {
    JSONArray pts = p.getJSONArray("points");
    long dur = clampDuration(p.has("durationMs") ? p.getLong("durationMs") : 300);
    int n = pts.length();
    if (n < 2) throw new IllegalArgumentException("path requires >= 2 points");
    // Resample the supplied polyline at frame cadence (with ease-in-out + jitter when
    // humanizing) so callers can pass a few waypoints and still get a smooth stroke.
    double[] xs = new double[n], ys = new double[n];
    for (int i = 0; i < n; i++) { JSONArray pt = pts.getJSONArray(i); xs[i] = pt.getDouble(0); ys[i] = pt.getDouble(1); }
    int frames = frameCount(dur);
    double[][] out = new double[frames][2];
    for (int i = 0; i < frames; i++) {
      double t = frames == 1 ? 1.0 : (double) i / (frames - 1);
      double tt = humanize ? easeInOut(t) : t;
      double[] pos = polylineAt(xs, ys, tt);
      if (humanize && i > 0 && i < frames - 1) { pos[0] += jitter(rng, 1.5); pos[1] += jitter(rng, 1.5); }
      out[i] = pos;
    }
    return stroke(out, dur, humanize, rng);
  }

  /** Inject DOWN → MOVE(samples) → UP along an explicit sample list. */
  private int stroke(double[][] pts, long dur, boolean humanize, Random rng) {
    long downTime = SystemClock.uptimeMillis();
    int n = 0;
    inject(action(downTime, downTime, MotionEvent.ACTION_DOWN, pts[0][0], pts[0][1], pressure(humanize, rng)), true); n++;
    for (int i = 1; i < pts.length - 1; i++) {
      long et = downTime + Math.round(dur * (double) i / (pts.length - 1));
      paceTo(et);  // pace to wall-clock so velocity/fling + arrival timing are real
      inject(action(downTime, et, MotionEvent.ACTION_MOVE, pts[i][0], pts[i][1], pressure(humanize, rng)), false); n++;
    }
    double[] last = pts[pts.length - 1];
    paceTo(downTime + dur);
    inject(action(downTime, downTime + dur, MotionEvent.ACTION_MOVE, last[0], last[1], pressure(humanize, rng)), false); n++;
    inject(action(downTime, downTime + dur, MotionEvent.ACTION_UP, last[0], last[1], 1.0f), true); n++;
    return n;
  }

  private static void paceTo(long targetUptimeMs) {
    long delta = targetUptimeMs - SystemClock.uptimeMillis();
    if (delta > 0) SystemClock.sleep(delta);
  }

  // --- multi-pointer gestures (ported from android-multitouch-helper, MIT) ---
  private int gesture(String kind, JSONObject p, boolean humanize, Random rng) throws JSONException {
    int x = p.getInt("x"), y = p.getInt("y");
    int dx = p.optInt("dx", 0), dy = p.optInt("dy", 0);
    long dur = clampDuration(p.has("durationMs") ? p.getLong("durationMs") : 300);
    int radius = (int) Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, p.optInt("radius", DEFAULT_RADIUS)));
    double scale = p.optDouble("scale", 1.0);
    double degrees = p.optDouble("degrees", 0.0);
    if (("pinch".equals(kind) || "transform".equals(kind)) && !(scale > 0))
      throw new IllegalArgumentException("scale must be > 0");

    long downTime = SystemClock.uptimeMillis();
    long et = downTime;
    float[][] start = pair(kind, x, y, dx, dy, scale, degrees, radius, 0.0);
    float[][] end = pair(kind, x, y, dx, dy, scale, degrees, radius, 1.0);
    int n = 0;
    inject(multi(downTime, et, MotionEvent.ACTION_DOWN, one(start)), true); n++;
    et += 8;
    inject(multi(downTime, et, MotionEvent.ACTION_POINTER_DOWN | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT), start), true); n++;
    int frames = frameCount(dur);
    for (int i = 1; i < frames; i++) {
      double t = (double) i / frames;
      if (humanize) t = easeInOut(t);
      et = downTime + Math.round(dur * (double) i / frames);
      paceTo(et);  // real-time pacing: two-finger velocity is computed from arrival cadence
      inject(multi(downTime, et, MotionEvent.ACTION_MOVE, pair(kind, x, y, dx, dy, scale, degrees, radius, t)), false); n++;
    }
    paceTo(downTime + dur);
    et = downTime + dur;
    inject(multi(downTime, et, MotionEvent.ACTION_POINTER_UP | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT), end), true); n++;
    inject(multi(downTime, et + 8, MotionEvent.ACTION_UP, one(end)), true); n++;
    return n;
  }

  private static float[][] pair(String kind, int x, int y, int dx, int dy, double scale, double degrees, int radius, double t) {
    if ("pinch".equals(kind)) {
      double sr = scale >= 1.0 ? radius / scale : radius;
      double er = scale >= 1.0 ? radius : radius * scale;
      double r = sr + (er - sr) * t;
      return new float[][] {{(float) (x - r), (float) (x + r)}, {(float) y, (float) y}};
    }
    double cx = x, cy = y, r = radius;
    if ("transform".equals(kind)) {
      cx = x + dx * t; cy = y + dy * t;
      double sr = scale >= 1.0 ? radius / scale : radius;
      double er = scale >= 1.0 ? radius : radius * scale;
      r = sr + (er - sr) * t;
    }
    double a = Math.toRadians(-90 + degrees * t);
    return new float[][] {
      {(float) (cx + Math.cos(a) * r), (float) (cx - Math.cos(a) * r)},
      {(float) (cy + Math.sin(a) * r), (float) (cy - Math.sin(a) * r)}
    };
  }

  private static float[][] one(float[][] pair) {
    return new float[][] {{pair[0][0]}, {pair[1][0]}};
  }

  // --- MotionEvent construction + injection ---
  private MotionEvent action(long downTime, long eventTime, int action, double x, double y, float pressure) {
    return multiP(downTime, eventTime, action, new float[] {(float) x}, new float[] {(float) y}, pressure);
  }

  private MotionEvent multi(long downTime, long eventTime, int action, float[][] xy) {
    return multiP(downTime, eventTime, action, xy[0], xy[1], 1.0f);
  }

  private MotionEvent multiP(long downTime, long eventTime, int action, float[] xs, float[] ys, float pressure) {
    int count = xs.length;
    MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[count];
    MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[count];
    for (int i = 0; i < count; i++) {
      props[i] = new MotionEvent.PointerProperties();
      props[i].id = i;
      props[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
      coords[i] = new MotionEvent.PointerCoords();
      coords[i].x = xs[i];
      coords[i].y = ys[i];
      coords[i].pressure = pressure;
      coords[i].size = 1.0f;
    }
    MotionEvent e = MotionEvent.obtain(downTime, eventTime, action, count, props, coords,
        0, 0, 1.0f, 1.0f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
    e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    return e;
  }

  private void inject(MotionEvent event, boolean sync) {
    try {
      if (!automation.injectInputEvent(event, sync)) {
        throw new IllegalStateException("injectInputEvent returned false");
      }
    } finally {
      event.recycle();
    }
  }

  // --- humanization helpers ---
  private static double[][] linearStroke(double x1, double y1, double x2, double y2, long dur) {
    int frames = frameCount(dur);
    double[][] out = new double[frames][2];
    for (int i = 0; i < frames; i++) {
      double t = frames == 1 ? 1.0 : (double) i / (frames - 1);
      out[i] = new double[] {x1 + (x2 - x1) * t, y1 + (y2 - y1) * t};
    }
    return out;
  }

  /** Cubic bezier from start to end with perpendicular-offset control points, sampled
   *  with ease-in-out timing + light jitter — a finger-like arc, not a straight line. */
  private static double[][] bezierStroke(double x1, double y1, double x2, double y2, long dur, Random rng) {
    double dx = x2 - x1, dy = y2 - y1;
    double dist = Math.hypot(dx, dy);
    double px = dist == 0 ? 0 : -dy / dist, py = dist == 0 ? 0 : dx / dist;  // unit perpendicular
    double off1 = (rng.nextDouble() - 0.5) * dist * 0.2;
    double off2 = (rng.nextDouble() - 0.5) * dist * 0.2;
    double c1x = x1 + dx * 0.33 + px * off1, c1y = y1 + dy * 0.33 + py * off1;
    double c2x = x1 + dx * 0.66 + px * off2, c2y = y1 + dy * 0.66 + py * off2;
    int frames = frameCount(dur);
    double[][] out = new double[frames][2];
    for (int i = 0; i < frames; i++) {
      double t = frames == 1 ? 1.0 : (double) i / (frames - 1);
      double tt = easeInOut(t);
      double u = 1 - tt;
      double bx = u * u * u * x1 + 3 * u * u * tt * c1x + 3 * u * tt * tt * c2x + tt * tt * tt * x2;
      double by = u * u * u * y1 + 3 * u * u * tt * c1y + 3 * u * tt * tt * c2y + tt * tt * tt * y2;
      if (i > 0 && i < frames - 1) { bx += jitter(rng, 1.5); by += jitter(rng, 1.5); }
      out[i] = new double[] {bx, by};
    }
    out[frames - 1] = new double[] {x2, y2};  // land exactly on target
    return out;
  }

  private static double[] polylineAt(double[] xs, double[] ys, double t) {
    int segs = xs.length - 1;
    double pos = t * segs;
    int i = (int) Math.floor(pos);
    if (i >= segs) return new double[] {xs[segs], ys[segs]};
    double f = pos - i;
    return new double[] {xs[i] + (xs[i + 1] - xs[i]) * f, ys[i] + (ys[i + 1] - ys[i]) * f};
  }

  private static int frameCount(long dur) {
    return (int) Math.max(2, Math.min(600, dur / MOVE_FRAME_MS));
  }

  private static double easeInOut(double t) {
    return (1 - Math.cos(Math.PI * t)) / 2.0;  // cosine smoothstep
  }

  private static double jitter(Random rng, double mag) {
    return (rng.nextDouble() - 0.5) * 2 * mag;
  }

  private static float pressure(boolean humanize, Random rng) {
    return humanize ? (float) (0.85 + rng.nextDouble() * 0.15) : 1.0f;
  }

  private static long clampDuration(long ms) {
    return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, ms));
  }
}
