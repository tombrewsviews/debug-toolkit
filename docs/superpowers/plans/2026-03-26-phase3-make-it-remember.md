# Phase 3: "Make It Remember" — Memory Overhaul

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the memory system smarter — confidence scoring ranks memories by reliability, exportable knowledge packs enable cross-project sharing, proactive memory surfaces high-confidence fixes before full investigation, and decay/archival prevents stale memories from polluting results.

**Architecture:** Extend `MemoryEntry` with confidence metadata. Add a confidence scoring function that weighs age, file drift, and usage. Create a `packs.ts` module for export/import CLI. Modify `debug_investigate` to surface proactive suggestions for high-confidence matches. Add archival to the persistence layer.

**Tech Stack:** TypeScript, existing memory system, Node.js fs for pack I/O.

**Spec:** `docs/superpowers/specs/2026-03-26-roadmap-v06-v08-design.md` (Phase 3 sections 3.1–3.4)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/confidence.ts` | Create | Confidence scoring — age decay, file drift, usage tracking |
| `src/packs.ts` | Create | Export/import knowledge packs |
| `src/memory.ts` | Modify | Add confidence to recall ranking, archival support |
| `src/mcp.ts` | Modify | Proactive memory in investigate, confidence in recall |
| `src/index.ts` | Modify | Add export/import CLI commands |
| `tests/confidence.test.ts` | Create | Tests for confidence scoring |
| `tests/packs.test.ts` | Create | Tests for export/import |

---

### Task 1: Create Confidence Scoring Module

**Files:**
- Create: `src/confidence.ts`
- Create: `tests/confidence.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/confidence.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeConfidence, type ConfidenceFactors } from "../src/confidence.js";

