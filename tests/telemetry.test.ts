import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordOutcome, getTelemetry, getFixRateForError } from "../src/telemetry.js";

describe("Telemetry", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tel-"));
  });

  it("should record and retrieve outcomes", () => {
    recordOutcome(tmp, {
      sessionId: "s1",
      errorType: "TypeError",
      category: "runtime",
      files: ["src/app.ts"],
      triageLevel: "medium",
      outcome: "fixed",
      durationMs: 5000,
      toolsUsed: ["investigate", "verify"],
      memoryHit: false,
      memoryApplied: false,
      timestamp: new Date().toISOString(),
    });

    const tel = getTelemetry(tmp);
    expect(tel.outcomes).toHaveLength(1);
    expect(tel.aggregates.totalSessions).toBe(1);
    expect(tel.aggregates.fixRate).toBe(1.0);
  });

  it("should compute fix rate per error type", () => {
    for (let i = 0; i < 5; i++) {
      recordOutcome(tmp, {
        sessionId: `s${i}`,
        errorType: "TypeError",
        category: "runtime",
        files: ["src/app.ts"],
        triageLevel: "medium",
        outcome: i < 3 ? "fixed" : "abandoned",
        durationMs: 5000,
        toolsUsed: ["investigate"],
        memoryHit: false,
        memoryApplied: false,
        timestamp: new Date().toISOString(),
      });
    }

    const rate = getFixRateForError(tmp, "TypeError");
    expect(rate).toBe(0.6);
  });

  it("should return null for insufficient data", () => {
    const rate = getFixRateForError(tmp, "SyntaxError");
    expect(rate).toBeNull();
  });

  it("should track top error types", () => {
    for (let i = 0; i < 10; i++) {
      recordOutcome(tmp, {
        sessionId: `s${i}`,
        errorType: i < 7 ? "TypeError" : "RangeError",
        category: "runtime",
        files: [],
        triageLevel: "medium",
        outcome: "fixed",
        durationMs: 1000,
        toolsUsed: [],
        memoryHit: false,
        memoryApplied: false,
        timestamp: new Date().toISOString(),
      });
    }

    const tel = getTelemetry(tmp);
    expect(tel.aggregates.topErrors[0].errorType).toBe("TypeError");
    expect(tel.aggregates.topErrors[0].count).toBe(7);
  });
});
