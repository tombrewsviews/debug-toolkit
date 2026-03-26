/**
 * telemetry.ts — Debug session outcome tracking.
 *
 * Tracks success/failure of debug sessions to improve future suggestions.
 * All data stays local in .debug/telemetry.json.
 */
export interface SessionOutcome {
    sessionId: string;
    errorType: string;
    category: string;
    files: string[];
    triageLevel: "trivial" | "medium" | "complex";
    outcome: "fixed" | "workaround" | "abandoned" | "recurring";
    durationMs: number;
    toolsUsed: string[];
    memoryHit: boolean;
    memoryApplied: boolean;
    timestamp: string;
}
export interface TelemetryStore {
    version: "1.0";
    outcomes: SessionOutcome[];
    aggregates: {
        totalSessions: number;
        fixRate: number;
        avgDurationMs: number;
        memoryHitRate: number;
        memoryApplyRate: number;
        topErrors: {
            errorType: string;
            count: number;
            fixRate: number;
        }[];
        topFiles: {
            file: string;
            count: number;
            fixRate: number;
        }[];
    };
}
export declare function recordOutcome(cwd: string, outcome: SessionOutcome): void;
export declare function getTelemetry(cwd: string): TelemetryStore;
export declare function getFixRateForError(cwd: string, errorType: string): number | null;
