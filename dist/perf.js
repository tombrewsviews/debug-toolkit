/**
 * perf.ts — Lighthouse CLI runner and metric extraction.
 *
 * Runs Lighthouse in headless Chrome, extracts Web Vitals,
 * and compares before/after snapshots for regression detection.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Detect if the project uses Tauri or Electron.
 * Returns a warning about Lighthouse accuracy when running outside a native webview.
 */
export function detectAppFramework(cwd) {
    // Check Tauri: src-tauri/tauri.conf.json or src-tauri/Cargo.toml
    if (existsSync(join(cwd, "src-tauri", "tauri.conf.json")) ||
        existsSync(join(cwd, "src-tauri", "Cargo.toml"))) {
        return {
            framework: "tauri",
            warning: "Lighthouse runs in headless Chrome without window.__TAURI__. Metrics may not reflect actual webview performance. Browser errors triggered by Lighthouse ARE still valuable for finding runtime issues.",
        };
    }
    // Check Electron: electron in package.json dependencies
    try {
        const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
        if (pkg.dependencies?.electron || pkg.devDependencies?.electron) {
            return {
                framework: "electron",
                warning: "Lighthouse runs in headless Chrome, not your Electron renderer. Metrics may differ from actual app performance. Browser errors triggered during audit ARE still useful.",
            };
        }
    }
    catch { }
    return { framework: null, warning: null };
}
/**
 * Extract Web Vitals from Lighthouse JSON output.
 */
export function extractMetrics(lighthouseResult) {
    const audits = (lighthouseResult?.audits ?? {});
    const num = (key) => {
        const v = audits[key]?.numericValue;
        return typeof v === "number" ? v : null;
    };
    return {
        lcp: num("largest-contentful-paint"),
        cls: num("cumulative-layout-shift"),
        inp: num("interaction-to-next-paint"),
        tbt: num("total-blocking-time"),
        speedIndex: num("speed-index"),
    };
}
/**
 * Compare before/after performance snapshots.
 * Negative diff = improvement (lower is better for all metrics).
 */
export function compareSnapshots(before, after) {
    const diff = (a, b) => a !== null && b !== null ? b - a : null;
    const lcpDiff = diff(before.lcp, after.lcp);
    const clsDiff = diff(before.cls, after.cls);
    const tbtDiff = diff(before.tbt, after.tbt);
    // Improved if any key metric got better and none got significantly worse
    // CLS is 0-1 scale (not ms), so use per-metric thresholds
    const worsened = (lcpDiff !== null && lcpDiff > 100) ||
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
 * Framework-specific performance advice when Lighthouse metrics are unreliable.
 */
export function getAlternativePerfAdvice(framework) {
    if (framework === "tauri") {
        return "For accurate Tauri webview metrics, use the WebView DevTools Performance tab (right-click → Inspect Element in the app window). Lighthouse browser errors triggered during this audit ARE still valuable for finding runtime issues.";
    }
    return "For accurate Electron metrics, use --enable-logging and the DevTools Performance panel in the renderer process. Lighthouse browser errors triggered during this audit ARE still valuable for finding runtime issues.";
}
/**
 * Run Lighthouse against a URL and return extracted metrics.
 * Requires Chrome to be installed. Returns null on failure.
 */
export function runLighthouse(url, timeoutMs = 60_000) {
    // Validate URL to prevent injection
    try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol))
            return Promise.resolve(null);
    }
    catch {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        execFile("npx", [
            "lighthouse", url,
            "--output=json",
            "--quiet",
            "--chrome-flags=--headless --no-sandbox",
            "--only-categories=performance",
        ], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            try {
                const json = JSON.parse(stdout);
                resolve(extractMetrics(json));
            }
            catch {
                resolve(null);
            }
        });
    });
}
//# sourceMappingURL=perf.js.map