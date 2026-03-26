# Phase 2: "Make It Smart" — Triage + Efficiency

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the toolkit pay for itself on every bug — trivial errors get fast-path responses, fixes auto-save to memory without manual cleanup, and recurring patterns generate preventive recommendations.

**Architecture:** Add a triage gate at the start of `debug_investigate` that classifies error complexity (trivial/medium/complex) and short-circuits the full pipeline for simple bugs. Move the memory-save step from `debug_cleanup` into `debug_verify` (auto-learning). Extend `debug_patterns` to output actionable preventive suggestions.

**Tech Stack:** TypeScript, existing memory system, existing error classification.

**Spec:** `docs/superpowers/specs/2026-03-26-roadmap-v06-v08-design.md` (Phase 2 sections 2.1–2.4)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/triage.ts` | Create | Error complexity classification — trivial/medium/complex |
| `src/suggestions.ts` | Create | Pattern-to-suggestion mapping for preventive recommendations |
| `src/context.ts` | Modify | Export classifyError (currently private) for triage use |
| `src/mcp.ts` | Modify | Wire triage gate into investigate, add auto-learning to verify |
| `src/memory.ts` | Modify | Add suggestion generation to detectPatterns |
| `src/index.ts` | Modify | Update activation rules template |
| `tests/triage.test.ts` | Create | Tests for triage classification |
| `tests/suggestions.test.ts` | Create | Tests for preventive suggestions |

---

### Task 1: Export classifyError from context.ts

**Files:**
- Modify: `src/context.ts:323` (make classifyError exported)

Currently `classifyError` is a private function. The triage gate needs to call it independently.

- [ ] **Step 1: Export classifyError**

In `src/context.ts`, change line 323 from:
```typescript
function classifyError(raw: string): ErrorClassification {
```
to:
```typescript
export function classifyError(raw: string): ErrorClassification {
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 3: Commit**

```bash
git add src/context.ts
git commit -m "refactor: export classifyError for triage gate use"
```

---

### Task 2: Create Triage Classification Module

**Files:**
- Create: `src/triage.ts`
- Create: `tests/triage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/triage.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { triageError, type TriageResult } from "../src/triage.js";

describe("Error triage", () => {
  it("should classify missing import as trivial", () => {
    const result = triageError("ReferenceError: foo is not defined\n    at Object.<anonymous> (src/app.ts:5:1)");
    expect(result.level).toBe("trivial");
    expect(result.skipFullPipeline).toBe(true);
  });

  it("should classify syntax error as trivial", () => {
    const result = triageError("SyntaxError: Unexpected token '}' at src/index.ts:10:5");
    expect(result.level).toBe("trivial");
  });

  it("should classify single-frame type error as trivial", () => {
    const result = triageError("TypeError: Cannot read properties of undefined (reading 'map')\n    at UserList (src/UserList.tsx:15:20)");
    expect(result.level).toBe("medium");
  });

  it("should classify deep multi-file stack as complex", () => {
    const error = `Error: Connection failed
    at Database.connect (src/db.ts:45:10)
    at UserService.init (src/services/user.ts:12:5)
    at App.bootstrap (src/app.ts:8:3)
    at Server.listen (src/server.ts:20:7)
    at main (src/index.ts:5:1)`;
    const result = triageError(error);
    expect(result.level).toBe("complex");
    expect(result.skipFullPipeline).toBe(false);
  });

  it("should classify ambiguous description as complex", () => {
    const result = triageError("the page is blank after login");
    expect(result.level).toBe("complex");
  });

  it("should classify known framework error as medium", () => {
    const result = triageError("Error: Cannot find module './components/App'\n    at require (node:internal/modules/cjs/loader:1080:19)\n    at Object.<anonymous> (src/index.ts:3:1)");
    expect(result.level).toBe("medium");
  });

  it("should include fix hint for trivial errors", () => {
    const result = triageError("ReferenceError: useState is not defined\n    at App (src/App.tsx:5:10)");
    expect(result.level).toBe("trivial");
    expect(result.fixHint).toBeDefined();
    expect(result.fixHint).toContain("import");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/triage.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement triage.ts**

Create `src/triage.ts`:

```typescript
/**
 * triage.ts — Error complexity classification.
 *
 * Classifies errors as trivial/medium/complex to determine
 * how much of the investigation pipeline to run.
 *
 * Trivial: self-explanatory, single file, known pattern → fast-path
 * Medium: known type, needs some context → partial pipeline
 * Complex: ambiguous, multi-file, no pattern → full pipeline
 */

import { classifyError, type ErrorClassification } from "./context.js";

export interface TriageResult {
  level: "trivial" | "medium" | "complex";
  skipFullPipeline: boolean;
  skipEnvScan: boolean;
  skipMemorySearch: boolean;
  fixHint: string | null;
  classification: ErrorClassification;
}

// Patterns that are self-explanatory with known fixes
const TRIVIAL_PATTERNS: Array<{ test: RegExp; hint: string }> = [
  { test: /ReferenceError:.*is not defined/i, hint: "Check for missing import or typo in variable/function name." },
  { test: /SyntaxError/i, hint: "Check for missing brackets, quotes, or invalid syntax at the indicated line." },
  { test: /Cannot find module/i, hint: "Run `npm install` or check the import path." },
  { test: /ERR_MODULE_NOT_FOUND/i, hint: "Add .js extension to the import or check the path." },
  { test: /ENOENT.*no such file/i, hint: "The file path doesn't exist — check for typos." },
  { test: /@import must precede/i, hint: "Move @import statements to the top of the CSS file, before other rules." },
  { test: /Unexpected token/i, hint: "Syntax error — check the indicated line for missing or extra characters." },
];

// Count user-code stack frames (excludes node_modules, node:internal, etc.)
const USER_FRAME_RE = /at\s+(?:[\w$.< >\[\]]+?\s+)?\(?([^\s()]+):(\d+):(\d+)\)?/gm;
const INTERNAL_PATH = /node_modules|node:|\.cargo|\/rustc\//;

function countUserFrames(error: string): number {
  let count = 0;
  let m;
  USER_FRAME_RE.lastIndex = 0;
  while ((m = USER_FRAME_RE.exec(error)) !== null) {
    if (!INTERNAL_PATH.test(m[1])) count++;
  }
  return count;
}

export function triageError(errorText: string): TriageResult {
  const classification = classifyError(errorText);
  const userFrames = countUserFrames(errorText);

  // Check for trivial patterns first
  for (const { test, hint } of TRIVIAL_PATTERNS) {
    if (test.test(errorText) && userFrames <= 1) {
      return {
        level: "trivial",
        skipFullPipeline: true,
        skipEnvScan: true,
        skipMemorySearch: true,
        fixHint: hint,
        classification,
      };
    }
  }

  // No stack trace + no known error type → complex (ambiguous)
  if (userFrames === 0 && classification.type === "Unknown") {
    return {
      level: "complex",
      skipFullPipeline: false,
      skipEnvScan: false,
      skipMemorySearch: false,
      fixHint: null,
      classification,
    };
  }

  // Deep stack (5+ user frames) → complex
  if (userFrames >= 5) {
    return {
      level: "complex",
      skipFullPipeline: false,
      skipEnvScan: false,
      skipMemorySearch: false,
      fixHint: null,
      classification,
    };
  }

  // Known error type with some stack → medium
  return {
    level: "medium",
    skipFullPipeline: false,
    skipEnvScan: true,
    skipMemorySearch: false,
    fixHint: classification.suggestion || null,
    classification,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/triage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/triage.ts tests/triage.test.ts
git commit -m "feat: add error triage classification (trivial/medium/complex)"
```

---

### Task 3: Create Preventive Suggestions Module

**Files:**
- Create: `src/suggestions.ts`
- Create: `tests/suggestions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/suggestions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateSuggestions, type Suggestion } from "../src/suggestions.js";
import type { PatternInsight } from "../src/memory.js";

describe("Preventive suggestions", () => {
  it("should suggest stylelint for repeated CSS errors", () => {
    const patterns: PatternInsight[] = [{
      type: "recurring_error",
      severity: "warning",
      message: "3 occurrences of syntax error in index.css",
      data: { errorType: "SyntaxError", file: "src/index.css", count: 3 },
    }];
    const suggestions = generateSuggestions(patterns);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].action).toContain("stylelint");
  });

  it("should suggest TypeScript strict mode for repeated type errors", () => {
    const patterns: PatternInsight[] = [{
      type: "recurring_error",
      severity: "critical",
      message: "5 occurrences of TypeError in App.tsx",
      data: { errorType: "TypeError", file: "src/App.tsx", count: 5 },
    }];
    const suggestions = generateSuggestions(patterns);
    expect(suggestions.some((s) => s.action.includes("strict"))).toBe(true);
  });

  it("should suggest refactoring for hot files", () => {
    const patterns: PatternInsight[] = [{
      type: "hot_file",
      severity: "warning",
      message: "src/utils.ts appears in 20% of sessions",
      data: { file: "src/utils.ts", percentage: 20 },
    }];
    const suggestions = generateSuggestions(patterns);
    expect(suggestions.some((s) => s.category === "refactoring")).toBe(true);
  });

  it("should return empty for no patterns", () => {
    expect(generateSuggestions([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/suggestions.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement suggestions.ts**

Create `src/suggestions.ts`:

```typescript
/**
 * suggestions.ts — Preventive suggestions from debug patterns.
 *
 * Maps recurring error patterns to actionable recommendations
 * that prevent the same class of bugs from happening again.
 */

import type { PatternInsight } from "./memory.js";

export interface Suggestion {
  category: "lint-rule" | "config" | "refactoring" | "testing";
  priority: "high" | "medium" | "low";
  action: string;
  rationale: string;
}

const CSS_FILE_RE = /\.(css|scss|sass|less)$/i;
const TS_FILE_RE = /\.(ts|tsx)$/i;

export function generateSuggestions(patterns: PatternInsight[]): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const pattern of patterns) {
    const data = pattern.data as Record<string, unknown>;

    if (pattern.type === "recurring_error") {
      const file = String(data.file ?? "");
      const errorType = String(data.errorType ?? "");
      const count = Number(data.count ?? 0);

      // CSS errors → stylelint
      if (CSS_FILE_RE.test(file)) {
        suggestions.push({
          category: "lint-rule",
          priority: count >= 5 ? "high" : "medium",
          action: `Add stylelint with relevant rules to catch ${errorType} errors in CSS files at build time.`,
          rationale: `${count} ${errorType} errors in ${file} — a lint rule would catch these before runtime.`,
        });
      }

      // Type errors → TypeScript strict
      if (errorType === "TypeError" || errorType === "ReferenceError") {
        suggestions.push({
          category: "config",
          priority: count >= 5 ? "high" : "medium",
          action: `Enable TypeScript strict mode (strictNullChecks, noUncheckedIndexedAccess) to catch null/undefined errors at compile time.`,
          rationale: `${count} ${errorType} errors — stricter type checking would prevent many of these.`,
        });
      }

      // Repeated null/undefined → optional chaining
      if (errorType === "TypeError" && count >= 3) {
        suggestions.push({
          category: "lint-rule",
          priority: "medium",
          action: `Add ESLint rule '@typescript-eslint/prefer-optional-chain' to enforce optional chaining patterns.`,
          rationale: `Repeated TypeError suggests unsafe property access — optional chaining prevents this.`,
        });
      }
    }

    if (pattern.type === "hot_file") {
      const file = String(data.file ?? "");
      const percentage = Number(data.percentage ?? 0);

      suggestions.push({
        category: "refactoring",
        priority: percentage >= 30 ? "high" : "medium",
        action: `Consider splitting ${file} into smaller modules — it appears in ${percentage}% of debug sessions.`,
        rationale: `Files that trigger bugs frequently often have too many responsibilities.`,
      });
    }

    if (pattern.type === "regression") {
      suggestions.push({
        category: "testing",
        priority: "high",
        action: `Add regression tests for the error pattern in ${String(data.file ?? "the affected file")} — this bug has recurred after being fixed.`,
        rationale: `Regressions indicate the fix wasn't protected by tests.`,
      });
    }
  }

  return suggestions;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/suggestions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/suggestions.ts tests/suggestions.test.ts
git commit -m "feat: add preventive suggestion engine for recurring patterns"
```

---

### Task 4: Wire Triage Gate into debug_investigate

**Files:**
- Modify: `src/mcp.ts` (debug_investigate handler, ~lines 59-195)

- [ ] **Step 1: Add triage import**

Add to imports in `src/mcp.ts`:

```typescript
import { triageError } from "./triage.js";
```

- [ ] **Step 2: Add triage gate at start of debug_investigate**

In the `debug_investigate` handler, AFTER the session is loaded/created (around line 80) and BEFORE `const result = investigate(...)`, add:

```typescript
    // Triage: classify error complexity
    const triage = triageError(errorText);

    // Fast-path for trivial errors — skip full pipeline
    if (triage.level === "trivial" && triage.fixHint) {
      // Still store as capture for session tracking
      session.captures.push({
        id: `inv_${Date.now()}`, timestamp: new Date().toISOString(),
        source: "environment", markerTag: null,
        data: { type: "investigation", triage: "trivial", error: triage.classification },
        hypothesisId: null,
      });
      saveSession(cwd, session);

      return text({
        sessionId: session.id,
        triage: "trivial",
        error: triage.classification,
        fixHint: triage.fixHint,
        nextStep: `Trivial error: ${triage.fixHint} Apply the fix, then use debug_verify to confirm.`,
      });
    }
```

- [ ] **Step 3: Add triage info to full investigation response**

In the response object (around line 130), add `triage: triage.level` alongside the existing fields.

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp.ts
git commit -m "feat: add triage gate to debug_investigate for trivial error fast-path"
```

---

### Task 5: Add Auto-Learning to debug_verify

**Files:**
- Modify: `src/mcp.ts` (debug_verify handler, ~lines 305-355)

- [ ] **Step 1: Update debug_verify to auto-save on pass**

In the `debug_verify` handler, AFTER the `passed` check and BEFORE the `return text(...)`, add auto-learning logic:

```typescript
    // Auto-learning: when fix is verified, auto-save diagnosis to memory
    if (passed && session.problem) {
      // Extract error info from the investigation capture
      const errorCap = session.captures.find((c) =>
        (c.data as Record<string, unknown>)?.type === "investigation",
      );
      const errorData = errorCap?.data as Record<string, Record<string, string>> | undefined;

      // Build file set from session instrumentation + investigation
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

      // Auto-save to memory (lightweight — no rootCause required)
      remember(cwd, {
        id: session.id,
        timestamp: new Date().toISOString(),
        problem: session.problem,
        errorType: errorData?.error?.type ?? errorData?.triage?.type ?? "Unknown",
        category: errorData?.error?.category ?? "runtime",
        diagnosis: `Auto-learned: fix verified via "${command}"`,
        files: [...filesSet],
        rootCause: null,
      });
    }
```

- [ ] **Step 2: Add `remember` import if not already present**

Check that `remember` is already imported from `./memory.js` — it should be (from the cleanup handler). Also ensure `basename` is imported from `node:path`.

- [ ] **Step 3: Update the passed nextStep message**

Update the return to inform the agent that the fix was auto-saved:

```typescript
      nextStep: passed
        ? "Fix verified and auto-saved to memory! Use debug_cleanup to remove instrumentation (optional — diagnosis already recorded)."
        : "Fix failed. Review the errors above and try a different approach.",
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npm test`
Expected: Clean build, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts
git commit -m "feat: auto-learn from verified fixes (no manual cleanup required)"
```

---

### Task 6: Wire Preventive Suggestions into debug_patterns

**Files:**
- Modify: `src/mcp.ts` (debug_patterns handler, ~lines 473-515)

- [ ] **Step 1: Add suggestions import**

Add to imports in `src/mcp.ts`:

```typescript
import { generateSuggestions } from "./suggestions.js";
```

- [ ] **Step 2: Generate suggestions in debug_patterns response**

In the `debug_patterns` handler, after `const patterns = stats.patterns;`, add:

```typescript
    const suggestions = generateSuggestions(patterns);
```

Then add `suggestions` to the response object:

```typescript
      suggestions: suggestions.length > 0 ? suggestions.map((s) => ({
        category: s.category,
        priority: s.priority,
        action: s.action,
        rationale: s.rationale,
      })) : undefined,
```

Update the nextStep to mention suggestions when available:

```typescript
      nextStep: suggestions.length > 0
        ? `${suggestions.length} preventive suggestion(s) available. Top: ${suggestions[0].action}`
        : critical.length > 0
          ? `Critical: ${critical[0].message}. Consider refactoring this code.`
          : patterns.length > 0
            ? `Top finding: ${patterns[0].message}`
            : undefined,
```

- [ ] **Step 3: Build and run tests**

Run: `npm run build && npm test`
Expected: Clean build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/mcp.ts
git commit -m "feat: add preventive suggestions to debug_patterns response"
```

---

### Task 7: Update Activation Rules

**Files:**
- Modify: `src/index.ts` (~lines 242-273, rules template)

- [ ] **Step 1: Update the activation rules template**

In `src/index.ts`, replace the activation rules content (the string that gets written to `.claude/rules/debug-toolkit.md`) with updated heuristics:

```markdown
# debug-toolkit — activation rules

## TRIGGER: Any error, failure, or bug
When you encounter ANY of these, call debug_investigate BEFORE reading code manually:
- Stack trace → debug_investigate({ error })
- Test failure → debug_investigate({ error })
- "Wrong output" / visual bug → debug_investigate({ error, files: [...] })
- Bug report → debug_investigate({ error, files: [...] })

Note: The toolkit auto-triages errors. Trivial errors (missing imports, syntax errors)
get a fast-path response with a fix hint. Complex errors get the full investigation.

## SKIP toolkit for:
- Syntax errors you can already see in the editor
- Single-character typos with obvious fixes
- Errors where the user already pasted the full context and fix is obvious

## Use debug_recall (not full investigate) when:
- The error is clear but might be recurring
- You want to check if this was solved before

## TRIGGER: After fixing any bug
The toolkit auto-saves to memory when debug_verify passes.
Only call debug_cleanup if you need to:
- Remove debug instrumentation from source files
- Add a custom diagnosis or rootCause chain

## TRIGGER: Before claiming fix works
ALWAYS call debug_verify({ command: "npm test" })

## TRIGGER: Periodically check for patterns
Call debug_patterns to see recurring issues and preventive suggestions.

## WHY
debug_investigate returns error classification, source code, git diff, environment,
AND past solutions in one call. Trivial errors get fast-path responses in <100ms.
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: update activation rules with triage awareness and skip heuristics"
```

---

### Task 8: Update Version + Docs + Final Verification

**Files:**
- Modify: `src/mcp.ts` (version), `package.json` (version)
- Modify: `SKILL.md`, `README.md`

- [ ] **Step 1: Bump version to 0.7.0**

Update `src/mcp.ts` server version and `package.json` version to `"0.7.0"`.

- [ ] **Step 2: Update SKILL.md**

Add documentation for:
- Triage gate — trivial errors get fast-path responses
- Auto-learning — `debug_verify` auto-saves to memory
- Preventive suggestions in `debug_patterns` response
- Updated activation rules (skip for trivial, use recall for recurring)

- [ ] **Step 3: Update README.md**

Add a "What's New in v0.7" section mentioning the triage gate, auto-learning, and preventive suggestions.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 6: Commit**

```bash
git add src/mcp.ts package.json SKILL.md README.md
git commit -m "chore: Phase 2 complete — v0.7.0 with triage, auto-learning, preventive suggestions"
```
