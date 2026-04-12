/**
 * context.ts — Automatic context gathering engine.
 *
 * The #1 insight: developers waste most debugging time gathering context,
 * not fixing bugs. This module automates that entirely.
 *
 * Given an error string, it:
 *   1. Parses stack frames to find relevant source files
 *   2. Reads those files (the exact lines around the error)
 *   3. Gets the git diff showing recent changes to those files
 *   4. Captures the runtime environment
 *   5. Returns a single structured object with everything the agent needs
 */
export interface StackFrame {
    fn: string;
    file: string;
    line: number;
    col: number | null;
    isUserCode: boolean;
}
interface SourceSnippet {
    file: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    lines: string;
    errorLine: number;
}
interface GitContext {
    branch: string | null;
    commit: string | null;
    dirty: number;
    recentChanges: string | null;
}
interface EnvSnapshot {
    platform: string;
    node: string;
    python: string | null;
    rust: string | null;
    project: string | null;
    frameworks: Record<string, string>;
    envVars: Record<string, string>;
}
export interface ErrorClassification {
    type: string;
    summary: string;
    category: string;
    severity: "fatal" | "error" | "warning";
    suggestion: string;
}
export declare function classifyError(raw: string): ErrorClassification;
export interface UnwrappedError {
    outerMessage: string;
    innerErrors: Array<{
        wrapper: string;
        message: string;
        attempts?: number;
    }>;
    httpStatus: number | null;
    url: string | null;
    provider: string | null;
}
/** Extract diagnostic info from wrapped/chained errors (RetryError, AI SDK, etc.) */
export declare function unwrapErrorChain(raw: string): UnwrappedError;
export interface ProviderMismatch {
    expected: string | null;
    actual: string;
    actualUrl: string;
    signal: string;
}
/**
 * Detect provider/endpoint mismatches from browser network events and error chain.
 * Looks for signals that the app is hitting a different provider than expected.
 */
export declare function detectProviderMismatch(errorChain: UnwrappedError, browserNetworkEvents: Array<{
    url?: string;
    status?: number;
    method?: string;
    ok?: boolean;
}>, errorText: string): ProviderMismatch | null;
/**
 * Determine if an error is visual/CSS-related, warranting screenshot capture.
 */
export declare function isVisualError(category: string, file?: string | null, description?: string | null): boolean;
export interface InvestigationResult {
    error: ErrorClassification;
    sourceCode: SourceSnippet[];
    git: GitContext;
    environment: EnvSnapshot;
    frames: StackFrame[];
}
export declare function investigate(errorText: string, cwd: string, hintFiles?: string[]): InvestigationResult;
export {};
