import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { redactSensitiveData } from "./security.js";
import { newCaptureId, lookupHypothesis, saveSession, } from "./session.js";
// --- Marker tag extraction ---
const MARKER_RE = /\[DBG_(\d{3})\]/;
function extractMarkerTag(text) {
    const m = MARKER_RE.exec(text);
    return m ? `DBG_${m[1]}` : null;
}
const BUILD_PATTERNS = [
    // Vite / PostCSS errors: [vite:css][postcss] message
    {
        test: /\[vite[:\]]/i,
        tool: "vite",
        extract: (text) => {
            const msg = text.match(/\[vite[^\]]*\](?:\[([^\]]+)\])?\s*(.+)/)?.[2] ?? text;
            const fileLine = text.match(/(\S+\.(?:css|scss|less|tsx?|jsx?)):?(\d+)?/);
            return { message: msg, file: fileLine?.[1] ?? null, line: fileLine?.[2] ? +fileLine[2] : null };
        },
    },
    // TypeScript: src/file.tsx(15,3): error TS2322: message
    {
        test: /error TS\d+:/,
        tool: "tsc",
        extract: (text) => {
            const m = text.match(/(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/);
            if (!m)
                return null;
            return { file: m[1], line: +m[2], column: +m[3], code: m[4], message: m[5] };
        },
    },
    // webpack: ERROR in ./path
    {
        test: /ERROR in \.\//,
        tool: "webpack",
        extract: (text) => {
            const file = text.match(/ERROR in (\.\/.+)/)?.[1] ?? null;
            const msg = text.match(/(?:Error|Module not found):\s*(.+)/)?.[1] ?? text;
            return { file, message: msg };
        },
    },
    // ESLint: path/file.tsx\n  15:3  error  message  rule-name
    {
        test: /\d+:\d+\s+error\s+/,
        tool: "eslint",
        extract: (text) => {
            const lines = text.split("\n");
            let file = null;
            for (const line of lines) {
                const m = line.match(/^\s*(\d+):(\d+)\s+error\s+(.+?)\s{2,}(\S+)/);
                if (m) {
                    return { file, line: +m[1], column: +m[2], message: m[3], code: m[4] };
                }
                if (line.trim() && !line.match(/^\s*\d+:\d+/))
                    file = line.trim();
            }
            return null;
        },
    },
];
export function parseBuildError(text) {
    for (const pattern of BUILD_PATTERNS) {
        if (pattern.test.test(text)) {
            const extracted = pattern.extract(text);
            if (!extracted)
                continue;
            return {
                tool: pattern.tool,
                file: extracted.file ?? null,
                line: extracted.line ?? null,
                column: extracted.column ?? null,
                code: extracted.code ?? null,
                message: extracted.message ?? text.split("\n")[0] ?? "",
                raw: text,
            };
        }
    }
    return null;
}
// --- Ring buffer: fixed-size, no allocation on push ---
class RingBuffer {
    buf;
    head = 0;
    count = 0;
    cap;
    constructor(capacity) {
        this.cap = capacity;
        this.buf = new Array(capacity);
    }
    push(item) {
        this.buf[this.head] = item;
        this.head = (this.head + 1) % this.cap;
        if (this.count < this.cap)
            this.count++;
    }
    drain() {
        if (this.count === 0)
            return [];
        const start = (this.head - this.count + this.cap) % this.cap;
        const result = [];
        for (let i = 0; i < this.count; i++) {
            result.push(this.buf[(start + i) % this.cap]);
        }
        this.count = 0;
        this.head = 0;
        this.buf = new Array(this.cap); // Release references
        return result;
    }
    /** Read last N items without removing them from the buffer */
    peek(n) {
        const want = Math.min(n ?? this.count, this.count);
        if (want === 0)
            return [];
        const start = (this.head - want + this.cap) % this.cap;
        const result = [];
        for (let i = 0; i < want; i++) {
            result.push(this.buf[(start + i) % this.cap]);
        }
        return result;
    }
    get length() { return this.count; }
}
// --- Buffers ---
export const terminalBuffer = new RingBuffer(500);
export const browserBuffer = new RingBuffer(200);
export const buildBuffer = new RingBuffer(100);
/**
 * Peek at recent terminal + browser + build output WITHOUT draining.
 * Used by debug_investigate to auto-include runtime context.
 */
