/**
 * memory.ts — Debug session memory across conversations.
 *
 * Three tiers of intelligence:
 *   1. Recall — search past diagnoses for similar errors (keyword overlap)
 *   2. Staleness — flag outdated diagnoses when code has changed since
 *   3. Patterns — detect recurring errors, hot files, regression trends
 *
 * Implementation: JSON file + in-memory inverted index.
 * Zero native dependencies. Fast enough for hundreds of sessions.
 */
export interface MemoryEntry {
    id: string;
    timestamp: string;
    problem: string;
    errorType: string;
    category: string;
    diagnosis: string;
    files: string[];
    keywords: string[];
    gitSha: string | null;
    rootCause: CausalLink | null;
}
export interface CausalLink {
    trigger: string;
    errorFile: string;
    causeFile: string;
    fixDescription: string;
}
/**
 * Check staleness of a memory entry — have the referenced files changed?
 */
export interface StalenessInfo {
    stale: boolean;
    reason: string | null;
    commitsBehind: number;
    filesChanged: string[];
}
export interface PatternInsight {
    type: "recurring_error" | "hot_file" | "regression" | "error_cluster";
    severity: "info" | "warning" | "critical";
    message: string;
    data: Record<string, unknown>;
}
/**
 * Detect patterns across all stored debug sessions.
 * Cheap — just scans the JSON array, no external calls.
 */
export declare function detectPatterns(cwd: string): PatternInsight[];
/**
 * Save a completed debug session to memory.
 * Auto-captures the current git SHA for staleness tracking.
 */
export declare function remember(cwd: string, entry: Omit<MemoryEntry, "keywords" | "gitSha" | "rootCause"> & {
    rootCause?: CausalLink | null;
}): MemoryEntry;
/**
 * Search past debug sessions for similar errors.
 * Returns matches ranked by relevance, with staleness info and causal chains.
 */
export declare function recall(cwd: string, query: string, limit?: number): Array<MemoryEntry & {
    relevance: number;
    staleness: StalenessInfo;
}>;
/**
 * Get memory stats.
 */
export declare function memoryStats(cwd: string): {
    entries: number;
    oldestDate: string | null;
    newestDate: string | null;
    patterns: PatternInsight[];
};
