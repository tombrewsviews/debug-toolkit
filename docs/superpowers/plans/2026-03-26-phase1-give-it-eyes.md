# Phase 1: "Give It Eyes" — Visual + Build Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make debug-toolkit see visual state (screenshots, DOM) and build errors (Vite/tsc/PostCSS) — closing the biggest gap identified in the v0.5.2 roast.

**Architecture:** Add an adapter layer that probes for Ghost OS / Claude Preview MCP tools at investigation time. Extend the capture system to parse structured build errors from dev server output. Add a new `debug_perf` tool wrapping Lighthouse CLI. All visual features gracefully degrade when no visual tools are available.

**Tech Stack:** TypeScript, MCP SDK, Node.js child_process (Lighthouse), existing RingBuffer + session model.

**Spec:** `docs/superpowers/specs/2026-03-26-roadmap-v06-v08-design.md` (Phase 1 sections 1.1–1.6)

**Architectural Decision — Visual Tool Integration:** The spec envisions the toolkit auto-calling Ghost OS / Claude Preview tools for screenshots and DOM capture. However, MCP servers cannot call other MCP servers — they can only respond to agent tool calls. Therefore, this plan implements visual integration as an **advisory system**: the toolkit detects visual bugs, tells the agent which visual tools to use, and provides structured fields (`visualHint`) in its responses. The agent (Claude) then orchestrates the visual tool calls. This achieves the same user-facing outcome while respecting MCP architecture constraints.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/adapters.ts` | Create | MCP tool discovery — detects Ghost OS / Claude Preview availability |
| `src/perf.ts` | Create | Lighthouse CLI runner — captures LCP, CLS, INP metrics |
| `src/session.ts` | Modify | Extend Capture source types + DebugSession with `visualContext` and `perfSnapshots` fields |
| `src/capture.ts` | Modify | Add `buildBuffer` ring buffer + build error parsers for Vite/tsc/PostCSS |
| `src/context.ts` | Modify | Add `isVisualError()` classifier + `captureVisualContext()` function |
| `src/mcp.ts` | Modify | Wire adapters into investigate/verify, register `debug_perf` tool |
| `tests/adapters.test.ts` | Create | Tests for adapter discovery |
| `tests/capture-build.test.ts` | Create | Tests for build error parsing |
| `tests/perf.test.ts` | Create | Tests for Lighthouse metric extraction |
| `tests/context-visual.test.ts` | Create | Tests for visual error classification |
| `package.json` | Modify | Add vitest dev dependency |

---

### Task 1: Set Up Test Infrastructure

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

The project has zero tests. Before adding features, set up vitest.

- [ ] **Step 1: Install vitest**

```bash
cd /Users/parandykt/Apps/AgenticDebugging/debug-toolkit
npm install -D vitest
```

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
  },
});
```

- [ ] **Step 3: Add test script to package.json**

Add to `scripts` in `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Create tests directory**

```bash
mkdir -p tests
```

- [ ] **Step 5: Verify vitest runs (no tests yet)**

Run: `npm test`
Expected: "No test files found" or similar — confirms vitest is working.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest test infrastructure"
```

---

### Task 2: Extend Session Model with Visual + Perf Fields

