import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureGitignore } from "./security.js";
import { atomicWrite } from "./utils.js";
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
// atomicWrite imported from utils.ts
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
    // Backwards compat: initialize new fields for old session files
    if (!session.failedApproaches)
        session.failedApproaches = [];
    if (!session.errorTrajectory)
        session.errorTrajectory = [];
    if (!session._recalledEntryIds)
        session._recalledEntryIds = [];
    if (!session._recalledFiles)
        session._recalledFiles = [];
    if (session._memoryHit === undefined)
        session._memoryHit = false;
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
// --- Session auto-expiry ---
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
/**
 * Expire old active sessions that haven't been updated recently.
 * Returns the count of sessions expired.
 */
export function expireOldSessions(cwd, maxAgeMs = DEFAULT_MAX_AGE_MS) {
    const dir = sessionsDir(cwd);
    if (!existsSync(dir))
        return 0;
    let expired = 0;
    try {
        const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
        const now = Date.now();
        for (const file of files) {
            try {
                const filePath = join(dir, file);
                const raw = JSON.parse(readFileSync(filePath, "utf-8"));
                if (raw.status !== "active")
                    continue;
                // Use the most recent activity timestamp
                const lastActivity = raw.captures.length > 0
                    ? new Date(raw.captures[raw.captures.length - 1].timestamp).getTime()
                    : new Date(raw.createdAt).getTime();
                if (now - lastActivity > maxAgeMs) {
                    raw.status = "expired";
                    atomicWrite(filePath, JSON.stringify(raw, null, 2));
                    expired++;
                }
            }
            catch { /* skip corrupt session files */ }
        }
    }
    catch { /* sessions dir unreadable */ }
    return expired;
}
/**
 * List session summaries for the status report.
 * Only returns active sessions, with a count of total/expired/resolved.
 */
export function listSessionSummaries(cwd) {
    const dir = sessionsDir(cwd);
    if (!existsSync(dir))
        return { active: [], counts: { active: 0, resolved: 0, expired: 0, total: 0 } };
    const counts = { active: 0, resolved: 0, expired: 0, total: 0 };
    const active = [];
    try {
        const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
        for (const file of files) {
            try {
                const raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
                counts.total++;
                if (raw.status === "active") {
                    counts.active++;
                    active.push({ id: raw.id, problem: raw.problem, createdAt: raw.createdAt, captureCount: raw.captures.length });
                }
                else if (raw.status === "resolved") {
                    counts.resolved++;
                }
                else {
                    counts.expired++;
                }
            }
            catch {
                counts.total++;
            }
        }
    }
    catch { }
    return { active: active.slice(0, 5), counts };
}
//# sourceMappingURL=session.js.map