import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ensureGitignore } from "./security.js";
// --- Constants ---
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_CAPTURES = 3000;
const TRIM_TO = 2000;
// --- Helpers ---
function uid(prefix) {
    return `${prefix}_${randomBytes(4).toString("hex")}`;
}
function debugDir(cwd) {
    return join(cwd, ".debug");
}
function sessionsDir(cwd) {
    return join(debugDir(cwd), "sessions");
}
function ensureDirs(cwd) {
    for (const d of [debugDir(cwd), sessionsDir(cwd)]) {
        if (!existsSync(d))
            mkdirSync(d, { recursive: true, mode: 0o700 });
    }
    ensureGitignore(cwd);
}
function atomicWrite(filePath, data) {
    const tmp = `${filePath}.tmp_${process.pid}`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, filePath);
}
// --- Session CRUD ---
export function createSession(cwd, problem) {
    ensureDirs(cwd);
    const session = {
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
export function saveSession(cwd, session) {
    ensureDirs(cwd);
    // Trim captures to prevent unbounded growth
    if (session.captures.length > MAX_CAPTURES) {
        session.captures = session.captures.slice(-TRIM_TO);
    }
    session.version++;
    atomicWrite(join(sessionsDir(cwd), `${session.id}.json`), JSON.stringify(session, null, 2));
}
export function loadSession(cwd, sessionId) {
    const p = join(sessionsDir(cwd), `${sessionId}.json`);
    if (!existsSync(p))
        throw new Error(`Session not found: ${sessionId}`);
    const session = JSON.parse(readFileSync(p, "utf-8"));
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
export function indexMarker(session, tag, hypothesisId) {
    if (hypothesisId) {
        session._markerIndex[tag] = hypothesisId;
    }
}
export function lookupHypothesis(session, markerTag) {
    return session._markerIndex[markerTag] ?? null;
}
// --- ID generators ---
export function newHypothesisId() { return uid("hyp"); }
export function newInstrumentationId() { return uid("ins"); }
export function newCaptureId() { return uid("cap"); }
let markerCounter = 0;
export function nextMarkerTag() {
    markerCounter++;
    return `DBG_${String(markerCounter).padStart(3, "0")}`;
}
export function resetMarkerCounter() { markerCounter = 0; }
//# sourceMappingURL=session.js.map