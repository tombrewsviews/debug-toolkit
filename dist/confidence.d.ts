/**
 * confidence.ts — Memory confidence scoring.
 *
 * Composite score (0.0–1.0) based on:
 *   - Age factor (0.3 weight): exponential decay over 90 days
 *   - File drift factor (0.4 weight): exponential decay by commit count
 *   - Usage factor (0.3 weight): recall-to-use ratio
 */
export interface ConfidenceFactors {
    ageInDays: number;
    fileDriftCommits: number;
    timesRecalled: number;
    timesUsed: number;
}
export declare function computeConfidence(factors: ConfidenceFactors): number;
export declare const CONFIDENCE_THRESHOLD = 0.3;
export declare const ARCHIVE_THRESHOLD = 0.2;
export declare const PROACTIVE_THRESHOLD = 0.8;
