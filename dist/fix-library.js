/**
 * fix-library.ts — Auto-filed issue inbox + curated fix prompt library.
 *
 * Two data structures:
 *
 * 1. ISSUE INBOX (.debug/issues.json)
 *    Auto-populated from browser captures. When the capture server sees
 *    an error, it files an issue with all available context. Issues
 *    accumulate automatically as users work with closed agents.
 *    Each issue includes a pre-built Claude prompt ready to copy.
 *
 * 2. FIX LIBRARY (.debug/fix-library.json)
 *    Curated fix prompts, keyed by error signature. When you solve an
 *    issue (by running the Claude prompt and getting a fix), you paste
 *    Claude's response back and it becomes a library entry.
 *
 * Workflow:
 *   - Issues file themselves automatically from captures
 *   - `spdg fix list` shows the inbox
 *   - `spdg fix show <id>` prints the pre-built Claude prompt (ready to copy)
 *   - You paste into Claude, get the fix prompt back
 *   - `spdg fix solve <id>` lets you paste Claude's response → becomes library entry
 *   - Next user who hits the same error gets the fix served automatically
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signatureFromError } from "./signature.js";
import { recall } from "./memory.js";
// --- Storage ---
function issuesPath(cwd) { return join(cwd, ".debug", "issues.json"); }
function libraryPath(cwd) { return join(cwd, ".debug", "fix-library.json"); }
function ensureDir(cwd) {
    const dir = join(cwd, ".debug");
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
function loadIssues(cwd) {
    const p = issuesPath(cwd);
    if (!existsSync(p))
        return { version: 1, issues: [] };
    try {
        return JSON.parse(readFileSync(p, "utf-8"));
    }
    catch {
        return { version: 1, issues: [] };
    }
}
function saveIssues(cwd, store) {
    ensureDir(cwd);
    writeFileSync(issuesPath(cwd), JSON.stringify(store, null, 2));
}
function loadLibrary(cwd) {
    const p = libraryPath(cwd);
    if (!existsSync(p))
        return { version: 1, entries: [] };
    try {
        return JSON.parse(readFileSync(p, "utf-8"));
    }
    catch {
        return { version: 1, entries: [] };
    }
}
function saveLibrary(cwd, lib) {
    ensureDir(cwd);
    writeFileSync(libraryPath(cwd), JSON.stringify(lib, null, 2));
}
// --- Auto-File Issues ---
/**
 * File an issue from a capture event. Called by the capture server
 * every time an error is received. Deduplicates by signature —
 * if the same error has been filed, increments the occurrence count.
 */
export function fileIssue(cwd, event, context) {
    const store = loadIssues(cwd);
    const errorText = event.message ?? event.args ?? event.reason ?? event.text ?? event.error ?? "unknown";
    const sig = signatureFromError(errorText, event.filename ?? null);
    // Check if this error is already filed
    const existing = store.issues.find((i) => i.errorSignature === sig && i.status === "open");
    if (existing) {
        existing.occurrenceCount++;
        existing.lastSeen = new Date().toISOString();
        // Update context with latest data
        if (context.recentAgentMessages.length > 0) {
            existing.agentChatContext = context.recentAgentMessages.slice(-10);
        }
        if (context.editorContent) {
            existing.editorContext = context.editorContent;
        }
        // Rebuild the Claude prompt with updated context
        existing.claudePrompt = buildClaudePrompt(existing, cwd);
        saveIssues(cwd, store);
        return existing;
    }
    // New issue
    const issue = {
        id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        errorSignature: sig,
        errorType: extractErrorType(errorText),
        errorMessage: errorText.slice(0, 2000),
        stack: event.stack?.slice(0, 3000) ?? null,
        sourceFile: event.filename ?? null,
        platform: context.platform,
        agentChatContext: context.recentAgentMessages.slice(-10),
        editorContext: context.editorContent,
        failedApproaches: extractFailedApproaches(context.recentAgentMessages),
        networkErrors: context.recentNetworkErrors.slice(-5),
        occurrenceCount: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        status: "open",
        fixId: null,
        claudePrompt: "", // built below
    };
    issue.claudePrompt = buildClaudePrompt(issue, cwd);
    store.issues.push(issue);
    // Cap at 200 issues
    if (store.issues.length > 200) {
        store.issues = store.issues
            .filter((i) => i.status !== "solved") // keep unsolved
            .slice(-200);
    }
    saveIssues(cwd, store);
    return issue;
}
// --- Build Claude Prompt ---
/**
 * Build the complete Claude prompt for an issue.
 * This is the prompt you copy and paste into Claude to get a fix.
 * It includes EVERYTHING Claude needs to generate the fix prompt.
 */
