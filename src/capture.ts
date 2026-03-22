import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
    return result;
  }

  get length(): number { return this.count; }
}

// --- Buffers ---

export const terminalBuffer = new RingBuffer<Capture>(500);
export const browserBuffer = new RingBuffer<Capture>(200);

// --- Terminal pipe ---

export function pipeProcess(child: ChildProcess): void {
  const pipe = (stream: NodeJS.ReadableStream | null, isErr: boolean) => {
    if (!stream) return;
    stream.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      (isErr ? process.stderr : process.stdout).write(chunk);

      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
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

export function runAndCapture(command: string, timeoutMs = 30_000): Promise<Capture[]> {
  return new Promise((resolve, reject) => {
    const out: Capture[] = [];
    const child = spawn(command, { shell: true, stdio: "pipe" });
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

export function onBrowserEvent(event: { type: string; data: unknown; ts: number }): void {
  const srcMap: Record<string, Capture["source"]> = {
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

export function drainCaptures(cwd: string, session: DebugSession): Capture[] {
  const all = [...terminalBuffer.drain(), ...browserBuffer.drain()];

  for (const c of all) {
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

  session.captures.push(...all);
  saveSession(cwd, session);
  return all;
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
