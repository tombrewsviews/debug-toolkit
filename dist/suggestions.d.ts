/**
 * suggestions.ts — Preventive suggestions from debug patterns.
 *
 * Maps recurring error patterns to actionable recommendations
 * that prevent the same class of bugs from happening again.
 */
export interface PatternInput {
    type: "recurring_error" | "hot_file" | "regression" | "error_cluster";
    severity: "critical" | "warning" | "info";
    message: string;
    data: Record<string, unknown>;
}
export interface Suggestion {
    category: "lint-rule" | "config" | "refactoring" | "testing";
    priority: "high" | "medium" | "low";
    action: string;
    rationale: string;
}
export declare function generateSuggestions(patterns: PatternInput[]): Suggestion[];
