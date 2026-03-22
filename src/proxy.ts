import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import httpProxy from "http-proxy";
import { WebSocketServer, type WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { onBrowserEvent } from "./capture.js";
import { createGunzip } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));

const INJECTED_SCRIPT_TAG = `<script src="/__debug_toolkit/injected.js"></script>`;

export interface ProxyOptions {
  targetPort: number;
  listenPort: number;
}

export function startProxy(opts: ProxyOptions): {
  close: () => void;
} {
  const { targetPort, listenPort } = opts;
  const target = `http://127.0.0.1:${targetPort}`;

  const proxy = httpProxy.createProxyServer({
    target,
    ws: true,
    selfHandleResponse: true,
  });

  // Handle proxy responses: inject script into HTML
  proxy.on("proxyRes", (proxyRes, req, res) => {
    const contentType = proxyRes.headers["content-type"] ?? "";
    const isHtml = contentType.includes("text/html");

    if (!isHtml) {
      // Pass through non-HTML responses unchanged
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    // Buffer and modify HTML responses
    const chunks: Buffer[] = [];
    const encoding = proxyRes.headers["content-encoding"];

    let stream: NodeJS.ReadableStream = proxyRes;
    if (encoding === "gzip") {
      stream = proxyRes.pipe(createGunzip());
    }

    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      let body = Buffer.concat(chunks).toString("utf-8");

      // Inject our script before </body> or at end of document
      if (body.includes("</body>")) {
        body = body.replace("</body>", `${INJECTED_SCRIPT_TAG}\n</body>`);
      } else if (body.includes("</html>")) {
        body = body.replace("</html>", `${INJECTED_SCRIPT_TAG}\n</html>`);
      } else {
        body += `\n${INJECTED_SCRIPT_TAG}`;
      }

      // Send modified response without compression
      const headers = { ...proxyRes.headers };
      delete headers["content-encoding"];
      delete headers["content-length"];
      headers["content-length"] = String(Buffer.byteLength(body));

      res.writeHead(proxyRes.statusCode ?? 200, headers);
      res.end(body);
    });

    stream.on("error", () => {
      // If decompression fails, pass through raw
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res);
    });
  });

  proxy.on("error", (err, _req, res) => {
    if (res && "writeHead" in res) {
      (res as ServerResponse).writeHead(502, { "Content-Type": "text/plain" });
      (res as ServerResponse).end(`debug-toolkit proxy error: ${err.message}`);
    }
  });

  // HTTP server
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Serve our injected script
    if (req.url === "/__debug_toolkit/injected.js") {
      const scriptPath = join(__dirname, "injected.js");
      try {
        const script = readFileSync(scriptPath, "utf-8");
        res.writeHead(200, {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache",
        });
        res.end(script);
      } catch {
        res.writeHead(404);
        res.end("injected.js not found");
      }
      return;
    }

    // Proxy everything else
    proxy.web(req, res);
  });

  // WebSocket handling
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        onBrowserEvent(event);
      } catch {
        // Ignore malformed messages
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    // Our debug WebSocket
    if (req.url === "/__debug_toolkit/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }

    // Proxy all other WebSocket upgrades (e.g., HMR)
    proxy.ws(req, socket, head);
  });

  // Security: bind to localhost only — never expose to network
  server.listen(listenPort, "127.0.0.1", () => {
    // Server started
  });

  return {
    close() {
      wss.close();
      server.close();
      proxy.close();
    },
  };
}

/**
 * Detect the dev server port by watching child process output.
 * Returns a promise that resolves with the port or rejects after timeout.
 */
export function detectPort(
  stdout: NodeJS.ReadableStream,
  timeoutMs = 30_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    // Ordered from most specific to least. No greedy catch-all patterns.
    const patterns = [
      /https?:\/\/localhost:(\d+)/,
      /https?:\/\/127\.0\.0\.1:(\d+)/,
      /https?:\/\/0\.0\.0\.0:(\d+)/,
      /https?:\/\/\[::\]:(\d+)/,
      /listening\s+(?:on\s+)?(?:port\s+)?(\d{4,5})/i,
      /localhost:(\d{4,5})/,
      /127\.0\.0\.1:(\d{4,5})/,
    ];

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Could not auto-detect dev server port within timeout. Use --port to specify."));
    }, timeoutMs);

    function onData(chunk: Buffer) {
      const text = chunk.toString();
      for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (match) {
          const port = parseInt(match[1], 10);
          if (port >= 1024 && port <= 65535) {
            cleanup();
            resolve(port);
            return;
          }
        }
      }
    }

    function cleanup() {
      clearTimeout(timer);
      stdout.removeListener("data", onData);
    }

    stdout.on("data", onData);
  });
}
