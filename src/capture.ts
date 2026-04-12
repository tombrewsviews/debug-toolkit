import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { redactSensitiveData } from "./security.js";
import {
  type Capture,
  type DebugSession,
  newCaptureId,
  lookupHypothesis,
  saveSession,
} from "./session.js";

// --- Marker tag extraction ---

const MARKER_RE = /\[DBG_(\d{3})\]/;

function extractMarkerTag(text: string): string | null {
  const m = MARKER_RE.exec(text);
  return m ? `DBG_${m[1]}` : null;
}

// --- Build error parsing ---

export interface BuildError {
  tool: "vite" | "tsc" | "webpack" | "eslint" | "postcss" | "unknown";
  file: string | null;
  line: number | null;
  column: number | null;
  code: string | null;    // e.g., "TS2322", "E0308"
  message: string;
  raw: string;
}

const BUILD_PATTERNS: Array<{
  test: RegExp;
  tool: BuildError["tool"];
  extract: (text: string) => Partial<BuildError> | null;
}> = [
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
      if (!m) return null;
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
      let file: string | null = null;
      for (const line of lines) {
        const m = line.match(/^\s*(\d+):(\d+)\s+error\s+(.+?)\s{2,}(\S+)/);
        if (m) {
          return { file, line: +m[1], column: +m[2], message: m[3], code: m[4] };
        }
        if (line.trim() && !line.match(/^\s*\d+:\d+/)) file = line.trim();
      }
      return null;
    },
  },
];

export function parseBuildError(text: string): BuildError | null {
  for (const pattern of BUILD_PATTERNS) {
    if (pattern.test.test(text)) {
      const extracted = pattern.extract(text);
      if (!extracted) continue;
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

class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private count = 0;
  private cap: number;

  constructor(capacity: number) {
    this.cap = capacity;
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
  }

  drain(): T[] {
    if (this.count === 0) return [];
    const start = (this.head - this.count + this.cap) % this.cap;
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buf[(start + i) % this.cap] as T);
    }
    this.count = 0;
    this.head = 0;
    this.buf = new Array(this.cap);  // Release references
    return result;
  }

  /** Read last N items without removing them from the buffer */
  peek(n?: number): T[] {
    const want = Math.min(n ?? this.count, this.count);
    if (want === 0) return [];
    const start = (this.head - want + this.cap) % this.cap;
    const result: T[] = [];
    for (let i = 0; i < want; i++) {
      result.push(this.buf[(start + i) % this.cap] as T);
    }
    return result;
  }

  get length(): number { return this.count; }
}

// --- Buffers ---

export const terminalBuffer = new RingBuffer<Capture>(500);
export const browserBuffer = new RingBuffer<Capture>(200);
export const buildBuffer = new RingBuffer<BuildError>(100);

// --- Immutable recent window: last 60s of terminal output, immune to drain ---

const RECENT_WINDOW_MS = 60_000;
const recentWindow: Array<{ ts: number; capture: Capture }> = [];

function pushRecentWindow(capture: Capture): void {
  const now = Date.now();
  recentWindow.push({ ts: now, capture });
  // Evict entries older than 60s
  while (recentWindow.length > 0 && now - recentWindow[0].ts > RECENT_WINDOW_MS) {
    recentWindow.shift();
  }
}

/** Read recent terminal output from the immutable window (never drained). */
export function peekRecentWindow(lastMs?: number): Capture[] {
  const cutoff = Date.now() - (lastMs ?? RECENT_WINDOW_MS);
  return recentWindow.filter(e => e.ts >= cutoff).map(e => e.capture);
}

// --- Consecutive dedup tracking ---

let lastTerminalText = "";
let terminalRepeatCount = 0;

let lastBrowserText = "";
let browserRepeatCount = 0;

function pushTerminalDeduped(capture: Capture): void {
  // Always push to immutable recent window (before dedup filtering)
  pushRecentWindow(capture);
  const d = capture.data as Record<string, unknown> | null;
  const text = String(d?.text ?? d?.data ?? "");
  if (text === lastTerminalText && text.length > 0) {
    terminalRepeatCount++;
    return;
  }
  // Flush repeat count as a summary entry
  if (terminalRepeatCount > 0) {
    terminalBuffer.push({
      id: newCaptureId(),
      timestamp: new Date().toISOString(),
      source: "terminal",
      markerTag: null,
      data: { text: `[repeated ${terminalRepeatCount + 1}× total]`, stream: "stderr" },
      hypothesisId: null,
    });
    terminalRepeatCount = 0;
  }
  lastTerminalText = text;
  terminalBuffer.push(capture);
}

