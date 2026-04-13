/**
 * mcp.ts — MCP server with 9 tools + 1 resource.
 *
 * Design principles:
 *   1. One tool = one complete outcome. No chatty multi-step protocols.
 *   2. Preprocess, don't dump. Summarize and highlight, never return raw arrays.
 *   3. Every response tells the agent what to do next.
 *   4. Context window space is precious — keep responses compact.
 *   5. Memory: save diagnoses, recall past fixes for similar errors.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  createSession, loadSession, saveSession, newHypothesisId,
  indexMarker, expireOldSessions, listSessionSummaries, type Hypothesis,
} from "./session.js";
import { instrumentFile } from "./instrument.js";
import { cleanupSession } from "./cleanup.js";
import { drainCaptures, runAndCapture, getRecentCaptures, readTauriLogs, discoverTauriLogs, drainBuildErrors, peekRecentOutput, peekRecentWindow, readLiveContext, setLighthouseRunning, waitForNewOutput, extractFilePathsFromError, getTrackedProcesses, readConfigState, type LiveContext, type RuntimeError } from "./capture.js";
import { investigate, isVisualError, unwrapErrorChain, classifyError, detectProviderMismatch } from "./context.js";
import { validateCommand } from "./security.js";
import { remember, recall, markUsed, memoryStats, detectPatterns, maybeArchive, type CausalLink } from "./memory.js";
import { getCachedTopology, type NetworkTopology } from "./network.js";
import { triageError } from "./triage.js";
import { generateSuggestions } from "./suggestions.js";
import { METHODOLOGY } from "./methodology.js";
import { runLighthouse, compareSnapshots, detectAppFramework, getAlternativePerfAdvice } from "./perf.js";
import type { PerfSnapshot } from "./session.js";
import { fitToBudget, estimateTokens } from "./budget.js";
import { explainTriage, explainConfidence } from "./explain.js";
import { recordOutcome, getTelemetry, getFixRateForError } from "./telemetry.js";
import { detectEnvironment, listInstallable, installIntegration, type EnvironmentCapabilities } from "./adapters.js";
import {
  connectToGhostOs, disconnectGhostOs, isGhostConnected, resetConnectionState,
  takeScreenshot, readScreen, findElements, annotateScreen, getVisualDiagnostic,
  SCREEN_RECORDING_SETTINGS_URL,
} from "./ghost-bridge.js";
import { screenshotDir, saveScreenshot, getPackageVersion, checkForUpdate, runSelfUpdate, backgroundSelfUpgrade } from "./utils.js";
import { enableActivityWriter, logActivity } from "./activity.js";
import { analyzeLoop } from "./loop.js";
import { signatureFromError } from "./signature.js";
import { TeamMemoryClient, mergeRecallResults, type TeamRecallResult } from "./storage.js";

let cwd = process.cwd();
let envCaps: EnvironmentCapabilities | null = null;
export function setCwd(dir: string): void { cwd = dir; }

// Team memory client — initialized from env vars, null if not configured
const teamClient = TeamMemoryClient.fromEnv();

// Cached update check — run once per MCP session, non-blocking
let updateCheckResult: { updateAvailable: boolean; current: string; latest: string } | null = null;
let updateCheckDone = false;
let backgroundUpgradeStarted = false;

function lazyUpdateCheck(): void {
  if (updateCheckDone) return;
  updateCheckDone = true;
  // Run async to avoid blocking status reads
  try {
    const result = checkForUpdate();
    updateCheckResult = result;
  } catch { /* silent */ }

  // Also trigger a background self-upgrade (once per MCP session)
  if (!backgroundUpgradeStarted) {
    backgroundUpgradeStarted = true;
    backgroundSelfUpgrade((result) => {
      if (result.upgraded) {
        updateCheckResult = { updateAvailable: false, current: result.to, latest: result.to };
      }
    });
  }
}

// Status diff tracking — detect changes between reads
let lastStatusReadAt: string | null = null;
let lastStatusTerminalCount = 0;
let lastStatusBrowserCount = 0;
let lastStatusBuildErrorCount = 0;

// Health trend — rolling window of error counts across status reads
interface HealthSnapshot {
  timestamp: string;
  tscErrors: number;
  buildErrors: number;
  totalIssues: number;
}
const healthTrend: HealthSnapshot[] = [];
const MAX_HEALTH_SNAPSHOTS = 20;

interface VisualConfig {
  autoCapture: "auto" | "manual" | "off";
  captureOnInvestigate: boolean;
  captureOnVerify: boolean;
  saveScreenshots: boolean;
}

let visualConfig: VisualConfig = {
  autoCapture: "auto",
  captureOnInvestigate: true,
  captureOnVerify: true,
  saveScreenshots: true,
};

function loadVisualConfig(cwd: string): void {
  const configPath = join(cwd, ".debug", "config.json");
  if (!existsSync(configPath)) return;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (raw.visual) Object.assign(visualConfig, raw.visual);
  } catch { /* use defaults */ }
}

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/**
 * Build a live status report from all available runtime sources.
 * Reads from .debug/live-context.json (written by serve process every 5s)
 * since MCP and serve run in separate processes with separate ring buffers.
 */
const SEVERITY_ICON: Record<string, string> = { fatal: "🔴", error: "🟠", warning: "🟡" };

/** Collapse React component tree dumps and stack traces to reduce noise */
function collapseReactNoise(msg: string): string {
  // Collapse "at ComponentName (file.tsx:line:col)" stack frames
  const reactStackPattern = /(\n\s*at \w[\w.]*\s*\([\w/.:-]+\))+/g;
  msg = msg.replace(reactStackPattern, (match) => {
    const lines = match.trim().split("\n").map((l) => l.trim());
    if (lines.length <= 2) return match;
    return `\n    at ${lines[0].replace(/^at\s+/, "")}  (+ ${lines.length - 1} component stack frames)`;
  });

  // Collapse <ComponentName><ChildName>... JSX tree dumps
  const jsxTreePattern = /(<\w+>(?:\s*<\w+>){3,}[\s\S]*?(?:<\/\w+>\s*){3,})/g;
  msg = msg.replace(jsxTreePattern, (match) => {
    const tags = match.match(/<\w+>/g) ?? [];
    const first = tags[0] ?? "<Component>";
    return `${first}...  (${tags.length} nested components collapsed)`;
  });

  // Truncate very long single-line messages (often stringified component trees)
  if (msg.length > 500 && !msg.includes("\n")) {
    return msg.slice(0, 400) + `…  (truncated, ${msg.length} chars total)`;
  }

  return msg;
}

function extractBrowserMessage(b: { timestamp: string; source: string; data: unknown }): string {
  const d = typeof b.data === "object" && b.data !== null ? b.data as Record<string, unknown> : null;
  if (d?.args) return (d.args as string[]).join(" ");
  if (d?.url) return `${d.method ?? "GET"} ${d.url} → ${d.status ?? d.error}`;
  if (d?.message) return String(d.message);
  return JSON.stringify(d ?? b.data);
}

function formatBrowserEvent(b: { timestamp: string; source: string; data: unknown }, severity?: string): string {
  const d = typeof b.data === "object" && b.data !== null ? b.data as Record<string, unknown> : null;
  const icon = severity ? (SEVERITY_ICON[severity] ?? "") + " " : "";
  if (d?.url) return `${icon}[network] ${d.method ?? "GET"} ${d.url} → ${d.status ?? d.error}`;
  const level = d?.level ?? d?.type ?? b.source;
  const msg = collapseReactNoise(extractBrowserMessage(b));
  return `${icon}[${level}] ${msg}`;
}

/** Classify a browser event using the same engine as terminal errors */
function classifyBrowserEvent(b: { timestamp: string; source: string; data: unknown }): import("./context.js").ErrorClassification {
  const msg = extractBrowserMessage(b);
  return classifyError(msg);
}

let tscCache: { result: string[]; timestamp: number } | null = null;
const TSC_CACHE_TTL = 30_000; // 30s

function runQuickTsc(cwd: string): string[] {
  if (tscCache && Date.now() - tscCache.timestamp < TSC_CACHE_TTL) return tscCache.result;
  let result: string[];
  try {
    execSync("npx tsc --noEmit 2>&1", { cwd, timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    result = []; // clean
  } catch (e: any) {
    if (e.stdout) {
      result = e.stdout.split("\n").filter((l: string) => l.trim() && /error TS\d+/.test(l)).slice(0, 20);
    } else {
      result = [];
    }
  }
  tscCache = { result, timestamp: Date.now() };
  return result;
}

function getRecentGitActivity(cwd: string): string[] {
  try {
    // Get actual diff stat + changed files for last 3 commits
    const log = execSync("git log --oneline -5 2>/dev/null", { cwd, encoding: "utf-8", timeout: 5_000 }).trim();
    const dirty = execSync("git diff --stat 2>/dev/null", { cwd, encoding: "utf-8", timeout: 5_000 }).trim();
    const lines: string[] = [];
    if (log) lines.push("Recent commits:", ...log.split("\n").map(l => `  ${l}`));
    if (dirty) lines.push("Uncommitted changes:", ...dirty.split("\n").map(l => `  ${l}`));
    return lines;
  } catch { return []; }
}

/** Collapse consecutive duplicate lines into "line (×N)" */
function collapseRepeats(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const result: string[] = [];
  let prev = lines[0];
  let count = 1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === prev) {
      count++;
    } else {
      result.push(count > 1 ? `${prev}  (×${count})` : prev);
      prev = lines[i];
      count = 1;
    }
  }
  result.push(count > 1 ? `${prev}  (×${count})` : prev);
  return result;
}

function buildCaptureStatus(live: LiveContext | null, topology: NetworkTopology | null): string {
  const lines: string[] = [];

  if (live && live.captureMode === "full") {
    lines.push("## Capture Mode: FULL\n");
  } else if (live && live.captureMode === "active-collection") {
    lines.push("## Capture Mode: ACTIVE COLLECTION\n");
  } else if (topology?.devServer) {
    lines.push("## Capture Mode: PARTIAL\n");
  } else {
    lines.push("## Capture Mode: STATIC\n");
  }

  if (live?.terminal && live.terminal.length > 0) {
    const errors = live.terminal.filter((t) => /error|warn|panic|failed|crash|exception/i.test(t.text));
    lines.push(`- ✓ Terminal output (${live.terminal.length} lines, ${errors.length} errors)`);
  } else {
    lines.push("- ✗ Terminal output — run `spdg` → \"Start dev server\" or \"Monitor running app\"");
  }

  if (live?.browser && live.browser.length > 0) {
    lines.push(`- ✓ Browser console (${live.browser.length} events)`);
  } else {
    lines.push("- ✗ Browser console — run `spdg` → \"Start dev server\" for auto-capture");
  }

  if (live?.buildErrors && live.buildErrors.length > 0) {
    lines.push(`- ✓ Build errors: ${live.buildErrors.length}`);
  } else {
    lines.push("- ✓ Build errors: 0");
  }

  const net = live?.network ?? topology;
  if (net?.devServer) {
    lines.push(`- ✓ Dev server detected on :${net.devServer.port} (PID ${net.devServer.pid}, ${net.devServer.process})`);
    const inCount = net.inbound?.length ?? 0;
    const outParts = (net.outbound ?? []).map((c) => `${c.service ?? "unknown"}:${c.remotePort}`);
    if (outParts.length > 0) {
      lines.push(`- ✓ Network: ${inCount} inbound, ${net.outbound.length} outbound (${outParts.join(", ")})`);
    } else {
      lines.push(`- ✓ Network: ${inCount} inbound, 0 outbound`);
    }
    if (net.missing && net.missing.length > 0) {
      for (const m of net.missing) {
        lines.push(`  - ⚠ No connection to ${m} — server may be stuck or service not running`);
      }
    }
  } else {
    lines.push("- ✗ No dev server detected on common ports");
  }

  lines.push("");
  return lines.join("\n");
}

