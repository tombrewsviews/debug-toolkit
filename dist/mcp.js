/**
 * mcp.ts — MCP server with 9 tools + 1 resource.
 *
 * Design principles:
 *   1. One tool = one complete outcome. No chatty multi-step protocols.
 *   2. Preprocess, don't dump. Summarize and highlight, never return raw arrays.
 *   3. Every response tells the agent what to do next.
 *   4. Context window space is precious — keep responses compact.
 *   5. Memory: save diagnoses, recall past fixes for similar errors.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { basename } from "node:path";
import { createSession, loadSession, saveSession, newHypothesisId, } from "./session.js";
import { instrumentFile } from "./instrument.js";
import { cleanupSession } from "./cleanup.js";
import { drainCaptures, runAndCapture, getRecentCaptures, readTauriLogs, drainBuildErrors } from "./capture.js";
import { investigate, isVisualError } from "./context.js";
import { validateCommand } from "./security.js";
import { remember, recall, memoryStats } from "./memory.js";
import { triageError } from "./triage.js";
import { generateSuggestions } from "./suggestions.js";
import { METHODOLOGY } from "./methodology.js";
import { runLighthouse, compareSnapshots } from "./perf.js";
let cwd = process.cwd();
export function setCwd(dir) { cwd = dir; }
function text(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
export function createMcpServer() {
    const server = new McpServer({ name: "debug-toolkit", version: "0.7.0" }, { capabilities: { tools: {}, resources: {} } });
    // ━━━ RESOURCE: debug_methodology ━━━
    // Always-available debugging methodology. The "hot memory" tier.
    server.registerResource("debug_methodology", "debug://methodology", {
        description: "The debugging methodology — how to use debug-toolkit effectively. Read this before your first debugging session.",
        mimeType: "text/markdown",
    }, async () => ({
        contents: [{ uri: "debug://methodology", mimeType: "text/markdown", text: METHODOLOGY }],
    }));
    // ━━━ TOOL 1: debug_investigate ━━━
    // The killer feature. One call: error in, full context out.
    server.registerTool("debug_investigate", {
        title: "Investigate Error",
        description: `The primary debugging tool. Works for BOTH runtime errors AND logic/behavior bugs.

For runtime errors: give it the stack trace → returns error classification, source code at crash site, git context, environment.
For logic bugs: describe the problem + pass file paths in 'files' parameter → returns source code from those files for comparison.

Also auto-searches debug memory for past solutions to similar errors.
Start every debugging session with this tool.`,
        inputSchema: {
            error: z.string().describe("Error message, stack trace, or bug description"),
            sessionId: z.string().optional().describe("Existing session ID, or omit to auto-create"),
            problem: z.string().optional().describe("Bug description (used if creating new session)"),
            files: z.array(z.string()).optional().describe("File paths to examine (for logic bugs with no stack trace)"),
        },
    }, async ({ error: errorText, sessionId, problem, files: hintFiles }) => {
        // Auto-create session if needed
        let session;
        if (sessionId) {
            session = loadSession(cwd, sessionId);
        }
        else {
            session = createSession(cwd, problem ?? errorText.split("\n")[0]?.slice(0, 100) ?? "Debug session");
        }
        // Triage: classify error complexity
        const triage = triageError(errorText);
        // Fast-path for trivial errors — skip full pipeline
        if (triage.level === "trivial" && triage.fixHint) {
            session.captures.push({
                id: `inv_${Date.now()}`, timestamp: new Date().toISOString(),
                source: "environment", markerTag: null,
                data: { type: "investigation", triage: "trivial", error: triage.classification },
                hypothesisId: null,
            });
            saveSession(cwd, session);
            return text({
                sessionId: session.id,
                triage: "trivial",
                error: triage.classification,
                fixHint: triage.fixHint,
                nextStep: `Trivial error: ${triage.fixHint} Apply the fix, then use debug_verify to confirm.`,
            });
        }
        // Run the investigation engine
        const result = investigate(errorText, cwd, hintFiles);
        // Drain any accumulated build errors from the dev server
        const buildErrors = drainBuildErrors();
        // Persist build errors as captures on the session so they survive the response
        for (const be of buildErrors) {
            session.captures.push({
                id: `bld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                timestamp: new Date().toISOString(),
                source: "build-error",
                markerTag: null,
                data: { tool: be.tool, file: be.file, line: be.line, code: be.code, message: be.message },
                hypothesisId: null,
            });
        }
        // Check if this is a visual error (for screenshot integration)
        const sourceFiles = result.sourceCode.map((s) => s.relativePath);
        const visualError = isVisualError(result.error.category, sourceFiles[0] ?? null, errorText);
        // Check memory for past solutions to similar errors
        const pastSolutions = recall(cwd, errorText, 3);
        // Store as capture (include hint files for file tracking in cleanup)
        session.captures.push({
            id: `inv_${Date.now()}`, timestamp: new Date().toISOString(),
            source: "environment", markerTag: null,
            data: {
                type: "investigation",
                error: result.error,
                hintFiles: hintFiles ?? [],
                sourceFiles: result.sourceCode.map((s) => s.relativePath),
            },
            hypothesisId: null,
        });
        saveSession(cwd, session);
        const response = {
            sessionId: session.id,
            triage: triage.level,
            error: result.error,
            sourceCode: result.sourceCode.map((s) => ({
                file: s.relativePath,
                errorLine: s.errorLine,
                snippet: s.lines,
            })),
            git: result.git,
            environment: result.environment,
            buildErrors: buildErrors.length > 0 ? buildErrors.map((e) => ({
                tool: e.tool,
                file: e.file,
                line: e.line,
                code: e.code,
                message: e.message,
            })) : undefined,
            visualError,
            userFrames: result.frames.filter((f) => f.isUserCode).map((f) => ({
                fn: f.fn,
                file: basename(f.file),
                line: f.line,
            })),
        };
        // Include past solutions if found (with staleness + causal info)
        if (pastSolutions.length > 0) {
            const fresh = pastSolutions.filter((s) => !s.staleness.stale);
            response.pastSolutions = pastSolutions.map((s) => ({
                problem: s.problem,
                diagnosis: s.diagnosis,
                files: s.files,
                relevance: Math.round(s.relevance * 100) + "%",
                stale: s.staleness.stale,
                staleness: s.staleness.stale ? s.staleness.reason : undefined,
                rootCause: s.rootCause ?? undefined,
            }));
            response.nextStep = fresh.length > 0
                ? `Found ${fresh.length} fresh past solution(s). Review them before investigating further.`
                : `Found ${pastSolutions.length} past solution(s) but all are outdated (code changed). Investigate fresh.`;
        }
        else {
            response.nextStep = result.error.suggestion
                ? `Suggested fix: ${result.error.suggestion}`
                : "Use debug_instrument to add logging, then debug_capture to see the output.";
        }
        // Adjust nextStep if build errors found
        if (buildErrors.length > 0 && !response.nextStep) {
            response.nextStep = `${buildErrors.length} build error(s) detected from dev server. Review them — they may be the root cause.`;
        }
        // Visual error advisory — tell agent to use visual tools
        if (visualError) {
            response.visualHint = {
                isVisualBug: true,
                message: "This appears to be a visual/CSS bug. Use ghost_screenshot or preview_screenshot to capture the current visual state, then attach findings to this session.",
                suggestedActions: [
                    "Take a screenshot with ghost_screenshot or preview_screenshot",
                    "Capture DOM state with ghost_read or preview_snapshot for the affected element",
                    "After fixing, take another screenshot to compare before/after",
                ],
            };
            // Append to nextStep
            if (typeof response.nextStep === "string") {
                response.nextStep += " (Visual bug detected — screenshot recommended.)";
            }
        }
        return text(response);
    });
    // ━━━ TOOL 2: debug_instrument ━━━
    server.registerTool("debug_instrument", {
        title: "Instrument Code",
        description: `Add tagged debug logging to a source file. The logging:
- Respects the file's indentation
- Is tagged with a marker (e.g., [DBG_001]) for tracking
- Can be linked to a hypothesis
- Auto-cleans when you call debug_cleanup

Supports JS/TS/Python/Go.`,
        inputSchema: {
            sessionId: z.string(),
            filePath: z.string().describe("File to instrument"),
            lineNumber: z.number().describe("Insert AFTER this line (0-indexed)"),
            expression: z.string().describe("What to log (e.g., 'req.body', 'state.count')"),
            hypothesis: z.string().optional().describe("What you're testing (auto-creates hypothesis)"),
        },
    }, async ({ sessionId, filePath, lineNumber, expression, hypothesis }) => {
        const session = loadSession(cwd, sessionId);
        // Auto-create hypothesis if description provided
        let hypId;
        if (hypothesis) {
            const hyp = {
                id: newHypothesisId(), text: hypothesis, status: "testing", evidence: [],
            };
            session.hypotheses.push(hyp);
            hypId = hyp.id;
            saveSession(cwd, session);
        }
        const r = instrumentFile({ cwd, session, filePath, lineNumber, expression, hypothesisId: hypId });
        return text({
            markerTag: r.markerTag,
            file: basename(filePath),
            line: lineNumber,
            code: r.insertedCode,
            hypothesis: hypothesis ?? null,
            nextStep: `Run your app and use debug_capture to see [${r.markerTag}] output.`,
        });
    });
    // ━━━ TOOL 3: debug_capture ━━━
    server.registerTool("debug_capture", {
        title: "Capture Runtime Output",
        description: `Collect runtime output. Two modes:
1. Run a command and capture its output (e.g., 'npm test', 'curl localhost:3000')
2. Drain buffered terminal/browser output from the dev server

Returns tagged captures linked to hypotheses, plus any errors detected.
Results are paginated — only the most recent captures are returned.`,
        inputSchema: {
            sessionId: z.string(),
            command: z.string().optional().describe("Command to run (e.g., 'npm test')"),
            limit: z.number().optional().describe("Max results (default 30)"),
        },
    }, async ({ sessionId, command, limit }) => {
        const session = loadSession(cwd, sessionId);
        if (command) {
            const safe = validateCommand(command);
            const caps = await runAndCapture(safe, 30_000);
            session.captures.push(...caps);
            saveSession(cwd, session);
        }
        drainCaptures(cwd, session);
        // Also drain Tauri log files if this is a Tauri project
        const tauriLogs = readTauriLogs(cwd, 30);
        if (tauriLogs.length > 0) {
            session.captures.push(...tauriLogs);
            saveSession(cwd, session);
        }
        const recent = getRecentCaptures(session, { limit: limit ?? 30 });
        // Separate tagged (from instrumentation) vs untagged (ambient) captures
        const tagged = recent.captures.filter((c) => c.markerTag);
        const errors = recent.captures.filter((c) => {
            const d = c.data;
            return d?.stream === "stderr" || d?.text?.toLowerCase().includes("error");
        });
        return text({
            total: recent.total,
            showing: recent.showing,
            tagged: tagged.map((c) => ({
                tag: c.markerTag,
                hypothesis: c.hypothesisId,
                data: c.data,
            })),
            errors: errors.slice(0, 10).map((c) => c.data?.text),
            output: recent.captures.slice(0, 15).map((c) => ({
                source: c.source,
                data: c.data,
            })),
            nextStep: errors.length > 0
                ? "Errors detected. Use debug_investigate with the error text for full context."
                : tagged.length > 0
                    ? "Instrumented output captured. Review tagged data to confirm/reject hypotheses."
                    : recent.total === 0 && !command
                        ? "No output captured. Ask the user to run their app, then call debug_capture with a command like 'npm test' or 'curl localhost:3000' to collect output."
                        : "No tagged output yet. Make sure the instrumented code path is executed.",
        });
    });
    // ━━━ TOOL 4: debug_verify ━━━
    // Compound: snapshot + run + diff + assert — all in one call
    server.registerTool("debug_verify", {
        title: "Verify Fix",
        description: `After applying a fix, run this to verify it works. In one call it:
1. Runs your test/command
2. Captures all output
3. Checks for errors
4. Reports pass/fail

Use this before cleanup to confirm the fix actually works.`,
        inputSchema: {
            sessionId: z.string(),
            command: z.string().describe("Command that should succeed after the fix (e.g., 'npm test')"),
            expectNoErrors: z.boolean().optional().describe("Fail if ANY stderr output (default: true)"),
        },
    }, async ({ sessionId, command, expectNoErrors }) => {
        const session = loadSession(cwd, sessionId);
        const safe = validateCommand(command);
        const captures = await runAndCapture(safe, 60_000);
        session.captures.push(...captures);
        saveSession(cwd, session);
        const exitCapture = captures.find((c) => {
            const d = c.data;
            return d?.stream === "meta" && d?.text?.startsWith("exit:");
        });
        const exitCode = exitCapture
            ? parseInt(exitCapture.data.text.split(":")[1] ?? "1")
            : null;
        const errors = captures.filter((c) => {
            const d = c.data;
            return d?.stream === "stderr" && d?.text?.toLowerCase().includes("error");
        });
        const noErrors = expectNoErrors !== false;
        const passed = exitCode === 0 && (noErrors ? errors.length === 0 : true);
        // Auto-learning: when fix is verified, auto-save diagnosis to memory
        if (passed && session.problem) {
            const errorCap = session.captures.find((c) => c.data?.type === "investigation");
            const errorData = errorCap?.data;
            const filesSet = new Set(session.instrumentation.map((i) => basename(i.filePath)));
            for (const cap of session.captures) {
                const d = cap.data;
                if (d?.type === "investigation") {
                    for (const key of ["hintFiles", "sourceFiles"]) {
                        if (Array.isArray(d[key])) {
                            for (const f of d[key])
                                if (typeof f === "string")
                                    filesSet.add(f);
                        }
                    }
                }
            }
            remember(cwd, {
                id: session.id,
                timestamp: new Date().toISOString(),
                problem: session.problem,
                errorType: errorData?.error?.type ?? "Unknown",
                category: errorData?.error?.category ?? "runtime",
                diagnosis: `Auto-learned: fix verified via "${command}"`,
                files: [...filesSet],
                rootCause: null,
            });
        }
        return text({
            passed,
            exitCode,
            errorCount: errors.length,
            errors: errors.slice(0, 5).map((c) => c.data?.text),
            output: captures.slice(0, 10).map((c) => c.data?.text),
            nextStep: passed
                ? "Fix verified and auto-saved to memory! Use debug_cleanup to remove instrumentation (optional — diagnosis already recorded)."
                : "Fix failed. Review the errors above and try a different approach.",
        });
    });
    // ━━━ TOOL 5: debug_cleanup ━━━
    server.registerTool("debug_cleanup", {
        title: "Cleanup & Close",
        description: `Remove ALL debug instrumentation from source files, verify removal, and close the session.
Idempotent — safe to call multiple times. Files are restored to their pre-instrumented state.`,
        inputSchema: {
            sessionId: z.string(),
            diagnosis: z.string().optional().describe("Root cause summary (for the session record)"),
            rootCause: z.object({
                trigger: z.string().describe("What caused the error"),
                errorFile: z.string().describe("Where the error manifested"),
                causeFile: z.string().describe("Where the actual bug was"),
                fixDescription: z.string().describe("One-line fix description"),
            }).optional().describe("Causal chain — what caused the error and what fixed it"),
        },
    }, async ({ sessionId, diagnosis, rootCause }) => {
        const session = loadSession(cwd, sessionId);
        if (diagnosis) {
            session.diagnosis = diagnosis;
            saveSession(cwd, session);
        }
        const r = cleanupSession(cwd, session);
        // Save to memory for future recall
        if (diagnosis && session.problem) {
            const errorCap = session.captures.find((c) => c.data?.type === "investigation");
            const errorData = errorCap?.data;
            // Merge ALL file sources: instrumented + rootCause + investigated hint files
            const filesSet = new Set(session.instrumentation.map((i) => basename(i.filePath)));
            const rc = rootCause;
            if (rc?.errorFile)
                filesSet.add(rc.errorFile);
            if (rc?.causeFile)
                filesSet.add(rc.causeFile);
            // Also include files from investigation captures (hint files + source files)
            for (const cap of session.captures) {
                const d = cap.data;
                if (d?.type === "investigation") {
                    for (const key of ["hintFiles", "sourceFiles"]) {
                        if (Array.isArray(d[key])) {
                            for (const f of d[key])
                                if (typeof f === "string")
                                    filesSet.add(f);
                        }
                    }
                }
            }
            remember(cwd, {
                id: session.id,
                timestamp: new Date().toISOString(),
                problem: session.problem,
                errorType: errorData?.error?.type ?? "Unknown",
                category: errorData?.error?.category ?? "runtime",
                diagnosis,
                files: [...filesSet],
                rootCause: rc,
            });
        }
        const stats = memoryStats(cwd);
        return text({
            cleaned: r.cleaned,
            verified: r.verified,
            files: r.filesProcessed.map((f) => basename(f)),
            errors: r.errors.length > 0 ? r.errors : undefined,
            savedToMemory: !!diagnosis,
            memoryEntries: stats.entries,
            message: r.verified
                ? `Done. ${r.cleaned} file(s) cleaned.${diagnosis ? " Diagnosis saved to memory." : ""}`
                : `Cleanup had issues: ${r.errors.join(", ")}`,
        });
    });
    // ━━━ TOOL 7: debug_recall ━━━
    server.registerTool("debug_recall", {
        title: "Recall Past Solutions",
        description: `Search debug memory for past solutions to similar errors.
Returns past diagnoses ranked by relevance. Check this BEFORE deep investigation —
the same error may have been solved before in this project.`,
        inputSchema: {
            query: z.string().describe("Error message, error type, or description to search for"),
            limit: z.number().optional().describe("Max results (default: 5)"),
        },
    }, async ({ query, limit }) => {
        const matches = recall(cwd, query, limit ?? 5);
        const stats = memoryStats(cwd);
        if (matches.length === 0) {
            return text({
                matches: [],
                memoryEntries: stats.entries,
                message: stats.entries === 0
                    ? "No debug memory yet. Complete a debug session with a diagnosis to start building memory."
                    : `No matches found in ${stats.entries} stored sessions. This is a new error.`,
            });
        }
        const staleCount = matches.filter((m) => m.staleness.stale).length;
        return text({
            matches: matches.map((m) => ({
                problem: m.problem,
                errorType: m.errorType,
                diagnosis: m.diagnosis,
                files: m.files,
                relevance: Math.round(m.relevance * 100) + "%",
                date: m.timestamp,
                stale: m.staleness.stale,
                staleness: m.staleness.stale ? m.staleness.reason : undefined,
                rootCause: m.rootCause ?? undefined,
            })),
            message: `Found ${matches.length} past solution(s).${staleCount > 0 ? ` ${staleCount} may be outdated (code has changed since).` : ""} Top match: "${matches[0].diagnosis}"`,
            nextStep: staleCount === matches.length
                ? "All past solutions are outdated — code has changed. Investigate fresh with debug_investigate."
                : "If a past solution applies, try the same fix. Otherwise proceed with debug_investigate.",
        });
    });
    // ━━━ TOOL 8: debug_patterns ━━━
    server.registerTool("debug_patterns", {
        title: "Detect Bug Patterns",
        description: `Analyze debug memory to detect patterns across all past sessions:
- Recurring errors (same error type in same file, 3+ times)
- Hot files (files that appear in many debug sessions)
- Regressions (bugs that were fixed but came back)
- Error clusters (multiple errors in a short time window — cascading failures)

Use this periodically to understand your project's debugging health.`,
        inputSchema: {},
    }, async () => {
        const stats = memoryStats(cwd);
        if (stats.entries === 0) {
            return text({
                patterns: [],
                message: "No debug memory yet. Complete debug sessions to start detecting patterns.",
            });
        }
        const patterns = stats.patterns;
        const suggestions = generateSuggestions(patterns);
        const critical = patterns.filter((p) => p.severity === "critical");
        const warnings = patterns.filter((p) => p.severity === "warning");
        return text({
            memoryEntries: stats.entries,
            patterns: patterns.map((p) => ({
                type: p.type,
                severity: p.severity,
                message: p.message,
                details: p.data,
            })),
            suggestions: suggestions.length > 0 ? suggestions.map((s) => ({
                category: s.category,
                priority: s.priority,
                action: s.action,
                rationale: s.rationale,
            })) : undefined,
            summary: patterns.length === 0
                ? `${stats.entries} sessions analyzed. No concerning patterns detected.`
                : `${patterns.length} pattern(s) found: ${critical.length} critical, ${warnings.length} warnings.`,
            nextStep: suggestions.length > 0
                ? `${suggestions.length} preventive suggestion(s) available. Top: ${suggestions[0].action}`
                : critical.length > 0
                    ? `Critical: ${critical[0].message}. Consider refactoring this code.`
                    : patterns.length > 0
                        ? `Top finding: ${patterns[0].message}`
                        : undefined,
        });
    });
    // ━━━ TOOL: debug_perf ━━━
    server.registerTool("debug_perf", {
        title: "Performance Snapshot",
        description: `Capture a Lighthouse performance snapshot for a URL.
Returns Web Vitals: LCP, CLS, INP, Total Blocking Time, Speed Index.
Call before and after a fix to compare performance impact.
Requires Chrome installed. Gracefully skips if unavailable.`,
        inputSchema: {
            sessionId: z.string(),
            url: z.string().describe("URL to audit (e.g., 'http://localhost:3000')"),
            phase: z.enum(["before", "after"]).optional().describe("Label this snapshot as before or after a fix (default: before)"),
        },
    }, async ({ sessionId, url, phase }) => {
        const session = loadSession(cwd, sessionId);
        const snapshotPhase = phase ?? "before";
        const metrics = await runLighthouse(url);
        if (!metrics) {
            return text({
                error: "Lighthouse failed — Chrome may not be installed or the URL is unreachable.",
                nextStep: "Ensure Chrome is installed and the dev server is running, then retry.",
            });
        }
        const snapshot = {
            id: `perf_${Date.now()}`,
            timestamp: new Date().toISOString(),
            url,
            metrics,
            phase: snapshotPhase,
        };
        if (!session.perfSnapshots)
            session.perfSnapshots = [];
        session.perfSnapshots.push(snapshot);
        saveSession(cwd, session);
        // Compare with previous snapshot if this is an "after" snapshot
        let comparison;
        if (snapshotPhase === "after") {
            const beforeSnapshot = session.perfSnapshots.find((s) => s.phase === "before");
            if (beforeSnapshot) {
                const diff = compareSnapshots(beforeSnapshot.metrics, metrics);
                comparison = {
                    lcpChange: diff.lcp !== null ? `${diff.lcp > 0 ? "+" : ""}${Math.round(diff.lcp)}ms` : null,
                    clsChange: diff.cls !== null ? `${diff.cls > 0 ? "+" : ""}${diff.cls.toFixed(3)}` : null,
                    tbtChange: diff.tbt !== null ? `${diff.tbt > 0 ? "+" : ""}${Math.round(diff.tbt)}ms` : null,
                    improved: diff.improved,
                };
            }
        }
        return text({
            phase: snapshotPhase,
            url,
            metrics: {
                lcp: metrics.lcp !== null ? `${Math.round(metrics.lcp)}ms` : null,
                cls: metrics.cls !== null ? metrics.cls.toFixed(3) : null,
                inp: metrics.inp !== null ? `${Math.round(metrics.inp)}ms` : null,
                tbt: metrics.tbt !== null ? `${Math.round(metrics.tbt)}ms` : null,
                speedIndex: metrics.speedIndex !== null ? `${Math.round(metrics.speedIndex)}ms` : null,
            },
            comparison,
            nextStep: snapshotPhase === "before"
                ? "Apply your fix, then call debug_perf again with phase='after' to compare."
                : comparison?.improved
                    ? "Performance improved! Proceed with debug_verify to confirm the fix."
                    : "Performance did not improve. Review the metrics and consider a different approach.",
        });
    });
    // ━━━ TOOL 9: debug_session ━━━
    server.registerTool("debug_session", {
        title: "Session Status",
        description: `Get current session state: hypotheses, active instruments, recent captures.
Lightweight — returns a summary, not the full capture history.`,
        inputSchema: {
            sessionId: z.string(),
        },
    }, async ({ sessionId }) => {
        const session = loadSession(cwd, sessionId);
        const recent = getRecentCaptures(session, { limit: 10 });
        return text({
            id: session.id,
            status: session.status,
            problem: session.problem,
            hypotheses: session.hypotheses.map((h) => ({
                id: h.id, text: h.text, status: h.status, evidenceCount: h.evidence.length,
            })),
            instruments: session.instrumentation.filter((i) => i.active).map((i) => ({
                tag: i.markerTag, file: basename(i.filePath), line: i.lineNumber, hypothesis: i.hypothesisId,
            })),
            recentCaptures: recent.showing > 0
                ? { count: recent.total, recent: recent.captures.slice(0, 5).map((c) => ({ source: c.source, tag: c.markerTag, data: c.data })) }
                : null,
            diagnosis: session.diagnosis,
        });
    });
    return server;
}
export async function startMcpServer() {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
//# sourceMappingURL=mcp.js.map