/**
 * memory.ts — Debug session memory across conversations.
 *
 * Three tiers of intelligence:
 *   1. Recall — search past diagnoses for similar errors (keyword overlap)
 *   2. Staleness — flag outdated diagnoses when code has changed since
 *   3. Patterns — detect recurring errors, hot files, regression trends
 *
 * Implementation: JSON file + in-memory inverted index.
 * Zero native dependencies. Fast enough for hundreds of sessions.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

// ━━━ Types ━━━

export interface MemoryEntry {
  id: string;
  timestamp: string;
  problem: string;
  errorType: string;
  category: string;
  diagnosis: string;
  files: string[];
  keywords: string[];
  // Temporal: track when this diagnosis was valid
  gitSha: string | null;
  // Causal chain: what caused the error and what fixed it
  rootCause: CausalLink | null;
}

export interface CausalLink {
  trigger: string;        // What caused the error (e.g., "missing null check in db.getUsers()")
  errorFile: string;      // Where the error manifested
  causeFile: string;      // Where the actual bug was (may differ from errorFile)
  fixDescription: string; // One-line description of the fix
}

interface MemoryStore {
  version: number;
  entries: MemoryEntry[];
}

// ━━━ Git helpers ━━━

function getGitSha(cwd: string): string | null {
  try {
    return execSync("git rev-parse --short HEAD 2>/dev/null", { cwd, timeout: 3000 })
      .toString().trim() || null;
  } catch { return null; }
}

/**
 * Check how many commits have touched a file since a given SHA.
 * Returns null if git isn't available, 0 if unchanged, N if changed.
 */
function commitsSince(cwd: string, sha: string, file: string): number | null {
  try {
    const count = execSync(
      `git rev-list --count ${sha}..HEAD -- "${file}" 2>/dev/null`,
      { cwd, timeout: 3000 },
    ).toString().trim();
    return parseInt(count, 10);
  } catch { return null; }
}

/**
 * Check staleness of a memory entry — have the referenced files changed?
 */
export interface StalenessInfo {
  stale: boolean;
  reason: string | null;
  commitsBehind: number;
  filesChanged: string[];
}

function checkStaleness(cwd: string, entry: MemoryEntry): StalenessInfo {
  if (!entry.gitSha) return { stale: false, reason: null, commitsBehind: 0, filesChanged: [] };

  let totalCommits = 0;
  const changed: string[] = [];

  for (const f of entry.files) {
    // Resolve relative to cwd
    const fullPath = resolve(cwd, f);
    if (!existsSync(fullPath)) {
      changed.push(f);
      totalCommits += 1; // file deleted = definitely stale
      continue;
    }
    const n = commitsSince(cwd, entry.gitSha, f);
    if (n !== null && n > 0) {
      changed.push(f);
      totalCommits += n;
    }
  }

  // Also check causeFile if it's different from the error files
  if (entry.rootCause?.causeFile && !entry.files.includes(entry.rootCause.causeFile)) {
    const n = commitsSince(cwd, entry.gitSha, entry.rootCause.causeFile);
    if (n !== null && n > 0) {
      changed.push(entry.rootCause.causeFile);
      totalCommits += n;
    }
  }

  if (changed.length === 0) return { stale: false, reason: null, commitsBehind: 0, filesChanged: [] };

  return {
    stale: true,
    reason: `${changed.length} file(s) changed in ${totalCommits} commit(s) since this diagnosis`,
    commitsBehind: totalCommits,
    filesChanged: changed,
  };
}

// ━━━ Pattern Detection ━━━

export interface PatternInsight {
  type: "recurring_error" | "hot_file" | "regression" | "error_cluster";
  severity: "info" | "warning" | "critical";
  message: string;
  data: Record<string, unknown>;
}

/**
 * Detect patterns across all stored debug sessions.
 * Cheap — just scans the JSON array, no external calls.
 */
