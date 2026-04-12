/**
 * watcher.ts — Live loop detection for serve mode.
 *
 * Monitors .debug/live-context.json for error patterns that indicate
 * an agent (any agent — Claude Code, Lovable, Bolt, Replit, or a human)
 * is going in circles. When detected, prints actionable warnings to
 * the terminal and optionally sends a desktop notification.
 *
 * This is the bridge between stackpack-debug and closed agent systems.
 * The user can't inject tools into Lovable's sandbox, but they CAN
 * run `spdg serve` while the closed agent works. The watcher sees
 * the same errors the agent sees and detects loops the agent can't.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { recall } from "./memory.js";
import { signatureFromError } from "./signature.js";
import { lookupFixPrompt } from "./fix-library.js";
// --- State ---
const history = [];
const MAX_HISTORY = 30; // 30 snapshots × 5s = 2.5 minutes of history
const seenAlerts = new Set(); // dedup alerts by message hash
// --- Core ---
function takeSnapshot(cwd) {
    const path = join(cwd, ".debug", "live-context.json");
    if (!existsSync(path))
        return null;
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        const age = Date.now() - new Date(raw.updatedAt).getTime();
        if (age > 15_000)
            return null; // stale — serve might not be running
        const termErrors = (raw.terminal ?? [])
            .filter((t) => /error|panic|failed|crash|exception/i.test(t.text))
            .map((t) => t.text);
        const browserErrors = (raw.browser ?? [])
            .filter((b) => {
            const d = typeof b.data === "object" && b.data !== null ? b.data : null;
            return d?.level === "error" || b.source === "browser-error";
        })
            .map((b) => {
            const d = typeof b.data === "object" && b.data !== null ? b.data : null;
            return String(d?.message ?? d?.text ?? JSON.stringify(d));
        });
        const buildErrors = (raw.buildErrors ?? []).map((e) => ({
            file: e.file, message: e.message,
        }));
        // Compute error signatures for the current errors
        const allErrorTexts = [...termErrors, ...browserErrors, ...buildErrors.map((e) => e.message)];
        const signatures = allErrorTexts.slice(0, 5).map((text) => signatureFromError(text, null));
        return {
            timestamp: raw.updatedAt,
            terminalErrors: termErrors.slice(-10),
            browserErrors: browserErrors.slice(-10),
            buildErrors: buildErrors.slice(-10),
            totalCount: termErrors.length + browserErrors.length + buildErrors.length,
            errorSignatures: [...new Set(signatures)],
        };
    }
    catch {
        return null;
    }
}
function analyze(cwd) {
    const snapshot = takeSnapshot(cwd);
    if (!snapshot)
        return [];
    history.push(snapshot);
    if (history.length > MAX_HISTORY)
        history.shift();
    if (history.length < 3)
        return [];
    const alerts = [];
    // --- Detection 1: Error count rising (degrading health) ---
    const recent5 = history.slice(-5);
    if (recent5.length >= 3) {
        const counts = recent5.map((s) => s.totalCount);
        const rising = counts.every((c, i) => i === 0 || c >= counts[i - 1]) && counts[counts.length - 1] > counts[0];
        if (rising && counts[counts.length - 1] > 0) {
            alerts.push({
                type: "degrading",
                severity: counts[counts.length - 1] >= counts[0] + 3 ? "critical" : "warning",
                message: `Error count rising: ${counts.join(" → ")}`,
                suggestion: "The current changes are making things worse. Consider reverting the last edit.",
            });
        }
    }
    // --- Detection 2: Same error signature repeating (loop) ---
    if (history.length >= 4) {
        const recent = history.slice(-6);
        const sigCounts = new Map();
        for (const snap of recent) {
            for (const sig of snap.errorSignatures) {
                sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
            }
        }
        for (const [sig, count] of sigCounts) {
            if (count >= 4) {
                // Same error appearing in 4+ of the last 6 snapshots = stuck
                const errorText = recent[recent.length - 1].terminalErrors[0]
                    ?? recent[recent.length - 1].browserErrors[0]
                    ?? recent[recent.length - 1].buildErrors[0]?.message
                    ?? "unknown error";
                alerts.push({
                    type: "loop",
                    severity: count >= 5 ? "critical" : "warning",
                    message: `Same error persisting across ${count} checks: ${errorText.slice(0, 100)}`,
                    suggestion: "This error isn't being fixed by the current approach. Try a different strategy.",
                });
                // Check fix library first (curated prompts), then general memory
                try {
                    const fixEntry = lookupFixPrompt(cwd, errorText, null);
                    if (fixEntry) {
                        const rate = fixEntry.successCount + fixEntry.failureCount > 0
                            ? `${Math.round(fixEntry.successCount / (fixEntry.successCount + fixEntry.failureCount) * 100)}% success rate`
                            : "new fix";
                        alerts.push({
                            type: "recall_available",
                            severity: "info",
                            message: `Curated fix prompt available (${rate})`,
                            suggestion: fixEntry.explanation,
                            recalledFix: fixEntry.fixPrompt,
                        });
                    }
                    else {
                        const matches = recall(cwd, errorText, 1);
                        if (matches.length > 0 && !matches[0].staleness.stale) {
                            alerts.push({
                                type: "recall_available",
                                severity: "info",
                                message: `Known fix exists in debug memory`,
                                suggestion: matches[0].diagnosis,
                                recalledFix: matches[0].rootCause?.fixDescription ?? matches[0].diagnosis,
                            });
                        }
                    }
                }
                catch { /* recall failure is non-fatal */ }
                break; // one loop alert is enough
            }
        }
    }
    // --- Detection 3: Error orbiting (signature A → B → A) ---
    if (history.length >= 6) {
        const sigSequence = history.slice(-8).map((s) => s.errorSignatures[0]).filter(Boolean);
        if (sigSequence.length >= 4) {
            // Check if a signature from early in the sequence reappears later
            const firstSig = sigSequence[0];
            const lastSig = sigSequence[sigSequence.length - 1];
            const midSigs = sigSequence.slice(1, -1);
            if (firstSig === lastSig && midSigs.some((s) => s !== firstSig)) {
                alerts.push({
                    type: "orbiting",
                    severity: "critical",
                    message: "Errors are cycling: fix A → introduces B → fix B → reintroduces A",
                    suggestion: "The underlying issue connects both errors. Look for the shared dependency or state they both touch.",
                });
            }
        }
    }
    // Dedup: don't repeat the same alert within 60 seconds
    return alerts.filter((a) => {
        const key = `${a.type}:${a.message.slice(0, 50)}`;
        if (seenAlerts.has(key))
            return false;
        seenAlerts.add(key);
        setTimeout(() => seenAlerts.delete(key), 60_000);
        return true;
    });
}
// --- Terminal Rendering ---
const SEVERITY_ICONS = {
    info: "💡",
    warning: "⚠️ ",
    critical: "🔴",
};
function renderAlert(alert) {
    const icon = SEVERITY_ICONS[alert.severity] ?? "•";
    const divider = alert.severity === "critical"
        ? "\x1b[31m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m"
        : "\x1b[33m───────────────────────────────────────────────\x1b[0m";
    console.log("");
    console.log(divider);
    console.log(`${icon} \x1b[1m${alert.type.toUpperCase()}: ${alert.message}\x1b[0m`);
    console.log(`   ${alert.suggestion}`);
    if (alert.recalledFix) {
        console.log(`   \x1b[32m💾 Known fix: ${alert.recalledFix}\x1b[0m`);
    }
    console.log(divider);
    console.log("");
    // Desktop notification for critical alerts
    if (alert.severity === "critical") {
        sendDesktopNotification(alert);
    }
}
function sendDesktopNotification(alert) {
    try {
        if (process.platform === "darwin") {
            const title = `stackpack-debug: ${alert.type}`;
            const msg = alert.message.slice(0, 200).replace(/"/g, '\\"');
            execSync(`osascript -e 'display notification "${msg}" with title "${title}"' 2>/dev/null`, { timeout: 2000 });
        }
    }
    catch {
        // Non-fatal — notification is a nice-to-have
    }
}
// --- Public API ---
/**
 * Start the loop watcher. Polls live-context.json and prints alerts.
 * Returns a stop function.
 */
export function startLoopWatcher(cwd) {
    // Check every 10 seconds (live context updates every 5s, so we catch every other)
    const interval = setInterval(() => {
        const alerts = analyze(cwd);
        for (const alert of alerts) {
            renderAlert(alert);
        }
    }, 10_000);
    return { stop: () => clearInterval(interval) };
}
//# sourceMappingURL=watcher.js.map