**Files:**
- Modify: `src/session.ts:26-54` (Capture type + DebugSession interface)
- Create: `tests/session-visual.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/session-visual.test.ts`:

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { createSession, saveSession, loadSession } from "../src/session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Session visual context", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dbt-test-"));

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("should persist visualContext on session", () => {
    const session = createSession(tmp, "visual bug");
    session.visualContext = {
      screenshots: [{ id: "ss_1", timestamp: new Date().toISOString(), tool: "ghost_screenshot", reference: "/tmp/ss.png" }],
      domSnapshot: null,
    };
    session.perfSnapshots = [];
    saveSession(tmp, session);

    const loaded = loadSession(tmp, session.id);
    expect(loaded.visualContext).toBeDefined();
    expect(loaded.visualContext!.screenshots).toHaveLength(1);
    expect(loaded.visualContext!.screenshots[0].tool).toBe("ghost_screenshot");
    expect(loaded.perfSnapshots).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/session-visual.test.ts`
Expected: FAIL — `visualContext` doesn't exist on DebugSession yet.

- [ ] **Step 3: Add types and fields to session.ts**

First, extend the `Capture` source type (line 29) to include new source types:

```typescript
  source: "terminal" | "browser-console" | "browser-network" | "browser-error" | "environment" | "tauri-log" | "build-error" | "visual" | "perf";
```

Then add these interfaces BEFORE the `DebugSession` interface (after the `Capture` interface, before `FileSnapshot`):

```typescript
export interface ScreenshotRecord {
  id: string;
  timestamp: string;
  tool: "ghost_screenshot" | "preview_screenshot" | "none";
  reference: string; // file path or base64 data URI
}

export interface DomSnapshot {
  timestamp: string;
  tool: "ghost_read" | "preview_snapshot";
  elements: Array<{ role: string; name: string; visible: boolean }>;
}

export interface VisualContext {
  screenshots: ScreenshotRecord[];
  domSnapshot: DomSnapshot | null;
}

export interface PerfSnapshot {
  id: string;
  timestamp: string;
  url: string;
  metrics: {
    lcp: number | null;      // Largest Contentful Paint (ms)
    cls: number | null;      // Cumulative Layout Shift
    inp: number | null;      // Interaction to Next Paint (ms)
    tbt: number | null;      // Total Blocking Time (ms)
    speedIndex: number | null;
  };
  phase: "before" | "after";
}
```

Then extend the `DebugSession` interface — add before `_markerIndex`:

```typescript
  visualContext: VisualContext | null;
  perfSnapshots: PerfSnapshot[];
```

Update `createSession()` to initialize the new fields:

```typescript
    visualContext: null,
    perfSnapshots: [],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/session-visual.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session.ts tests/session-visual.test.ts
git commit -m "feat: extend session model with visual context and perf snapshots"
```

---

### Task 3: Add Build Error Parsers to Capture System

**Files:**
- Modify: `src/capture.ts` (add build error buffer + parsers)
- Create: `tests/capture-build.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/capture-build.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseBuildError, type BuildError } from "../src/capture.js";

describe("Build error parsers", () => {
  it("should parse Vite/PostCSS error", () => {
    const output = `[vite:css][postcss] @import must precede all other statements (besides @charset or empty @layer)
1048|  @import url('https://fonts.googleapis.com/css2?family=Inter');
    |  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^`;
    const err = parseBuildError(output);
    expect(err).not.toBeNull();
    expect(err!.tool).toBe("vite");
    expect(err!.message).toContain("@import must precede");
  });

  it("should parse TypeScript compiler error", () => {
    const output = `src/App.tsx(15,3): error TS2322: Type 'string' is not assignable to type 'number'.`;
    const err = parseBuildError(output);
    expect(err).not.toBeNull();
    expect(err!.tool).toBe("tsc");
    expect(err!.file).toBe("src/App.tsx");
    expect(err!.line).toBe(15);
    expect(err!.code).toBe("TS2322");
  });

  it("should parse webpack error", () => {
    const output = `ERROR in ./src/index.js
Module not found: Error: Can't resolve './components/App' in '/project/src'`;
    const err = parseBuildError(output);
    expect(err).not.toBeNull();
    expect(err!.tool).toBe("webpack");
    expect(err!.message).toContain("Can't resolve");
  });

  it("should parse ESLint error", () => {
    const output = `/project/src/App.tsx
  15:3  error  'unused' is defined but never used  no-unused-vars`;
    const err = parseBuildError(output);
    expect(err).not.toBeNull();
    expect(err!.tool).toBe("eslint");
    expect(err!.line).toBe(15);
  });

  it("should return null for non-error output", () => {
    const output = `VITE v6.4.1  ready in 1014 ms`;
    const err = parseBuildError(output);
    expect(err).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/capture-build.test.ts`
Expected: FAIL — `parseBuildError` doesn't exist yet.

- [ ] **Step 3: Implement build error parsers**

Add to `src/capture.ts`, after the existing `extractMarkerTag` function:

```typescript
// --- Build error parsing ---

export interface BuildError {
  tool: "vite" | "tsc" | "webpack" | "eslint" | "postcss" | "unknown";
  file: string | null;
  line: number | null;
  column: number | null;
  code: string | null;    // e.g., "TS2322", "E0308"
  message: string;
  raw: string;
}

const BUILD_PATTERNS: Array<{
  test: RegExp;
  tool: BuildError["tool"];
  extract: (text: string) => Partial<BuildError> | null;
}> = [
  // Vite / PostCSS errors: [vite:css][postcss] message
  {
    test: /\[vite[:\]]/i,
    tool: "vite",
    extract: (text) => {
      const msg = text.match(/\[vite[^\]]*\](?:\[([^\]]+)\])?\s*(.+)/)?.[2] ?? text;
      const fileLine = text.match(/(\S+\.(?:css|scss|less|tsx?|jsx?)):?(\d+)?/);
      return { message: msg, file: fileLine?.[1] ?? null, line: fileLine?.[2] ? +fileLine[2] : null };
    },
  },
  // TypeScript: src/file.tsx(15,3): error TS2322: message
  {
    test: /error TS\d+:/,
    tool: "tsc",
    extract: (text) => {
      const m = text.match(/(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/);
      if (!m) return null;
      return { file: m[1], line: +m[2], column: +m[3], code: m[4], message: m[5] };
    },
  },
  // webpack: ERROR in ./path
  {
    test: /ERROR in \.\//,
    tool: "webpack",
    extract: (text) => {
      const file = text.match(/ERROR in (\.\/.+)/)?.[1] ?? null;
      const msg = text.match(/(?:Error|Module not found):\s*(.+)/)?.[1] ?? text;
      return { file, message: msg };
    },
  },
  // ESLint: path/file.tsx\n  15:3  error  message  rule-name
  {
    test: /\d+:\d+\s+error\s+/,
    tool: "eslint",
    extract: (text) => {
      const lines = text.split("\n");
      let file: string | null = null;
      for (const line of lines) {
        const m = line.match(/^\s*(\d+):(\d+)\s+error\s+(.+?)\s{2,}(\S+)/);
        if (m) {
          return { file, line: +m[1], column: +m[2], message: m[3], code: m[4] };
        }
        // Line before error line is usually the file path
        if (line.trim() && !line.match(/^\s*\d+:\d+/)) file = line.trim();
      }
      return null;
    },
  },
];

export function parseBuildError(text: string): BuildError | null {
  for (const pattern of BUILD_PATTERNS) {
    if (pattern.test.test(text)) {
      const extracted = pattern.extract(text);
      if (!extracted) continue;
      return {
        tool: pattern.tool,
        file: extracted.file ?? null,
        line: extracted.line ?? null,
        column: extracted.column ?? null,
        code: extracted.code ?? null,
        message: extracted.message ?? text.split("\n")[0] ?? "",
        raw: text,
      };
    }
  }
  return null;
}
```

Also add a new build error ring buffer after the existing buffers:

```typescript
export const buildBuffer = new RingBuffer<BuildError>(100);
```

Modify `pipeProcess` to accumulate chunks and detect multiline build errors. Add a module-level accumulator and feed full chunks (not individual lines) to `parseBuildError`. After the existing `pipe(child.stderr, true);` line, the full function should look like this — the key change is calling `parseBuildError` on the full `text` chunk (which may contain multiple lines), not on individual lines:

```typescript
export function pipeProcess(child: ChildProcess): void {
  const pipe = (stream: NodeJS.ReadableStream | null, isErr: boolean) => {
    if (!stream) return;
    stream.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      (isErr ? process.stderr : process.stdout).write(chunk);

      // Check full chunk for multiline build errors (Vite, tsc, etc.)
      const buildErr = parseBuildError(text);
      if (buildErr) buildBuffer.push(buildErr);

      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        terminalBuffer.push({
          id: newCaptureId(),
          timestamp: new Date().toISOString(),
          source: "terminal",
          markerTag: extractMarkerTag(t),
          data: { text: redactSensitiveData(t), stream: isErr ? "stderr" : "stdout" },
          hypothesisId: null,
        });
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/capture-build.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture.ts tests/capture-build.test.ts
git commit -m "feat: add build error parsers for Vite, tsc, webpack, ESLint"
```

---

### Task 4: Create Adapter Discovery Module

**Files:**
- Create: `src/adapters.ts`
- Create: `tests/adapters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/adapters.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectVisualTools, type VisualCapabilities } from "../src/adapters.js";

describe("Adapter discovery", () => {
  it("should return no capabilities when no tools available", () => {
    const caps = detectVisualTools([]);
    expect(caps.canScreenshot).toBe(false);
    expect(caps.canReadDom).toBe(false);
    expect(caps.screenshotTool).toBeNull();
    expect(caps.domTool).toBeNull();
  });

  it("should detect Ghost OS screenshot capability", () => {
    const tools = ["ghost_screenshot", "ghost_read", "ghost_inspect"];
    const caps = detectVisualTools(tools);
    expect(caps.canScreenshot).toBe(true);
    expect(caps.screenshotTool).toBe("ghost_screenshot");
    expect(caps.canReadDom).toBe(true);
    expect(caps.domTool).toBe("ghost_read");
  });

  it("should detect Claude Preview capabilities", () => {
    const tools = ["preview_screenshot", "preview_snapshot"];
    const caps = detectVisualTools(tools);
    expect(caps.canScreenshot).toBe(true);
    expect(caps.screenshotTool).toBe("preview_screenshot");
    expect(caps.canReadDom).toBe(true);
    expect(caps.domTool).toBe("preview_snapshot");
  });

  it("should prefer Ghost OS over Preview when both available", () => {
    const tools = ["ghost_screenshot", "ghost_read", "preview_screenshot", "preview_snapshot"];
    const caps = detectVisualTools(tools);
    expect(caps.screenshotTool).toBe("ghost_screenshot");
    expect(caps.domTool).toBe("ghost_read");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/adapters.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement adapters.ts**

Create `src/adapters.ts`:

```typescript
/**
 * adapters.ts — MCP tool discovery for visual integrations.
 *
 * Detects available tools from Ghost OS and Claude Preview at runtime.
 * All visual features gracefully degrade when no tools are available.
 */

export interface VisualCapabilities {
  canScreenshot: boolean;
  canReadDom: boolean;
  canInspect: boolean;
  screenshotTool: "ghost_screenshot" | "preview_screenshot" | null;
  domTool: "ghost_read" | "preview_snapshot" | null;
  inspectTool: "ghost_inspect" | "preview_inspect" | null;
  availableTools: string[];
}

// Ghost OS tools (preferred — native macOS accessibility)
const GHOST_TOOLS = {
  screenshot: "ghost_screenshot",
  dom: "ghost_read",
  inspect: "ghost_inspect",
} as const;

// Claude Preview tools (browser-based alternative)
const PREVIEW_TOOLS = {
  screenshot: "preview_screenshot",
  dom: "preview_snapshot",
  inspect: "preview_inspect",
} as const;

/**
 * Detect which visual tools are available from the provided tool list.
 * Prefers Ghost OS over Claude Preview when both are available.
 */
export function detectVisualTools(availableTools: string[]): VisualCapabilities {
  const set = new Set(availableTools);

  const hasGhostScreenshot = set.has(GHOST_TOOLS.screenshot);
  const hasGhostDom = set.has(GHOST_TOOLS.dom);
  const hasGhostInspect = set.has(GHOST_TOOLS.inspect);

  const hasPreviewScreenshot = set.has(PREVIEW_TOOLS.screenshot);
  const hasPreviewDom = set.has(PREVIEW_TOOLS.dom);
  const hasPreviewInspect = set.has(PREVIEW_TOOLS.inspect);

  return {
    canScreenshot: hasGhostScreenshot || hasPreviewScreenshot,
    canReadDom: hasGhostDom || hasPreviewDom,
    canInspect: hasGhostInspect || hasPreviewInspect,
    screenshotTool: hasGhostScreenshot ? GHOST_TOOLS.screenshot
      : hasPreviewScreenshot ? PREVIEW_TOOLS.screenshot : null,
    domTool: hasGhostDom ? GHOST_TOOLS.dom
      : hasPreviewDom ? PREVIEW_TOOLS.dom : null,
    inspectTool: hasGhostInspect ? GHOST_TOOLS.inspect
      : hasPreviewInspect ? PREVIEW_TOOLS.inspect : null,
    availableTools: availableTools.filter((t) =>
      Object.values(GHOST_TOOLS).includes(t as any) ||
      Object.values(PREVIEW_TOOLS).includes(t as any)
    ),
  };
}

/**
 * Format a visual capabilities summary for MCP server startup log.
 */
export function formatCapabilitiesSummary(caps: VisualCapabilities): string {
  if (!caps.canScreenshot && !caps.canReadDom) {
    return "No visual tools detected. Screenshots and DOM capture unavailable.";
  }
  const parts: string[] = [];
  if (caps.screenshotTool) parts.push(`screenshot: ${caps.screenshotTool}`);
  if (caps.domTool) parts.push(`DOM: ${caps.domTool}`);
  if (caps.inspectTool) parts.push(`inspect: ${caps.inspectTool}`);
  return `Visual tools: ${parts.join(", ")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/adapters.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters.ts tests/adapters.test.ts
git commit -m "feat: add MCP tool discovery for Ghost OS and Claude Preview"
```

---

### Task 5: Add Visual Error Classification to Context

**Files:**
- Modify: `src/context.ts:315-410` (classifyError function + new isVisualError helper)
- Create: `tests/context-visual.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/context-visual.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isVisualError } from "../src/context.js";

describe("Visual error classification", () => {
  it("should detect CSS errors as visual", () => {
    expect(isVisualError("runtime", "src/index.css")).toBe(true);
    expect(isVisualError("runtime", "styles/main.scss")).toBe(true);
  });

  it("should detect layout/visual categories", () => {
    expect(isVisualError("logic", null, "the header looks broken on mobile")).toBe(true);
    expect(isVisualError("logic", null, "animation stutters on scroll")).toBe(true);
  });

  it("should not flag non-visual errors", () => {
    expect(isVisualError("type", "src/api.ts")).toBe(false);
    expect(isVisualError("network", null)).toBe(false);
  });

  it("should detect CSS-related error categories", () => {
    expect(isVisualError("syntax", "src/App.module.css")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/context-visual.test.ts`
Expected: FAIL — `isVisualError` doesn't exist.

- [ ] **Step 3: Implement isVisualError**

Add to `src/context.ts`, after the `classifyError` function (after line 410):

```typescript
// --- Visual error detection ---

const CSS_EXTENSIONS = /\.(css|scss|sass|less|stylus|styl)$/i;
const VISUAL_KEYWORDS = /looks?\s+(wrong|off|different|broken)|layout|visual|css|style|animation|render|display|position|z-index|overflow|responsive|mobile|tablet|screen|viewport|font|color|opacity|margin|padding|align|flex|grid|stutter|flicker|overlap/i;

/**
 * Determine if an error is visual/CSS-related, warranting screenshot capture.
 */
export function isVisualError(
  category: string,
  file?: string | null,
  description?: string | null,
): boolean {
  // CSS file involvement
  if (file && CSS_EXTENSIONS.test(file)) return true;

  // Visual error categories
  if (category === "logic" && description && VISUAL_KEYWORDS.test(description)) return true;

  // Check for CSS-specific error patterns
  if (file && /\.module\.(css|scss|less)$/i.test(file)) return true;

  return false;
}
```

Also export `isVisualError` by adding it to the exports (it's already a named export via `export function`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/context-visual.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context.ts tests/context-visual.test.ts
git commit -m "feat: add visual error classification for screenshot triggers"
```

---

### Task 6: Create Lighthouse Performance Runner

**Files:**
- Create: `src/perf.ts`
- Create: `tests/perf.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/perf.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/perf.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement perf.ts**

Create `src/perf.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/perf.test.ts`
Expected: PASS (unit tests only — `runLighthouse` is integration-tested manually)

- [ ] **Step 5: Commit**

```bash
git add src/perf.ts tests/perf.test.ts
git commit -m "feat: add Lighthouse performance runner and metric extraction"
```

---

### Task 7: Wire Build Errors into Investigation

**Files:**
- Modify: `src/mcp.ts:55-140` (debug_investigate tool handler)
- Modify: `src/capture.ts` (export buildBuffer drain function)

- [ ] **Step 1: Add drainBuildErrors to capture.ts**

Add to `src/capture.ts` after the `buildBuffer` declaration:

```typescript
/**
 * Drain all accumulated build errors from the buffer.
 */
export function drainBuildErrors(): BuildError[] {
  return buildBuffer.drain();
}
```

- [ ] **Step 2: Update debug_investigate to include build errors**

In `src/mcp.ts`, add to the imports:

```typescript
import { drainCaptures, runAndCapture, getRecentCaptures, readTauriLogs, discoverTauriLogs, drainBuildErrors } from "./capture.js";
import { isVisualError } from "./context.js";
```

In the `debug_investigate` handler (around line 82-139), after `const result = investigate(...)` and before `const pastSolutions = recall(...)`, add:

```typescript
    // Drain any accumulated build errors from the dev server
    const buildErrors = drainBuildErrors();

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

    // Check if this is a visual error (for future screenshot integration)
    const sourceFiles = result.sourceCode.map((s) => s.relativePath);
    const visualError = isVisualError(
      result.error.category,
      sourceFiles[0] ?? null,
      errorText,
    );
```

Then in the response object (around line 101-116), add after `environment`:

```typescript
      buildErrors: buildErrors.length > 0 ? buildErrors.map((e) => ({
        tool: e.tool,
        file: e.file,
        line: e.line,
        code: e.code,
        message: e.message,
      })) : undefined,
      visualError,
```

Update the nextStep logic to mention build errors when present:

```typescript
    // Adjust nextStep if build errors found
    if (buildErrors.length > 0 && !response.nextStep) {
      response.nextStep = `${buildErrors.length} build error(s) detected from dev server. Review them — they may be the root cause.`;
    }
```

- [ ] **Step 3: Build and verify compilation**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src/mcp.ts src/capture.ts
git commit -m "feat: wire build error capture into debug_investigate"
```

---

### Task 8: Register debug_perf MCP Tool

**Files:**
- Modify: `src/mcp.ts` (add new tool registration)

- [ ] **Step 1: Add perf tool import**

Add to imports in `src/mcp.ts`:

```typescript
import { runLighthouse, compareSnapshots, type LighthouseMetrics } from "./perf.js";
import type { PerfSnapshot } from "./session.js";
```

- [ ] **Step 2: Register the debug_perf tool**

Add after the `debug_patterns` tool registration (before `debug_session`), in `src/mcp.ts`:

```typescript
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
    const session = loadSession(cwd, sessionId);
    const snapshotPhase = phase ?? "before";

    const metrics = await runLighthouse(url);
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

    return text({
      phase: snapshotPhase,
      url,
      metrics: {
        lcp: metrics.lcp !== null ? `${Math.round(metrics.lcp)}ms` : null,
        cls: metrics.cls !== null ? metrics.cls.toFixed(3) : null,
        inp: metrics.inp !== null ? `${Math.round(metrics.inp)}ms` : null,
        tbt: metrics.tbt !== null ? `${Math.round(metrics.tbt)}ms` : null,
        speedIndex: metrics.speedIndex !== null ? `${Math.round(metrics.speedIndex)}ms` : null,
      },
      comparison,
      nextStep: snapshotPhase === "before"
        ? "Apply your fix, then call debug_perf again with phase='after' to compare."
        : comparison?.improved
          ? "Performance improved! Proceed with debug_verify to confirm the fix."
          : "Performance did not improve. Review the metrics and consider a different approach.",
    });
  });
```

- [ ] **Step 3: Update server version**

In `src/mcp.ts`, update the version on line 37:

```typescript
    { name: "debug-toolkit", version: "0.6.0" },
```

- [ ] **Step 4: Update package.json version**

In `package.json`, update version:

```json
"version": "0.6.0",
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 6: Commit**

```bash
git add src/mcp.ts src/perf.ts package.json
git commit -m "feat: add debug_perf tool for Lighthouse performance snapshots"
```

---

### Task 9: Add Visual Context Hints to Investigation Response

**Files:**
- Modify: `src/mcp.ts` (debug_investigate response)

This task adds advisory messages to the investigation response telling the agent it should use Ghost OS / Preview for visual bugs. The toolkit can't call those tools directly (MCP servers can't call other MCP servers), but it can signal to the agent that visual tools would help.

- [ ] **Step 1: Update investigation response for visual bugs**

In `src/mcp.ts`, in the `debug_investigate` handler, after the existing `nextStep` logic, add:

```typescript
    // Visual error advisory — tell agent to use visual tools
    if (visualError) {
      response.visualHint = {
        isVisualBug: true,
        message: "This appears to be a visual/CSS bug. Use ghost_screenshot or preview_screenshot to capture the current visual state, then attach findings to this session.",
        suggestedActions: [
          "Take a screenshot with ghost_screenshot or preview_screenshot",
          "Capture DOM state with ghost_read or preview_snapshot for the affected element",
          "After fixing, take another screenshot to compare before/after",
        ],
      };
      // Append to nextStep
      if (typeof response.nextStep === "string") {
        response.nextStep += " (Visual bug detected — screenshot recommended.)";
      }
    }
```

- [ ] **Step 2: Update debug_verify to suggest visual comparison**

In the `debug_verify` handler, when the fix passes, update the nextStep to mention visual comparison:

```typescript
      nextStep: passed
        ? "Fix verified! Use debug_cleanup to remove instrumentation and close the session. If this was a visual bug, take a screenshot to confirm the visual fix."
        : "Fix failed. Review the errors above and try a different approach.",
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src/mcp.ts
git commit -m "feat: add visual bug detection hints in investigation response"
```

---

### Task 10: Update SKILL.md and README

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Update SKILL.md tool table**

Add `debug_perf` to the tool table in `SKILL.md`. Add documentation for the new `buildErrors` and `visualHint` fields in `debug_investigate` response. Document the visual error detection and Lighthouse integration.

- [ ] **Step 2: Update README.md**

Add a "What's New in v0.6" section mentioning:
- Build error auto-capture (Vite, tsc, webpack, ESLint)
- Visual bug detection with Ghost OS / Claude Preview advisory
- Lighthouse performance snapshots (`debug_perf`)
- Extended session model with visual context

- [ ] **Step 3: Commit**

```bash
git add SKILL.md README.md
git commit -m "docs: update SKILL.md and README for v0.6 features"
```

---

### Task 11: Run Full Test Suite + Manual Smoke Test

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 3: Smoke test — MCP server starts**

Run: `echo '{}' | node dist/index.js mcp`
Expected: MCP server starts on stdio without errors.

- [ ] **Step 4: Smoke test — demo still works**

Run: `npx debug-toolkit demo`
Expected: Demo runs through full workflow without errors.

- [ ] **Step 5: Final commit if any adjustments needed**

```bash
git add -A
git commit -m "chore: phase 1 complete — v0.6.0 release ready"
```
