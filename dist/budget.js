/**
 * budget.ts — Token budget estimation and response compression.
 *
 * Ensures debug responses fit within agent context windows by:
 * 1. Estimating token count of structured responses
 * 2. Progressively compressing sections when over budget
 * 3. Prioritizing actionable info (nextStep, rootCause) over raw data
 */
// Rough token estimation: ~4 chars per token for English text
const CHARS_PER_TOKEN = 4;
const DEFAULTS = {
    maxTokens: 4000,
    preserveKeys: ["nextStep", "rootCause", "severity", "category", "confidence"],
    summaryDepth: 1,
};
export function estimateTokens(obj) {
    const json = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    return Math.ceil(json.length / CHARS_PER_TOKEN);
}
/**
 * Compress a response object to fit within a token budget.
 * Strategy: progressively truncate lower-priority fields.
 */
export function fitToBudget(response, opts = {}) {
    const { maxTokens, preserveKeys, summaryDepth } = { ...DEFAULTS, ...opts };
    const initial = estimateTokens(response);
    if (initial <= maxTokens) {
        return { ...response, _budget: { estimated: initial, target: maxTokens, compressed: false } };
    }
    // Clone for mutation
    const compressed = JSON.parse(JSON.stringify(response));
    // Phase 1: Truncate long string arrays (captures, stackFrames, etc.)
    for (const [key, val] of Object.entries(compressed)) {
        if (preserveKeys.includes(key))
            continue;
        if (Array.isArray(val) && val.length > 5) {
            const kept = val.slice(0, 3);
            kept.push(`... ${val.length - 3} more items omitted for context budget`);
            compressed[key] = kept;
        }
    }
    if (estimateTokens(compressed) <= maxTokens) {
        return { ...compressed, _budget: { estimated: estimateTokens(compressed), target: maxTokens, compressed: true } };
    }
    // Phase 2: Truncate long strings (>500 chars) to first 200 + summary
    for (const [key, val] of Object.entries(compressed)) {
        if (preserveKeys.includes(key))
            continue;
        if (typeof val === "string" && val.length > 500) {
            compressed[key] = val.slice(0, 200) + `\n... [truncated ${val.length - 200} chars]`;
        }
    }
    if (estimateTokens(compressed) <= maxTokens) {
        return { ...compressed, _budget: { estimated: estimateTokens(compressed), target: maxTokens, compressed: true } };
    }
    // Phase 3: Remove non-essential nested objects
    for (const [key, val] of Object.entries(compressed)) {
        if (preserveKeys.includes(key))
            continue;
        if (val && typeof val === "object" && !Array.isArray(val)) {
            const nested = val;
            const keys = Object.keys(nested);
            if (keys.length > 5) {
                const summary = {};
                for (const k of keys.slice(0, 3))
                    summary[k] = nested[k];
                summary._note = `${keys.length - 3} more fields omitted`;
                compressed[key] = summary;
            }
        }
    }
    // Phase 4 (aggressive): Remove environment, git details if still over budget
    if (summaryDepth >= 2 || estimateTokens(compressed) > maxTokens) {
        delete compressed.environment;
        delete compressed.gitContext;
        delete compressed.rawStack;
    }
    const finalTokens = estimateTokens(compressed);
    return { ...compressed, _budget: { estimated: finalTokens, target: maxTokens, compressed: true } };
}
//# sourceMappingURL=budget.js.map