export function peekRecentOutput(opts = {}) {
    const terminal = terminalBuffer.peek(opts.terminalLines ?? 50);
    const browser = browserBuffer.peek(opts.browserLines ?? 30);
    const build = buildBuffer.peek(opts.buildErrors ?? 20);
    return {
        terminal,
        browser,
        buildErrors: build,
        counts: {
            terminal: terminalBuffer.length,
            browser: browserBuffer.length,
            buildErrors: buildBuffer.length,
        },
    };
}
/**
 * Drain all accumulated build errors from the buffer.
 */
export function drainBuildErrors() {
    return buildBuffer.drain();
}
// --- Terminal pipe ---
export function pipeProcess(child) {
    const pipe = (stream, isErr) => {
        if (!stream)
            return;
        stream.on("data", (chunk) => {
            const text = chunk.toString();
            (isErr ? process.stderr : process.stdout).write(chunk);
            // Check full chunk for multiline build errors (Vite, tsc, etc.)
            const buildErr = parseBuildError(text);
            if (buildErr)
                buildBuffer.push(buildErr);
            for (const line of text.split("\n")) {
                const t = line.trim();
                if (!t)
                    continue;
                terminalBuffer.push({
                    id: newCaptureId(),
                    timestamp: new Date().toISOString(),
                    source: "terminal",
                    markerTag: extractMarkerTag(t),
                    data: { text: redactSensitiveData(t), stream: isErr ? "stderr" : "stdout" },
                    hypothesisId: null,
                });
            }
        });
    };
    pipe(child.stdout, false);
    pipe(child.stderr, true);
}
// --- Run command and capture ---
export function runAndCapture(command, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
        const out = [];
        const child = spawn(command, { shell: true, stdio: "pipe" });
        const timer = setTimeout(() => { child.kill(); resolve(out); }, timeoutMs);
        const handle = (stream, name) => {
            if (!stream)
                return;
            stream.on("data", (chunk) => {
                for (const line of chunk.toString().split("\n")) {
                    const t = line.trim();
                    if (!t)
                        continue;
                    out.push({
                        id: newCaptureId(),
                        timestamp: new Date().toISOString(),
                        source: "terminal",
                        markerTag: extractMarkerTag(t),
                        data: { text: redactSensitiveData(t), stream: name },
                        hypothesisId: null,
                    });
                }
            });
        };
        handle(child.stdout, "stdout");
        handle(child.stderr, "stderr");
        child.on("close", (code) => {
            clearTimeout(timer);
            out.push({
                id: newCaptureId(), timestamp: new Date().toISOString(),
                source: "terminal", markerTag: null,
                data: { text: `exit:${code}`, stream: "meta" }, hypothesisId: null,
            });
            resolve(out);
        });
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
}
// --- Browser event handler ---
export function onBrowserEvent(event) {
    const srcMap = {
        console: "browser-console", network: "browser-network", error: "browser-error",
    };
    const src = srcMap[event.type] ?? "browser-console";
    const str = typeof event.data === "object" ? JSON.stringify(event.data) : String(event.data);
    browserBuffer.push({
        id: newCaptureId(),
        timestamp: new Date(event.ts).toISOString(),
        source: src,
        markerTag: extractMarkerTag(str),
        data: event.data,
        hypothesisId: null,
    });
}
// --- Drain + link (O(n) using pre-built index, not O(n*m)) ---
export function drainCaptures(cwd, session) {
    const all = [...terminalBuffer.drain(), ...browserBuffer.drain()];
    for (const c of all) {
        if (c.markerTag) {
            // O(1) lookup via pre-built index instead of O(m) scan
            const hypId = lookupHypothesis(session, c.markerTag);
            if (hypId) {
                c.hypothesisId = hypId;
                const hyp = session.hypotheses.find((h) => h.id === hypId);
                if (hyp && !hyp.evidence.includes(c.id))
                    hyp.evidence.push(c.id);
            }
        }
    }
    session.captures.push(...all);
    saveSession(cwd, session);
    return all;
}
// --- Tauri log file discovery and reading ---
/**
 * Discover Tauri log files for a project.
 * Searches platform-specific log directories based on the bundle identifier.
 */