describe("Confidence scoring", () => {
  it("should return high confidence for recent entry with no drift", () => {
    const score = computeConfidence({
      ageInDays: 1,
      fileDriftCommits: 0,
      timesRecalled: 3,
      timesUsed: 2,
    });
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

  it("should return 0 for very old entries with high drift", () => {
    const score = computeConfidence({ ageInDays: 120, fileDriftCommits: 50, timesRecalled: 0, timesUsed: 0 });
    expect(score).toBeLessThan(0.2);
  });

  it("should clamp between 0 and 1", () => {
    const score = computeConfidence({ ageInDays: 0, fileDriftCommits: 0, timesRecalled: 100, timesUsed: 100 });
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0.0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/confidence.test.ts`

- [ ] **Step 3: Implement confidence.ts**

Create `src/confidence.ts`:

```typescript
/**
 * confidence.ts — Memory confidence scoring.
 *
 * Composite score (0.0–1.0) based on:
 *   - Age factor (0.3 weight): linear decay over 90 days
 *   - File drift factor (0.4 weight): git changes since fix
 *   - Usage factor (0.3 weight): was this fix actually used when recalled?
 */

export interface ConfidenceFactors {
  ageInDays: number;
  fileDriftCommits: number;
  timesRecalled: number;
  timesUsed: number;
}

const AGE_WEIGHT = 0.3;
const DRIFT_WEIGHT = 0.4;
const USAGE_WEIGHT = 0.3;

const AGE_HALF_LIFE_DAYS = 90;
const DRIFT_HALF_LIFE_COMMITS = 15;

/**
 * Compute confidence score for a memory entry.
 * Returns 0.0–1.0 where higher = more reliable.
 */
export function computeConfidence(factors: ConfidenceFactors): number {
  // Age: exponential decay with 90-day half-life
  const ageFactor = Math.exp(-0.693 * factors.ageInDays / AGE_HALF_LIFE_DAYS);

  // Drift: exponential decay with 15-commit half-life
  const driftFactor = Math.exp(-0.693 * factors.fileDriftCommits / DRIFT_HALF_LIFE_COMMITS);

  // Usage: sigmoid-like boost based on recall-to-use ratio
  let usageFactor = 0.5; // neutral baseline
  if (factors.timesRecalled > 0) {
    const useRate = factors.timesUsed / factors.timesRecalled;
    usageFactor = 0.3 + 0.7 * useRate; // 0.3 to 1.0
  }

  const raw = AGE_WEIGHT * ageFactor + DRIFT_WEIGHT * driftFactor + USAGE_WEIGHT * usageFactor;
  return Math.max(0, Math.min(1, raw));
}

/** Threshold below which memories are demoted from auto-recall */
export const CONFIDENCE_THRESHOLD = 0.3;

/** Threshold below which memories should be archived */
export const ARCHIVE_THRESHOLD = 0.2;

/** Threshold above which memories trigger proactive suggestions */
export const PROACTIVE_THRESHOLD = 0.8;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/confidence.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/confidence.ts tests/confidence.test.ts
git commit -m "feat: add confidence scoring for memory entries"
```

---

### Task 2: Extend Memory Entry with Confidence Metadata

**Files:**
- Modify: `src/memory.ts`

- [ ] **Step 1: Add confidence fields to MemoryEntry**

In `src/memory.ts`, extend the `MemoryEntry` interface (around line 19-32) with:

```typescript
  // Confidence metadata (Phase 3)
  timesRecalled: number;
  timesUsed: number;
  archived: boolean;
```

- [ ] **Step 2: Update remember() to initialize new fields**

In the `remember()` function (around line 290), when building the full entry, add defaults:

```typescript
    timesRecalled: 0,
    timesUsed: 0,
    archived: false,
```

- [ ] **Step 3: Update loadStore() migration**

In `loadStore()` (around line 234), add migration for entries missing the new fields:

```typescript
    // Migrate v2 entries to v3 (add confidence metadata)
    for (const e of store.entries) {
      if (e.timesRecalled === undefined) e.timesRecalled = 0;
      if (e.timesUsed === undefined) e.timesUsed = 0;
      if (e.archived === undefined) e.archived = false;
    }
```

- [ ] **Step 4: Update recall() with confidence scoring and usage tracking**

Import confidence module at the top of memory.ts:

```typescript
import { computeConfidence, CONFIDENCE_THRESHOLD } from "./confidence.js";
```

In `recall()`, after computing relevance, add confidence scoring. Replace the sort logic with:

```typescript
    // Compute confidence for each match
    const withConfidence = filtered.map((m) => {
      const ageInDays = (Date.now() - new Date(m.entry.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      const staleness = checkStaleness(cwd, m.entry);
      const confidence = computeConfidence({
        ageInDays,
        fileDriftCommits: staleness.commitsBehind,
        timesRecalled: m.entry.timesRecalled,
        timesUsed: m.entry.timesUsed,
      });

      // Track recall
      m.entry.timesRecalled++;

      return { ...m.entry, relevance: m.relevance, staleness, confidence };
    });

    // Filter out low-confidence entries from auto-recall
    const confident = withConfidence.filter((m) => m.confidence >= CONFIDENCE_THRESHOLD);

    // Sort: confidence * relevance (combined score)
    confident.sort((a, b) => (b.confidence * b.relevance) - (a.confidence * a.relevance));

    // Save updated recall counts
    saveStore(cwd, store);

    return confident.slice(0, limit);
```

- [ ] **Step 5: Build and test**

Run: `npm run build && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/memory.ts
git commit -m "feat: add confidence scoring to memory recall"
```

---

### Task 3: Create Knowledge Pack Export/Import

**Files:**
- Create: `src/packs.ts`
- Create: `tests/packs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/packs.test.ts`:

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { exportPack, importPack, type KnowledgePack } from "../src/packs.js";
import { remember } from "../src/memory.js";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Knowledge packs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dbt-pack-"));
  const tmp2 = mkdtempSync(join(tmpdir(), "dbt-pack2-"));

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tmp2, { recursive: true, force: true });
  });

  it("should export memory as a knowledge pack", () => {
    // Seed some memory
    remember(tmp, {
      id: "test_1", timestamp: new Date().toISOString(),
      problem: "CSS import ordering", errorType: "SyntaxError",
      category: "syntax", diagnosis: "Move @import to top of file",
      files: ["src/index.css"],
    });

    const outPath = join(tmp, "export.json");
    const result = exportPack(tmp, outPath);
    expect(result.entries).toBe(1);
    expect(existsSync(outPath)).toBe(true);

    const pack = JSON.parse(readFileSync(outPath, "utf-8")) as KnowledgePack;
    expect(pack.version).toBe("1.0");
    expect(pack.entries).toHaveLength(1);
    expect(pack.entries[0].diagnosis).toBe("Move @import to top of file");
  });

  it("should import a knowledge pack into a fresh project", () => {
    const packPath = join(tmp, "export.json");
    const result = importPack(tmp2, packPath);
    expect(result.imported).toBe(1);
    expect(result.total).toBe(1);
  });

  it("should tag imported entries as external", () => {
    const packPath = join(tmp, "export.json");
    importPack(tmp2, packPath);
    // Re-import should not duplicate
    const result2 = importPack(tmp2, packPath);
    expect(result2.total).toBe(1); // no duplicates
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/packs.test.ts`

- [ ] **Step 3: Implement packs.ts**

Create `src/packs.ts`:

```typescript
/**
 * packs.ts — Exportable knowledge packs.
 *
 * Export project debug knowledge as shareable JSON packs.
 * Import external packs into a project's memory.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface KnowledgePack {
  version: "1.0";
  name: string;
  description: string;
  exportedAt: string;
  entries: PackEntry[];
}

export interface PackEntry {
  errorType: string;
  category: string;
  problem: string;
  diagnosis: string;
  files: string[];
  rootCause: { trigger: string; errorFile: string; causeFile: string; fixDescription: string } | null;
}

interface MemoryStore {
  version: number;
  entries: Array<{
    id: string;
    timestamp: string;
    problem: string;
    errorType: string;
    category: string;
    diagnosis: string;
    files: string[];
    keywords: string[];
    gitSha: string | null;
    rootCause: { trigger: string; errorFile: string; causeFile: string; fixDescription: string } | null;
    timesRecalled?: number;
    timesUsed?: number;
    archived?: boolean;
    source?: "local" | "external";
  }>;
}

function memoryPath(cwd: string): string {
  return join(cwd, ".debug", "memory.json");
}

function loadStore(cwd: string): MemoryStore {
  const p = memoryPath(cwd);
  if (!existsSync(p)) return { version: 2, entries: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { version: 2, entries: [] };
  }
}

function saveStore(cwd: string, store: MemoryStore): void {
  const p = memoryPath(cwd);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp_${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  const { renameSync } = require("node:fs");
  renameSync(tmp, p);
}

/**
 * Export project memory as a knowledge pack.
 */
export function exportPack(
  cwd: string,
  outPath: string,
  options?: { name?: string; filter?: string },
): { path: string; entries: number } {
  const store = loadStore(cwd);

  let entries = store.entries;
  if (options?.filter) {
    const f = options.filter.toLowerCase();
    entries = entries.filter((e) =>
      e.category.toLowerCase().includes(f) ||
      e.errorType.toLowerCase().includes(f) ||
      e.files.some((file) => file.toLowerCase().includes(f)),
    );
  }

  const pack: KnowledgePack = {
    version: "1.0",
    name: options?.name ?? "debug-knowledge",
    description: `Debug knowledge exported from ${cwd}`,
    exportedAt: new Date().toISOString(),
    entries: entries.map((e) => ({
      errorType: e.errorType,
      category: e.category,
      problem: e.problem,
      diagnosis: e.diagnosis,
      files: e.files,
      rootCause: e.rootCause ?? null,
    })),
  };

  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(pack, null, 2));

  return { path: outPath, entries: pack.entries.length };
}

/**
 * Import a knowledge pack into project memory.
 * Imported entries are tagged as "external" with lower initial confidence.
 */
export function importPack(
  cwd: string,
  packPath: string,
): { imported: number; total: number } {
  const packContent = readFileSync(packPath, "utf-8");
  const pack = JSON.parse(packContent) as KnowledgePack;

  const store = loadStore(cwd);
  const existingIds = new Set(store.entries.map((e) => `${e.errorType}:${e.diagnosis}`));

  let imported = 0;
  for (const entry of pack.entries) {
    const key = `${entry.errorType}:${entry.diagnosis}`;
    if (existingIds.has(key)) continue; // skip duplicates

    store.entries.push({
      id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      problem: entry.problem,
      errorType: entry.errorType,
      category: entry.category,
      diagnosis: entry.diagnosis,
      files: entry.files,
      keywords: tokenize(`${entry.problem} ${entry.diagnosis} ${entry.files.join(" ")}`),
      gitSha: null,
      rootCause: entry.rootCause,
      timesRecalled: 0,
      timesUsed: 0,
      archived: false,
      source: "external",
    });
    existingIds.add(key);
    imported++;
  }

  saveStore(cwd, store);
  return { imported, total: store.entries.length };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_./\-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}
```

NOTE: The `saveStore` function uses `require("node:fs")` for `renameSync` to match the ESM pattern. Actually, this is an ESM project — fix this by importing `renameSync` at the top of the file instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/packs.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/packs.ts tests/packs.test.ts
git commit -m "feat: add knowledge pack export/import"
```

---

### Task 4: Add Proactive Memory to debug_investigate

**Files:**
- Modify: `src/mcp.ts` (debug_investigate handler)

- [ ] **Step 1: Update recall response handling**

In the `debug_investigate` handler, where past solutions are included in the response, add confidence scores. The recall() function now returns entries with a `confidence` field. Update the pastSolutions mapping to include it:

```typescript
      response.pastSolutions = pastSolutions.map((s) => ({
        problem: s.problem,
        diagnosis: s.diagnosis,
        files: s.files,
        relevance: Math.round(s.relevance * 100) + "%",
        confidence: Math.round((s as any).confidence * 100) + "%",
        stale: s.staleness.stale,
        staleness: s.staleness.stale ? s.staleness.reason : undefined,
        rootCause: s.rootCause ?? undefined,
      }));
```

- [ ] **Step 2: Add proactive memory suggestion for high-confidence matches**

After the pastSolutions mapping, add:

```typescript
    // Proactive memory: surface high-confidence matches prominently
    const highConfidence = pastSolutions.filter((s) => ((s as any).confidence ?? 0) >= 0.8);
    if (highConfidence.length > 0) {
      const top = highConfidence[0];
      response.proactiveSuggestion = {
        confidence: Math.round(((top as any).confidence ?? 0) * 100) + "%",
        diagnosis: top.diagnosis,
        files: top.files,
        rootCause: top.rootCause ?? undefined,
        message: `High-confidence match (${Math.round(((top as any).confidence ?? 0) * 100)}%): "${top.diagnosis}". This fix was verified before — try applying it directly.`,
      };
      response.nextStep = `Proactive suggestion: ${top.diagnosis}. Verify with debug_verify after applying.`;
    }
```

- [ ] **Step 3: Build and test**

Run: `npm run build && npm test`

- [ ] **Step 4: Commit**

```bash
git add src/mcp.ts
git commit -m "feat: add proactive memory suggestions for high-confidence matches"
```

---

### Task 5: Add Export/Import CLI Commands

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports**

Add to imports in `src/index.ts`:

```typescript
import { exportPack, importPack } from "./packs.js";
```

- [ ] **Step 2: Extend command parsing**

In the `parseArgs` function or command routing, add "export" and "import" to the list of recognized commands.

- [ ] **Step 3: Add export command handler**

Add a case for "export" in the main command switch:

```typescript
    case "export": {
      const outPath = args[0] ?? join(cwd, ".debug", "knowledge-pack.json");
      const filter = args.find((a) => a.startsWith("--filter="))?.split("=")[1];
      const result = exportPack(cwd, outPath, { filter });
      console.log(`Exported ${result.entries} entries to ${result.path}`);
      break;
    }
```

- [ ] **Step 4: Add import command handler**

```typescript
    case "import": {
      const packPath = args[0];
      if (!packPath) {
        console.error("Usage: debug-toolkit import <pack-file>");
        process.exit(1);
      }
      const result = importPack(cwd, packPath);
      console.log(`Imported ${result.imported} new entries (${result.total} total)`);
      break;
    }
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: add export/import CLI commands for knowledge packs"
```

---

### Task 6: Add Memory Archival

**Files:**
- Modify: `src/memory.ts`

- [ ] **Step 1: Add archival logic to recall**

In `recall()`, filter out archived entries from results:

```typescript
    // Filter out archived entries
    entries = entries.filter((e) => !e.archived);
```

Add this before the scoring loop.

- [ ] **Step 2: Add archiveStaleMemories function**

Add a new exported function:

```typescript
/**
 * Archive memories with confidence below threshold.
 * Archived memories are excluded from auto-recall but still searchable with --include-archived.
 */
export function archiveStaleMemories(cwd: string): { archived: number } {
  const store = loadStore(cwd);
  let archived = 0;

  for (const entry of store.entries) {
    if (entry.archived) continue;
    const ageInDays = (Date.now() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60 * 24);
    if (ageInDays < 30) continue; // Don't archive recent entries

    const staleness = checkStaleness(cwd, entry);
    const confidence = computeConfidence({
      ageInDays,
      fileDriftCommits: staleness.commitsBehind,
      timesRecalled: entry.timesRecalled ?? 0,
      timesUsed: entry.timesUsed ?? 0,
    });

    if (confidence < ARCHIVE_THRESHOLD) {
      entry.archived = true;
      archived++;
    }
  }

  if (archived > 0) saveStore(cwd, store);
  return { archived };
}
```

Import the thresholds at the top:

```typescript
import { computeConfidence, CONFIDENCE_THRESHOLD, ARCHIVE_THRESHOLD } from "./confidence.js";
```

- [ ] **Step 3: Build and test**

Run: `npm run build && npm test`

- [ ] **Step 4: Commit**

```bash
git add src/memory.ts
git commit -m "feat: add memory archival for low-confidence entries"
```

---

### Task 7: Version Bump + Docs + Final Verification

**Files:**
- Modify: `src/mcp.ts`, `package.json`, `SKILL.md`, `README.md`

- [ ] **Step 1: Bump version to 0.8.0**

Update `src/mcp.ts` server version and `package.json` to `"0.8.0"`.

- [ ] **Step 2: Update SKILL.md**

Add documentation for:
- Confidence scoring in recall results
- Proactive memory suggestions
- Knowledge pack export/import
- Memory archival

- [ ] **Step 3: Update README.md**

Add "What's New in v0.8" section.

- [ ] **Step 4: Run full test suite + build**

Run: `npm test && npm run build`

- [ ] **Step 5: Commit and rebuild dist**

```bash
git add src/mcp.ts package.json SKILL.md README.md
git commit -m "chore: Phase 3 complete — v0.8.0 with confidence scoring, knowledge packs, proactive memory"
npm run build && git add dist/ && git commit -m "chore: rebuild dist for v0.8.0"
```
