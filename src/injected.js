(function () {
  "use strict";

  var wsUrl =
    "ws://" + location.hostname + ":" + location.port + "/__stackpack_debug/ws";
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
      if (queue.length > 100) queue.shift(); // Prevent unbounded queue growth
    }
  }

  function connect() {
    try {
      ws = new WebSocket(wsUrl);
    } catch (_) {
      return;
    }

    ws.addEventListener("open", function () {
      reconnectAttempts = 0;
      for (var i = 0; i < queue.length; i++) {
        ws.send(queue[i]);
      }
      queue = [];
    });

    ws.addEventListener("close", function () {
      if (reconnectAttempts >= maxReconnects) return;
      var delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 16000);
      reconnectAttempts++;
      setTimeout(connect, delay);
    });

    ws.addEventListener("error", function () {
      // Errors are followed by close events, so reconnect logic handles it
    });
  }

  connect();

  // --- Console capture ---
  var methods = ["log", "warn", "error", "info", "debug"];
  methods.forEach(function (method) {
    var orig = console[method];
    console[method] = function () {
      var args = Array.prototype.slice.call(arguments);
      send("console", {
        level: method,
        args: args.map(function (a) {
          try {
            return typeof a === "object" ? JSON.stringify(a) : String(a);
          } catch (_) {
            return "[unserializable]";
          }
        }),
      });
      return orig.apply(console, arguments);
    };
  });

  // --- Error capture ---
  window.addEventListener("error", function (e) {
    send("error", {
      message: e.message,
      source: e.filename,
      line: e.lineno,
      column: e.colno,
    });
  });

  window.addEventListener("unhandledrejection", function (e) {
    send("error", {
      message: e.reason ? String(e.reason) : "Unhandled promise rejection",
      type: "unhandledrejection",
    });
  });

  // --- Network capture (fetch) ---
  // Track API calls for provider/endpoint visibility, not just failures
  var origFetch = window.fetch;
  function isApiCall(url) {
    return /\/api\/|anthropic\.com|openai\.com|localhost:\d{4,5}\/v1\//i.test(url);
  }
  window.fetch = function () {
    var args = arguments;
    var url = String(args[0] && args[0].url ? args[0].url : args[0]);
    var method =
      (args[1] && args[1].method) ||
      (args[0] && args[0].method) ||
      "GET";
    var trackThis = isApiCall(url);

    return origFetch.apply(this, args).then(
      function (res) {
        if (!res.ok) {
          // For errors, try to capture response body snippet
          var cloned = res.clone();
          cloned.text().then(function (body) {
            var snippet = body.length > 500 ? body.slice(0, 500) + "..." : body;
            send("network", {
              url: url,
              method: method,
              status: res.status,
              statusText: res.statusText,
              responseSnippet: snippet,
            });
          }).catch(function () {
            send("network", {
              url: url,
              method: method,
              status: res.status,
              statusText: res.statusText,
            });
          });
        } else if (trackThis) {
          // Track successful API calls for endpoint visibility
          send("network-api", {
            url: url,
            method: method,
            status: res.status,
            ok: true,
          });
        }
        return res;
      },
      function (err) {
        send("network", {
          url: url,
          method: method,
          error: err.message || String(err),
        });
        throw err;
      },
    );
  };

  // --- Network capture (XMLHttpRequest) ---
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._dbg_method = method;
    this._dbg_url = String(url);
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var self = this;
    self.addEventListener("load", function () {
      if (self.status >= 400) {
        send("network", {
          url: self._dbg_url,
          method: self._dbg_method,
          status: self.status,
          statusText: self.statusText,
        });
      } else if (isApiCall(self._dbg_url)) {
        send("network-api", {
          url: self._dbg_url,
          method: self._dbg_method,
          status: self.status,
          ok: true,
        });
      }
    });
    self.addEventListener("error", function () {
      send("network", {
        url: self._dbg_url,
        method: self._dbg_method,
        error: "Network error",
      });
    });
    return origSend.apply(this, arguments);
  };
})();
