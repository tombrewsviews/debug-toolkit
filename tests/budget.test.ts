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

  it("should apply nuclear option when response exceeds budget after all phases", () => {
    // Create a massive response that exceeds budget even after compression
    const massive: Record<string, unknown> = {
      severity: "high", // preserved
      nextStep: "do something", // preserved
      bigData1: "x".repeat(5000),
      bigData2: "y".repeat(5000),
      bigData3: "z".repeat(5000),
      bigArray: Array.from({ length: 100 }, (_, i) => ({ id: i, data: "a".repeat(200) })),
    };
    const result = fitToBudget(massive, { maxTokens: 200 });
    expect(result._budget?.compressed).toBe(true);
    expect(result._budget?.estimated).toBeLessThanOrEqual(200);
    // Preserved keys should survive
    expect(result.severity).toBe("high");
    expect(result.nextStep).toBe("do something");
    // Non-preserved keys should be gone
    expect(result.bigData1).toBeUndefined();
    expect(result.bigArray).toBeUndefined();
  });

  it("should set overflowHandled when even preserved keys exceed budget", () => {
    const huge: Record<string, unknown> = {
      nextStep: "x".repeat(10000), // preserved but massive
    };
    const result = fitToBudget(huge, { maxTokens: 50 });
    expect(result._budget?.overflowHandled).toBe(true);
  });
});