function buildClaudePrompt(issue, cwd) {
    // Check memory for past solutions
    let memorySection = "";
    try {
        const matches = recall(cwd, issue.errorMessage, 3);
        if (matches.length > 0) {
            memorySection = `\n## PAST SOLUTIONS FROM MEMORY\n\n${matches.map((m) => `- "${m.diagnosis}" (${Math.round(m.confidence * 100)}% confidence${m.staleness.stale ? ", code changed since" : ""})`
                + (m.rootCause ? `\n  Root cause: ${m.rootCause.trigger}\n  Fix: ${m.rootCause.fixDescription}` : "")).join("\n")}\n`;
        }
    }
    catch { /* non-fatal */ }
    return `You are generating a FIX PROMPT for a closed AI coding agent (${issue.platform}).

A user is building an app with ${issue.platform}. The agent hit this error and is looping. The user needs a prompt they can paste into the ${issue.platform} chat that will lead the agent to fix the error in ONE attempt.

## THE ERROR

\`\`\`
${issue.errorMessage}
\`\`\`

${issue.stack ? `### Stack Trace\n\`\`\`\n${issue.stack}\n\`\`\`\n` : ""}
${issue.sourceFile ? `**Source file:** ${issue.sourceFile}\n` : ""}
**Error type:** ${issue.errorType}
**Times seen:** ${issue.occurrenceCount}
**Platform:** ${issue.platform}

## WHAT THE AGENT WAS DOING

${issue.agentChatContext.length > 0
        ? `The agent's recent messages:\n${issue.agentChatContext.map((m) => `> ${m.slice(0, 300)}`).join("\n\n")}`
        : "No agent chat context captured."}

## CODE IN THE EDITOR AT TIME OF ERROR

${issue.editorContext
        ? `\`\`\`\n${issue.editorContext.slice(0, 3000)}\n\`\`\``
        : "No editor content captured."}

## WHAT HAS ALREADY BEEN TRIED AND FAILED

${issue.failedApproaches.length > 0
        ? issue.failedApproaches.map((a) => `- ${a}`).join("\n")
        : "No failed approaches recorded yet."}

## NETWORK ERRORS (if related)

${issue.networkErrors.length > 0
        ? issue.networkErrors.map((e) => `- ${e}`).join("\n")
        : "None."}
${memorySection}
## YOUR TASK

Generate a prompt the user will paste into the ${issue.platform} agent's chat. Requirements:

1. **Be specific.** Name the exact file and change needed. Include the actual code to write.
2. **Explain the root cause.** The agent needs to understand WHY, not just WHAT.
3. **Reference what failed.** Tell the agent not to try approaches that already failed.
4. **Be copy-pasteable.** The user will select your ENTIRE response and paste it. No meta-commentary.
5. **Start with "STOP."** — This gets the agent's attention and breaks it out of its current loop.

## OUTPUT FORMAT

Your response must follow this exact format:

STOP. [one sentence describing the root cause]

The error is caused by [detailed explanation].

Fix it by changing [specific file] as follows:

\`\`\`[language]
[exact code to add/change]
\`\`\`

[If there are multiple changes needed, list each one with the file path]

Do NOT [list what the agent should avoid, based on failed approaches].

---

Write the fix prompt now. Start with "STOP."`;
}
// --- Extract Helpers ---
function extractErrorType(text) {
    const jsMatch = text.match(/^((?:Uncaught\s+)?(?:\w+Error|EvalError|RangeError|URIError))\s*:/m);
    if (jsMatch)
        return jsMatch[1].replace(/^Uncaught\s+/, "");
    if (/hydration/i.test(text))
        return "HydrationError";
    if (/ECONNREFUSED/.test(text))
        return "ECONNREFUSED";
    if (/404/.test(text))
        return "HTTP404";
    if (/500/.test(text))
        return "HTTP500";
    if (/CORS/.test(text))
        return "CORSError";
    return "RuntimeError";
}
/**
 * Extract failed approaches from agent chat messages.
 * Looks for patterns like "Let me try...", "I'll fix...", "Updating..."
 * followed by the error still persisting.
 */
