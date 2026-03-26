/**
 * confidence.ts — Memory confidence scoring.
 *
 * Composite score (0.0–1.0) based on:
 *   - Age factor (0.3 weight): exponential decay over 90 days
 *   - File drift factor (0.4 weight): exponential decay by commit count
 *   - Usage factor (0.3 weight): recall-to-use ratio
 */
const AGE_WEIGHT = 0.3;
const DRIFT_WEIGHT = 0.4;
const USAGE_WEIGHT = 0.3;
const AGE_HALF_LIFE_DAYS = 90;
const DRIFT_HALF_LIFE_COMMITS = 15;
export function computeConfidence(factors) {
    const ageFactor = Math.exp(-Math.LN2 * factors.ageInDays / AGE_HALF_LIFE_DAYS);
    const driftFactor = Math.exp(-Math.LN2 * factors.fileDriftCommits / DRIFT_HALF_LIFE_COMMITS);
    let usageFactor = 0.0;
    if (factors.timesRecalled > 0) {
        const useRate = factors.timesUsed / factors.timesRecalled;
        usageFactor = 0.3 + 0.7 * useRate;
    }
    const raw = AGE_WEIGHT * ageFactor + DRIFT_WEIGHT * driftFactor + USAGE_WEIGHT * usageFactor;
    return Math.max(0, Math.min(1, raw));
}
export const CONFIDENCE_THRESHOLD = 0.3;
export const ARCHIVE_THRESHOLD = 0.2;
export const PROACTIVE_THRESHOLD = 0.8;
//# sourceMappingURL=confidence.js.map