function pushBrowserDeduped(capture: Capture): void {
  const str = typeof capture.data === "object" ? JSON.stringify(capture.data) : String(capture.data);
  if (str === lastBrowserText && str.length > 0) {
    browserRepeatCount++;
    return;
  }
  if (browserRepeatCount > 0) {
    browserBuffer.push({
      id: newCaptureId(),
      timestamp: new Date().toISOString(),
      source: "browser-console",
      markerTag: null,
      data: { level: "info", message: `[repeated ${browserRepeatCount + 1}× total]` },
      hypothesisId: null,
    });
    browserRepeatCount = 0;
  }
  lastBrowserText = str;
  browserBuffer.push(capture);
}

// Build error dedup by identity tuple
const recentBuildErrorKeys = new Set<string>();

function pushBuildErrorDeduped(err: BuildError): void {
  const key = `${err.tool}:${err.file}:${err.line}:${err.code}`;
  if (recentBuildErrorKeys.has(key)) return;
  recentBuildErrorKeys.add(key);
  // Cap the set so it doesn't grow unbounded
  if (recentBuildErrorKeys.size > 200) recentBuildErrorKeys.clear();
  buildBuffer.push(err);
}

/**
 * Peek at recent terminal + browser + build output WITHOUT draining.
 * Used by debug_investigate to auto-include runtime context.
 */
export function peekRecentOutput(opts: { terminalLines?: number; browserLines?: number; buildErrors?: number } = {}): {
  terminal: Capture[];
  browser: Capture[];
  buildErrors: BuildError[];
  counts: { terminal: number; browser: number; buildErrors: number };
} {
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
 * Block until new output arrives in the ring buffers, or timeout.
 * Polls every 1s. Returns new items that appeared since the call started.
 */
export function waitForNewOutput(opts: {
  timeoutMs?: number;
  minLines?: number;
  source?: Capture["source"];
} = {}): Promise<{ items: Capture[]; timedOut: boolean; waitedMs: number }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const minLines = opts.minLines ?? 1;
  const startTermLen = terminalBuffer.length;
  const startBrowserLen = browserBuffer.length;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - startTime;

      // Count new items by comparing buffer lengths
      const newTerminal = terminalBuffer.length - startTermLen;
      const newBrowser = browserBuffer.length - startBrowserLen;
      const totalNew = opts.source
        ? (opts.source.startsWith("browser") ? newBrowser : newTerminal)
        : newTerminal + newBrowser;

      if (totalNew >= minLines) {
        // Peek only the new items
        const terminal = opts.source?.startsWith("browser") ? [] : terminalBuffer.peek(Math.max(0, newTerminal));
        const browser = opts.source === "terminal" ? [] : browserBuffer.peek(Math.max(0, newBrowser));
        const items = [...terminal, ...browser].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        resolve({ items, timedOut: false, waitedMs: elapsed });
        return;
      }

      if (elapsed >= timeoutMs) {
        resolve({ items: [], timedOut: true, waitedMs: elapsed });
        return;
      }

      setTimeout(check, 1000);
    };

    // First check after 1s (don't return immediately)
    setTimeout(check, 1000);
  });
}

/**
 * Drain all accumulated build errors from the buffer.
 */
export function drainBuildErrors(): BuildError[] {
  return buildBuffer.drain();
}

// --- Process tracking ---

export interface TrackedProcess {
  pid: number;
  command: string;
  startedAt: string;
  exitCode: number | null;
}

const trackedProcesses = new Map<number, TrackedProcess>();

function trackProcess(pid: number | undefined, command: string): void {
  if (!pid) return;
  trackedProcesses.set(pid, {
    pid,
    command,
    startedAt: new Date().toISOString(),
    exitCode: null,
  });
}

function markProcessExited(pid: number | undefined, code: number | null): void {
  if (!pid) return;
  const entry = trackedProcesses.get(pid);
  if (entry) entry.exitCode = code;
}

/**
 * Get all tracked processes. Checks if running processes are still alive.
 */
