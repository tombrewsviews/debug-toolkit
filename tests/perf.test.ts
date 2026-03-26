import { describe, it, expect } from "vitest";
import { extractMetrics, compareSnapshots, type LighthouseMetrics } from "../src/perf.js";

describe("Lighthouse metric extraction", () => {
  it("should extract metrics from Lighthouse JSON", () => {
    const lighthouseJson = {
      audits: {
        "largest-contentful-paint": { numericValue: 1200 },
        "cumulative-layout-shift": { numericValue: 0.05 },
        "interaction-to-next-paint": { numericValue: 200 },
        "total-blocking-time": { numericValue: 150 },
        "speed-index": { numericValue: 1800 },
      },
    };
    const metrics = extractMetrics(lighthouseJson);
    expect(metrics.lcp).toBe(1200);
    expect(metrics.cls).toBe(0.05);
    expect(metrics.inp).toBe(200);
    expect(metrics.tbt).toBe(150);
    expect(metrics.speedIndex).toBe(1800);
  });

  it("should handle missing audits gracefully", () => {
    const metrics = extractMetrics({ audits: {} });
    expect(metrics.lcp).toBeNull();
    expect(metrics.cls).toBeNull();
    expect(metrics.inp).toBeNull();
    expect(metrics.tbt).toBeNull();
    expect(metrics.speedIndex).toBeNull();
  });

  it("should compare before/after snapshots", () => {
    const before: LighthouseMetrics = { lcp: 2000, cls: 0.1, inp: 300, tbt: 500, speedIndex: 3000 };
    const after: LighthouseMetrics = { lcp: 1200, cls: 0.05, inp: 200, tbt: 150, speedIndex: 1800 };
    const diff = compareSnapshots(before, after);
    expect(diff.lcp).toBe(-800);
    expect(diff.improved).toBe(true);
  });
});