function extractFailedApproaches(messages) {
    const approaches = [];
    const fixPatterns = /(?:let me|i'll|i will|trying to|updating|fixing|changing|modifying|adding|removing)/i;
    for (const msg of messages) {
        if (fixPatterns.test(msg)) {
            // Extract the first sentence as the approach description
            const firstSentence = msg.match(/^[^.!?\n]{10,150}[.!?]/)?.[0];
            if (firstSentence && !approaches.includes(firstSentence)) {
                approaches.push(firstSentence);
            }
        }
    }
    return approaches.slice(-5); // keep last 5
}
// --- Public API: Issue Inbox ---
/** Get all open issues, sorted by occurrence count (most common first). */
export function getOpenIssues(cwd) {
    return loadIssues(cwd).issues
        .filter((i) => i.status === "open")
        .sort((a, b) => b.occurrenceCount - a.occurrenceCount);
}
/** Get a specific issue by ID. */
export function getIssue(cwd, issueId) {
    return loadIssues(cwd).issues.find((i) => i.id === issueId) ?? null;
}
// --- Public API: Solve Workflow ---
/**
 * Solve an issue: submit the fix prompt that Claude generated.
 * This creates a library entry and marks the issue as solved.
 */
export function solveIssue(cwd, issueId, fixPrompt, explanation) {
    const store = loadIssues(cwd);
    const issue = store.issues.find((i) => i.id === issueId);
    if (!issue)
        throw new Error(`Issue not found: ${issueId}`);
    // Create fix library entry
    const lib = loadLibrary(cwd);
    const now = new Date().toISOString();
    const entry = {
        id: `fix_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        errorSignature: issue.errorSignature,
        errorType: issue.errorType,
        errorExample: issue.errorMessage.slice(0, 200),
        platform: issue.platform,
        fixPrompt,
        explanation,
        failedApproaches: issue.failedApproaches,
        successCount: 0,
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
    };
    // Replace existing entry for same signature+platform, or append
    const existingIdx = lib.entries.findIndex((e) => e.errorSignature === entry.errorSignature && e.platform === entry.platform);
    if (existingIdx >= 0) {
        entry.successCount = lib.entries[existingIdx].successCount;
        entry.failureCount = lib.entries[existingIdx].failureCount;
        lib.entries[existingIdx] = entry;
    }
    else {
        lib.entries.push(entry);
    }
    saveLibrary(cwd, lib);
    // Mark issue as solved
    issue.status = "solved";
    issue.fixId = entry.id;
    saveIssues(cwd, store);
    return entry;
}
// --- Public API: Fix Library ---
export function lookupFixPrompt(cwd, errorText, sourceFile, platform) {
    const lib = loadLibrary(cwd);
    if (lib.entries.length === 0)
        return null;
    const sig = signatureFromError(errorText, sourceFile);
    const exact = lib.entries.find((e) => e.errorSignature === sig && (e.platform === platform || e.platform === "any"));
    if (exact)
        return exact;
    const sigMatch = lib.entries.find((e) => e.errorSignature === sig);
    return sigMatch ?? null;
}
export function recordFixOutcome(cwd, fixId, success) {
    const lib = loadLibrary(cwd);
    const entry = lib.entries.find((e) => e.id === fixId);
    if (!entry)
        return;
    if (success)
        entry.successCount++;
    else
        entry.failureCount++;
    entry.updatedAt = new Date().toISOString();
    saveLibrary(cwd, lib);
}
export function listFixPrompts(cwd) {
    return loadLibrary(cwd).entries;
}
//# sourceMappingURL=fix-library.js.map