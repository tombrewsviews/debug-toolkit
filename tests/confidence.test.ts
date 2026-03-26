import { describe, it, expect } from "vitest";
import { computeConfidence, type ConfidenceFactors } from "../src/confidence.js";

describe("Confidence scoring", () => {
  it("should return high confidence for recent entry with no drift", () => {
    const score = computeConfidence({ ageInDays: 1, fileDriftCommits: 0, timesRecalled: 3, timesUsed: 2 });
    expect(score).toBeGreaterThan(0.8);
  });

  it("should decay confidence with age", () => {
    const recent = computeConfidence({ ageInDays: 1, fileDriftCommits: 0, timesRecalled: 0, timesUsed: 0 });
    const old = computeConfidence({ ageInDays: 80, fileDriftCommits: 0, timesRecalled: 0, timesUsed: 0 });
    expect(recent).toBeGreaterThan(old);
  });

  it("should reduce confidence with file drift", () => {
    const noDrift = computeConfidence({ ageInDays: 5, fileDriftCommits: 0, timesRecalled: 0, timesUsed: 0 });
    const highDrift = computeConfidence({ ageInDays: 5, fileDriftCommits: 20, timesRecalled: 0, timesUsed: 0 });
    expect(noDrift).toBeGreaterThan(highDrift);
  });

  it("should boost confidence with usage", () => {
    const unused = computeConfidence({ ageInDays: 30, fileDriftCommits: 5, timesRecalled: 0, timesUsed: 0 });
    const used = computeConfidence({ ageInDays: 30, fileDriftCommits: 5, timesRecalled: 5, timesUsed: 4 });
    expect(used).toBeGreaterThan(unused);
  });

  it("should return low score for very old entries with high drift", () => {
    const score = computeConfidence({ ageInDays: 120, fileDriftCommits: 50, timesRecalled: 0, timesUsed: 0 });
    expect(score).toBeLessThan(0.2);
  });

  it("should clamp between 0 and 1", () => {
    const score = computeConfidence({ ageInDays: 0, fileDriftCommits: 0, timesRecalled: 100, timesUsed: 100 });
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0.0);
  });

  it("should have lower usage factor when recalled but never used", () => {
    const recalledNotUsed = computeConfidence({ ageInDays: 5, fileDriftCommits: 0, timesRecalled: 10, timesUsed: 0 });
    const recalledAndUsed = computeConfidence({ ageInDays: 5, fileDriftCommits: 0, timesRecalled: 10, timesUsed: 8 });
    expect(recalledAndUsed).toBeGreaterThan(recalledNotUsed);
  });
});