function buildLiveStatus(cwd: string, since?: { timestamp: string; terminalCount: number; browserCount: number; buildErrorCount: number } | null): string {
  const sections: string[] = [];
  sections.push("# stackpack-debug — Live Situation Report\n");

  // Read from live context file (written by serve process)
  const live = readLiveContext(cwd);

  // Also try local ring buffers (if MCP is co-located with serve, e.g. tests)
  const local = peekRecentOutput({ terminalLines: 100, browserLines: 50, buildErrors: 30 });

  // Use whichever source has data
  const hasLive = live !== null;
  const hasLocal = local.counts.terminal > 0 || local.counts.browser > 0;

  // Diff section — show what changed since last read
  if (since && (hasLive || hasLocal)) {
    const currentTerminal = live?.counts.terminal ?? local.counts.terminal;
    const currentBrowser = live?.counts.browser ?? local.counts.browser;
    const currentBuild = live?.buildErrors.length ?? local.counts.buildErrors;
    const newTerminal = Math.max(0, currentTerminal - since.terminalCount);
    const newBrowser = Math.max(0, currentBrowser - since.browserCount);
    const newBuild = Math.max(0, currentBuild - since.buildErrorCount);
    const elapsed = Math.round((Date.now() - new Date(since.timestamp).getTime()) / 1000);

    if (newTerminal > 0 || newBrowser > 0 || newBuild > 0) {
      sections.push(`## Changes Since Last Check (${elapsed}s ago)\n`);
      if (newTerminal > 0) sections.push(`- **${newTerminal}** new terminal line(s)`);
      if (newBrowser > 0) sections.push(`- **${newBrowser}** new browser event(s)`);
      if (newBuild > 0) sections.push(`- **${newBuild}** new build error(s)`);
      sections.push("");
    } else {
      // True delta: no new events → compact response, skip full dump
      const tscErrors = runQuickTsc(cwd);
      sections.push(`*No new events since last check (${elapsed}s ago).*`);
      sections.push(`Terminal: ${currentTerminal} lines, Browser: ${currentBrowser} events, Build errors: ${currentBuild}`);
      if (tscErrors.length > 0) sections.push(`TypeScript errors: ${tscErrors.length}`);
      sections.push("");
      appendSessions(sections, cwd);
      appendLoopWarning(sections, cwd);
      appendUpdateNotice(sections);
      return sections.join("\n");
    }
  }

  const topology = getCachedTopology(cwd);

  if (!hasLive && !hasLocal) {
    // No live context — do inline collection with capture status
    sections.push(buildCaptureStatus(null, topology));

    // Network topology section (key value-add for MCP-only mode)
    if (topology?.devServer) {
      sections.push("## Network Topology\n");
      sections.push(`Dev server: **${topology.devServer.process}** on port ${topology.devServer.port} (PID ${topology.devServer.pid})\n`);
      if (topology.inbound.length > 0) {
        sections.push(`Inbound connections: ${topology.inbound.length}`);
      }
      if (topology.outbound.length > 0) {
        sections.push("Outbound connections:");
        for (const c of topology.outbound) {
          sections.push(`- ${c.service ?? c.remoteAddr}:${c.remotePort} (${c.state})`);
        }
      } else {
        sections.push("Outbound connections: **none** — server is not connecting to any backends");
      }
      if (topology.missing && topology.missing.length > 0) {
        sections.push("");
        sections.push("**Missing expected connections:**");
        for (const m of topology.missing) {
          sections.push(`- ⚠ ${m}`);
        }
      }
      sections.push("");
    }

    // Static analysis fallback (existing behavior, keep as-is)
    const tscErrors = runQuickTsc(cwd);
    if (tscErrors.length > 0) {
      sections.push("## TypeScript Errors\n");
      sections.push("```");
      for (const e of tscErrors) sections.push(e);
      sections.push("```\n");
    }

    const gitLines = getRecentGitActivity(cwd);
    if (gitLines.length > 0) {
      sections.push("## Git Activity\n");
      for (const l of gitLines) sections.push(l);
      sections.push("");
    }

    appendTauriLogs(sections, cwd);
    appendSessions(sections, cwd);
    appendLoopWarning(sections, cwd);
    return sections.join("\n");
  }

  if (hasLive && live) {
    sections.push(`*Updated: ${live.updatedAt}*\n`);

    sections.push(buildCaptureStatus(live, topology));

    // === FULL TERMINAL OUTPUT (unfiltered — agent needs to see app state) ===
    if (live.terminal.length > 0) {
      // Split into errors and application output
      const errors = live.terminal.filter((t) => /error|warn|panic|failed|crash|exception/i.test(t.text));
      const appOutput = live.terminal.filter((t) => !/error|warn|panic|failed|crash|exception/i.test(t.text));

      if (errors.length > 0) {
        sections.push("## Terminal Errors & Warnings\n");
        sections.push("```");
        for (const line of collapseRepeats(errors.slice(-30).map((t) => t.text))) sections.push(line);
        sections.push("```\n");
        // Annotate errors with classification suggestions
        const seen = new Set<string>();
        for (const e of errors.slice(-10)) {
          const c = classifyError(e.text);
          if (c.category !== "runtime" && c.suggestion && !seen.has(c.category)) {
            seen.add(c.category);
            sections.push(`> **${c.category}**: ${c.suggestion}\n`);
          }
        }
      }

      // Application output — shows what's running, what loaded, what state the app is in
      if (appOutput.length > 0) {
        sections.push("## Terminal Output (app state)\n");
        sections.push("```");
        for (const line of collapseRepeats(appOutput.slice(-50).map((t) => t.text))) sections.push(line);
        sections.push("```\n");
      }
    }

    // === BUILD ERRORS ===
    if (live.buildErrors.length > 0) {
      sections.push("## Build Errors\n");
      for (const e of live.buildErrors) {
        sections.push(`- **${e.tool}** ${e.file}${e.line ? `:${e.line}` : ""} — ${e.message}`);
      }
      sections.push("");
    }

    // === RUNTIME ERRORS (server-side console.error, unhandled rejections, stack traces) ===
    if (live.runtimeErrors && live.runtimeErrors.length > 0) {
      sections.push("## Runtime Errors (server-side)\n");
      sections.push("*These are errors from the Node.js process (console.error, unhandled rejections, stack traces) — not visible in browser devtools.*\n");
      for (const e of live.runtimeErrors.slice(-15)) {
        const loc = e.file ? ` at ${e.file}${e.line ? `:${e.line}` : ""}` : "";
        sections.push(`- **${e.type}**${loc} — ${e.message}`);
        if (e.stack) {
          // Show first 3 lines of stack trace
          const stackLines = e.stack.split("\n").slice(0, 3).map(l => `  ${l.trim()}`);
          for (const sl of stackLines) sections.push(sl);
        }
      }
      sections.push("");
    }

    // === CONFIGURATION STATE (env files, provider settings) ===
    if (live.configState && live.configState.length > 0) {
      // Only show config section when there are AI/provider-related settings
      const providerKeys = live.configState.filter(c =>
        /PROVIDER|MODEL|OLLAMA|OPENAI|ANTHROPIC|GOOGLE|GROQ|TOGETHER|BASE_URL/i.test(c.key)
      );
      if (providerKeys.length > 0) {
        sections.push("## Configuration State\n");
        sections.push("*Provider and model settings detected from env files and process.env:*\n");
        for (const c of providerKeys) {
          const icon = c.persistence === "env-file" ? "📁" : "🔧";
          sections.push(`- ${icon} \`${c.key}\` = \`${c.value}\` *(${c.source})*`);
        }
        // Persistence hint
        const envFileCount = providerKeys.filter(c => c.persistence === "env-file").length;
        const envVarCount = providerKeys.filter(c => c.persistence === "env-var").length;
        if (envVarCount > 0 && envFileCount === 0) {
          sections.push("\n> **Warning**: All provider settings are from `process.env` only (no .env file). These will reset on server restart.");
        }
        sections.push("");
      }
    }

    // === NETWORK TOPOLOGY ===
    const net = live.network ?? topology;
    if (net?.devServer) {
      sections.push("## Network Topology\n");
      const outParts = (net.outbound ?? []).map((c) => `${c.service ?? c.remoteAddr}:${c.remotePort}`);
      sections.push(`Dev server: **${net.devServer.process}** :${net.devServer.port} → ${outParts.length > 0 ? outParts.join(", ") : "no outbound connections"}\n`);
      if (net.missing && net.missing.length > 0) {
        for (const m of net.missing) {
          sections.push(`> ⚠ **Missing connection**: ${m} — check if service is running or if middleware is blocking`);
        }
        sections.push("");
      }
    }

    // === FULL BROWSER CONSOLE (unfiltered — agent needs ALL logs) ===
    if (live.browser.length > 0) {
      const isError = (b: LiveContext["browser"][number]) => {
        const d = typeof b.data === "object" && b.data !== null ? b.data as Record<string, unknown> : null;
        return d?.level === "error" || d?.level === "warn" || b.source === "browser-error" || b.source === "browser-network";
      };
      const errors = live.browser.filter(isError);
      const logs = live.browser.filter((b) => !isError(b));

      // Split errors by source context: webview vs external vs Lighthouse
      const contexts = new Set(errors.map((b) => b.sourceContext ?? (b.lighthouseTriggered ? "lighthouse" : "webview")));
      const hasMultipleSources = contexts.size > 1;

      if (errors.length > 0) {
        // Classify and sort browser errors by severity (fatal → error → warning)
        const severityOrder: Record<string, number> = { fatal: 0, error: 1, warning: 2 };
        const classifiedErrors = errors.map((b) => ({ event: b, classification: classifyBrowserEvent(b) }));
        const sortBySeverity = <T extends { classification: { severity: string } }>(arr: T[]): T[] =>
          [...arr].sort((a, b) => (severityOrder[a.classification.severity] ?? 3) - (severityOrder[b.classification.severity] ?? 3));

        const renderBrowserErrors = (items: typeof classifiedErrors, label: string, note?: string) => {
          if (items.length === 0) return;
          const sorted = sortBySeverity(items);
          sections.push(`## Browser Errors & Warnings${label}\n`);
          if (note) sections.push(`*${note}*\n`);
          sections.push("```");
          for (const { event, classification } of sorted.slice(-30)) {
            sections.push(formatBrowserEvent(event, classification.severity));
          }
          sections.push("```\n");
          // Annotate with classification suggestions (deduplicated)
          const seen = new Set<string>();
          for (const { classification: c } of sorted.slice(0, 10)) {
            if (c.category !== "runtime" && c.suggestion && !seen.has(c.category)) {
              seen.add(c.category);
              sections.push(`> **${c.category}**: ${c.suggestion}\n`);
            }
          }
        };

        if (hasMultipleSources) {
          const webviewErrors = classifiedErrors.filter((e) => (e.event.sourceContext ?? (e.event.lighthouseTriggered ? "lighthouse" : "webview")) === "webview");
          const externalErrors = classifiedErrors.filter((e) => e.event.sourceContext === "external");
          const lighthouseErrors = classifiedErrors.filter((e) => (e.event.sourceContext === "lighthouse") || (!e.event.sourceContext && e.event.lighthouseTriggered));

          renderBrowserErrors(webviewErrors, " (webview)");
          renderBrowserErrors(externalErrors, " (external Chrome)", "These errors came from an external Chrome instance, not the app's webview.");
          renderBrowserErrors(lighthouseErrors, " (Lighthouse-triggered)", "These errors were triggered by Lighthouse loading the page in headless Chrome, not by normal app usage. They may still indicate real code issues.");
        } else {
          const label = contexts.has("lighthouse") ? " (Lighthouse-triggered)" : contexts.has("external") ? " (external Chrome)" : "";
          const note = contexts.has("lighthouse") ? "These errors were triggered by Lighthouse loading the page in headless Chrome, not by normal app usage. They may still indicate real code issues." : undefined;
          renderBrowserErrors(classifiedErrors, label, note);
        }
      }

      if (logs.length > 0) {
        sections.push("## Browser Console (app logs)\n");
        sections.push("```");
        for (const b of logs.slice(-30)) sections.push(formatBrowserEvent(b));
        sections.push("```\n");
      }
    }

    // === RECENT API CALLS (endpoint visibility for provider debugging) ===
    if (live.browser.length > 0) {
      const networkEvents = live.browser.filter(b => b.source === "browser-network");
      if (networkEvents.length > 0) {
        sections.push("## Recent API Calls\n");
        const deduped = new Map<string, { method: string; url: string; status: number | string; count: number }>();
        for (const b of networkEvents.slice(-20)) {
          const d = typeof b.data === "object" && b.data !== null ? b.data as Record<string, unknown> : null;
          const url = String(d?.url ?? "");
          const method = String(d?.method ?? "GET");
          const status = d?.status ?? d?.error ?? "?";
          const key = `${method} ${url} ${status}`;
          const existing = deduped.get(key);
          if (existing) { existing.count++; } else { deduped.set(key, { method, url, status: status as number | string, count: 1 }); }
        }
        for (const [, entry] of deduped) {
          const statusStr = typeof entry.status === "number"
            ? (entry.status >= 400 ? `**${entry.status}**` : `${entry.status}`)
            : `**${entry.status}**`;
          const countStr = entry.count > 1 ? ` (×${entry.count})` : "";
          sections.push(`- ${entry.method} \`${entry.url}\` → ${statusStr}${countStr}`);
        }
        sections.push("");
      }
    }

    // === FILE CROSS-REFERENCE (check if referenced files exist on disk) ===
    if (live.browser.length > 0) {
      const allPaths: Array<{ original: string; resolved: string; exists: boolean }> = [];
      const seenResolved = new Set<string>();
      for (const b of live.browser) {
        const refs = extractFilePathsFromError(b.data);
        for (const ref of refs) {
          if (seenResolved.has(ref.resolved)) continue;
          seenResolved.add(ref.resolved);
          const fullPath = ref.resolved.startsWith("/") ? ref.resolved : join(cwd, ref.resolved);
          allPaths.push({ ...ref, exists: existsSync(fullPath) });
        }
      }
      if (allPaths.length > 0) {
        sections.push("## File Cross-Reference\n");
        const shown = allPaths.slice(0, 10);
        for (const p of shown) {
          const icon = p.exists ? "✓ EXISTS" : "✗ NOT FOUND";
          const hint = p.exists ? " *(file exists — check protocol scope or permissions)*" : "";
          sections.push(`- \`${p.original}\` → \`${p.resolved}\` — **${icon}**${hint}`);
        }
        if (allPaths.length > 10) sections.push(`*... and ${allPaths.length - 10} more referenced paths*`);
        sections.push("");
      }
    }

    // === PROACTIVE STATIC ANALYSIS ===
    const tscErrors = runQuickTsc(cwd);
    if (tscErrors.length > 0) {
      sections.push("## TypeScript Errors (tsc --noEmit)\n");
      sections.push("```");
      for (const e of tscErrors) sections.push(e);
      sections.push("```\n");
    }

    // === GIT ACTIVITY ===
    const gitLines = getRecentGitActivity(cwd);
    if (gitLines.length > 0) {
      sections.push("## Git Activity\n");
      for (const l of gitLines) sections.push(l);
      sections.push("");
    }

    // === SEVERITY-RANKED SUMMARY ===
    const termErrors = live.terminal.filter((t) => /error|warn|panic|failed|crash|exception/i.test(t.text));
    const browserErrors = live.browser.filter((b) => {
      const d = typeof b.data === "object" && b.data !== null ? b.data as Record<string, unknown> : null;
      return d?.level === "error" || d?.level === "warn" || b.source === "browser-error" || b.source === "browser-network";
    });

    // Classify all issues by severity
    const allClassified: Array<{ severity: string; category: string; source: string }> = [];
    for (const t of termErrors) {
      const c = classifyError(t.text);
      allClassified.push({ severity: c.severity, category: c.category, source: "terminal" });
    }
    for (const b of browserErrors) {
      const c = classifyBrowserEvent(b);
      allClassified.push({ severity: c.severity, category: c.category, source: "browser" });
    }
    for (let i = 0; i < live.buildErrors.length; i++) {
      allClassified.push({ severity: "error", category: "build", source: "build" });
    }
    for (let i = 0; i < tscErrors.length; i++) {
      allClassified.push({ severity: "error", category: "typescript", source: "tsc" });
    }
    if (live.runtimeErrors) {
      for (const re of live.runtimeErrors) {
        const sev = re.type === "unhandled-rejection" || re.type === "uncaught-exception" ? "fatal" : "error";
        allClassified.push({ severity: sev, category: `runtime-${re.type}`, source: "server" });
      }
    }

    const totalIssues = allClassified.length;

    // Record health snapshot for trend tracking
    healthTrend.push({
      timestamp: new Date().toISOString(),
      tscErrors: tscErrors.length,
      buildErrors: live.buildErrors.length,
      totalIssues,
    });
    if (healthTrend.length > MAX_HEALTH_SNAPSHOTS) healthTrend.shift();

    if (totalIssues > 0) {
      // Group by severity, then by category with counts
      const bySeverity: Record<string, Map<string, number>> = { fatal: new Map(), error: new Map(), warning: new Map() };
      for (const item of allClassified) {
        const sev = bySeverity[item.severity] ?? bySeverity.error;
        sev.set(item.category, (sev.get(item.category) ?? 0) + 1);
      }

      sections.push("## Issues Summary\n");
      const severityLabels: Array<[string, string, string]> = [["fatal", "🔴", "fatal"], ["error", "🟠", "error"], ["warning", "🟡", "warning"]];
      for (const [key, icon, label] of severityLabels) {
        const cats = bySeverity[key];
        if (!cats || cats.size === 0) continue;
        const total = Array.from(cats.values()).reduce((a, b) => a + b, 0);
        const details = Array.from(cats.entries()).map(([cat, count]) => count > 1 ? `${cat} (×${count})` : cat).join(", ");
        sections.push(`${icon} **${total} ${label}**: ${details}`);
      }
      sections.push("");
      sections.push(`Call \`debug_investigate\` with the specific error for deep analysis.\n`);
    } else {
      sections.push("**No errors detected.** App running cleanly.\n");
    }

    // Health trend — show if we have enough data points
    if (healthTrend.length >= 3) {
      const recent = healthTrend.slice(-5);
      const first = recent[0].totalIssues;
      const last = recent[recent.length - 1].totalIssues;
      const direction = last < first ? "improving" : last > first ? "degrading" : "stable";
      const trend = recent.map((s) => String(s.totalIssues)).join(" → ");

      if (direction === "degrading") {
        sections.push(`## ⚠ Health Trend: DEGRADING\n`);
        sections.push(`Issues: ${trend}`);
        // Find the pivot point
        let pivotIdx = 0;
        for (let i = 1; i < recent.length; i++) {
          if (recent[i].totalIssues > recent[i - 1].totalIssues) { pivotIdx = i; break; }
        }
        if (pivotIdx > 0) {
          sections.push(`Started degrading around ${recent[pivotIdx].timestamp.split("T")[1]?.slice(0, 8) ?? "unknown"}`);
        }
        sections.push("Your recent changes may have introduced new errors.\n");
      } else if (direction === "improving" && first > 0) {
        sections.push(`## Health Trend: Improving\n`);
        sections.push(`Issues: ${trend} — getting better.\n`);
      }
    }
  }

  appendTauriLogs(sections, cwd);
  appendActiveProcesses(sections);
  appendVisualStatus(sections);
  appendSessions(sections, cwd);
  appendLoopWarning(sections, cwd);
  appendUpdateNotice(sections);

  return sections.join("\n");
}

