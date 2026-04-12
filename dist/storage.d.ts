/**
 * storage.ts — Team memory backend for shared debugging knowledge.
 *
 * Local memory (memory.ts) remains primary and unchanged.
 * This module adds team sync: push local entries to StackPack platform,
 * pull team knowledge on recall, merge results.
 *
 * Requires STACKPACK_EVENTS_URL + STACKPACK_API_KEY env vars.
 * Degrades gracefully: if not configured or unreachable, returns empty.
 */
import type { MemoryEntry } from "./memory.js";
export interface TeamRecallResult {
    entry: MemoryEntry;
    relevance: number;
    contributedBy: string;
    projectSlug: string | null;
    successRate: number;
    superseded: boolean;
    source: "team";
}
export interface TeamPushResult {
    synced: number;
    conflicts: number;
    errors: string[];
}
export interface TeamPullResult {
    entries: Array<MemoryEntry & {
        contributedBy: string;
        successRate: number;
    }>;
    cursor: string;
}
export declare class TeamMemoryClient {
    private baseUrl;
    private apiKey;
    constructor(baseUrl: string, apiKey: string);
    /**
     * Create a client from environment variables.
     * Returns null if not configured.
     */
    static fromEnv(): TeamMemoryClient | null;
    /**
     * Check if the platform is reachable and healthy.
     * Returns status info for display to the user.
     */
    checkHealth(): Promise<{
        reachable: boolean;
        status: string;
        uptime?: number;
        services?: Record<string, string>;
        error?: string;
        troubleshooting?: string[];
    }>;
    /**
     * Push local memory entries to the team pool.
     * Deduplicates by error signature on the server side.
     */
    push(entries: MemoryEntry[]): Promise<TeamPushResult>;
    /**
     * Pull new team entries since a timestamp.
     */
    pull(since: string): Promise<TeamPullResult>;
    /**
     * Search team memory for past solutions.
     * Falls back to empty results on any error.
     */
    recall(query: string, opts?: {
        errorSignature?: string;
        sourceFile?: string;
        limit?: number;
        projectSlug?: string;
        scope?: "project" | "org";
    }): Promise<TeamRecallResult[]>;
    /**
     * Report outcome for a recalled entry — closes the feedback loop.
     * Increments times_applied + times_succeeded/times_failed on the server.
     */
    reportOutcome(entryId: string, outcome: {
        applied: boolean;
        succeeded: boolean;
    }): Promise<void>;
}
/**
 * Merge local recall results with team recall results.
 * Local results always rank first. Team results fill remaining slots.
 * Entries matching failedApproaches get annotated.
 */
export declare function mergeRecallResults<L extends {
    relevance: number;
    confidence: number;
}>(local: L[], team: TeamRecallResult[], limit: number, failedApproaches?: string[]): Array<(L & {
    source: "local";
}) | (TeamRecallResult & {
    failedApproachWarning?: string;
})>;