export function discoverTauriLogs(cwd) {
    // Read bundle identifier from tauri.conf.json
    let identifier = null;
    const confPath = join(cwd, "src-tauri", "tauri.conf.json");
    if (existsSync(confPath)) {
        try {
            const conf = JSON.parse(readFileSync(confPath, "utf-8"));
            identifier = conf.identifier ?? conf.bundle?.identifier ?? null;
        }
        catch { }
    }
    if (!identifier)
        return { logDir: null, logFiles: [], identifier: null };
    // Platform-specific log directories
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const candidates = [];
    if (process.platform === "darwin") {
        candidates.push(join(home, "Library", "Logs", identifier));
    }
    else if (process.platform === "win32") {
        const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
        candidates.push(join(appdata, identifier, "logs"));
    }
    else {
        // Linux
        candidates.push(join(home, ".config", identifier, "logs"));
    }
    for (const dir of candidates) {
        if (existsSync(dir)) {
            try {
                const files = readdirSync(dir)
                    .filter((f) => f.endsWith(".log"))
                    .map((f) => join(dir, f))
                    .sort((a, b) => {
                    // Most recently modified first
                    try {
                        return statSync(b).mtimeMs - statSync(a).mtimeMs;
                    }
                    catch {
                        return 0;
                    }
                });
                return { logDir: dir, logFiles: files, identifier };
            }
            catch { }
        }
    }
    return { logDir: null, logFiles: [], identifier };
}
/**
 * Read recent lines from Tauri log files.
 * Returns captures from the most recent log file.
 */
export function readTauriLogs(cwd, tailLines = 50) {
    const { logFiles } = discoverTauriLogs(cwd);
    if (logFiles.length === 0)
        return [];
    const captures = [];
    const logFile = logFiles[0]; // Most recent
    try {
        const content = readFileSync(logFile, "utf-8");
        const lines = content.split("\n").slice(-tailLines);
        for (const line of lines) {
            const t = line.trim();
            if (!t)
                continue;
            captures.push({
                id: newCaptureId(),
                timestamp: new Date().toISOString(),
                source: "tauri-log",
                markerTag: extractMarkerTag(t),
                data: { text: redactSensitiveData(t), file: basename(logFile), stream: "log" },
                hypothesisId: null,
            });
        }
    }
    catch { }
    return captures;
}
// --- Paginated capture retrieval (avoids dumping entire session) ---
export function getRecentCaptures(session, opts = {}) {
    let filtered = session.captures;
    if (opts.source) {
        filtered = filtered.filter((c) => c.source === opts.source);
    }
    if (opts.markerOnly) {
        filtered = filtered.filter((c) => c.markerTag !== null);
    }
    const limit = opts.limit ?? 50;
    const recent = filtered.slice(-limit);
    return {
        captures: recent,
        total: filtered.length,
        showing: recent.length,
    };
}
/**
 * Write live context snapshot to .debug/live-context.json.
 * Called periodically by the serve process.
 */
export function writeLiveContext(cwd) {
    const recent = peekRecentOutput({ terminalLines: 50, browserLines: 30, buildErrors: 20 });
    const context = {
        updatedAt: new Date().toISOString(),
        terminal: recent.terminal.map((c) => {
            const d = typeof c.data === "object" && c.data !== null ? c.data : null;
            return { timestamp: c.timestamp, text: String(d?.text ?? d?.data ?? c.data), stream: String(d?.stream ?? "stdout") };
        }),
        browser: recent.browser.map((c) => ({
            timestamp: c.timestamp, source: c.source, data: c.data,
        })),
        buildErrors: recent.buildErrors.map((e) => ({
            tool: e.tool, file: e.file, line: e.line, code: e.code, message: e.message,
        })),
        counts: recent.counts,
    };
    const dir = join(cwd, ".debug");
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "live-context.json"), JSON.stringify(context));
}
/**
 * Read live context from .debug/live-context.json.
 * Called by MCP resource handler (separate process from serve).
 */
export function readLiveContext(cwd) {
    const path = join(cwd, ".debug", "live-context.json");
    if (!existsSync(path))
        return null;
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        // Check freshness — if older than 30 seconds, serve might not be running
        const age = Date.now() - new Date(raw.updatedAt).getTime();
        if (age > 30_000)
            return null; // stale
        return raw;
    }
    catch {
        return null;
    }
}
/**
 * Start periodic live context writer. Returns stop function.
 */
export function startLiveContextWriter(cwd) {
    // Write immediately, then every 5 seconds
    writeLiveContext(cwd);
    const interval = setInterval(() => writeLiveContext(cwd), 5_000);
    return { stop: () => clearInterval(interval) };
}
//# sourceMappingURL=capture.js.map