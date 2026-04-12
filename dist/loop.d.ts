/**
 * Loop Detection — within-session analysis layer.
 *
 * Detects when an agent is going in circles: repeated errors, file churn,
 * reverted changes, verify failure streaks, and long sessions.
 * Pure read-only analysis over existing session state — no new disk writes.
 */
import type { DebugSession } from "./session.js";
export type LoopSignalType = "repeated_error" | "file_churn" | "revert_detected" | "verify_failures" | "long_session";
export type LoopSeverity = "info" | "warning" | "critical";
export interface LoopSignal {
    signal: LoopSignalType;
    severity: LoopSeverity;
    count: number;
    message: string;
    data: Record<string, unknown>;
}
export interface LoopAnalysis {
    looping: boolean;
    severity: LoopSeverity;
    signals: LoopSignal[];
    recommendation: string;
}
export declare function analyzeLoop(session: DebugSession, cwd: string): LoopAnalysis;
