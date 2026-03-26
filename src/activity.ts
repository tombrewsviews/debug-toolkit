/**
 * Live Activity Feed — shows MCP tool activity in the serve terminal.
 *
 * MCP and serve run in separate processes. They communicate via
 * `.debug/activity.jsonl` — MCP appends events, serve tails and renders.
 */

import { appendFileSync, mkdirSync, statSync, openSync, readSync, closeSync, writeFileSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { c, sym } from "./cli.js";

// ━━━ Event interface ━━━

export interface ActivityEvent {
  tool: string;
  ts: number;
  summary: string;
  metrics?: Record<string, string | number | undefined>;
}

// ━━━ Writer (MCP side) ━━━

let writerPath: string | null = null;

export function enableActivityWriter(cwd: string): void {
  const dir = join(cwd, ".debug");
  mkdirSync(dir, { recursive: true });
  writerPath = join(dir, "activity.jsonl");
}

export function logActivity(event: ActivityEvent): void {
  if (!writerPath) return;
  try {
    // Strip undefined metrics values before serializing
    if (event.metrics) {
      const clean: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(event.metrics)) {
        if (v !== undefined) clean[k] = v;
      }
      event.metrics = Object.keys(clean).length > 0 ? clean : undefined;
    }
    appendFileSync(writerPath, JSON.stringify(event) + "\n");
  } catch { /* non-fatal — don't break MCP for logging */ }
}

// ━━━ Reader (serve side) ━━━

const TOOL_ICONS: Record<string, string> = {
  debug_investigate: "⚡",
  debug_recall:      "💡",
  debug_instrument:  "🔧",
  debug_capture:     "📡",
  debug_verify:      "✓ ",
  debug_cleanup:     "🧹",
  debug_session:     "📋",
  debug_perf:        "⏱ ",
  debug_setup:       "⚙ ",
  debug_visual:      "👁 ",
  debug_patterns:    "📊",
};

function renderActivity(event: ActivityEvent): void {
  const icon = TOOL_ICONS[event.tool] ?? sym.dot;
  const name = event.tool.replace("debug_", "");

  const metricParts: string[] = [];
  if (event.metrics) {
    for (const [k, v] of Object.entries(event.metrics)) {
      if (v !== undefined) metricParts.push(`${k}: ${v}`);
    }
  }
  const detail = metricParts.length > 0 ? ` ${c.dim}(${metricParts.join(", ")})${c.reset}` : "";

  process.stderr.write(
    `  ${icon} ${c.bold}${name}${c.reset} ${c.dim}— ${event.summary}${c.reset}${detail}\n`
  );

  // Session summary on verify-pass or cleanup
  if (
    (event.tool === "debug_verify" && event.summary === "PASSED") ||
    event.tool === "debug_cleanup"
  ) {
    renderSessionSummary(event);
  }
}

function renderSessionSummary(event: ActivityEvent): void {
  const m = event.metrics ?? {};
  const line = c.dim + sym.dash.repeat(45) + c.reset;
  const parts: string[] = [];

  if (m.duration) parts.push(`Duration: ${m.duration}`);
  if (m.outcome) parts.push(`Outcome: ${m.outcome}`);
  if (m.savedToMemory === "yes") parts.push("Memory: saved");
  if (m.captures) parts.push(`Captures: ${m.captures}`);
  if (m.hypotheses) parts.push(`Hypotheses: ${m.hypotheses}`);
  if (m.memoryEntries) parts.push(`Memory entries: ${m.memoryEntries}`);

  if (parts.length === 0) return;

  process.stderr.write(`\n  ${line}\n`);
  process.stderr.write(`  ${c.bold}SESSION${c.reset}\n`);
  for (const part of parts) {
    process.stderr.write(`  ${c.dim}${part}${c.reset}\n`);
  }
  process.stderr.write(`  ${line}\n\n`);
}

export function startActivityFeed(cwd: string): { stop: () => void } {
  const filePath = join(cwd, ".debug", "activity.jsonl");
  mkdirSync(dirname(filePath), { recursive: true });

  // Truncate — only current serve session matters
  writeFileSync(filePath, "");
  let offset = 0;

  const watcher = watch(filePath, () => {
    let size: number;
    try { size = statSync(filePath).size; } catch { return; }
    if (size <= offset) { offset = 0; return; } // truncated externally

    let fd: number;
    try { fd = openSync(filePath, "r"); } catch { return; }
    const buf = Buffer.alloc(size - offset);
    try {
      readSync(fd, buf, 0, buf.length, offset);
    } finally {
      closeSync(fd);
    }
    offset = size;

    for (const line of buf.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        renderActivity(JSON.parse(line) as ActivityEvent);
      } catch { /* skip malformed */ }
    }
  });

  return { stop: () => watcher.close() };
}