export function getTrackedProcesses(): TrackedProcess[] {
  // Verify running processes are still alive
  for (const [pid, proc] of trackedProcesses) {
    if (proc.exitCode !== null) continue;
    try {
      process.kill(pid, 0); // Signal 0 = check if alive
    } catch {
      proc.exitCode = -1; // Dead but we missed the exit event
    }
  }
  return [...trackedProcesses.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

// --- Terminal pipe ---

export function pipeProcess(child: ChildProcess, commandLabel = "dev server"): void {
  trackProcess(child.pid, commandLabel);
  child.on("close", (code) => markProcessExited(child.pid, code));
  child.on("error", () => markProcessExited(child.pid, -1));

  const pipe = (stream: NodeJS.ReadableStream | null, isErr: boolean) => {
    if (!stream) return;
    stream.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      (isErr ? process.stderr : process.stdout).write(chunk);

      // Check full chunk for multiline build errors (Vite, tsc, etc.)
      const buildErr = parseBuildError(text);
      if (buildErr) pushBuildErrorDeduped(buildErr);

      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        pushTerminalDeduped({
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

export function runAndCapture(command: string, timeoutMs = 30_000): Promise<Capture[]> {
  return new Promise((resolve, reject) => {
    const out: Capture[] = [];
    const child = spawn(command, { shell: true, stdio: "pipe" });
    trackProcess(child.pid, command);
    const timer = setTimeout(() => { child.kill(); resolve(out); }, timeoutMs);

    const handle = (stream: NodeJS.ReadableStream | null, name: string) => {
      if (!stream) return;
      stream.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          const t = line.trim();
          if (!t) continue;
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
      markProcessExited(child.pid, code);
      out.push({
        id: newCaptureId(), timestamp: new Date().toISOString(),
        source: "terminal", markerTag: null,
        data: { text: `exit:${code}`, stream: "meta" }, hypothesisId: null,
      });
      resolve(out);
    });
    child.on("error", (e) => { clearTimeout(timer); markProcessExited(child.pid, -1); reject(e); });
  });
}

// --- Lighthouse flag (for tagging browser events triggered by Lighthouse) ---

let lighthouseRunning = false;
export function setLighthouseRunning(running: boolean): void { lighthouseRunning = running; }

// --- Browser event handler ---

export function onBrowserEvent(event: { type: string; data: unknown; ts: number }, context?: "webview" | "external"): void {
  const srcMap: Record<string, Capture["source"]> = {
    console: "browser-console", network: "browser-network", error: "browser-error",
    "network-api": "browser-network",
  };
  const src = srcMap[event.type] ?? "browser-console";
  const str = typeof event.data === "object" ? JSON.stringify(event.data) : String(event.data);

  const sourceContext: Capture["sourceContext"] = lighthouseRunning
    ? "lighthouse"
    : (context ?? "webview");

  pushBrowserDeduped({
    id: newCaptureId(),
    timestamp: new Date(event.ts).toISOString(),
    source: src,
    markerTag: extractMarkerTag(str),
    data: event.data,
    hypothesisId: null,
    lighthouseTriggered: lighthouseRunning || undefined,
    sourceContext,
  });
}

// --- Drain + link (O(n) using pre-built index, not O(n*m)) ---

export function drainCaptures(cwd: string, session: DebugSession): Capture[] {
  // Use peek instead of drain to prevent data loss across tools.
  // The ring buffer's natural rotation handles cleanup.
  const all = [...terminalBuffer.peek(), ...browserBuffer.peek()];

  // Dedup against captures already in the session (by id)
  const existingIds = new Set(session.captures.map(c => c.id));
  const newCaptures = all.filter(c => !existingIds.has(c.id));

  for (const c of newCaptures) {
    if (c.markerTag) {
      // O(1) lookup via pre-built index instead of O(m) scan
      const hypId = lookupHypothesis(session, c.markerTag);
      if (hypId) {
        c.hypothesisId = hypId;
        const hyp = session.hypotheses.find((h) => h.id === hypId);
        if (hyp && !hyp.evidence.includes(c.id)) hyp.evidence.push(c.id);
      }
    }
  }

  if (newCaptures.length > 0) {
    session.captures.push(...newCaptures);
    saveSession(cwd, session);
  }
  return newCaptures;
}

// --- Tauri log file discovery and reading ---

/**
 * Discover Tauri log files for a project.
 * Searches platform-specific log directories based on the bundle identifier.
 */
export function discoverTauriLogs(cwd: string): { logDir: string | null; logFiles: string[]; identifier: string | null } {
  // Read bundle identifier from tauri.conf.json
  let identifier: string | null = null;
  const confPath = join(cwd, "src-tauri", "tauri.conf.json");
  if (existsSync(confPath)) {
    try {
      const conf = JSON.parse(readFileSync(confPath, "utf-8"));
      identifier = conf.identifier ?? conf.bundle?.identifier ?? null;
    } catch {}
  }

  if (!identifier) return { logDir: null, logFiles: [], identifier: null };

  // Platform-specific log directories
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates: string[] = [];

  if (process.platform === "darwin") {
    candidates.push(join(home, "Library", "Logs", identifier));
  } else if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    candidates.push(join(appdata, identifier, "logs"));
  } else {
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
            try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
          });
        return { logDir: dir, logFiles: files, identifier };
      } catch {}
    }
  }

  return { logDir: null, logFiles: [], identifier };
}

/**
 * Read recent lines from Tauri log files.
 * Returns captures from the most recent log file.
 */
