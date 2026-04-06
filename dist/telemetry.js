/**
 * telemetry.ts — Debug session outcome tracking.
 *
 * Tracks success/failure of debug sessions to improve future suggestions.
 * All data stays local in .debug/telemetry.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./utils.js";
function telemetryPath(cwd) {
    return join(cwd, ".debug", "telemetry.json");
}
function loadTelemetry(cwd) {
    const p = telemetryPath(cwd);
    if (!existsSync(p)) {
        return {
            version: "1.0",
            outcomes: [],
            aggregates: {
                totalSessions: 0,
                fixRate: 0,
                avgDurationMs: 0,
                memoryHitRate: 0,
                memoryApplyRate: 0,
                topErrors: [],
                topFiles: [],
            },
        };
    }
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    }
    catch {
        return { version: "1.0", outcomes: [], aggregates: { totalSessions: 0, fixRate: 0, avgDurationMs: 0, memoryHitRate: 0, memoryApplyRate: 0, topErrors: [], topFiles: [] } };
    }
}
function recomputeAggregates(store) {
    const o = store.outcomes;
    if (o.length === 0)
        return;
    store.aggregates.totalSessions = o.length;
    store.aggregates.fixRate = o.filter(x => x.outcome === "fixed").length / o.length;
    store.aggregates.avgDurationMs = o.reduce((s, x) => s + x.durationMs, 0) / o.length;
    store.aggregates.memoryHitRate = o.filter(x => x.memoryHit).length / o.length;
    const hits = o.filter(x => x.memoryHit);
    store.aggregates.memoryApplyRate = hits.length > 0
        ? hits.filter(x => x.memoryApplied).length / hits.length
        : 0;
    // Top errors by count
    const errorMap = new Map();
    for (const x of o) {
        const e = errorMap.get(x.errorType) ?? { count: 0, fixed: 0 };
        e.count++;
        if (x.outcome === "fixed")
            e.fixed++;
        errorMap.set(x.errorType, e);
    }
    store.aggregates.topErrors = [...errorMap.entries()]
        .map(([errorType, { count, fixed }]) => ({ errorType, count, fixRate: fixed / count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    // Top files by count
    const fileMap = new Map();
    for (const x of o) {
        for (const f of x.files) {
            const e = fileMap.get(f) ?? { count: 0, fixed: 0 };
            e.count++;
            if (x.outcome === "fixed")
                e.fixed++;
            fileMap.set(f, e);
        }
    }
    store.aggregates.topFiles = [...fileMap.entries()]
        .map(([file, { count, fixed }]) => ({ file, count, fixRate: fixed / count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
}
export function recordOutcome(cwd, outcome) {
    const store = loadTelemetry(cwd);
    store.outcomes.push(outcome);
    // Keep last 500 outcomes
    if (store.outcomes.length > 500) {
        store.outcomes = store.outcomes.slice(-500);
    }
    recomputeAggregates(store);
    atomicWrite(telemetryPath(cwd), JSON.stringify(store, null, 2));
    // Optional: report to StackPack Monitor for cross-product visibility
    reportToStackpack(outcome).catch(() => { });
}
async function reportToStackpack(outcome) {
    const url = process.env.STACKPACK_EVENTS_URL;
    const key = process.env.STACKPACK_API_KEY;
    if (!url || !key)
        return; // Graceful no-op when not configured
    try {
        await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                product: "debug",
                event_type: "session_outcome",
                metadata: {
                    sessionId: outcome.sessionId,
                    errorType: outcome.errorType,
                    category: outcome.category,
                    outcome: outcome.outcome,
                    durationMs: outcome.durationMs,
                    triageLevel: outcome.triageLevel,
                    toolsUsed: outcome.toolsUsed,
                    files: outcome.files,
                    memoryHit: outcome.memoryHit,
                    memoryApplied: outcome.memoryApplied,
                },
            }),
        });
    }
    catch {
        // Silent — telemetry must never break debug
    }
}
export function getTelemetry(cwd) {
    const store = loadTelemetry(cwd);
    recomputeAggregates(store);
    return store;
}
export function getFixRateForError(cwd, errorType) {
    const store = loadTelemetry(cwd);
    const relevant = store.outcomes.filter(o => o.errorType === errorType);
    if (relevant.length < 2)
        return null; // Not enough data
    return relevant.filter(o => o.outcome === "fixed").length / relevant.length;
}
//# sourceMappingURL=telemetry.js.map