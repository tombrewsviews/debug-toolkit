/**
 * perf.ts — Lighthouse CLI runner and metric extraction.
 *
 * Runs Lighthouse in headless Chrome, extracts Web Vitals,
 * and compares before/after snapshots for regression detection.
 */

import { execSync } from "node:child_process";

export interface LighthouseMetrics {
  lcp: number | null;
  cls: number | null;
  inp: number | null;
  tbt: number | null;
  speedIndex: number | null;
}

interface MetricDiff {
  lcp: number | null;
  cls: number | null;
  inp: number | null;
  tbt: number | null;
  speedIndex: number | null;
  improved: boolean;
}

/**
 * Extract Web Vitals from Lighthouse JSON output.
 */
export function extractMetrics(lighthouseResult: Record<string, any>): LighthouseMetrics {
  const audits = lighthouseResult?.audits ?? {};
  return {
    lcp: audits["largest-contentful-paint"]?.numericValue ?? null,
    cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
    inp: audits["interaction-to-next-paint"]?.numericValue ?? null,
    tbt: audits["total-blocking-time"]?.numericValue ?? null,
    speedIndex: audits["speed-index"]?.numericValue ?? null,
  };
}

/**
 * Compare before/after performance snapshots.
 * Negative diff = improvement (lower is better for all metrics).
 */
export function compareSnapshots(before: LighthouseMetrics, after: LighthouseMetrics): MetricDiff {
  const diff = (a: number | null, b: number | null) =>
    a !== null && b !== null ? b - a : null;

  const lcpDiff = diff(before.lcp, after.lcp);
  const clsDiff = diff(before.cls, after.cls);
  const tbtDiff = diff(before.tbt, after.tbt);

  // Improved if any key metric got better and none got significantly worse
  // CLS is 0-1 scale (not ms), so use per-metric thresholds
  const worsened =
    (lcpDiff !== null && lcpDiff > 100) ||
    (clsDiff !== null && clsDiff > 0.05) ||
    (tbtDiff !== null && tbtDiff > 100);
  const improved = [lcpDiff, clsDiff, tbtDiff].some((d) => d !== null && d < 0) && !worsened;

  return {
    lcp: lcpDiff,
    cls: clsDiff,
    inp: diff(before.inp, after.inp),
    tbt: tbtDiff,
    speedIndex: diff(before.speedIndex, after.speedIndex),
    improved,
  };
}

/**
 * Run Lighthouse against a URL and return extracted metrics.
 * Requires Chrome to be installed. Returns null on failure.
 */
export async function runLighthouse(url: string, timeoutMs = 60_000): Promise<LighthouseMetrics | null> {
  try {
    const result = execSync(
      `npx lighthouse "${url}" --output=json --quiet --chrome-flags="--headless --no-sandbox" --only-categories=performance 2>/dev/null`,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
    const json = JSON.parse(result.toString());
    return extractMetrics(json);
  } catch {
    return null;
  }
}
