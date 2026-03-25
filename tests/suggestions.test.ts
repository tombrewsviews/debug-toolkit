import { describe, it, expect } from "vitest";
import { generateSuggestions, type Suggestion } from "../src/suggestions.js";

describe("Preventive suggestions", () => {
  it("should suggest stylelint for repeated CSS errors", () => {
    const patterns = [{
      type: "recurring_error" as const,
      severity: "warning" as const,
      message: "3 occurrences of syntax error in index.css",
      data: { errorType: "SyntaxError", file: "src/index.css", count: 3 },
    }];
    const suggestions = generateSuggestions(patterns);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].action).toContain("stylelint");
  });

  it("should suggest TypeScript strict mode for repeated type errors", () => {
    const patterns = [{
      type: "recurring_error" as const,
      severity: "critical" as const,
      message: "5 occurrences of TypeError in App.tsx",
      data: { errorType: "TypeError", file: "src/App.tsx", count: 5 },
    }];
    const suggestions = generateSuggestions(patterns);
    expect(suggestions.some((s) => s.action.includes("strict"))).toBe(true);
  });

  it("should suggest refactoring for hot files", () => {
    const patterns = [{
      type: "hot_file" as const,
      severity: "warning" as const,
      message: "src/utils.ts appears in 20% of sessions",
      data: { file: "src/utils.ts", percentage: 20 },
    }];
    const suggestions = generateSuggestions(patterns);
    expect(suggestions.some((s) => s.category === "refactoring")).toBe(true);
  });

  it("should return empty for no patterns", () => {
    expect(generateSuggestions([])).toEqual([]);
  });
});
