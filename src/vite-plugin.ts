/**
 * Vite plugin for debug-toolkit.
 * Injects console/error/network capture directly into HTML served by Vite.
 *
 * This is critical for Tauri/Electron apps where the webview loads from
 * the Vite dev server directly (not through the debug-toolkit proxy).
 *
 * Usage in vite.config.ts:
 *   import debugToolkit from 'debug-toolkit/vite-plugin';
 *   export default defineConfig({ plugins: [debugToolkit()] });
 *
 * Or auto-configured by `npx debug-toolkit init` for Tauri projects.
 */

import type { Plugin } from "vite";

export interface DebugToolkitPluginOptions {
  /** Port the debug-toolkit proxy WebSocket listens on. Default: auto-detect from env or 2420 */
  wsPort?: number;
  /** Disable in production builds. Default: true (only active in dev) */
  devOnly?: boolean;
}

export default function debugToolkitPlugin(opts: DebugToolkitPluginOptions = {}): Plugin {
  const devOnly = opts.devOnly ?? true;
  let wsPort = opts.wsPort ?? parseInt(process.env.DEBUG_TOOLKIT_WS_PORT ?? "0", 10);

  return {
    name: "debug-toolkit",
    apply: devOnly ? "serve" : undefined,

    configResolved(config) {
      // Auto-detect WS port: proxy listens on devServerPort + 1000
      if (!wsPort && config.server?.port) {
        wsPort = config.server.port + 1000;
      }
      if (!wsPort) {
        wsPort = 2420; // fallback
      }
    },

    transformIndexHtml() {
      // Inline the capture script — connects back to toolkit's WebSocket
      const script = buildInlineScript(wsPort);
      return [
        {
          tag: "script",
          attrs: { "data-debug-toolkit": "true" },
          children: script,
          injectTo: "body",
        },
      ];
    },
  };
}

function buildInlineScript(wsPort: number): string {
  return `
(function() {
  "use strict";
  if (window.__debug_toolkit_injected) return;
  window.__debug_toolkit_injected = true;

  var wsUrl = "ws://127.0.0.1:${wsPort}/__debug_toolkit/ws";
  var ws;
  var queue = [];
  var reconnectAttempts = 0;
  var maxReconnects = 5;

  function send(type, data) {
    var msg = JSON.stringify({ type: type, data: data, ts: Date.now() });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    } else {
      queue.push(msg);
      if (queue.length > 100) queue.shift();
    }
  }

  function connect() {
    try { ws = new WebSocket(wsUrl); } catch (_) { return; }
    ws.addEventListener("open", function() {
      reconnectAttempts = 0;
      send("console", { level: "info", args: ["[debug-toolkit] Connected to capture server"] });
      for (var i = 0; i < queue.length; i++) ws.send(queue[i]);
      queue = [];
    });
    ws.addEventListener("close", function() {
      if (reconnectAttempts >= maxReconnects) return;
      var delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 16000);
      reconnectAttempts++;
      setTimeout(connect, delay);
    });
    ws.addEventListener("error", function() {});
  }
  connect();

  // Console capture
  ["log", "warn", "error", "info", "debug"].forEach(function(method) {
    var orig = console[method];
    console[method] = function() {
      var args = Array.prototype.slice.call(arguments);
      send("console", {
        level: method,
        args: args.map(function(a) {
          try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
          catch (_) { return "[unserializable]"; }
        })
      });
      return orig.apply(console, arguments);
    };
  });

  // Error capture
  window.addEventListener("error", function(e) {
    send("error", { message: e.message, source: e.filename, line: e.lineno, column: e.colno });
  });
  window.addEventListener("unhandledrejection", function(e) {
    send("error", { message: e.reason ? String(e.reason) : "Unhandled promise rejection", type: "unhandledrejection" });
  });

  // Fetch failure capture
  var origFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    var url = String(args[0] && args[0].url ? args[0].url : args[0]);
    var method = (args[1] && args[1].method) || (args[0] && args[0].method) || "GET";
    return origFetch.apply(this, args).then(
      function(res) {
        if (!res.ok) send("network", { url: url, method: method, status: res.status, statusText: res.statusText });
        return res;
      },
      function(err) {
        send("network", { url: url, method: method, error: err.message || String(err) });
        throw err;
      }
    );
  };

  // XHR failure capture
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._dbg_method = method;
    this._dbg_url = String(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    var self = this;
    self.addEventListener("load", function() {
      if (self.status >= 400) send("network", { url: self._dbg_url, method: self._dbg_method, status: self.status, statusText: self.statusText });
    });
    self.addEventListener("error", function() {
      send("network", { url: self._dbg_url, method: self._dbg_method, error: "Network error" });
    });
    return origSend.apply(this, arguments);
  };
})();
`.trim();
}
