/**
 * Loop Detection — within-session analysis layer.
 *
 * Detects when an agent is going in circles: repeated errors, file churn,
 * reverted changes, verify failure streaks, and long sessions.
 * Pure read-only analysis over existing session state — no new disk writes.
 */
import { execSync } from "node:child_process";
import { basename } from "node:path";
import { recall } from "./memory.js";
import { logActivity } from "./activity.js";
// --- Signal Detectors ---
/**
 * Signal 1: Same error (by type + file) appears in multiple investigations.
 */
function detectRepeatedErrors(session) {
    const investigations = session.captures.filter((c) => c.data?.type === "investigation");
    if (investigations.length < 2)
        return null;
    const counts = new Map();
    for (const inv of investigations) {
        const d = inv.data;
        const type = d.error?.type ?? d.triage?.classification?.type ?? "unknown";
        const file = d.sourceFiles?.[0] ?? d.hintFiles?.[0] ?? "unknown";
        const fp = `${type}::${file}`;
        counts.set(fp, (counts.get(fp) ?? 0) + 1);
    }
    const repeated = [...counts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1]);
    if (repeated.length === 0)
        return null;
    const [topFp, topCount] = repeated[0];
    const [errorType, file] = topFp.split("::");
    return {
        signal: "repeated_error",
        severity: topCount >= 3 ? "critical" : "warning",
        count: topCount,
        message: `Same error investigated ${topCount} times this session: ${errorType} in ${file}`,
        data: { errorType, file, occurrences: topCount },
    };
}
/**
 * Signal 2: Same file touched multiple times without resolution.
 */
