/**
 * budget.ts — Token budget estimation and response compression.
 *
 * Ensures debug responses fit within agent context windows by:
 * 1. Estimating token count of structured responses
 * 2. Progressively compressing sections when over budget
 * 3. Prioritizing actionable info (nextStep, rootCause) over raw data
 */
export interface BudgetOptions {
    maxTokens: number;
    preserveKeys: string[];
    summaryDepth: number;
}
export declare function estimateTokens(obj: unknown): number;
/**
 * Compress a response object to fit within a token budget.
 * Strategy: progressively truncate lower-priority fields.
 */
export declare function fitToBudget<T extends Record<string, unknown>>(response: T, opts?: Partial<BudgetOptions>): T & {
    _budget?: {
        estimated: number;
        target: number;
        compressed: boolean;
        overflowHandled?: boolean;
    };
};
