import { describe, it, expect } from "vitest";
import { explainTriage, explainConfidence, explainArchival } from "../src/explain.js";

describe("Explain Mode", () => {
  it("should explain trivial triage", () => {
    const result = explainTriage("trivial", "SyntaxError", 1, true);
    expect(result.level).toBe("trivial");
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.skipped).toContain("Full pipeline");
  });

  it("should explain complex triage with deep stack", () => {
    const result = explainTriage("complex", "unknown", 8, false);
    expect(result.level).toBe("complex");
    expect(result.reasons.some(r => r.includes("Deep stack"))).toBe(true);
  });

  it("should explain high confidence", () => {
    const result = explainConfidence({ ageInDays: 2, fileDriftCommits: 1, timesRecalled: 10, timesUsed: 9 });
    expect(result.scoreLabel).toBe("High");
    expect(result.recommendation).toContain("Proactively");
    expect(result.factors).toHaveLength(3);
  });

  it("should explain low confidence", () => {
    const result = explainConfidence({ ageInDays: 120, fileDriftCommits: 80, timesRecalled: 5, timesUsed: 0 });
    expect(result.scoreLabel).toBe("Very Low");
    expect(result.recommendation).toContain("archiving");
  });

  it("should explain archival decision", () => {
    const archived = explainArchival(0.1, 60);
    expect(archived.archived).toBe(true);
    expect(archived.reason).toContain("Auto-archived");

    const kept = explainArchival(0.5, 10);
    expect(kept.archived).toBe(false);
    expect(kept.reason).toContain("healthy");
  });
});
