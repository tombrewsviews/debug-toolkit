import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureGitignore } from "./security.js";
import { atomicWrite } from "./utils.js";

// --- Types ---

export interface Hypothesis {
  id: string;
  text: string;
  status: "testing" | "confirmed" | "rejected";
  evidence: string[];
}

export interface InstrumentationRecord {
  id: string;
  filePath: string;
  lineNumber: number;
  markerTag: string;
  language: string;
  insertedCode: string;
  active: boolean;
  hypothesisId: string | null;
}

export interface Capture {
  id: string;
  timestamp: string;
  source: "terminal" | "browser-console" | "browser-network" | "browser-error" | "environment" | "tauri-log" | "build-error" | "visual" | "perf";
  markerTag: string | null;
  data: unknown;
  hypothesisId: string | null;
}

export interface ScreenshotRecord {
  id: string;
  timestamp: string;
  tool: "ghost_screenshot" | "preview_screenshot" | "none";
  reference: string; // file path or base64 data URI
}

export interface DomSnapshot {
  timestamp: string;
  tool: "ghost_read" | "preview_snapshot";
  elements: Array<{ role: string; name: string; visible: boolean }>;
}

export interface VisualContext {
  screenshots: ScreenshotRecord[];
  domSnapshot: DomSnapshot | null;
}

export interface PerfSnapshot {
  id: string;
  timestamp: string;
  url: string;
  metrics: {
    lcp: number | null;      // Largest Contentful Paint (ms)
    cls: number | null;      // Cumulative Layout Shift
    inp: number | null;      // Interaction to Next Paint (ms)
    tbt: number | null;      // Total Blocking Time (ms)
    speedIndex: number | null;
  };
  phase: "before" | "after";
}

export interface FileSnapshot {
  filePath: string;
  content: string;
  takenAt: string;
}

export interface DebugSession {
  id: string;
  version: number;
  createdAt: string;
  status: "active" | "resolved" | "abandoned";
  problem: string;
  hypotheses: Hypothesis[];
  instrumentation: InstrumentationRecord[];
  captures: Capture[];
  snapshots: Record<string, FileSnapshot>;
  diagnosis: string | null;
  visualContext: VisualContext | null;
  perfSnapshots: PerfSnapshot[];
  // Performance: pre-built index from markerTag → hypothesisId
  _markerIndex: Record<string, string>;
}

// --- Constants ---

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_CAPTURES = 3000;
const TRIM_TO = 2000;

// --- Helpers ---

function uid(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

function debugDir(cwd: string): string {
  return join(cwd, ".debug");
}

function sessionsDir(cwd: string): string {
  return join(debugDir(cwd), "sessions");
}

function ensureDirs(cwd: string): void {
  for (const d of [debugDir(cwd), sessionsDir(cwd)]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  ensureGitignore(cwd);
}

// atomicWrite imported from utils.ts

// --- Session CRUD ---

export function createSession(cwd: string, problem: string): DebugSession {
  ensureDirs(cwd);
  const session: DebugSession = {
    id: uid("dbg"),
    version: 0,
    createdAt: new Date().toISOString(),
    status: "active",
    problem,
    hypotheses: [],
    instrumentation: [],
    captures: [],
    snapshots: {},
    diagnosis: null,
    visualContext: null,
    perfSnapshots: [],
    _markerIndex: {},
  };
  saveSession(cwd, session);
  return session;
}

export function saveSession(cwd: string, session: DebugSession): void {
  ensureDirs(cwd);
  // Trim captures to prevent unbounded growth
  if (session.captures.length > MAX_CAPTURES) {
    session.captures = session.captures.slice(-TRIM_TO);
  }
  session.version++;
  atomicWrite(
    join(sessionsDir(cwd), `${session.id}.json`),
    JSON.stringify(session, null, 2),
  );
}

export function loadSession(cwd: string, sessionId: string): DebugSession {
  const p = join(sessionsDir(cwd), `${sessionId}.json`);
  if (!existsSync(p)) throw new Error(`Session not found: ${sessionId}`);
  const session = JSON.parse(readFileSync(p, "utf-8")) as DebugSession;
  // Rebuild marker index if missing (backwards compat)
  if (!session._markerIndex) {
    session._markerIndex = {};
    for (const r of session.instrumentation) {
      if (r.active && r.hypothesisId) {
        session._markerIndex[r.markerTag] = r.hypothesisId;
      }
    }
  }
  return session;
}

// --- Marker index ---

export function indexMarker(session: DebugSession, tag: string, hypothesisId: string | null): void {
  if (hypothesisId) {
    session._markerIndex[tag] = hypothesisId;
  }
}

export function lookupHypothesis(session: DebugSession, markerTag: string): string | null {
  return session._markerIndex[markerTag] ?? null;
}

// --- ID generators ---

export function newHypothesisId(): string { return uid("hyp"); }
export function newInstrumentationId(): string { return uid("ins"); }
export function newCaptureId(): string { return uid("cap"); }

let markerCounter = 0;
export function nextMarkerTag(): string {
  markerCounter++;
  return `DBG_${String(markerCounter).padStart(3, "0")}`;
}
export function resetMarkerCounter(): void { markerCounter = 0; }
