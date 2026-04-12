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
import type { CaptureEvent } from "./capture-server.js";
/** An auto-filed issue from browser captures. */
export interface Issue {
    id: string;
    errorSignature: string;
    errorType: string;
    errorMessage: string;
    stack: string | null;
    sourceFile: string | null;
    platform: string;
    agentChatContext: string[];
    editorContext: string | null;
    failedApproaches: string[];
    networkErrors: string[];
    occurrenceCount: number;
    firstSeen: string;
    lastSeen: string;
    status: "open" | "solved" | "wont_fix";
    fixId: string | null;
    claudePrompt: string;
}
/** A curated fix prompt — the output of the curation workflow. */
export interface FixPromptEntry {
    id: string;
    errorSignature: string;
    errorType: string;
    errorExample: string;
    platform: string | "any";
    fixPrompt: string;
    explanation: string;
    failedApproaches: string[];
    successCount: number;
    failureCount: number;
    createdAt: string;
    updatedAt: string;
    contributedBy?: string;
}
/**
 * File an issue from a capture event. Called by the capture server
 * every time an error is received. Deduplicates by signature —
 * if the same error has been filed, increments the occurrence count.
 */
export declare function fileIssue(cwd: string, event: CaptureEvent, context: {
    platform: string;
    recentAgentMessages: string[];
    editorContent: string | null;
    recentNetworkErrors: string[];
}): Issue;
/** Get all open issues, sorted by occurrence count (most common first). */
export declare function getOpenIssues(cwd: string): Issue[];
/** Get a specific issue by ID. */
export declare function getIssue(cwd: string, issueId: string): Issue | null;
/**
 * Solve an issue: submit the fix prompt that Claude generated.
 * This creates a library entry and marks the issue as solved.
 */
export declare function solveIssue(cwd: string, issueId: string, fixPrompt: string, explanation: string): FixPromptEntry;
export declare function lookupFixPrompt(cwd: string, errorText: string, sourceFile: string | null, platform?: string): FixPromptEntry | null;
export declare function recordFixOutcome(cwd: string, fixId: string, success: boolean): void;
export declare function listFixPrompts(cwd: string): FixPromptEntry[];
