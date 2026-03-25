import { describe, it, expect } from "vitest";
import { estimateTokens, fitToBudget } from "../src/budget.js";

describe("Token Budget", () => {
  it("should estimate tokens from object", () => {
    const obj = { message: "hello world", count: 42 };
    const tokens = estimateTokens(obj);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it("should pass through small responses unchanged", () => {
    const response = { nextStep: "check logs", severity: "error" };
    const result = fitToBudget(response, { maxTokens: 1000 });
    expect(result._budget?.compressed).toBe(false);
    expect(result.nextStep).toBe("check logs");
  });

  it("should compress large arrays", () => {
    const response = {
      nextStep: "fix it",
      captures: Array.from({ length: 50 }, (_, i) => `log line ${i}`),
    };
    const result = fitToBudget(response, { maxTokens: 200 });
    expect(result._budget?.compressed).toBe(true);
    expect((result.captures as string[]).length).toBeLessThan(50);
  });

  it("should never truncate preserveKeys", () => {
    const response = {
      nextStep: "a".repeat(1000),
      severity: "critical",
      largeField: "b".repeat(2000),
    };
    const result = fitToBudget(response, { maxTokens: 300, preserveKeys: ["nextStep", "severity"] });
    expect(result.nextStep).toBe("a".repeat(1000));
    expect(result.severity).toBe("critical");
  });
});