export function detectPatterns(cwd: string): PatternInsight[] {
  const store = loadStore(cwd);
  if (store.entries.length < 2) return [];
  const insights: PatternInsight[] = [];

  // 1. Recurring errors — same errorType in the same file
  const errorFileMap = new Map<string, MemoryEntry[]>();
  for (const e of store.entries) {
    for (const f of e.files) {
      const key = `${e.errorType}:${f}`;
      const arr = errorFileMap.get(key);
      if (arr) arr.push(e); else errorFileMap.set(key, [e]);
    }
  }
  for (const [key, entries] of errorFileMap) {
    if (entries.length >= 3) {
      const [errType, file] = key.split(":", 2);
      insights.push({
        type: "recurring_error",
        severity: entries.length >= 5 ? "critical" : "warning",
        message: `${errType} has occurred ${entries.length} times in ${file}`,
        data: { errorType: errType, file, count: entries.length, dates: entries.map((e) => e.timestamp) },
      });
    }
  }

  // 2. Hot files — files that appear in many debug sessions
  const fileCount = new Map<string, number>();
  for (const e of store.entries) {
    for (const f of e.files) {
      fileCount.set(f, (fileCount.get(f) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(store.entries.length * 0.15));
  for (const [file, count] of fileCount) {
    if (count >= threshold) {
      insights.push({
        type: "hot_file",
        severity: count >= threshold * 2 ? "critical" : "warning",
        message: `${file} appears in ${count}/${store.entries.length} debug sessions (${Math.round(count / store.entries.length * 100)}%)`,
        data: { file, sessions: count, total: store.entries.length },
      });
    }
  }

  // 3. Regressions — same problem diagnosed more than once (diagnosis keywords overlap)
  for (let i = store.entries.length - 1; i >= 1; i--) {
    const current = store.entries[i];
    for (let j = i - 1; j >= Math.max(0, i - 20); j--) { // only check recent 20
      const past = store.entries[j];
      if (current.id === past.id) continue;
      // Check if same files AND same errorType — likely a regression
      const sharedFiles = current.files.filter((f) => past.files.includes(f));
      if (sharedFiles.length > 0 && current.errorType === past.errorType) {
        insights.push({
          type: "regression",
          severity: "warning",
          message: `Possible regression: ${current.errorType} in ${sharedFiles[0]} was fixed before (${past.timestamp.slice(0, 10)}) but reappeared`,
          data: {
            currentId: current.id, pastId: past.id,
            file: sharedFiles[0], errorType: current.errorType,
            pastDiagnosis: past.diagnosis, currentProblem: current.problem,
          },
        });
        break; // Only report the most recent regression per entry
      }
    }
  }

  // 4. Error clusters — multiple different errors happening in a short time window
  const sorted = [...store.entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (let i = 0; i < sorted.length - 2; i++) {
    const window = sorted.slice(i, i + 3);
    const t0 = new Date(window[0].timestamp).getTime();
    const t2 = new Date(window[2].timestamp).getTime();
    const hoursDiff = (t2 - t0) / (1000 * 60 * 60);
    if (hoursDiff < 2 && hoursDiff > 0) {
      const uniqueErrors = new Set(window.map((e) => e.errorType));
      if (uniqueErrors.size >= 2) {
        insights.push({
          type: "error_cluster",
          severity: "info",
          message: `${window.length} errors in ${Math.round(hoursDiff * 60)} minutes — possible cascading failure`,
          data: {
            errors: window.map((e) => ({ type: e.errorType, file: e.files[0], time: e.timestamp })),
            timeWindowMinutes: Math.round(hoursDiff * 60),
          },
        });
        i += 2; // Skip past this cluster
      }
    }
  }

  return insights;
}

// ━━━ Paths & Persistence ━━━

function memoryPath(cwd: string): string {
  return join(cwd, ".debug", "memory.json");
}

function loadStore(cwd: string): MemoryStore {
  const p = memoryPath(cwd);
  if (!existsSync(p)) return { version: 2, entries: [] };
  try {
    const store = JSON.parse(readFileSync(p, "utf-8")) as MemoryStore;
    // Migrate v1 entries (no gitSha/rootCause)
    for (const e of store.entries) {
      if (e.gitSha === undefined) (e as MemoryEntry).gitSha = null;
      if (e.rootCause === undefined) (e as MemoryEntry).rootCause = null;
    }
    store.version = 2;
    return store;
  } catch {
    return { version: 2, entries: [] };
  }
}

function saveStore(cwd: string, store: MemoryStore): void {
  const p = memoryPath(cwd);
  const tmp = `${p}.tmp_${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, p);
}

// ━━━ Tokenizer ━━━

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_./\-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

// ━━━ Public API ━━━

/**
 * Save a completed debug session to memory.
 * Auto-captures the current git SHA for staleness tracking.
 */
export function remember(
  cwd: string,
  entry: Omit<MemoryEntry, "keywords" | "gitSha" | "rootCause"> & {
    rootCause?: CausalLink | null;
  },
): MemoryEntry {
  const store = loadStore(cwd);

  const allText = [
    entry.problem, entry.errorType, entry.category, entry.diagnosis,
    ...entry.files,
    entry.rootCause?.trigger ?? "",
    entry.rootCause?.fixDescription ?? "",
  ].join(" ");
  const keywords = [...new Set(tokenize(allText))];

  const full: MemoryEntry = {
    ...entry,
    keywords,
    gitSha: getGitSha(cwd),
    rootCause: entry.rootCause ?? null,
  };

  store.entries = store.entries.filter((e) => e.id !== full.id);
  store.entries.push(full);

  if (store.entries.length > 200) {
    store.entries = store.entries.slice(-200);
  }

  saveStore(cwd, store);
  return full;
}

/**
 * Search past debug sessions for similar errors.
 * Returns matches ranked by relevance, with staleness info and causal chains.
 */
export function recall(
  cwd: string,
  query: string,
  limit = 5,
): Array<MemoryEntry & { relevance: number; staleness: StalenessInfo }> {
  const store = loadStore(cwd);
  if (store.entries.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scored = store.entries.map((entry) => {
    let hits = 0;
    for (const qt of queryTokens) {
      for (const ek of entry.keywords) {
        if (ek.includes(qt) || qt.includes(ek)) {
          hits++;
          break;
        }
      }
    }
    return {
      ...entry,
      relevance: hits / queryTokens.length,
      staleness: checkStaleness(cwd, entry),
    };
  });

  return scored
    .filter((e) => e.relevance > 0.2)
    .sort((a, b) => {
      // Prefer fresh over stale, then by relevance
      if (a.staleness.stale !== b.staleness.stale) return a.staleness.stale ? 1 : -1;
      return b.relevance - a.relevance;
    })
    .slice(0, limit);
}

/**
 * Get memory stats.
 */
export function memoryStats(cwd: string): {
  entries: number;
  oldestDate: string | null;
  newestDate: string | null;
  patterns: PatternInsight[];
} {
  const store = loadStore(cwd);
  if (store.entries.length === 0) {
    return { entries: 0, oldestDate: null, newestDate: null, patterns: [] };
  }
  return {
    entries: store.entries.length,
    oldestDate: store.entries[0].timestamp,
    newestDate: store.entries[store.entries.length - 1].timestamp,
    patterns: detectPatterns(cwd),
  };
}
