/**
 * perf.ts — Lighthouse CLI runner and metric extraction.
 *
 * Runs Lighthouse in headless Chrome, extracts Web Vitals,
 * and compares before/after snapshots for regression detection.
 */
export interface AppFrameworkInfo {
    framework: "tauri" | "electron" | null;
    warning: string | null;
}
/**
 * Detect if the project uses Tauri or Electron.
 * Returns a warning about Lighthouse accuracy when running outside a native webview.
 */
export declare function detectAppFramework(cwd: string): AppFrameworkInfo;
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
export declare function extractMetrics(lighthouseResult: Record<string, unknown>): LighthouseMetrics;
/**
 * Compare before/after performance snapshots.
 * Negative diff = improvement (lower is better for all metrics).
 */
export declare function compareSnapshots(before: LighthouseMetrics, after: LighthouseMetrics): MetricDiff;
/**
 * Framework-specific performance advice when Lighthouse metrics are unreliable.
 */
export declare function getAlternativePerfAdvice(framework: "tauri" | "electron"): string;
/**
 * Run Lighthouse against a URL and return extracted metrics.
 * Requires Chrome to be installed. Returns null on failure.
 */
export declare function runLighthouse(url: string, timeoutMs?: number): Promise<LighthouseMetrics | null>;
export {};
