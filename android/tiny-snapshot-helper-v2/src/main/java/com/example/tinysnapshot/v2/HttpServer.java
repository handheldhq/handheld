package com.example.tinysnapshot.v2;

import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

final class HttpServer {
  private static final String TAG = "TinySnapshot";
  private static final int ACCEPT_TIMEOUT_MS = 500;
  private static final int SOCKET_READ_TIMEOUT_MS = 10000;
  private static final int MAX_REQUEST_BODY_BYTES = 1024 * 1024;
  private static final int MAX_REQUEST_HEAD_BYTES = 64 * 1024;

  interface Running {
    boolean get();
  }

  interface Handler {
    void handle(Exchange exchange) throws Exception;
  }

  private final int port;
  private final Running running;
  private final Handler handler;
  private final AtomicInteger activeRequests = new AtomicInteger(0);
  private final AtomicLong requestSeq = new AtomicLong(0);
  private final AtomicLong totalRequests = new AtomicLong(0);
  private volatile String lastRequest = "";
  private volatile String lastError = "";

  HttpServer(int port, Running running, Handler handler) {
    this.port = port;
    this.running = running;
    this.handler = handler;
  }

  void serve() throws Exception {
    try (ServerSocket server = new ServerSocket()) {
      server.setReuseAddress(true);
      server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
      server.setSoTimeout(ACCEPT_TIMEOUT_MS);
      Log.i(TAG, "HTTP server listening on port " + port);
      while (running.get()) {
        try {
          Socket socket = server.accept();
          long requestId = requestSeq.incrementAndGet();
          Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
              handleSocket(socket, requestId);
            }
          }, "TinyHttp-" + requestId);
          thread.setDaemon(true);
          thread.start();
        } catch (SocketTimeoutException ignored) {
        }
      }
    }
  }

  JSONObject diagnosticsJson() throws Exception {
    return new JSONObject()
        .put("activeRequests", activeRequests.get())
        .put("totalRequests", totalRequests.get())
        .put("lastRequest", lastRequest)
        .put("lastError", lastError)
        .put("socketReadTimeoutMs", SOCKET_READ_TIMEOUT_MS);
  }

  private void handleSocket(Socket socket, long requestId) {
    long started = System.currentTimeMillis();
    Exchange exchange = null;
    activeRequests.incrementAndGet();
    totalRequests.incrementAndGet();
    try {
      socket.setSoTimeout(SOCKET_READ_TIMEOUT_MS);
      exchange = Exchange.read(socket);
      if (exchange == null) {
        lastRequest = "#" + requestId + " empty request";
        Log.w(TAG, lastRequest);
        return;
      }
      String label = "#" + requestId + " " + exchange.method + " " + exchange.path;
      lastRequest = label + " started";
      Log.i(TAG, "request started " + label);
      handler.handle(exchange);
      lastRequest = label + " completed in " + (System.currentTimeMillis() - started) + "ms";
      if (!exchange.responseWritten) {
        String message = label + " completed without writing a response";
        lastError = message;
        Log.e(TAG, message);
      }
    } catch (Throwable error) {
      lastError = "#" + requestId + " failed after " + (System.currentTimeMillis() - started) + "ms: " + errorMessage(error);
      Log.e(TAG, lastError, error);
      writeFailure(socket, exchange, error);
    } finally {
      activeRequests.decrementAndGet();
      try {
        socket.close();
      } catch (Throwable ignored) {
      }
    }
  }

  private static void writeFailure(Socket socket, Exchange exchange, Throwable error) {
    try {
      JSONObject json = new JSONObject()
          .put("ok", false)
          .put("message", errorMessage(error))
          .put("errorType", error.getClass().getName());
      if (exchange != null) {
        if (!exchange.responseWritten) {
          exchange.writeJson(500, json);
        }
      } else if (socket != null && !socket.isClosed()) {
        writeRawJson(socket, 500, json);
      }
    } catch (Throwable writeError) {
      Log.e(TAG, "could not write failure response: " + errorMessage(writeError), writeError);
    }
  }

  private static void writeRawJson(Socket socket, int status, JSONObject json) throws Exception {
    byte[] responseBody = json.toString().getBytes(StandardCharsets.UTF_8);
    String headers = "HTTP/1.1 " + status + " " + Exchange.reason(status) + "\r\n"
        + "Content-Type: application/json\r\n"
        + "Content-Length: " + responseBody.length + "\r\n"
        + "Connection: close\r\n\r\n";
    OutputStream output = socket.getOutputStream();
    output.write(headers.getBytes(StandardCharsets.UTF_8));
    output.write(responseBody);
    output.flush();
  }

  private static String errorMessage(Throwable error) {
    String message = error.getMessage();
    return message == null || message.trim().isEmpty() ? error.getClass().getName() : message;
  }

  static final class Exchange {
    final Socket socket;
    final String method;
    final String path;
    final String query;
    final Map<String, String> headers;
    final String body;
    private boolean responseWritten = false;

    private Exchange(Socket socket, String method, String path, String query, Map<String, String> headers, String body) {
      this.socket = socket;
      this.method = method;
      this.path = path;
      this.query = query;
      this.headers = headers;
      this.body = body;
    }

    static Exchange read(Socket socket) throws Exception {
      InputStream input = socket.getInputStream();
      // Read the request head (request line + headers) as raw bytes up to the
      // terminating CRLFCRLF, then read the body as exactly Content-Length
      // BYTES (see readRequestBody). Decoding the whole request through a char
      // reader and treating Content-Length as a char count stalls on multibyte
      // UTF-8 bodies — the byte count exceeds the char count, so the reader
      // blocks waiting for chars that never arrive and the socket times out.
      ByteArrayOutputStream head = new ByteArrayOutputStream();
      int matched = 0;
      int b;
      while ((b = input.read()) != -1) {
        head.write(b);
        if (b == "\r\n\r\n".charAt(matched)) {
          matched += 1;
          if (matched == 4) break;
        } else {
          matched = (b == '\r') ? 1 : 0;
        }
        if (head.size() > MAX_REQUEST_HEAD_BYTES) {
          throw new IllegalArgumentException("request head too large");
        }
      }
      if (head.size() == 0) {
        return null;
      }
      String[] lines = new String(head.toByteArray(), StandardCharsets.UTF_8).split("\r\n");
      String requestLine = lines.length > 0 ? lines[0] : "";
      if (requestLine.isEmpty()) {
        return null;
      }
      Map<String, String> headers = new HashMap<>();
      for (int i = 1; i < lines.length; i += 1) {
        String line = lines[i];
        if (line.isEmpty()) continue;
        int colon = line.indexOf(':');
        if (colon > 0) {
          headers.put(line.substring(0, colon).trim().toLowerCase(Locale.US), line.substring(colon + 1).trim());
        }
      }

      String body = readRequestBody(input, headers);
      String[] parts = requestLine.split(" ");
      String method = parts.length > 0 ? parts[0].toUpperCase(Locale.US) : "GET";
      String target = parts.length > 1 ? parts[1] : "/";
      String path = target;
      String query = "";
      int q = target.indexOf('?');
      if (q >= 0) {
        path = target.substring(0, q);
        query = target.substring(q + 1);
      }
      return new Exchange(socket, method, path, query, headers, body);
    }

    String header(String name) {
      if (name == null) return null;
      return headers.get(name.toLowerCase(Locale.US));
    }

    void writeJson(int status, JSONObject json) throws Exception {
      byte[] responseBody = json.toString().getBytes(StandardCharsets.UTF_8);
      String headers = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
          + "Content-Type: application/json\r\n"
          + "Content-Length: " + responseBody.length + "\r\n"
          + "Connection: close\r\n\r\n";
      OutputStream output = socket.getOutputStream();
      output.write(headers.getBytes(StandardCharsets.UTF_8));
      output.write(responseBody);
      output.flush();
      responseWritten = true;
    }

    private static String readRequestBody(InputStream input, Map<String, String> headers) throws Exception {
      String value = headers.get("content-length");
      if (value == null) return "";
      int length = Math.max(0, Integer.parseInt(value.trim()));
      if (length == 0) return "";
      if (length > MAX_REQUEST_BODY_BYTES) {
        throw new IllegalArgumentException("request body too large");
      }
      byte[] buffer = new byte[length];
      int offset = 0;
      while (offset < length) {
        int n = input.read(buffer, offset, length - offset);
        if (n < 0) break;
        offset += n;
      }
      // Content-Length is a byte count; decode the exact bytes as UTF-8 so
      // multibyte text (accents, CJK, emoji) round-trips intact.
      return new String(buffer, 0, offset, StandardCharsets.UTF_8);
    }

    private static String reason(int status) {
      if (status == 200) return "OK";
      if (status == 400) return "Bad Request";
      if (status == 403) return "Forbidden";
      if (status == 404) return "Not Found";
      if (status == 405) return "Method Not Allowed";
      if (status == 413) return "Payload Too Large";
      if (status >= 500) return "Internal Server Error";
      return "OK";
    }
  }
}
