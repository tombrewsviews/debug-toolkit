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

const CSS_FILE_RE = /\.(css|scss|sass|less)$/i;

export function generateSuggestions(patterns: PatternInput[]): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const pattern of patterns) {
    const data = pattern.data as Record<string, unknown>;

    if (pattern.type === "recurring_error") {
      const file = String(data.file ?? "");
      const errorType = String(data.errorType ?? "");
      const count = Number(data.count ?? 0);

      // CSS errors → stylelint
      if (CSS_FILE_RE.test(file)) {
        suggestions.push({
          category: "lint-rule",
          priority: count >= 5 ? "high" : "medium",
          action: `Add stylelint with relevant rules to catch ${errorType} errors in CSS files at build time.`,
          rationale: `${count} ${errorType} errors in ${file} — a lint rule would catch these before runtime.`,
        });
      }

      // Type errors → TypeScript strict
      if (errorType === "TypeError" || errorType === "ReferenceError") {
        suggestions.push({
          category: "config",
          priority: count >= 5 ? "high" : "medium",
          action: `Enable TypeScript strict mode (strictNullChecks, noUncheckedIndexedAccess) to catch null/undefined errors at compile time.`,
          rationale: `${count} ${errorType} errors — stricter type checking would prevent many of these.`,
        });
      }

      // Repeated null/undefined → optional chaining
      if (errorType === "TypeError" && count >= 3) {
        suggestions.push({
          category: "lint-rule",
          priority: "medium",
          action: `Add ESLint rule '@typescript-eslint/prefer-optional-chain' to enforce optional chaining patterns.`,
          rationale: `Repeated TypeError suggests unsafe property access — optional chaining prevents this.`,
        });
      }
    }

    if (pattern.type === "hot_file") {
      const file = String(data.file ?? "");
      const sessions = Number(data.sessions ?? 0);
      const total = Number(data.total ?? 0);
      const percentage = total > 0 ? Math.round(100 * sessions / total) : 0;

      suggestions.push({
        category: "refactoring",
        priority: percentage >= 30 ? "high" : "medium",
        action: `Consider splitting ${file} into smaller modules — it appears in ${percentage}% of debug sessions.`,
        rationale: `Files that trigger bugs frequently often have too many responsibilities.`,
      });
    }

    if (pattern.type === "regression") {
      suggestions.push({
        category: "testing",
        priority: "high",
        action: `Add regression tests for the error pattern in ${String(data.file ?? "the affected file")} — this bug has recurred after being fixed.`,
        rationale: `Regressions indicate the fix wasn't protected by tests.`,
      });
    }

    if (pattern.type === "error_cluster") {
      const errors = Array.isArray(data.errors) ? data.errors : [];
      suggestions.push({
        category: "testing",
        priority: "medium",
        action: `Add integration tests to catch cascading failures — ${errors.length} errors occurred within a short window.`,
        rationale: `Error clusters often indicate cascading failures where one root cause triggers multiple symptoms.`,
      });
    }
  }

  return suggestions;
}