function detectFileChurn(session) {
    const fileTouches = new Map();
    for (const inst of session.instrumentation) {
        const f = basename(inst.filePath);
        fileTouches.set(f, (fileTouches.get(f) ?? 0) + 1);
    }
    for (const cap of session.captures) {
        const d = cap.data;
        if (d?.type === "investigation") {
            for (const f of d.sourceFiles ?? []) {
                fileTouches.set(f, (fileTouches.get(f) ?? 0) + 1);
            }
        }
    }
    const churned = [...fileTouches.entries()]
        .filter(([, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1]);
    if (churned.length === 0)
        return null;
    const [topFile, topCount] = churned[0];
    return {
        signal: "file_churn",
        severity: topCount >= 5 ? "critical" : "warning",
        count: topCount,
        message: `${topFile} touched ${topCount} times this session without resolution`,
        data: { file: topFile, touches: topCount },
    };
}
/**
 * Signal 3: Agent reverted its own changes (git diff empty for session files).
 */
function detectReverts(session, cwd) {
    const sessionFiles = new Set();
    for (const inst of session.instrumentation) {
        sessionFiles.add(inst.filePath);
    }
    for (const cap of session.captures) {
        const d = cap.data;
        if (d?.type === "investigation" && Array.isArray(d.sourceFiles)) {
            for (const f of d.sourceFiles)
                sessionFiles.add(f);
        }
        if (d?.type === "investigation" && Array.isArray(d.hintFiles)) {
            for (const f of d.hintFiles)
                sessionFiles.add(f);
        }
    }
    if (sessionFiles.size === 0)
        return null;
    const revertedFiles = [];
    let checked = 0;
    for (const file of sessionFiles) {
        if (checked >= 5)
            break; // cap at 5 files for performance
        checked++;
        try {
            const diff = execSync(`git diff HEAD -- "${file}" 2>/dev/null`, { cwd, encoding: "utf-8", timeout: 5000 }).trim();
            if (diff === "") {
                const wasInstrumented = session.instrumentation.some((i) => i.filePath.endsWith(file));
                const wasInvestigated = session.captures.some((c) => {
                    const d = c.data;
                    return d?.sourceFiles?.includes(file) || d?.hintFiles?.includes(file);
                });
                if (wasInstrumented || wasInvestigated) {
                    revertedFiles.push(file);
                }
            }
        }
        catch {
            // git not available or file not tracked — skip
        }
    }
    if (revertedFiles.length === 0)
        return null;
    return {
        signal: "revert_detected",
        severity: "warning",
        count: revertedFiles.length,
        message: `${revertedFiles.length} file(s) reverted to original state: ${revertedFiles.join(", ")}`,
        data: { files: revertedFiles },
    };
}
/**
 * Signal 4: Multiple consecutive debug_verify failures.
 */
function detectVerifyStreak(session) {
    const verifies = session.captures.filter((c) => {
        const d = c.data;
        return d?.passed !== undefined && (d?.exitCode !== undefined || d?.errorCount !== undefined);
    });
    if (verifies.length < 2)
        return null;
    let streak = 0;
    for (let i = verifies.length - 1; i >= 0; i--) {
        const d = verifies[i].data;
        if (d.passed === false)
            streak++;
        else
            break;
    }
    if (streak < 2)
        return null;
    return {
        signal: "verify_failures",
        severity: streak >= 3 ? "critical" : "warning",
        count: streak,
        message: `${streak} consecutive fix attempts failed verification`,
        data: { consecutiveFailures: streak, totalVerifies: verifies.length },
    };
}
/**
 * Signal 5: Session duration warning (context rot indicator).
 */
function detectLongSession(session) {
    const elapsed = Date.now() - new Date(session.createdAt).getTime();
    const minutes = elapsed / (1000 * 60);
    if (minutes < 20)
        return null;
    const severity = minutes >= 90 ? "critical" : minutes >= 45 ? "warning" : "info";
    return {
        signal: "long_session",
        severity,
        count: Math.round(minutes),
        message: `Session running for ${Math.round(minutes)} minutes. ${severity === "critical"
            ? "Context is almost certainly degraded. Consider starting fresh with debug_cleanup."
            : severity === "warning"
                ? "Context may be degrading. Consider verifying your fix soon."
                : "Monitor for signs of context rot (repeated suggestions, forgotten decisions)."}`,
        data: { elapsedMinutes: Math.round(minutes) },
    };
}
// --- Recommendation Engine ---
function buildRecommendation(signals, session, cwd) {
    const types = new Set(signals.map((s) => s.signal));
    const maxSeverity = signals.some((s) => s.severity === "critical")
        ? "critical"
        : signals.some((s) => s.severity === "warning")
            ? "warning"
            : "info";
    // Priority 1: repeated error + verify failures = fix strategy is wrong
    if (types.has("repeated_error") && types.has("verify_failures")) {
        const pastFixes = recall(cwd, session.problem, 3);
        if (pastFixes.length > 0) {
            return ("LOOP DETECTED: Same error, repeated failed fixes. "
                + "Past solutions exist in memory — check debug_recall. "
                + "If those don't apply, the root cause is likely different from what you're targeting. "
                + "Step back and re-read the error from scratch.");
        }
        return ("LOOP DETECTED: Same error, repeated failed fixes. "
            + "Current approach isn't working. Try: "
            + "(1) re-read the actual error message, not your interpretation of it, "
            + "(2) check if a different file is the real source, "
            + "(3) use debug_cleanup and start a fresh session with a different hypothesis.");
    }
    // Priority 2: revert + file churn = agent is undoing its own work
    if (types.has("revert_detected") && types.has("file_churn")) {
        return ("LOOP DETECTED: Changes are being made and reverted in the same files. "
            + "The agent is fighting itself. "
            + "Run debug_cleanup, commit what works, and start a fresh session scoped to ONE file.");
    }
    // Priority 3: long session + any other signal = context rot
    if (types.has("long_session") && maxSeverity !== "info") {
        return ("LOOP DETECTED: Long session with repeated issues — likely context degradation. "
            + "Save your progress: run debug_verify on what works, debug_cleanup to close, "
            + "then start a new session. The fresh context will help.");
    }
    // Priority 4: repeated error alone = same bug keeps coming back
    if (types.has("repeated_error")) {
        return ("LOOP DETECTED: Same error keeps recurring. "
            + "The fix isn't addressing the root cause. "
            + "Check: (1) is the fix actually being saved to disk? "
            + "(2) is the dev server reloading? "
            + "(3) is there a different code path that produces the same error?");
    }
    // Priority 5: verify failures alone = fixes are wrong
    if (types.has("verify_failures")) {
        const streak = signals.find((s) => s.signal === "verify_failures");
        return (`LOOP DETECTED: ${streak?.count ?? 2}+ fix attempts failed. `
            + "Stop and reconsider the approach. "
            + "Use debug_recall to check if this error was solved before.");
    }
    // Default
    return "Potential loop detected. Consider reviewing your approach.";
}
/**
 * Signal 6: Too many failed approaches — agent keeps trying things that don't work.
 */
function detectFailedApproaches(session) {
    const approaches = session.failedApproaches;
    if (!approaches || approaches.length < 2)
        return null;
    return {
        signal: "repeated_error", // reuse existing signal type for compatibility
        severity: approaches.length >= 4 ? "critical" : "warning",
        count: approaches.length,
        message: `${approaches.length} fix attempts failed this session: ${approaches.slice(-2).join("; ")}`,
        data: { failedApproaches: approaches, total: approaches.length },
    };
}
/**
 * Signal 7: Error orbiting — error trajectory shows cycling back to a previous pattern.
 */
function detectOrbiting(session) {
    const traj = session.errorTrajectory;
    if (!traj || traj.length < 3)
        return null;
    const current = traj[traj.length - 1];
    const priorMatch = traj.slice(0, -1).find((t) => t.fingerprint === current.fingerprint);
    if (!priorMatch)
        return null;
    return {
        signal: "revert_detected", // reuse existing signal type — orbiting is a form of revert
        severity: "critical",
        count: traj.length,
        message: `Error is orbiting: ${current.errorType} in ${current.sourceFile ?? "unknown"} appeared before at ${priorMatch.timestamp}. The agent is cycling through error mutations without resolving the root cause.`,
        data: {
            currentFingerprint: current.fingerprint,
            trajectoryLength: traj.length,
            uniqueFingerprints: [...new Set(traj.map((t) => t.fingerprint))].length,
        },
    };
}
// --- Entry Point ---
export function analyzeLoop(session, cwd) {
    const signals = [];
    const s1 = detectRepeatedErrors(session);
    if (s1)
        signals.push(s1);
    const s2 = detectFileChurn(session);
    if (s2)
        signals.push(s2);
    const s3 = detectReverts(session, cwd);
    if (s3)
        signals.push(s3);
    const s4 = detectVerifyStreak(session);
    if (s4)
        signals.push(s4);
    const s5 = detectLongSession(session);
    if (s5)
        signals.push(s5);
    const s6 = detectFailedApproaches(session);
    if (s6)
        signals.push(s6);
    const s7 = detectOrbiting(session);
    if (s7)
        signals.push(s7);
    if (signals.length === 0) {
        return { looping: false, severity: "info", signals: [], recommendation: "" };
    }
    // Overall severity = worst signal
    const severity = signals.some((s) => s.severity === "critical")
        ? "critical"
        : signals.some((s) => s.severity === "warning")
            ? "warning"
            : "info";
    const recommendation = buildRecommendation(signals, session, cwd);
    // Log telemetry event
    logActivity({
        tool: "loop_detection",
        ts: Date.now(),
        summary: `${signals.length} signal(s): ${signals.map((s) => s.signal).join(", ")}`,
        metrics: {
            severity,
            signals: signals.length,
            sessionAge: Math.round((Date.now() - new Date(session.createdAt).getTime()) / 60000),
        },
    });
    return {
        looping: severity !== "info",
        severity,
        signals,
        recommendation,
    };
}
//# sourceMappingURL=loop.js.map