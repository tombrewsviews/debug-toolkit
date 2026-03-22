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
import { drainCaptures, runAndCapture, getRecentCaptures, readTauriLogs } from "./capture.js";
import { investigate } from "./context.js";
import { validateCommand } from "./security.js";
import { remember, recall, memoryStats } from "./memory.js";
import { METHODOLOGY } from "./methodology.js";
let cwd = process.cwd();
export function setCwd(dir) { cwd = dir; }
function text(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
export function createMcpServer() {
    const server = new McpServer({ name: "debug-toolkit", version: "0.4.0" }, { capabilities: { tools: {}, resources: {} } });
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
        description: `The primary debugging tool. Give it an error message or stack trace and it returns:
- Error classification (type, severity, plain-language suggestion)
- Source code snippets from the exact files/lines in the stack trace
- Git context (branch, recent changes to those files)
- Runtime environment (Node version, frameworks, env vars)

This is a COMPLETE investigation — no follow-up calls needed to understand the error.
Start every debugging session with this tool.`,
        inputSchema: {
            error: z.string().describe("Error message, stack trace, or terminal output"),
            sessionId: z.string().optional().describe("Existing session ID, or omit to auto-create"),
            problem: z.string().optional().describe("Bug description (used if creating new session)"),
        },
    }, async ({ error: errorText, sessionId, problem }) => {
        // Auto-create session if needed
        let session;
        if (sessionId) {
            session = loadSession(cwd, sessionId);
        }
        else {
            session = createSession(cwd, problem ?? errorText.split("\n")[0]?.slice(0, 100) ?? "Debug session");
        }
        // Run the investigation engine
        const result = investigate(errorText, cwd);
        // Check memory for past solutions to similar errors
        const pastSolutions = recall(cwd, errorText, 3);
        // Store as capture
        session.captures.push({
            id: `inv_${Date.now()}`, timestamp: new Date().toISOString(),
            source: "environment", markerTag: null, data: { type: "investigation", error: result.error },
            hypothesisId: null,
        });
        saveSession(cwd, session);
        const response = {
            sessionId: session.id,
            error: result.error,
            sourceCode: result.sourceCode.map((s) => ({
                file: s.relativePath,
                errorLine: s.errorLine,
                snippet: s.lines,
            })),
            git: result.git,
            environment: result.environment,
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
        return text({
            passed,
            exitCode,
            errorCount: errors.length,
            errors: errors.slice(0, 5).map((c) => c.data?.text),
            output: captures.slice(0, 10).map((c) => c.data?.text),
            nextStep: passed
                ? "Fix verified! Use debug_cleanup to remove instrumentation and close the session."
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
            remember(cwd, {
                id: session.id,
                timestamp: new Date().toISOString(),
                problem: session.problem,
                errorType: errorData?.error?.type ?? "Unknown",
                category: errorData?.error?.category ?? "runtime",
                diagnosis,
                files: session.instrumentation.map((i) => basename(i.filePath)),
                rootCause: rootCause,
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
            summary: patterns.length === 0
                ? `${stats.entries} sessions analyzed. No concerning patterns detected.`
                : `${patterns.length} pattern(s) found: ${critical.length} critical, ${warnings.length} warnings.`,
            nextStep: critical.length > 0
                ? `Critical: ${critical[0].message}. Consider refactoring this code.`
                : patterns.length > 0
                    ? `Top finding: ${patterns[0].message}`
                    : undefined,
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