function appendActiveProcesses(sections: string[]): void {
  const procs = getTrackedProcesses();
  if (procs.length === 0) return;

  const running = procs.filter((p) => p.exitCode === null);
  const recentlyExited = procs.filter((p) => p.exitCode !== null).slice(-3);

  if (running.length === 0 && recentlyExited.length === 0) return;

  sections.push("## Tracked Processes\n");
  for (const p of running) {
    const elapsed = Math.round((Date.now() - new Date(p.startedAt).getTime()) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    sections.push(`- **PID ${p.pid}**: \`${p.command.slice(0, 60)}\` — running (${duration})`);
  }
  for (const p of recentlyExited) {
    sections.push(`- PID ${p.pid}: \`${p.command.slice(0, 60)}\` — exited (code ${p.exitCode})`);
  }
  sections.push("");
}

function appendVisualStatus(sections: string[]): void {
  const diag = getVisualDiagnostic();
  sections.push("## Visual Debugging\n");
  if (diag.permissionDenied) {
    sections.push("- Ghost OS: **Screen Recording permission not granted**");
    sections.push("- Fix: `debug_setup action='fix-permissions'` — opens System Settings to grant access");
    sections.push("- Then: `debug_setup action='connect'` to reconnect");
  } else if (diag.connected) {
    sections.push(`- Ghost OS: **connected**${diag.lastSuccessAgo ? ` (last capture ${diag.lastSuccessAgo})` : ""}`);
  } else if (diag.binaryFound) {
    sections.push(`- Ghost OS: **not connected** (binary found at ${diag.binaryPath})`);
    if (diag.lastError) sections.push(`- Last error: ${diag.lastError}`);
    sections.push("- Try: `debug_setup action='connect'`");
  } else {
    sections.push("- Ghost OS: **not installed**");
    sections.push("- For visual debugging: `debug_setup action='install' integration='ghost-os'`");
  }
  sections.push("");
}

function appendTauriLogs(sections: string[], cwd: string): void {
  const tauriLogs = readTauriLogs(cwd, 20);
  const logErrors = tauriLogs.filter((c) => {
    const d = typeof c.data === "object" && c.data !== null ? c.data as Record<string, unknown> : null;
    return /error|warn|panic/i.test(typeof d?.text === "string" ? d.text : "");
  });
  if (logErrors.length > 0) {
    sections.push("## Tauri Logs\n");
    sections.push("```");
    for (const c of logErrors) {
      const d = typeof c.data === "object" && c.data !== null ? c.data as Record<string, unknown> : null;
      sections.push(typeof d?.text === "string" ? d.text : JSON.stringify(d));
    }
    sections.push("```\n");
  }
}

function appendLoopWarning(sections: string[], cwd: string): void {
  const { active } = listSessionSummaries(cwd);
  if (active.length === 0) return;

  // Check the most recent active session for loop signals
  const session = loadSession(cwd, active[0].id);
  const loopAnalysis = analyzeLoop(session, cwd);
  if (loopAnalysis.looping) {
    sections.push(`\n**⚠ LOOP WARNING (${loopAnalysis.severity})**`);
    sections.push(loopAnalysis.recommendation);
    for (const sig of loopAnalysis.signals) {
      sections.push(`  • ${sig.message}`);
    }
    sections.push("");
  }
}

function appendUpdateNotice(sections: string[]): void {
  lazyUpdateCheck();
  if (updateCheckResult?.updateAvailable) {
    sections.push("## Update Available\n");
    sections.push(`**v${updateCheckResult.current} → v${updateCheckResult.latest}**`);
    sections.push("Run `debug_setup action='update'` to upgrade, then restart Claude Code.\n");
  }
}

function appendSessions(sections: string[], cwd: string): void {
  // Auto-expire stale sessions before listing
  expireOldSessions(cwd);

  const { active, counts } = listSessionSummaries(cwd);
  if (counts.total === 0) return;

  sections.push("## Debug Sessions\n");
  if (active.length > 0) {
    for (const s of active) {
      sections.push(`- **${s.id}** [active] — ${s.problem?.slice(0, 80) ?? "unknown"} (${s.captureCount} captures)`);
    }
  } else {
    sections.push("- No active sessions");
  }
  if (counts.resolved > 0 || counts.expired > 0) {
    sections.push(`- *${counts.resolved} resolved, ${counts.expired} expired*`);
  }
  sections.push("");
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "stackpack-debug", version: getPackageVersion() },
    { capabilities: { tools: {}, resources: {} } },
  );

  // ━━━ RESOURCE: debug_methodology ━━━
  // Always-available debugging methodology. The "hot memory" tier.
  server.registerResource(
    "debug_methodology",
    "debug://methodology",
    {
      description: "The debugging methodology — how to use stackpack-debug effectively. Read this before your first debugging session.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [{ uri: "debug://methodology", mimeType: "text/markdown", text: METHODOLOGY }],
    }),
  );

  // ━━━ RESOURCE: debug_status ━━━
  // Live runtime context — pre-processed and ready for the agent.
  // Agent reads this BEFORE investigating to see what's happening right now.
  server.registerResource(
    "debug_status",
    "debug://status",
    {
      description: "Live runtime status — terminal errors, browser console, build errors, and active sessions. READ THIS FIRST when debugging.",
      mimeType: "text/markdown",
    },
    async () => {
      // Build diff context from previous read
      const since = lastStatusReadAt ? {
        timestamp: lastStatusReadAt,
        terminalCount: lastStatusTerminalCount,
        browserCount: lastStatusBrowserCount,
        buildErrorCount: lastStatusBuildErrorCount,
      } : null;

      const status = buildLiveStatus(cwd, since);

      // Update tracking for next diff
      const live = readLiveContext(cwd);
      const local = peekRecentOutput();
      lastStatusReadAt = new Date().toISOString();
      lastStatusTerminalCount = live?.counts.terminal ?? local.counts.terminal;
      lastStatusBrowserCount = live?.counts.browser ?? local.counts.browser;
      lastStatusBuildErrorCount = live?.buildErrors.length ?? local.counts.buildErrors;

      return {
        contents: [{ uri: "debug://status", mimeType: "text/markdown", text: status }],
      };
    },
  );

  // ━━━ RESOURCE: debug_errors ━━━
  // Error-only view — cuts through the noise. Shows only errors/warnings across all sources.
  server.registerResource(
    "debug_errors",
    "debug://errors",
    {
      description: "Errors only — deduplicated errors and warnings from terminal, browser, build, and TypeScript. Read this when you need signal without noise.",
      mimeType: "text/markdown",
    },
    async () => {
      const lines: string[] = ["# Errors & Warnings (all sources)\n"];

      const live = readLiveContext(cwd);
      const local = peekRecentOutput({ terminalLines: 100, browserLines: 50, buildErrors: 30 });
      let totalErrors = 0;

      // Terminal errors
      const terminalSource = live?.terminal ?? local.terminal.map((c) => {
        const d = c.data as Record<string, unknown> | null;
        return { timestamp: c.timestamp, text: String(d?.text ?? d?.data ?? c.data), stream: "stderr" };
      });
      const termErrors = terminalSource.filter((t) => /error|warn|panic|failed|crash|exception/i.test(t.text));
      if (termErrors.length > 0) {
        for (const t of collapseRepeats(termErrors.slice(-15).map((e) => `[terminal] ${e.text}`))) lines.push(t);
        totalErrors += termErrors.length;
      }

      // Browser errors
      const browserSource = live?.browser ?? local.browser.map((c) => ({
        timestamp: c.timestamp, source: c.source, data: c.data,
      }));
      const browserErrors = browserSource.filter((b) => {
        const d = typeof b.data === "object" && b.data !== null ? b.data as Record<string, unknown> : null;
        return d?.level === "error" || d?.level === "warn" || b.source === "browser-error" || b.source === "browser-network";
      });
      if (browserErrors.length > 0) {
        for (const b of browserErrors.slice(-15)) {
          lines.push(`[browser] ${formatBrowserEvent(b as any)}`);
        }
        totalErrors += browserErrors.length;
      }

      // Build errors
      const buildErrors = live?.buildErrors ?? local.buildErrors.map((e) => ({
        tool: e.tool, file: e.file, line: e.line, code: e.code, message: e.message,
      }));
      if (buildErrors.length > 0) {
        for (const e of buildErrors) {
          lines.push(`[build] ${e.tool} ${e.file}${e.line ? `:${e.line}` : ""} — ${e.message}`);
        }
        totalErrors += buildErrors.length;
      }

      // TypeScript errors
      const tscErrors = runQuickTsc(cwd);
      if (tscErrors.length > 0) {
        for (const e of tscErrors) lines.push(`[tsc] ${e}`);
        totalErrors += tscErrors.length;
      }

      if (totalErrors === 0) {
        lines.push("**No errors detected.** App running cleanly.");
      } else {
        lines.push("");
        lines.push(`**${totalErrors} total error(s)/warning(s).**`);
      }

      return {
        contents: [{ uri: "debug://errors", mimeType: "text/markdown", text: lines.join("\n") }],
      };
    },
  );

  // ━━━ TOOL 1: debug_investigate ━━━
  // The killer feature. One call: error in, full context out.
  server.registerTool("debug_investigate", {
    title: "Investigate Error",
    description: `The primary debugging tool. Works for BOTH runtime errors AND logic/behavior bugs.

For runtime errors: give it the stack trace → returns error classification, source code at crash site, git context, environment.
For logic bugs: describe the problem + pass file paths in 'files' parameter → returns source code from those files for comparison.

Also auto-searches debug memory for past solutions to similar errors.
Start every debugging session with this tool.`,
    inputSchema: {
      error: z.string().describe("Error message, stack trace, or bug description"),
      sessionId: z.string().optional().describe("Existing session ID, or omit to auto-create"),
      problem: z.string().optional().describe("Bug description (used if creating new session)"),
      files: z.array(z.string()).optional().describe("File paths to examine (for logic bugs with no stack trace)"),
    },
  }, async ({ error: errorText, sessionId, problem, files: hintFiles }) => {
    // Auto-create session if needed
    let session;
    if (sessionId) {
      session = loadSession(cwd, sessionId);
    } else {
      session = createSession(cwd, problem ?? errorText.split("\n")[0]?.slice(0, 100) ?? "Debug session");
    }

    // Triage: classify error complexity
    const triage = triageError(errorText);
    (session as any)._triageLevel = triage.level;

    // Fast-path for trivial errors — skip full pipeline
    if (triage.level === "trivial" && triage.fixHint) {
      session.captures.push({
        id: `inv_${Date.now()}`, timestamp: new Date().toISOString(),
        source: "environment", markerTag: null,
        data: { type: "investigation", triage: "trivial", error: triage.classification },
        hypothesisId: null,
      });
      saveSession(cwd, session);

      logActivity({ tool: "debug_investigate", ts: Date.now(), summary: `"${errorText.split("\n")[0]?.slice(0, 60)}"`, metrics: { triage: "trivial" } });
      return text({
        sessionId: session.id,
        triage: "trivial",
        error: triage.classification,
        fixHint: triage.fixHint,
        nextStep: `Trivial error: ${triage.fixHint} Apply the fix, then use debug_verify to confirm.`,
      });
    }

    // Run the investigation engine
    const result = investigate(errorText, cwd, hintFiles);

    // Drain any accumulated build errors from the dev server
    const buildErrors = drainBuildErrors();

    // Auto-include recent runtime output from ring buffers (peek, don't drain)
    let recentOutput = peekRecentOutput({ terminalLines: 30, browserLines: 20, buildErrors: 10 });
    // Fallback: if ring buffer is empty (e.g. drained by prior tool call), use immutable recent window
    if (recentOutput.terminal.length === 0) {
      const windowOutput = peekRecentWindow(10_000);
      if (windowOutput.length > 0) {
        recentOutput = { ...recentOutput, terminal: windowOutput.slice(-30) };
      }
    }
    const tauriLogs = readTauriLogs(cwd, 30);

    // Persist build errors as captures on the session so they survive the response
    for (const be of buildErrors) {
      session.captures.push({
        id: `bld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        source: "build-error",
        markerTag: null,
        data: { tool: be.tool, file: be.file, line: be.line, code: be.code, message: be.message },
        hypothesisId: null,
      });
    }

    // Check if this is a visual error (for screenshot integration)
    const sourceFiles = result.sourceCode.map((s) => s.relativePath);
    const visualError = isVisualError(
      result.error.category,
      sourceFiles[0] ?? null,
      errorText,
    );

    // Check memory for past solutions to similar errors
    const pastSolutions = recall(cwd, errorText, 3);

    // Track memory hit on session for feedback loop
    if (pastSolutions.length > 0) {
      session._memoryHit = true;
      session._recalledEntryIds = pastSolutions.map((s) => s.id);
      session._recalledFiles = [...new Set(pastSolutions.flatMap((s) => s.files))];
    }

    // Team recall — if local results are thin, async query team memory
    let teamResults: TeamRecallResult[] = [];
    if (teamClient && pastSolutions.length < 3) {
      const sourceFiles = result.sourceCode.map((s) => s.relativePath);
      const sig = signatureFromError(errorText, sourceFiles[0] ?? null);
      try {
        teamResults = await teamClient.recall(errorText, {
          errorSignature: sig,
          sourceFile: sourceFiles[0],
          limit: 3 - pastSolutions.length,
        });
      } catch { /* team recall failure is non-fatal */ }
    }

    // Store as capture (include hint files for file tracking in cleanup)
    session.captures.push({
      id: `inv_${Date.now()}`, timestamp: new Date().toISOString(),
      source: "environment", markerTag: null,
      data: {
        type: "investigation",
        error: result.error,
        hintFiles: hintFiles ?? [],
        sourceFiles: result.sourceCode.map((s) => s.relativePath),
      },
      hypothesisId: null,
    });
    // Error trajectory: track how the error evolves across investigations
    if (!session.errorTrajectory) session.errorTrajectory = [];
    const fingerprint = signatureFromError(errorText, sourceFiles[0] ?? null);
    // Infer what changed since last investigation from git diff
    let afterAction: string | null = null;
    if (session.errorTrajectory.length > 0) {
      try {
        const diffStat = execSync("git diff --stat HEAD 2>/dev/null", { cwd, encoding: "utf-8", timeout: 3000 }).trim();
        if (diffStat) {
          const lines = diffStat.split("\n");
          afterAction = lines[lines.length - 1]?.trim() ?? null; // summary line
        }
      } catch { /* no git or no changes */ }
    }
    session.errorTrajectory.push({
      timestamp: new Date().toISOString(),
      fingerprint,
      errorType: result.error.type ?? "unknown",
      sourceFile: sourceFiles[0] ?? null,
      afterAction,
    });
    saveSession(cwd, session);

    // Unwrap error chains (RetryError, AI SDK wrappers, etc.)
    const errorChain = unwrapErrorChain(errorText);
    const hasChainInfo = errorChain.innerErrors.length > 0 || errorChain.httpStatus !== null || errorChain.url !== null;

    // Detect provider/endpoint mismatch from browser network events
    const browserNetworkEvents = recentOutput.browser
      .filter(c => c.source === "browser-network")
      .map(c => c.data as Record<string, unknown>)
      .map(d => ({ url: d?.url as string | undefined, status: d?.status as number | undefined, method: d?.method as string | undefined, ok: d?.ok as boolean | undefined }));
    const providerMismatch = detectProviderMismatch(errorChain, browserNetworkEvents, errorText);

    const response: Record<string, unknown> = {
      sessionId: session.id,
      triage: triage.level,
      error: result.error,
      errorChain: hasChainInfo ? errorChain : undefined,
      providerMismatch: providerMismatch ?? undefined,
      sourceCode: result.sourceCode.map((s) => ({
        file: s.relativePath,
        errorLine: s.errorLine,
        snippet: s.lines,
      })),
      git: result.git,
      environment: result.environment,
      buildErrors: buildErrors.length > 0 ? buildErrors.map((e) => ({
        tool: e.tool,
        file: e.file,
        line: e.line,
        code: e.code,
        message: e.message,
      })) : undefined,
      runtimeErrors: recentOutput.runtimeErrors.length > 0 ? recentOutput.runtimeErrors.map((e) => ({
        type: e.type,
        message: e.message,
        file: e.file,
        line: e.line,
        stack: e.stack?.split("\n").slice(0, 5).join("\n") ?? null,
      })) : undefined,
      configState: (() => {
        const config = readConfigState(cwd);
        const providerConfig = config.filter(c =>
          /PROVIDER|MODEL|OLLAMA|OPENAI|ANTHROPIC|GOOGLE|GROQ|TOGETHER|BASE_URL/i.test(c.key)
        );
        return providerConfig.length > 0 ? providerConfig : undefined;
      })(),
      networkTopology: (() => {
        const topo = getCachedTopology(cwd);
        if (!topo?.devServer) return undefined;
        const topoResult: Record<string, unknown> = {
          devServer: `${topo.devServer.process} on :${topo.devServer.port}`,
          inbound: topo.inbound.length,
          outbound: topo.outbound.map((c) => `${c.service ?? "unknown"}:${c.remotePort}`),
        };
        if (topo.missing && topo.missing.length > 0) {
          topoResult.missingConnections = topo.missing;
          topoResult.hint = "Expected backend connections not found — check middleware/auth layer or verify service is running.";
        }
        if (topo.outbound.length === 0 && topo.inbound.length > 0) {
          topoResult.hint = "Server has inbound connections but no outbound — request may be stuck in middleware before reaching backend.";
        }
        return topoResult;
      })(),
      visualError,
      userFrames: result.frames.filter((f) => f.isUserCode).map((f) => ({
        fn: f.fn,
        file: basename(f.file),
        line: f.line,
      })),
    };

    // Proactive static analysis — catch what reading code would catch
    const tscErrors = runQuickTsc(cwd);
    if (tscErrors.length > 0) {
      response.typeErrors = tscErrors;
    }

    // Auto-include runtime output — but skip if agent just read debug://status
    const statusFresh = lastStatusReadAt && (Date.now() - new Date(lastStatusReadAt).getTime()) < 60_000;

    if (statusFresh) {
      // Agent already has runtime context from status read — just reference it
      response.runtimeContext = `See debug://status (read ${Math.round((Date.now() - new Date(lastStatusReadAt!).getTime()) / 1000)}s ago) for live terminal/browser output.`;
    } else {
      const hasTerminal = recentOutput.terminal.length > 0;
      const hasBrowser = recentOutput.browser.length > 0;
      const hasTauri = tauriLogs.length > 0;

      if (hasTerminal || hasBrowser || hasTauri) {
        const runtimeContext: Record<string, unknown> = {};

        if (hasTerminal) {
          // Only include errors — full output is in debug://status
          const termErrors = recentOutput.terminal.filter((c) => {
            const d = typeof c.data === "object" && c.data !== null ? c.data as Record<string, unknown> : null;
            const text = d?.text ?? d?.data ?? String(c.data);
            const str = typeof text === "string" ? text : JSON.stringify(text);
            return /error|warn|panic|failed|crash|exception|SIGTERM|SIGKILL/i.test(str);
          });
          if (termErrors.length > 0) {
            runtimeContext.terminalErrors = termErrors.slice(-15).map((c) => {
              const d = typeof c.data === "object" && c.data !== null ? c.data as Record<string, unknown> : null;
              return { timestamp: c.timestamp, text: d?.text ?? d?.data ?? String(c.data) };
            });
          }
        }

        if (hasBrowser) {
          runtimeContext.browserConsole = recentOutput.browser.slice(-20).map((c) => {
            const d = typeof c.data === "object" && c.data !== null ? c.data as Record<string, unknown> : null;
            return { timestamp: c.timestamp, source: c.source, ...(d ?? { text: String(c.data) }) };
          });
        }

        if (hasTauri) {
          runtimeContext.tauriLogs = tauriLogs.slice(-10).map((c) => {
            const d = typeof c.data === "object" && c.data !== null ? c.data as Record<string, unknown> : null;
            return { timestamp: c.timestamp, text: d?.text ?? String(c.data) };
          });
        }

        // Skip recentBuildErrors — already in top-level buildErrors field
        response.runtimeContext = runtimeContext;
      }
    }

    // Include past solutions if found (with staleness + causal info)
    if (pastSolutions.length > 0) {
      const fresh = pastSolutions.filter((s) => !s.staleness.stale);
      response.pastSolutions = pastSolutions.map((s) => {
        // Negative recall: check if this solution matches a failed approach in the current session
        const failedMatch = session.failedApproaches?.find((fa) =>
          s.diagnosis?.toLowerCase().includes(fa.toLowerCase().slice(0, 30))
          || fa.toLowerCase().includes(s.diagnosis?.toLowerCase().slice(0, 30) ?? ""),
        );
        return {
          problem: s.problem,
          diagnosis: s.diagnosis?.slice(0, 300) ?? null,
          files: s.files?.slice(0, 5) ?? [],
          relevance: Math.round(s.relevance * 100) + "%",
          confidence: Math.round(s.confidence * 100) + "%",
          stale: s.staleness.stale,
          rootCause: s.rootCause ?? undefined,
          ...(failedMatch ? { warning: `Similar approach already tried this session and failed: "${failedMatch}"` } : {}),
        };
      });
      const topDiag = fresh.length > 0 ? fresh[0].diagnosis?.slice(0, 200) : null;
      response.nextStep = fresh.length > 0
        ? `Investigation complete — source code, git context, and runtime data included. Also found ${fresh.length} past solution(s)${topDiag ? `: "${topDiag}"` : ""}. Check if they apply.`
        : `Investigation complete — source code, git context, runtime data included. Found ${pastSolutions.length} past solution(s) but code has changed — investigate fresh.`;

      // Proactive memory: surface high-confidence FRESH matches prominently
      const highConfidence = pastSolutions.filter((s) => (s.confidence ?? 0) >= 0.8 && !s.staleness.stale);
      if (highConfidence.length > 0) {
        const top = highConfidence[0];
        response.proactiveSuggestion = {
          confidence: Math.round((top.confidence ?? 0) * 100) + "%",
          diagnosis: top.diagnosis,
          files: top.files,
          rootCause: top.rootCause ?? undefined,
          message: `High-confidence match (${Math.round((top.confidence ?? 0) * 100)}%): "${top.diagnosis}". This fix was verified before — try applying it directly.`,
        };
        response.nextStep = `Investigation complete. High-confidence match (${Math.round((top.confidence ?? 0) * 100)}%): "${top.diagnosis?.slice(0, 150)}". Full investigation data also included — verify the match applies.`;
      }
    } else {
      response.nextStep = result.error.suggestion
        ? `Suggested fix: ${result.error.suggestion}`
        : "Use debug_instrument to add logging, then debug_capture to see the output.";
    }

    // Smart hint for wrapped/generic errors with no useful context
    if (triage.level === "complex" && result.sourceCode.length === 0 && hasChainInfo) {
      const hints: string[] = [
        "This error appears to be wrapped by middleware or SDK error handling. The original cause is hidden.",
      ];
      if (errorChain.httpStatus) {
        hints.push(`Detected HTTP ${errorChain.httpStatus}${errorChain.httpStatus === 429 ? " (rate limit)" : errorChain.httpStatus >= 500 ? " (server error)" : ""}`);
      }
      if (errorChain.url) {
        hints.push(`Request went to: ${errorChain.url}${errorChain.provider ? ` (${errorChain.provider})` : ""}`);
      }
      if (errorChain.innerErrors.length > 0) {
        hints.push(`Error chain: ${errorChain.innerErrors.map(e => e.wrapper).join(" → ")}`);
      }
      hints.push(
        "Surface the full error object in the HTTP response: catch(e) { return Response.json({ error: e.message, details: JSON.stringify(e, Object.getOwnPropertyNames(e)) }, { status: 500 }) }",
        "Or use debug_instrument to add tagged logging before the catch block",
        "Use debug_capture with a curl command — check serverLogs for correlated server output",
      );
      response.wrappedErrorHint = hints;
    }

    // Configuration drift detection — provider mismatch signals
    if (providerMismatch) {
      response.configDrift = {
        type: "provider-mismatch",
        signal: providerMismatch.signal,
        expected: providerMismatch.expected,
        actual: providerMismatch.actual,
        actualUrl: providerMismatch.actualUrl,
        suggestions: [
          "The app is hitting a different provider than expected. Check if the provider setting is persisted (database/file) or only stored in-memory.",
          "If settings are in-memory (e.g., `let override = null`), they reset on every server restart or hot-reload.",
          "Check: GET /api/providers/active (or similar settings endpoint) — does it return the expected provider?",
          "Look for the settings save handler — does it write to a database, file, or just a variable?",
          providerMismatch.expected === "local/ollama"
            ? "User likely configured Ollama but the override was lost. Check if the provider resolution falls back to a default when the override is null."
            : `Expected ${providerMismatch.expected ?? "unknown"} but got ${providerMismatch.actual}. Trace the provider resolution chain.`,
        ],
      };
      // Prepend config drift warning to nextStep
      response.nextStep = typeof response.nextStep === "string"
        ? `⚠ CONFIGURATION DRIFT: ${providerMismatch.signal}. ${response.nextStep}`
        : `⚠ CONFIGURATION DRIFT: ${providerMismatch.signal}`;
    }

    // Append team recall results if any
    if (teamResults.length > 0) {
      const teamSolutions = teamResults
        .filter((t) => !t.superseded)
        .map((t) => ({
          problem: t.entry.problem,
          diagnosis: t.entry.diagnosis?.slice(0, 300) ?? null,
          files: t.entry.files?.slice(0, 5) ?? [],
          relevance: Math.round(t.relevance * 100) + "%",
          confidence: Math.round(t.successRate * 100) + "%",
          stale: false,
          rootCause: t.entry.rootCause ?? undefined,
          source: "team" as const,
          contributedBy: t.contributedBy,
          successRate: Math.round(t.successRate * 100) + "%",
          failedApproachWarning: session.failedApproaches?.length
            ? teamResults.find((tr) => tr.entry.id === t.entry.id &&
                session.failedApproaches!.some((fa) =>
                  t.entry.diagnosis.toLowerCase().includes(fa.toLowerCase().slice(0, 30))))
              ? "WARNING: similar approach was already tried this session"
              : undefined
            : undefined,
        }));
      if (teamSolutions.length > 0) {
        if (!response.pastSolutions) response.pastSolutions = [];
        (response.pastSolutions as unknown[]).push(...teamSolutions);
        const teamMsg = `Also found ${teamSolutions.length} team solution(s) from ${teamSolutions.map((t) => t.contributedBy).join(", ")}.`;
        response.nextStep = typeof response.nextStep === "string"
          ? `${response.nextStep} ${teamMsg}`
          : teamMsg;
      }
    }

    // Add fix rate hint from telemetry
    const errorType = result.error.type;
    if (errorType) {
      const fixRate = getFixRateForError(cwd, errorType);
      if (fixRate !== null) {
        response.telemetryHint = `Similar errors have been fixed ${Math.round(fixRate * 100)}% of the time.`;
      }
    }

    // Adjust nextStep if build errors found
    if (buildErrors.length > 0) {
      const buildMsg = `${buildErrors.length} build error(s) detected from dev server.`;
      response.nextStep = typeof response.nextStep === "string"
        ? `${buildMsg} ${response.nextStep}`
        : buildMsg;
    }

    // Adjust nextStep if runtime context has live errors — prioritize over stale memory
    if (response.runtimeContext) {
      const rc = response.runtimeContext as Record<string, unknown>;
      const parts: string[] = [];
      if (rc.terminalErrors) parts.push(`${(rc.terminalErrors as unknown[]).length} terminal error(s)/warning(s)`);
      if (rc.browserConsole) parts.push(`${(rc.browserConsole as unknown[]).length} browser console message(s)`);
      if (rc.tauriLogs) parts.push(`${(rc.tauriLogs as unknown[]).length} Tauri log entries`);
      if (parts.length > 0) {
        const liveMsg = `Live runtime context captured: ${parts.join(", ")}. Review these first.`;
        response.nextStep = typeof response.nextStep === "string"
          ? `${liveMsg} ${response.nextStep}`
          : liveMsg;
      }
    }

    // Error trajectory analysis — detect mutation and orbiting
    if (session.errorTrajectory && session.errorTrajectory.length > 1) {
      const traj = session.errorTrajectory;
      const current = traj[traj.length - 1];
      const prev = traj[traj.length - 2];

      if (current.fingerprint !== prev.fingerprint) {
        // Error mutated — different bug now
        const orbiting = traj.length >= 3 && traj.slice(0, -1).some((t) => t.fingerprint === current.fingerprint);
        if (orbiting) {
          response.errorTrajectory = {
            status: "orbiting",
            message: `Error is cycling back to a previously seen pattern (${current.errorType} in ${current.sourceFile}). The underlying issue may not be any of the individual errors — look for the common thread.`,
            history: traj.map((t) => `${t.errorType}${t.sourceFile ? " in " + t.sourceFile : ""}`),
          };
          response.nextStep = `⚠ ORBITING: Error cycled back to a pattern seen earlier. ${typeof response.nextStep === "string" ? response.nextStep : ""}`;
        } else {
          response.errorTrajectory = {
            status: "mutated",
            message: `Error changed: was ${prev.errorType}${prev.sourceFile ? " in " + prev.sourceFile : ""}, now ${current.errorType}${current.sourceFile ? " in " + current.sourceFile : ""}. Your last change may have fixed the original bug but introduced a new one.`,
          };
        }
      }
    }

    // Surface failed approaches from earlier in this session
    if (session.failedApproaches?.length) {
      response.failedApproaches = session.failedApproaches;
      const failedMsg = `⚠ Previously tried (failed): ${session.failedApproaches.map((a, i) => `(${i + 1}) ${a}`).join("; ")}. Avoid repeating these.`;
      response.nextStep = typeof response.nextStep === "string"
        ? `${response.nextStep}\n\n${failedMsg}`
        : failedMsg;
    }

    // Visual error advisory — auto-capture if Ghost OS connected, otherwise advise
    if (visualError) {
      // Auto-capture if Ghost OS connected and config allows
      if (visualConfig.autoCapture !== "off" && visualConfig.captureOnInvestigate && isGhostConnected()) {
        try {
          const screenshot = await takeScreenshot();
          const domState = await readScreen(undefined, errorText);

          if (screenshot && visualConfig.saveScreenshots) {
            const ssPath = saveScreenshot(cwd, session.id, "investigate", screenshot.image);

            session.visualContext = {
              screenshots: [{
                id: `ss_${Date.now()}`,
                timestamp: new Date().toISOString(),
                tool: "ghost_screenshot",
                reference: ssPath,
              }],
              domSnapshot: domState ? {
                timestamp: new Date().toISOString(),
                tool: "ghost_read",
                elements: domState.elements.map((e) => ({ role: e.role, name: e.name, visible: true })),
              } : null,
            };
            saveSession(cwd, session);

            response.visualCapture = {
              screenshot: ssPath,
              elementsFound: domState?.elements.length ?? 0,
              message: "Visual state captured automatically via Ghost OS.",
            };
          }
        } catch (e) {
          response.visualDiagnostic = {
            failed: true,
            reason: e instanceof Error ? e.message : String(e),
            ...getVisualDiagnostic(),
            suggestion: "Visual capture failed. Check debug_setup for Ghost OS status.",
          };
        }
      }

      // Always include visual hint (whether or not we captured)
      const tools: string[] = [];
      if (envCaps?.visual.ghostOsConfigured) tools.push("ghost_screenshot", "ghost_read");
      if (envCaps?.visual.claudePreviewConfigured) tools.push("preview_screenshot", "preview_snapshot");

      const visualActions: string[] = [];
      if (isGhostConnected()) {
        visualActions.push("Screenshot already captured", "Use debug_visual for more captures");
      } else if (tools.length > 0) {
        visualActions.push(`Capture screenshot with ${tools[0]}`);
      }
      visualActions.push("Pass suspect CSS/component file paths in 'files' parameter for targeted source extraction");

      response.visualHint = {
        isVisualBug: true,
        message: isGhostConnected()
          ? "Visual/layout bug detected. Screenshot captured automatically."
          : tools.length > 0
            ? `Visual/layout bug detected. Use ${tools[0]} to see the rendered state — more useful than logs for CSS issues.`
            : "Visual/layout bug detected. For CSS issues, pass suspect file paths in 'files' parameter. 0 stack frames is expected for layout bugs.",
        suggestedActions: visualActions,
      };
      // Append to nextStep — make it actionable for layout bugs
      if (typeof response.nextStep === "string") {
        const visualNext = isGhostConnected()
          ? "Screenshot captured."
          : tools.length > 0
            ? `Use ${tools[0]} to see the actual rendered state.`
            : "Pass CSS/component files in 'files' for source context.";
        response.nextStep += ` Visual/layout bug — ${visualNext}`;
      }
    }

    // Hint when no source code could be extracted
    if (result.sourceCode.length === 0 && result.frames.length === 0 && (!hintFiles || hintFiles.length === 0)) {
      response.noSourceCodeHint = "No source code could be extracted from the description. For better results, pass file paths in the 'files' parameter. Example: { error: \"description\", files: [\"src/MyComponent.tsx\"] }";
    }

    // Add triage explanation
    const userFrameCount = result.frames.filter((f) => f.isUserCode).length;
    const isTrivialPattern = triage.level === "trivial";
    response._triageExplanation = explainTriage(
      triage.level,
      triage.classification.type,
      userFrameCount,
      isTrivialPattern,
    );

    logActivity({
      tool: "debug_investigate", ts: Date.now(),
      summary: `"${errorText.split("\n")[0]?.slice(0, 60)}"`,
      metrics: {
        triage: triage.level,
        files: result.sourceCode.length,
        ...(pastSolutions.length > 0 ? { memoryHits: pastSolutions.length } : {}),
        ...(buildErrors.length > 0 ? { buildErrors: buildErrors.length } : {}),
      },
    });

    // Loop detection — check if we're going in circles
    const loopAnalysis = analyzeLoop(session, cwd);
    if (loopAnalysis.looping) {
      response.loopDetection = {
        severity: loopAnalysis.severity,
        signals: loopAnalysis.signals.map((s) => ({
          type: s.signal,
          severity: s.severity,
          message: s.message,
        })),
        recommendation: loopAnalysis.recommendation,
      };
      response.nextStep = `⚠ ${loopAnalysis.recommendation}\n\n${response.nextStep ?? ""}`;
    }

    const budgeted = fitToBudget(response, { maxTokens: 4000 });
    return { content: [{ type: "text", text: JSON.stringify(budgeted) }] };
  });

  // ━━━ TOOL 2: debug_instrument ━━━
  server.registerTool("debug_instrument", {
    title: "Instrument Code",
    description: `Add tagged debug logging to a source file. The logging:
- Respects the file's indentation
- Is tagged with a marker (e.g., [DBG_001]) for tracking
- Can be linked to a hypothesis
- Auto-cleans when you call debug_cleanup

Supports JS/TS/Python/Go.`,
    inputSchema: {
      sessionId: z.string(),
      filePath: z.string().describe("File to instrument"),
      lineNumber: z.number().describe("Insert AFTER this line (0-indexed)"),
      expression: z.string().describe("What to log (e.g., 'req.body', 'state.count')"),
      hypothesis: z.string().optional().describe("What you're testing (auto-creates hypothesis)"),
      condition: z.string().optional().describe("Optional: only log when this condition is true (e.g., 'value === null', 'count > 100')"),
    },
  }, async ({ sessionId, filePath, lineNumber, expression, hypothesis, condition }) => {
    const session = loadSession(cwd, sessionId);

    // Auto-create hypothesis if description provided
    let hypId: string | undefined;
    if (hypothesis) {
      const hyp: Hypothesis = {
        id: newHypothesisId(), text: hypothesis, status: "testing", evidence: [],
      };
      session.hypotheses.push(hyp);
      hypId = hyp.id;
      saveSession(cwd, session);
    }

    const r = instrumentFile({ cwd, session, filePath, lineNumber, expression, hypothesisId: hypId, condition });

    logActivity({ tool: "debug_instrument", ts: Date.now(), summary: `added [${r.markerTag}] to ${basename(filePath)}:${lineNumber}`, metrics: hypothesis ? { hypothesis } : undefined });
    return text({
      markerTag: r.markerTag,
      file: basename(filePath),
      line: lineNumber,
      code: r.insertedCode,
      hypothesis: hypothesis ?? null,
      nextStep: `Run your app and use debug_capture to see [${r.markerTag}] output.`,
    });
  });

  // ━━━ TOOL 2b: debug_hypothesis ━━━
  server.registerTool("debug_hypothesis", {
    title: "Log Hypothesis",
    description: `Record a hypothesis before attempting a fix. Creates an auditable investigation trail.

Use this BEFORE making code changes:
- "I think X is the root cause because Y"
- Update status to 'confirmed' or 'rejected' after testing

Tracks your reasoning so you don't repeat failed approaches.`,
    inputSchema: {
      sessionId: z.string().describe("Active debug session ID"),
      hypothesis: z.string().describe("What you think the root cause is and why (e.g., 'The null check in middleware is missing because req.user is undefined when auth skips')"),
      status: z.enum(["testing", "confirmed", "rejected"]).optional().describe("Hypothesis status (default: testing). Use 'rejected' to mark a disproven theory."),
      evidence: z.array(z.string()).optional().describe("Supporting observations (e.g., ['error only happens on POST', 'works when auth is disabled'])"),
      hypothesisId: z.string().optional().describe("Update an existing hypothesis by ID instead of creating a new one"),
    },
  }, async ({ sessionId, hypothesis, status, evidence, hypothesisId }) => {
    const session = loadSession(cwd, sessionId);

    // Update existing hypothesis
    if (hypothesisId) {
      const existing = session.hypotheses.find((h) => h.id === hypothesisId);
      if (!existing) {
        return text({ error: `Hypothesis ${hypothesisId} not found in session ${sessionId}` });
      }
      if (status) existing.status = status;
      if (evidence) existing.evidence.push(...evidence);
      if (hypothesis && hypothesis !== existing.text) existing.text = hypothesis;
      saveSession(cwd, session);

      logActivity({ tool: "debug_hypothesis", ts: Date.now(), summary: `updated ${hypothesisId}: ${status ?? "evidence added"}` });
      return text({
        hypothesisId: existing.id,
        text: existing.text,
        status: existing.status,
        evidence: existing.evidence,
        allHypotheses: session.hypotheses.map((h) => ({ id: h.id, text: h.text, status: h.status })),
        nextStep: existing.status === "rejected"
          ? "Hypothesis rejected. Form a NEW hypothesis with a different theory — don't stack fixes on a disproven idea."
          : existing.status === "confirmed"
            ? "Hypothesis confirmed! Implement the fix, then use debug_verify to validate."
            : "Continue testing. Use debug_instrument or debug_capture to gather more evidence.",
      });
    }

    // Create new hypothesis
    const hyp: Hypothesis = {
      id: newHypothesisId(),
      text: hypothesis,
      status: (status ?? "testing") as "testing" | "confirmed" | "rejected",
      evidence: evidence ?? [],
    };
    session.hypotheses.push(hyp);
    saveSession(cwd, session);

    const rejectedCount = session.hypotheses.filter((h) => h.status === "rejected").length;

    logActivity({ tool: "debug_hypothesis", ts: Date.now(), summary: `new: ${hypothesis.slice(0, 60)}` });
    return text({
      hypothesisId: hyp.id,
      text: hyp.text,
      status: hyp.status,
      evidence: hyp.evidence,
      hypothesisNumber: session.hypotheses.length,
      rejectedCount,
      allHypotheses: session.hypotheses.map((h) => ({ id: h.id, text: h.text, status: h.status })),
      nextStep: rejectedCount >= 2
        ? `${rejectedCount} hypotheses already rejected. Consider: is the bug in a different layer entirely? Use debug_patterns to check for systemic issues.`
        : "Test this hypothesis. Use debug_instrument to add logging, then debug_capture to observe.",
    });
  });

  // ━━━ TOOL 3: debug_capture ━━━
  server.registerTool("debug_capture", {
    title: "Capture Runtime Output",
    description: `Collect runtime output. Three modes:
1. Run a command and capture its output (e.g., 'npm test', 'curl localhost:3000')
2. Drain buffered terminal/browser output from the dev server
3. Wait for new output (wait=true) — blocks until new lines arrive or timeout
4. Recent window (recent=<ms>) — read from immutable 60s buffer, immune to drain

Returns tagged captures linked to hypotheses, plus any errors detected.
Results are paginated — only the most recent captures are returned.
When running commands against localhost, server-side logs from the request window are included in serverLogs.`,
    inputSchema: {
      sessionId: z.string().optional().describe("Existing session ID, or omit to read output without a session"),
      command: z.string().optional().describe("Command to run (e.g., 'npm test')"),
      limit: z.number().optional().describe("Max results (default 30)"),
      wait: z.boolean().optional().describe("Block until new output arrives (up to waitTimeoutMs). Use for long-running processes."),
      waitTimeoutMs: z.number().optional().describe("Max ms to wait for new output (default 30000, max 60000)"),
      source: z.enum(["terminal", "browser", "all"]).optional().describe("Filter by source (default: all)"),
      filter: z.string().optional().describe("Text pattern to match (e.g., 'SCROLL-DEBUG', 'error')"),
      level: z.enum(["error", "warn", "all"]).optional().describe("Filter by log level"),
      recent: z.number().optional().describe("Read from immutable recent window (last N ms, max 60000). Immune to buffer drain — use when normal capture returns empty."),
    },
  }, async ({ sessionId, command, limit, wait, waitTimeoutMs, source: sourceFilter, filter: textFilter, level: levelFilter, recent }) => {
    // Session is optional — auto-create only when running commands, otherwise work sessionless
    let session = sessionId ? loadSession(cwd, sessionId) : null;
    if (!session && command) {
      session = createSession(cwd, `capture: ${command.slice(0, 60)}`);
    }

    // Filter helper — applies source/text/level filters to captures
    const matchesFilters = (c: { source: string; data: unknown }): boolean => {
      // Source filter
      if (sourceFilter && sourceFilter !== "all") {
        if (sourceFilter === "terminal" && c.source !== "terminal") return false;
        if (sourceFilter === "browser" && !c.source.startsWith("browser")) return false;
      }
      // Text filter (substring match)
      if (textFilter) {
        const d = c.data as Record<string, unknown> | null;
        const str = typeof d?.text === "string" ? d.text
          : typeof d?.message === "string" ? d.message
          : JSON.stringify(c.data);
        if (!str.toLowerCase().includes(textFilter.toLowerCase())) return false;
      }
      // Level filter
      if (levelFilter && levelFilter !== "all") {
        const d = c.data as Record<string, unknown> | null;
        if (levelFilter === "error") {
          const isErr = d?.level === "error" || d?.stream === "stderr"
            || c.source === "browser-error" || c.source === "browser-network"
            || (typeof d?.text === "string" && /error|panic|crash|fatal/i.test(d.text as string));
          if (!isErr) return false;
        } else if (levelFilter === "warn") {
          const isWarn = d?.level === "error" || d?.level === "warn" || d?.stream === "stderr"
            || c.source === "browser-error" || c.source === "browser-network"
            || (typeof d?.text === "string" && /error|warn|panic|crash|fatal/i.test(d.text as string));
          if (!isWarn) return false;
        }
      }
      return true;
    };

    // Mode 4: Recent window (immutable, immune to drain)
    if (recent && !command) {
      const windowMs = Math.min(recent, 60_000);
      const windowCaptures = peekRecentWindow(windowMs);
      const filtered = windowCaptures.filter(matchesFilters);
      const errors = filtered.filter((c) => {
        const d = c.data as Record<string, string> | undefined;
        return d?.stream === "stderr" || d?.text?.toLowerCase().includes("error");
      });

      logActivity({ tool: "debug_capture", ts: Date.now(), summary: `recent window ${windowMs}ms`, metrics: { total: filtered.length, errors: errors.length } });
      return text({
        sessionId: session?.id,
        mode: "recent-window",
        windowMs,
        total: filtered.length,
        output: filtered.slice(-(limit ?? 30)).map((c) => ({ source: c.source, data: c.data })),
        errors: errors.slice(0, 10).map((c) => (c.data as Record<string, string>)?.text),
        nextStep: filtered.length === 0
          ? `No output in the last ${Math.round(windowMs / 1000)}s. The server may not be producing output.`
          : errors.length > 0
            ? "Errors found in recent window. Use debug_investigate with the error text."
            : `${filtered.length} line(s) from the last ${Math.round(windowMs / 1000)}s.`,
      });
    }

    // Mode 3: Wait for new output (blocking poll)
    if (wait && !command) {
      const maxWait = Math.min(waitTimeoutMs ?? 30_000, 60_000);
      const result = await waitForNewOutput({ timeoutMs: maxWait, minLines: 1 });

      if (result.timedOut) {
        logActivity({ tool: "debug_capture", ts: Date.now(), summary: `waited ${Math.round(result.waitedMs / 1000)}s (timed out)`, metrics: { total: 0 } });
        return text({
          waited: true, waitedMs: result.waitedMs, timedOut: true, total: 0,
          nextStep: `No new output in ${Math.round(result.waitedMs / 1000)}s. Try running a command or check debug://status.`,
        });
      }

      const filtered = result.items.filter(matchesFilters);
      if (session) { session.captures.push(...filtered); saveSession(cwd, session); }

      const errors = filtered.filter((c) => {
        const d = c.data as Record<string, string> | undefined;
        return d?.stream === "stderr" || d?.text?.toLowerCase().includes("error");
      });

      logActivity({ tool: "debug_capture", ts: Date.now(), summary: `waited ${Math.round(result.waitedMs / 1000)}s, got ${filtered.length} lines`, metrics: { total: filtered.length, errors: errors.length } });
      return text({
        waited: true, waitedMs: result.waitedMs, timedOut: false,
        total: filtered.length,
        output: filtered.slice(0, 30).map((c) => ({ source: c.source, data: c.data })),
        errors: errors.slice(0, 10).map((c) => (c.data as Record<string, string>)?.text),
        nextStep: errors.length > 0
          ? "New errors arrived. Use debug_investigate with the error text for full context."
          : `${filtered.length} new line(s) captured.`,
      });
    }

    // Mode 1: Run command
    let serverLogs: Array<{ timestamp: string; text: unknown }> | undefined;
    if (command && session) {
      const safe = validateCommand(command);
      // Snapshot recent window before running command for localhost correlation
      const isLocalRequest = /localhost|127\.0\.0\.1/i.test(safe);
      const preTimestamp = isLocalRequest ? Date.now() : 0;

      const caps = await runAndCapture(safe, 30_000);
      session.captures.push(...caps);
      saveSession(cwd, session);

      // Correlate server-side logs triggered by the request
      if (isLocalRequest) {
        // Small delay for server to flush logs
        await new Promise(r => setTimeout(r, 250));
        const recentServerOutput = peekRecentWindow(Date.now() - preTimestamp + 500);
        if (recentServerOutput.length > 0) {
          serverLogs = recentServerOutput.map(c => {
            const d = typeof c.data === "object" && c.data !== null ? c.data as Record<string, unknown> : null;
            return { timestamp: c.timestamp, text: d?.text ?? d?.data ?? String(c.data) };
          });
        }
      }
    }

    // Mode 2: Drain/peek buffers
    if (session) {
      drainCaptures(cwd, session);
      const tauriLogs = readTauriLogs(cwd, 30);
      if (tauriLogs.length > 0) { session.captures.push(...tauriLogs); saveSession(cwd, session); }

      const recent = getRecentCaptures(session, { limit: limit ?? 30 });
      const filtered = recent.captures.filter(matchesFilters);
      const tagged = filtered.filter((c) => c.markerTag);
      const errors = filtered.filter((c) => {
        const d = c.data as Record<string, string> | undefined;
        return d?.stream === "stderr" || d?.text?.toLowerCase().includes("error");
      });

      logActivity({ tool: "debug_capture", ts: Date.now(), summary: command ? `ran "${command}"` : "drained buffers", metrics: { total: recent.total, tagged: tagged.length, errors: errors.length } });
      return text({
        sessionId: session.id,
        total: recent.total, showing: filtered.length,
        tagged: tagged.map((c) => ({ tag: c.markerTag, hypothesis: c.hypothesisId, data: c.data })),
        errors: errors.slice(0, 10).map((c) => (c.data as Record<string, string>)?.text),
        output: filtered.slice(0, 15).map((c) => ({ source: c.source, data: c.data })),
        serverLogs: serverLogs && serverLogs.length > 0 ? serverLogs.slice(0, 20) : undefined,
        nextStep: errors.length > 0
          ? "Errors detected. Use debug_investigate with the error text for full context."
          : serverLogs && serverLogs.length > 0
            ? "Server-side logs captured from this request — check serverLogs for the full picture."
            : tagged.length > 0
              ? "Instrumented output captured. Review tagged data to confirm/reject hypotheses."
              : recent.total === 0 && !command
                ? "No output captured. Try debug_capture with wait=true, or run a command."
                : "Output captured. Review the results.",
      });
    }

    // Sessionless mode — peek buffers without draining
    const peeked = peekRecentOutput({ terminalLines: limit ?? 30, browserLines: limit ?? 30, buildErrors: 10 });
    const allCaptures = [...peeked.terminal, ...peeked.browser];
    const filtered = allCaptures.filter(matchesFilters);
    const errors = filtered.filter((c) => {
      const d = c.data as Record<string, string> | undefined;
      return d?.stream === "stderr" || d?.text?.toLowerCase().includes("error");
    });

    logActivity({ tool: "debug_capture", ts: Date.now(), summary: "peeked buffers (no session)", metrics: { total: filtered.length, errors: errors.length } });
    return text({
      total: filtered.length,
      output: filtered.slice(0, 30).map((c) => ({ source: c.source, data: c.data })),
      errors: errors.slice(0, 10).map((c) => (c.data as Record<string, string>)?.text),
      nextStep: errors.length > 0
        ? "Errors detected. Use debug_investigate with the error text for full context."
        : filtered.length === 0
          ? "No matching output. Try adjusting filters or wait=true for new output."
          : "Output captured.",
    });
  });

  // ━━━ TOOL 4: debug_verify ━━━
  // Compound: snapshot + run + diff + assert — all in one call
  server.registerTool("debug_verify", {
    title: "Verify Fix",
    description: `After applying a fix, run this to verify it works. In one call it:
1. Runs your test/command
2. Captures all output
3. Checks for errors
4. Reports pass/fail

Use this before cleanup to confirm the fix actually works.`,
    inputSchema: {
      sessionId: z.string(),
      command: z.string().describe("Command that should succeed after the fix (e.g., 'npm test')"),
      expectNoErrors: z.boolean().optional().describe("Fail if ANY stderr output (default: true)"),
    },
  }, async ({ sessionId, command, expectNoErrors }) => {
    const session = loadSession(cwd, sessionId);
    const safe = validateCommand(command);

    const captures = await runAndCapture(safe, 60_000);
    session.captures.push(...captures);
    saveSession(cwd, session);

    const exitCapture = captures.find((c) => {
      const d = c.data as Record<string, string>;
      return d?.stream === "meta" && d?.text?.startsWith("exit:");
    });
    const exitCode = exitCapture
      ? parseInt((exitCapture.data as Record<string, string>).text.split(":")[1] ?? "1")
      : null;

    const errors = captures.filter((c) => {
      const d = c.data as Record<string, string>;
      return d?.stream === "stderr" && d?.text?.toLowerCase().includes("error");
    });

    const noErrors = expectNoErrors !== false;
    const passed = exitCode === 0 && (noErrors ? errors.length === 0 : true);

    // Auto-learning: when fix is verified, auto-save diagnosis to memory
    if (passed && session.problem) {
      const errorCap = session.captures.find((c) =>
        (c.data as Record<string, unknown>)?.type === "investigation",
      );
      const errorData = errorCap?.data as Record<string, Record<string, string>> | undefined;

      const filesSet = new Set(session.instrumentation.map((i) => basename(i.filePath)));
      for (const cap of session.captures) {
        const d = cap.data as Record<string, unknown> | undefined;
        if (d?.type === "investigation") {
          for (const key of ["hintFiles", "sourceFiles"] as const) {
            if (Array.isArray(d[key])) {
              for (const f of d[key] as string[]) if (typeof f === "string") filesSet.add(f);
            }
          }
        }
      }

      const savedEntry = remember(cwd, {
        id: session.id,
        timestamp: new Date().toISOString(),
        problem: session.problem,
        errorType: errorData?.error?.type ?? "Unknown",
        category: errorData?.error?.category ?? "runtime",
        diagnosis: `Auto-learned: fix verified via "${command}"`,
        files: [...filesSet],
        rootCause: null,
        failedApproaches: session.failedApproaches,
      });

      // Async push to team memory (fire-and-forget)
      if (teamClient) {
        teamClient.push([savedEntry]).catch(() => {});
      }
    }

    // Close feedback loop: check if recalled memory was actually applied
    const hadMemoryHit = session._memoryHit === true;
    let memoryApplied = false;
    if (hadMemoryHit && session._recalledFiles?.length && passed) {
      // Compare recalled files to files the agent actually changed
      const changedFiles = new Set(session.instrumentation.map((i) => basename(i.filePath)));
      for (const cap of session.captures) {
        const d = cap.data as Record<string, unknown> | undefined;
        if (d?.type === "investigation") {
          for (const f of (d.sourceFiles as string[] ?? [])) changedFiles.add(f);
        }
      }
      // If any recalled file overlaps with changed files, the fix was memory-informed
      memoryApplied = session._recalledFiles.some((f) =>
        changedFiles.has(f) || changedFiles.has(basename(f)),
      );
      // Increment timesUsed on the recalled entries
      if (memoryApplied && session._recalledEntryIds?.length) {
        markUsed(cwd, session._recalledEntryIds);
      }
    }

    // Record telemetry outcome
    if (session.problem) {
      const errorCap = session.captures.find((c) =>
        (c.data as Record<string, unknown>)?.type === "investigation",
      );
      const errorData = errorCap?.data as Record<string, Record<string, string>> | undefined;
      recordOutcome(cwd, {
        sessionId: session.id,
        errorType: errorData?.error?.type ?? "unknown",
        category: errorData?.error?.category ?? "unknown",
        files: session.instrumentation.map((i) => basename(i.filePath)),
        triageLevel: (session as any)._triageLevel ?? "complex",
        outcome: passed ? "fixed" : "workaround",
        durationMs: Date.now() - new Date(session.createdAt).getTime(),
        toolsUsed: ["investigate", "instrument", "capture", "verify"],
        memoryHit: hadMemoryHit,
        memoryApplied,
        timestamp: new Date().toISOString(),
      });
    }

    // Record failed approach on verify-fail for anti-loop memory
    if (!passed && session.instrumentation.length > 0) {
      if (!session.failedApproaches) session.failedApproaches = [];
      // Build a one-liner describing what was tried from instrumented files
      const touchedFiles = [...new Set(session.instrumentation.map((i) => basename(i.filePath)))];
      const topError = errors[0] ? (errors[0].data as Record<string, string>)?.text?.slice(0, 80) : "verification failed";
      const approach = `Fix in ${touchedFiles.join(", ")} — ${topError}`;
      // Avoid duplicates
      if (!session.failedApproaches.includes(approach)) {
        session.failedApproaches.push(approach);
        saveSession(cwd, session);
      }
    }

    const failedCount = session.failedApproaches?.length ?? 0;

    const verifyResponse: Record<string, unknown> = {
      passed,
      exitCode,
      errorCount: errors.length,
      errors: errors.slice(0, 5).map((c) => (c.data as Record<string, string>)?.text),
      output: captures.slice(0, 10).map((c) => (c.data as Record<string, string>)?.text),
      nextStep: passed
        ? "Fix verified and auto-saved to memory! Use debug_cleanup to remove instrumentation (optional — diagnosis already recorded)."
        : "Fix failed. Review the errors above and try a different approach.",
    };

    // Escalation: 3+ failed fixes → question the architecture
    if (!passed && failedCount >= 3) {
      const rejectedHypotheses = session.hypotheses.filter((h) => h.status === "rejected");
      verifyResponse.escalation = {
        triggered: true,
        failedCount,
        failedApproaches: session.failedApproaches!.slice(-3),
        rejectedHypotheses: rejectedHypotheses.map((h) => h.text),
        recommendations: [
          "STOP fixing symptoms. 3+ failed attempts means your mental model of the bug is wrong.",
          "Re-read the ORIGINAL error from scratch — ignore everything you've assumed so far.",
          "Run debug_recall with the original error to check if this was solved before.",
          "Run debug_patterns to detect systemic issues you may be missing.",
          "Consider: is the bug in a completely different file/layer than where you've been looking?",
          "If all else fails, use debug_cleanup to close this session and start fresh with debug_investigate.",
        ],
      };
      verifyResponse.nextStep = `🚨 ESCALATION: ${failedCount} fix attempts failed. Your understanding of the root cause is likely wrong. Stop and re-investigate before trying another fix.`;
    }

    // Loop detection on verify failure (only if escalation not already triggered)
    if (!passed && failedCount < 3) {
      const loopAnalysis = analyzeLoop(session, cwd);
      if (loopAnalysis.looping) {
        verifyResponse.loopDetection = {
          severity: loopAnalysis.severity,
          recommendation: loopAnalysis.recommendation,
        };
        verifyResponse.nextStep = `⚠ ${loopAnalysis.recommendation}`;
      }
    }

    // Visual verification: capture after-fix screenshot if we have a before
    if (session.visualContext?.screenshots.length && isGhostConnected() && visualConfig.captureOnVerify) {
      try {
        const afterShot = await takeScreenshot();
        if (afterShot && visualConfig.saveScreenshots) {
          const afterPath = saveScreenshot(cwd, session.id, "verify", afterShot.image);
          session.visualContext.screenshots.push({
            id: `ss_${Date.now()}`,
            timestamp: new Date().toISOString(),
            tool: "ghost_screenshot",
            reference: afterPath,
          });
          saveSession(cwd, session);

          verifyResponse.visualVerification = {
            before: session.visualContext.screenshots[0].reference,
            after: afterPath,
            message: "Before/after screenshots captured. Compare to confirm visual fix.",
          };
        }
      } catch { /* non-fatal */ }
    }

    const verifyDuration = Math.round((Date.now() - new Date(session.createdAt).getTime()) / 1000);
    logActivity({
      tool: "debug_verify", ts: Date.now(),
      summary: passed ? "PASSED" : "FAILED",
      metrics: { duration: `${verifyDuration}s`, errors: errors.length, captures: session.captures.length, hypotheses: session.hypotheses.length, ...(passed ? { outcome: "fixed", savedToMemory: "yes" } : { outcome: "failed" }) },
    });
    return text(verifyResponse);
  });

  // ━━━ TOOL 5: debug_cleanup ━━━
  server.registerTool("debug_cleanup", {
    title: "Cleanup & Close",
    description: `Remove ALL debug instrumentation from source files, verify removal, and close the session.
Idempotent — safe to call multiple times. Files are restored to their pre-instrumented state.`,
    inputSchema: {
      sessionId: z.string(),
      diagnosis: z.string().optional().describe("Root cause summary (for the session record)"),
      rootCause: z.object({
        trigger: z.string().describe("What caused the error"),
        errorFile: z.string().describe("Where the error manifested"),
        causeFile: z.string().describe("Where the actual bug was"),
        fixDescription: z.string().describe("One-line fix description"),
      }).optional().describe("Causal chain — what caused the error and what fixed it"),
    },
  }, async ({ sessionId, diagnosis, rootCause }) => {
    const session = loadSession(cwd, sessionId);
    if (diagnosis) { session.diagnosis = diagnosis; saveSession(cwd, session); }
    const r = cleanupSession(cwd, session);

    // Save to memory for future recall
    if (diagnosis && session.problem) {
      const errorCap = session.captures.find((c) =>
        (c.data as Record<string, unknown>)?.type === "investigation",
      );
      const errorData = errorCap?.data as Record<string, Record<string, string>> | undefined;

      // Merge ALL file sources: instrumented + rootCause + investigated hint files
      const filesSet = new Set(session.instrumentation.map((i) => basename(i.filePath)));
      const rc = rootCause as CausalLink | undefined;
      if (rc?.errorFile) filesSet.add(rc.errorFile);
      if (rc?.causeFile) filesSet.add(rc.causeFile);
      // Also include files from investigation captures (hint files + source files)
      for (const cap of session.captures) {
        const d = cap.data as Record<string, unknown> | undefined;
        if (d?.type === "investigation") {
          for (const key of ["hintFiles", "sourceFiles"] as const) {
            if (Array.isArray(d[key])) {
              for (const f of d[key] as string[]) if (typeof f === "string") filesSet.add(f);
            }
          }
        }
      }

      const savedEntry = remember(cwd, {
        id: session.id,
        timestamp: new Date().toISOString(),
        problem: session.problem,
        errorType: errorData?.error?.type ?? "Unknown",
        category: errorData?.error?.category ?? "runtime",
        diagnosis,
        files: [...filesSet],
        rootCause: rc,
        failedApproaches: session.failedApproaches,
      });

      // Async push to team memory (fire-and-forget)
      if (teamClient) {
        teamClient.push([savedEntry]).catch(() => {});
      }
    }

    maybeArchive(cwd);
    const stats = memoryStats(cwd);

    const cleanupDuration = Math.round((Date.now() - new Date(session.createdAt).getTime()) / 1000);
    logActivity({
      tool: "debug_cleanup", ts: Date.now(),
      summary: `${r.cleaned} file(s) cleaned${diagnosis ? ", diagnosis saved" : ""}`,
      metrics: { duration: `${cleanupDuration}s`, memoryEntries: stats.entries, captures: session.captures.length, hypotheses: session.hypotheses.length, savedToMemory: diagnosis ? "yes" : "no" },
    });
    return text({
      cleaned: r.cleaned,
      verified: r.verified,
      files: r.filesProcessed.map((f) => basename(f)),
      errors: r.errors.length > 0 ? r.errors : undefined,
      savedToMemory: !!diagnosis,
      memoryEntries: stats.entries,
      message: r.verified
        ? `Done. ${r.cleaned} file(s) cleaned.${diagnosis ? " Diagnosis saved to memory." : ""}`
        : `Cleanup had issues: ${r.errors.join(", ")}`,
    });
  });

  // ━━━ TOOL 7: debug_recall ━━━
  server.registerTool("debug_recall", {
    title: "Recall Past Solutions",
    description: `Search debug memory for past solutions to similar errors.
Returns past diagnoses ranked by relevance. Check this BEFORE deep investigation —
the same error may have been solved before in this project.`,
    inputSchema: {
      query: z.string().describe("Error message, error type, or description to search for"),
      limit: z.number().optional().describe("Max results (default: 5)"),
      explain: z.boolean().optional().describe("Include confidence explanations for each result"),
    },
  }, async ({ query: searchQuery, limit, explain }) => {
    const effectiveLimit = limit ?? 5;
    const matches = recall(cwd, searchQuery, effectiveLimit);
    const stats = memoryStats(cwd);

    // Team recall — if local results are thin, query team memory
    let teamMatches: TeamRecallResult[] = [];
    if (teamClient && matches.length < effectiveLimit) {
      const sig = signatureFromError(searchQuery, null);
      try {
        teamMatches = await teamClient.recall(searchQuery, {
          errorSignature: sig,
          limit: effectiveLimit - matches.length,
        });
      } catch { /* team recall failure is non-fatal */ }
    }

    if (matches.length === 0 && teamMatches.length === 0) {
      logActivity({ tool: "debug_recall", ts: Date.now(), summary: `no matches in ${stats.entries} entries` });
      return text({
        matches: [],
        memoryEntries: stats.entries,
        teamMemoryQueried: teamClient !== null,
        message: stats.entries === 0
          ? "No debug memory yet. Complete a debug session with a diagnosis to start building memory."
          : `No matches found in ${stats.entries} stored sessions${teamClient ? " or team memory" : ""}. This is a new error.`,
      });
    }

    const staleCount = matches.filter((m) => m.staleness.stale).length;

    // Format local matches
    const formattedLocal = matches.map((m) => {
      const entry: Record<string, unknown> = {
        problem: m.problem,
        errorType: m.errorType,
        diagnosis: m.diagnosis,
        files: m.files,
        relevance: Math.round(m.relevance * 100) + "%",
        date: m.timestamp,
        stale: m.staleness.stale,
        staleness: m.staleness.stale ? m.staleness.reason : undefined,
        rootCause: m.rootCause ?? undefined,
        source: "local",
      };
      if (explain) {
        const ageInDays = (Date.now() - new Date(m.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        entry._explanation = explainConfidence({
          ageInDays,
          fileDriftCommits: m.staleness.commitsBehind,
          timesRecalled: m.timesRecalled,
          timesUsed: m.timesUsed,
        });
      }
      return entry;
    });

    // Format team matches
    const formattedTeam = teamMatches
      .filter((t) => !t.superseded)
      .map((t) => ({
        problem: t.entry.problem,
        errorType: t.entry.errorType,
        diagnosis: t.entry.diagnosis,
        files: t.entry.files,
        relevance: Math.round(t.relevance * 100) + "%",
        date: t.entry.timestamp,
        stale: false,
        rootCause: t.entry.rootCause ?? undefined,
        source: "team" as const,
        contributedBy: t.contributedBy,
        successRate: Math.round(t.successRate * 100) + "%",
      }));

    const allMatches = [...formattedLocal, ...formattedTeam];
    const topMatch = matches[0]?.diagnosis ?? teamMatches[0]?.entry.diagnosis ?? "";
    const teamMsg = formattedTeam.length > 0
      ? ` Also ${formattedTeam.length} team solution(s) from ${formattedTeam.map((t) => t.contributedBy).join(", ")}.`
      : "";

    logActivity({ tool: "debug_recall", ts: Date.now(), summary: `found ${allMatches.length} past fix(es)${teamMsg ? " (incl team)" : ""}`, metrics: { local: matches.length, team: formattedTeam.length, topConfidence: matches[0] ? Math.round((matches[0].confidence ?? matches[0].relevance) * 100) + "%" : undefined, stale: staleCount } });
    return text({
      matches: allMatches,
      memoryEntries: stats.entries,
      message: `Found ${allMatches.length} past solution(s).${staleCount > 0 ? ` ${staleCount} may be outdated.` : ""}${teamMsg} Top match: "${topMatch}"`,
      nextStep: staleCount === matches.length && formattedTeam.length === 0
        ? "All past solutions are outdated — code has changed. Investigate fresh with debug_investigate."
        : "If a past solution applies, try the same fix. Otherwise proceed with debug_investigate.",
    });
  });

  // ━━━ TOOL 8: debug_patterns ━━━
  server.registerTool("debug_patterns", {
    title: "Detect Bug Patterns",
    description: `Analyze debug memory to detect patterns across all past sessions:
- Recurring errors (same error type in same file, 3+ times)
- Hot files (files that appear in many debug sessions)
- Regressions (bugs that were fixed but came back)
- Error clusters (multiple errors in a short time window — cascading failures)

Use this periodically to understand your project's debugging health.`,
    inputSchema: {},
  }, async () => {
    const stats = memoryStats(cwd);
    const telemetry = getTelemetry(cwd);

    if (stats.entries === 0) {
      return text({
        patterns: [],
        message: "No debug memory yet. Complete debug sessions to start detecting patterns.",
      });
    }

    const patterns = stats.patterns;
    const suggestions = generateSuggestions(patterns);
    const critical = patterns.filter((p) => p.severity === "critical");
    const warnings = patterns.filter((p) => p.severity === "warning");

    logActivity({ tool: "debug_patterns", ts: Date.now(), summary: patterns.length === 0 ? "no patterns" : `${patterns.length} pattern(s)`, metrics: patterns.length > 0 ? { critical: critical.length, warnings: warnings.length } : undefined });

    const telemetrySection = telemetry.aggregates.totalSessions > 0 ? {
      totalSessions: telemetry.aggregates.totalSessions,
      fixRate: `${Math.round(telemetry.aggregates.fixRate * 100)}%`,
      avgDurationMs: Math.round(telemetry.aggregates.avgDurationMs),
      memoryHitRate: `${Math.round(telemetry.aggregates.memoryHitRate * 100)}%`,
      memoryApplyRate: `${Math.round(telemetry.aggregates.memoryApplyRate * 100)}%`,
      topErrors: telemetry.aggregates.topErrors.slice(0, 5).map((e) => ({
        errorType: e.errorType,
        count: e.count,
        fixRate: `${Math.round(e.fixRate * 100)}%`,
      })),
    } : undefined;

    return text({
      memoryEntries: stats.entries,
      patterns: patterns.map((p) => ({
        type: p.type,
        severity: p.severity,
        message: p.message,
        details: p.data,
      })),
      suggestions: suggestions.length > 0 ? suggestions.map((s) => ({
        category: s.category,
        priority: s.priority,
        action: s.action,
        rationale: s.rationale,
      })) : undefined,
      telemetry: telemetrySection,
      summary: patterns.length === 0
        ? `${stats.entries} sessions analyzed. No concerning patterns detected.`
        : `${patterns.length} pattern(s) found: ${critical.length} critical, ${warnings.length} warnings.`,
      nextStep: suggestions.length > 0
        ? `${suggestions.length} preventive suggestion(s) available. Top: ${suggestions[0].action}`
        : critical.length > 0
          ? `Critical: ${critical[0].message}. Consider refactoring this code.`
          : patterns.length > 0
            ? `Top finding: ${patterns[0].message}`
            : undefined,
    });
  });

  // ━━━ TOOL: debug_perf ━━━
  server.registerTool("debug_perf", {
    title: "Performance Snapshot",
    description: `Capture a Lighthouse performance snapshot for a URL.
Returns Web Vitals: LCP, CLS, INP, Total Blocking Time, Speed Index.
Call before and after a fix to compare performance impact.
Requires Chrome installed. Gracefully skips if unavailable.`,
    inputSchema: {
      sessionId: z.string(),
      url: z.string().describe("URL to audit (e.g., 'http://localhost:3000')"),
      phase: z.enum(["before", "after"]).optional().describe("Label this snapshot as before or after a fix (default: before)"),
    },
  }, async ({ sessionId, url, phase }) => {
    // Pre-check: is Lighthouse available?
    if (envCaps && !envCaps.perf.lighthouseAvailable) {
      return text({
        error: "Lighthouse is not installed.",
        setup: "npm install -g lighthouse",
        chromeRequired: !envCaps.perf.chromeAvailable,
        hint: "Run 'npx stackpack-debug doctor' to check your full setup.",
      });
    }

    const session = loadSession(cwd, sessionId);
    const snapshotPhase = phase ?? "before";

    const frameworkInfo = detectAppFramework(cwd);
    setLighthouseRunning(true);
    const metrics = await runLighthouse(url);
    setLighthouseRunning(false);
    if (!metrics) {
      return text({
        error: "Lighthouse failed — Chrome may not be installed or the URL is unreachable.",
        nextStep: "Ensure Chrome is installed and the dev server is running, then retry.",
      });
    }

    const snapshot: PerfSnapshot = {
      id: `perf_${Date.now()}`,
      timestamp: new Date().toISOString(),
      url,
      metrics,
      phase: snapshotPhase,
    };

    if (!session.perfSnapshots) session.perfSnapshots = [];
    session.perfSnapshots.push(snapshot);
    saveSession(cwd, session);

    // Compare with previous snapshot if this is an "after" snapshot
    let comparison: Record<string, unknown> | undefined;
    if (snapshotPhase === "after") {
      const beforeSnapshot = session.perfSnapshots.find((s) => s.phase === "before");
      if (beforeSnapshot) {
        const diff = compareSnapshots(beforeSnapshot.metrics, metrics);
        comparison = {
          lcpChange: diff.lcp !== null ? `${diff.lcp > 0 ? "+" : ""}${Math.round(diff.lcp)}ms` : null,
          clsChange: diff.cls !== null ? `${diff.cls > 0 ? "+" : ""}${diff.cls.toFixed(3)}` : null,
          tbtChange: diff.tbt !== null ? `${diff.tbt > 0 ? "+" : ""}${Math.round(diff.tbt)}ms` : null,
          improved: diff.improved,
        };
      }
    }

    // Check for browser errors triggered during the audit
    const postAuditBrowser = peekRecentOutput({ browserLines: 50 });
    const auditTriggeredErrors = postAuditBrowser.browser.filter((c) =>
      c.lighthouseTriggered || c.sourceContext === "lighthouse"
    ).length;

    logActivity({
      tool: "debug_perf", ts: Date.now(),
      summary: `${snapshotPhase} snapshot for ${url}`,
      metrics: { lcp: metrics.lcp !== null ? `${Math.round(metrics.lcp)}ms` : "n/a", cls: metrics.cls !== null ? metrics.cls.toFixed(3) : "n/a", ...(comparison ? { improved: (comparison as Record<string, unknown>).improved ? "yes" : "no" } : {}) },
    });

    const isDesktopApp = frameworkInfo.framework === "tauri" || frameworkInfo.framework === "electron";
    return text({
      phase: snapshotPhase,
      url,
      framework: frameworkInfo.framework ?? undefined,
      frameworkWarning: frameworkInfo.warning ?? undefined,
      metricsReliability: isDesktopApp ? "low" : "normal",
      ...(isDesktopApp ? {
        alternativeAdvice: getAlternativePerfAdvice(frameworkInfo.framework!),
        valuableSignals: "Browser errors triggered during this audit reflect real code issues. Check debug://status for new errors.",
      } : {}),
      errorsTriggeredByAudit: auditTriggeredErrors > 0 ? auditTriggeredErrors : undefined,
      metrics: {
        lcp: metrics.lcp !== null ? `${Math.round(metrics.lcp)}ms` : null,
        cls: metrics.cls !== null ? metrics.cls.toFixed(3) : null,
        inp: metrics.inp !== null ? `${Math.round(metrics.inp)}ms` : null,
        tbt: metrics.tbt !== null ? `${Math.round(metrics.tbt)}ms` : null,
        speedIndex: metrics.speedIndex !== null ? `${Math.round(metrics.speedIndex)}ms` : null,
      },
      comparison,
      nextStep: snapshotPhase === "before"
        ? isDesktopApp
          ? `Metrics have low reliability for ${frameworkInfo.framework} apps. ${auditTriggeredErrors > 0 ? `${auditTriggeredErrors} browser error(s) triggered during audit — check debug://status.` : ""} Apply your fix, then call debug_perf again with phase='after' for relative comparison.`
          : "Apply your fix, then call debug_perf again with phase='after' to compare."
        : comparison?.improved
          ? "Performance improved! Proceed with debug_verify to confirm the fix."
          : "Performance did not improve. Review the metrics and consider a different approach.",
    });
  });

  // ━━━ TOOL: debug_setup ━━━
  // Check and install integrations
  server.tool(
    "debug_setup",
    "Check available integrations and install missing ones. Actions: check = list status, install = install integration, connect = connect Ghost OS, disconnect = disconnect Ghost OS, fix-permissions = open macOS Screen Recording settings for Ghost OS, check-update = check for newer version, update = update stackpack-debug to latest.",
    {
      action: z.enum(["check", "install", "connect", "disconnect", "fix-permissions", "check-update", "update"]).describe("check = list status, install = install an integration, connect/disconnect = Ghost OS, fix-permissions = open Screen Recording settings, check-update = check for newer version, update = update to latest"),
      integration: z.string().optional().describe("Integration id to install: lighthouse, chrome, ghost-os"),
    },
    async ({ action, integration }) => {
      logActivity({ tool: "debug_setup", ts: Date.now(), summary: action === "install" ? `install ${integration ?? "?"}` : action });

      if (action === "fix-permissions") {
        if (process.platform !== "darwin") {
          return text({ error: "fix-permissions is macOS only. Ghost OS requires macOS Screen Recording permission." });
        }
        try {
          execSync(`open "${SCREEN_RECORDING_SETTINGS_URL}"`, { timeout: 5000 });
        } catch { /* may fail in non-GUI context — still return instructions */ }
        return text({
          message: "Opening System Settings > Privacy & Security > Screen Recording.",
          steps: [
            "1. Find 'Ghost OS' (or 'ghost') in the list",
            "2. Toggle it ON (you may need to click the lock icon first)",
            "3. Restart Ghost OS: run `debug_setup action='connect'`",
          ],
          deepLink: SCREEN_RECORDING_SETTINGS_URL,
          nextStep: "After granting permission, run debug_setup action='connect' to reconnect Ghost OS.",
        });
      }

      if (action === "check-update") {
        const update = checkForUpdate();
        return text({
          ...update,
          message: update.updateAvailable
            ? `Update available: v${update.current} → v${update.latest}. Run debug_setup action='update' to upgrade, then restart Claude Code.`
            : `Already on latest version (v${update.current}).`,
        });
      }

      if (action === "update") {
        const result = runSelfUpdate();
        return text({
          ...result,
          nextStep: result.success && result.from !== result.to
            ? "Updated successfully. Restart Claude Code to use the new version."
            : result.success
              ? "Already on latest version."
              : "Update failed. Try manually: npx -y stackpack-debug@latest",
        });
      }
      if (action === "connect") {
        resetConnectionState();
        const connected = await connectToGhostOs();
        return text({ connected, message: connected ? "Ghost OS connected successfully" : "Ghost OS not available — use debug_setup action='install' integration='ghost-os'" });
      }

      if (action === "disconnect") {
        await disconnectGhostOs();
        return text({ disconnected: true, message: "Ghost OS disconnected" });
      }

      const caps = detectEnvironment(cwd);

      if (action === "check") {
        const integrations = listInstallable(caps);
        const teamConfigured = teamClient !== null;
        return text({
          integrations: integrations.map((i) => ({
            id: i.id,
            name: i.name,
            description: i.description,
            available: i.available,
            autoInstallable: i.autoInstallable,
            installCommand: i.installCommand,
            manualSteps: i.manualSteps,
          })),
          ghostOsConnected: isGhostConnected(),
          teamMemory: await (async () => {
            if (!teamConfigured) {
              return {
                configured: false,
                status: "not configured",
                message: "Team memory is not configured. Set STACKPACK_EVENTS_URL and STACKPACK_API_KEY to share debug knowledge across your team.",
                setup: [
                  "1. Sign up at stackpack.io to get an API key",
                  "2. Set environment variables:",
                  "   export STACKPACK_EVENTS_URL=https://your-stackpack-instance.fly.dev",
                  "   export STACKPACK_API_KEY=sk_sp_your_api_key",
                  "3. Restart Claude Code — team memory activates automatically",
                  "4. All team members with the same org share debugging knowledge",
                ],
              };
            }
            // Check actual platform health
            const health = await teamClient!.checkHealth();
            return {
              configured: true,
              platform: health.status,
              reachable: health.reachable,
              uptime: health.uptime ? `${Math.round(health.uptime / 60)}m` : undefined,
              services: health.services,
              message: health.reachable
                ? `Team memory is active and healthy. Platform uptime: ${Math.round((health.uptime ?? 0) / 60)}m.`
                : `Team memory is configured but the platform is unreachable.`,
              ...(health.troubleshooting ? { troubleshooting: health.troubleshooting } : {}),
              ...(health.error ? { error: health.error } : {}),
            };
          })(),
          summary: {
            available: integrations.filter((i) => i.available).map((i) => i.name),
            missing: integrations.filter((i) => !i.available).map((i) => i.name),
            autoInstallable: integrations.filter((i) => !i.available && i.autoInstallable).map((i) => i.id),
          },
        });
      }

      if (action === "install") {
        if (!integration) {
          return text({ error: "Specify which integration to install", available: ["lighthouse", "chrome", "ghost-os"] });
        }
        const result = installIntegration(integration, cwd);
        // Refresh capabilities after install
        if (result.success) {
          envCaps = detectEnvironment(cwd);
        }
        return text(result);
      }

      return text({ error: "Unknown action. Use 'check', 'install', 'connect', or 'disconnect'." });
    },
  );

  // ━━━ TOOL: debug_visual ━━━
  // Explicit visual capture tool
  server.tool(
    "debug_visual",
    "Capture visual state — screenshot, element inspection, annotated view, or before/after comparison. Requires Ghost OS.",
    {
      sessionId: z.string(),
      action: z.enum(["screenshot", "inspect", "annotate", "compare"]).describe("screenshot=capture screen, inspect=find elements, annotate=labeled screenshot, compare=before/after"),
      query: z.string().optional().describe("Element to find or inspect"),
      app: z.string().optional().describe("Target app (default: frontmost)"),
    },
    async ({ sessionId, action, query, app }) => {
      logActivity({ tool: "debug_visual", ts: Date.now(), summary: action });
      if (!isGhostConnected()) {
        const diag = getVisualDiagnostic();
        if (diag.permissionDenied) {
          return text({
            error: "Ghost OS is connected but Screen Recording permission is not granted.",
            fix: "Run debug_setup action='fix-permissions' to open System Settings and grant access.",
            nextStep: "After granting permission, run debug_setup action='connect' to reconnect.",
          });
        }
        return text({
          error: "Ghost OS is not connected.",
          setup: "Use debug_setup action='install' integration='ghost-os'",
          hint: "Ghost OS provides visual debugging — screenshots, DOM capture, element inspection.",
        });
      }

      let session;
      try { session = loadSession(cwd, sessionId); } catch { session = null; }

      switch (action) {
        case "screenshot": {
          const shot = await takeScreenshot(app);
          if (!shot) {
            const diag = getVisualDiagnostic();
            if (diag.permissionDenied) {
              return text({
                error: "Screenshot failed — Screen Recording permission not granted.",
                fix: "Run debug_setup action='fix-permissions' to open System Settings and grant access.",
                nextStep: "After granting permission, run debug_setup action='connect' to reconnect.",
              });
            }
            return text({ error: "Screenshot failed.", lastError: diag.lastError });
          }
          const path = saveScreenshot(cwd, sessionId, "manual", shot.image);
          if (session) {
            if (!session.visualContext) session.visualContext = { screenshots: [], domSnapshot: null };
            session.visualContext.screenshots.push({
              id: `ss_${Date.now()}`, timestamp: new Date().toISOString(),
              tool: "ghost_screenshot", reference: path,
            });
            saveSession(cwd, session);
          }
          return text({ screenshot: path, message: "Screenshot saved." });
        }
        case "inspect": {
          const elements = await findElements(query ?? "", undefined, app);
          return text({ elements, count: elements.length });
        }
        case "annotate": {
          const annotated = await annotateScreen(app);
          if (!annotated) {
            const diag = getVisualDiagnostic();
            if (diag.permissionDenied) {
              return text({
                error: "Annotation failed — Screen Recording permission not granted.",
                fix: "Run debug_setup action='fix-permissions' to open System Settings and grant access.",
              });
            }
            return text({ error: "Annotation failed.", lastError: diag.lastError });
          }
          const path = saveScreenshot(cwd, sessionId, "annotated", annotated.image);
          return text({ screenshot: path, labels: annotated.labels });
        }
        case "compare": {
          if (!session?.visualContext?.screenshots.length) {
            return text({ error: "No previous screenshot to compare against. Take a screenshot first." });
          }
          const afterShot = await takeScreenshot(app);
          if (!afterShot) return text({ error: "Screenshot failed." });
          const afterPath = saveScreenshot(cwd, sessionId, "compare", afterShot.image);
          return text({
            before: session.visualContext.screenshots[0].reference,
            after: afterPath,
            message: "Before/after screenshots captured.",
          });
        }
      }
      return text({ error: "Unknown action." });
    },
  );

  // ━━━ TOOL 9: debug_session ━━━
  server.registerTool("debug_session", {
    title: "Session Status",
    description: `Get current session state: hypotheses, active instruments, recent captures.
Lightweight — returns a summary, not the full capture history.`,
    inputSchema: {
      sessionId: z.string(),
    },
  }, async ({ sessionId }) => {
    const session = loadSession(cwd, sessionId);
    const recent = getRecentCaptures(session, { limit: 10 });

    logActivity({ tool: "debug_session", ts: Date.now(), summary: `status: ${session.status}`, metrics: { hypotheses: session.hypotheses.length, captures: session.captures.length } });
    return text({
      id: session.id,
      status: session.status,
      problem: session.problem,
      hypotheses: session.hypotheses.map((h) => ({
        id: h.id, text: h.text, status: h.status, evidenceCount: h.evidence.length,
      })),
      instruments: session.instrumentation.filter((i) => i.active).map((i) => ({
        tag: i.markerTag, file: basename(i.filePath), line: i.lineNumber, hypothesis: i.hypothesisId,
      })),
      recentCaptures: recent.showing > 0
        ? { count: recent.total, recent: recent.captures.slice(0, 5).map((c) => ({ source: c.source, tag: c.markerTag, data: c.data })) }
        : null,
      diagnosis: session.diagnosis,
    });
  });

  return server;
}

export async function startMcpServer(): Promise<void> {
  envCaps = detectEnvironment(cwd);
  loadVisualConfig(cwd);
  enableActivityWriter(cwd);

  // Attempt Ghost OS connection (lazy — won't block if unavailable)
  if (envCaps?.visual.ghostOsConfigured) {
    connectToGhostOs().catch(() => {}); // Fire and forget
  }

  // Clean shutdown
  process.on("SIGINT", async () => { await disconnectGhostOs(); process.exit(0); });
  process.on("SIGTERM", async () => { await disconnectGhostOs(); process.exit(0); });

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  maybeArchive(cwd);
}