export function readTauriLogs(cwd: string, tailLines = 50): Capture[] {
  const { logFiles } = discoverTauriLogs(cwd);
  if (logFiles.length === 0) return [];

  const captures: Capture[] = [];
  const logFile = logFiles[0]; // Most recent

  try {
    const content = readFileSync(logFile, "utf-8");
    const lines = content.split("\n").slice(-tailLines);

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      captures.push({
        id: newCaptureId(),
        timestamp: new Date().toISOString(),
        source: "tauri-log",
        markerTag: extractMarkerTag(t),
        data: { text: redactSensitiveData(t), file: basename(logFile), stream: "log" },
        hypothesisId: null,
      });
    }
  } catch {}

  return captures;
}

// --- Paginated capture retrieval (avoids dumping entire session) ---

export function getRecentCaptures(
  session: DebugSession,
  opts: { limit?: number; source?: string; markerOnly?: boolean } = {},
): { captures: Capture[]; total: number; showing: number } {
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

// --- File path extraction from errors ---

/**
 * Extract local file paths referenced in browser/terminal error data.
 * Returns paths with their original reference for cross-referencing.
 */
export function extractFilePathsFromError(data: unknown): Array<{ original: string; resolved: string }> {
  const str = typeof data === "object" && data !== null
    ? JSON.stringify(data)
    : String(data ?? "");

  const results: Array<{ original: string; resolved: string }> = [];
  const seen = new Set<string>();

  // asset://localhost/path → ./path
  const assetRe = /asset:\/\/localhost\/([\w/.@-]+)/g;
  let m;
  while ((m = assetRe.exec(str)) !== null) {
    const resolved = `./${m[1]}`;
    if (!seen.has(resolved)) { seen.add(resolved); results.push({ original: m[0], resolved }); }
  }

  // file:///path → /path
  const fileRe = /file:\/\/\/([\w/.@-]+)/g;
  while ((m = fileRe.exec(str)) !== null) {
    const resolved = `/${m[1]}`;
    if (!seen.has(resolved)) { seen.add(resolved); results.push({ original: m[0], resolved }); }
  }

  // ENOENT patterns: open '/path/to/file'
  const enoentRe = /ENOENT[^']*'([^']+)'/g;
  while ((m = enoentRe.exec(str)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); results.push({ original: `ENOENT: ${m[1]}`, resolved: m[1] }); }
  }

  return results.slice(0, 5);
}

// ━━━ Live Context (inter-process communication) ━━━

export interface LiveContext {
  updatedAt: string;
  terminal: Array<{ timestamp: string; text: string; stream: string }>;
  browser: Array<{ timestamp: string; source: string; data: unknown; lighthouseTriggered?: boolean; sourceContext?: "webview" | "external" | "lighthouse" }>;
  buildErrors: Array<{ tool: string; file: string | null; line: number | null; code: string | null; message: string }>;
  counts: { terminal: number; browser: number; buildErrors: number };
}

/**
 * Write live context snapshot to .debug/live-context.json.
 * Called periodically by the serve process.
 */
export function writeLiveContext(cwd: string): void {
  // Status shows max ~110 lines — no need to peek more than that
  const recent = peekRecentOutput({ terminalLines: 100, browserLines: 50, buildErrors: 30 });
  const context: LiveContext = {
    updatedAt: new Date().toISOString(),
    terminal: recent.terminal.map((c) => {
      const d = typeof c.data === "object" && c.data !== null ? c.data as Record<string, unknown> : null;
      return { timestamp: c.timestamp, text: String(d?.text ?? d?.data ?? c.data), stream: String(d?.stream ?? "stdout") };
    }),
    browser: recent.browser.map((c) => ({
      timestamp: c.timestamp, source: c.source, data: c.data,
      lighthouseTriggered: c.lighthouseTriggered || undefined,
      sourceContext: c.sourceContext || undefined,
    })),
    buildErrors: recent.buildErrors.map((e) => ({
      tool: e.tool, file: e.file, line: e.line, code: e.code, message: e.message,
    })),
    counts: recent.counts,
  };
  const dir = join(cwd, ".debug");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "live-context.json"), JSON.stringify(context));
}

/**
 * Read live context from .debug/live-context.json.
 * Called by MCP resource handler (separate process from serve).
 */
export function readLiveContext(cwd: string): LiveContext | null {
  const path = join(cwd, ".debug", "live-context.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as LiveContext;
    // Check freshness — if older than 30 seconds, serve might not be running
    const age = Date.now() - new Date(raw.updatedAt).getTime();
    if (age > 30_000) return null; // stale
    return raw;
  } catch { return null; }
}

/**
 * Start periodic live context writer. Returns stop function.
 */
export function startLiveContextWriter(cwd: string): { stop: () => void } {
  // Write immediately, then every 5 seconds
  writeLiveContext(cwd);
  const interval = setInterval(() => writeLiveContext(cwd), 5_000);
  return { stop: () => clearInterval(interval) };
}
