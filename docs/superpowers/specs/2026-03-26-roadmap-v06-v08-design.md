# debug-toolkit v0.6–0.8 Roadmap: Addressing Roast Feedback

## Context

A real-world roast session (March 26, 2026) exposed critical shortcomings in debug-toolkit v0.5.2 when used on a portfolio project. The agent honestly assessed that:

- The toolkit **adds overhead on trivial bugs** (more tokens, not fewer)
- It's **blind to visual/CSS bugs** — can't see the page or capture DOM state
- It **misses build-time errors** (Vite/PostCSS/tsc) — only captures browser runtime errors via proxy
- It has **no performance profiling** capability
- Memory is **reactive, not preventive** — identifies patterns but doesn't suggest fixes
- Memory is **project-scoped** with no cross-project sharing
- The agent said: "For this portfolio project, Ghost OS is probably more valuable — I can actually see what the page looks like"

**Goal:** Make the toolkit genuinely valuable across all debugging scenarios — visual, build-time, runtime, and performance — while making it smarter about when and how to engage.

---

## Phase 1: "Give It Eyes" — Visual + Build Integration (v0.6)

**Why first:** The roast showed the toolkit was most limited on visual/CSS bugs, which are the most common bug type in frontend projects. This phase makes the toolkit useful where it currently isn't.

### 1.1 MCP Tool Discovery Layer

**New file:** `src/adapters.ts`

Probe for available MCP tools at server startup:
- Detect Ghost OS tools: `ghost_screenshot`, `ghost_inspect`, `ghost_find`, `ghost_read`
- Detect Claude Preview tools: `preview_screenshot`, `preview_snapshot`, `preview_inspect`
- Store availability as capabilities flags on the session
- **Graceful degradation** — all visual features are no-ops when no visual tool is available
- Log which adapters are available in the MCP server startup message

**Existing code to extend:** `src/mcp.ts` (server creation), `src/session.ts` (session model)

### 1.2 Auto-Screenshot on Visual Bugs

**Modify:** `debug_investigate` in `src/mcp.ts` and `src/context.ts`

When error classification suggests a visual/CSS/layout bug:
1. Check if Ghost OS or Claude Preview adapter is available
2. Auto-call screenshot tool
3. Attach screenshot reference (file path or base64) to the debug session
4. Include in investigation response: "Screenshot captured — visual state attached"

**Error types that trigger screenshots:** CSS errors, layout errors, rendering errors, "looks wrong" descriptions, any error in `.css`, `.scss`, `.less` files or style-related components.

### 1.3 DOM/Accessibility State Capture

**Modify:** `src/context.ts` (new `captureVisualContext()` function)

When Ghost OS or Claude Preview is available:
- Capture accessibility tree / DOM snapshot alongside screenshots
- Extract: element roles, text content, visibility states, computed styles for error-related elements
- Store structured DOM data in session (not full tree — filtered to relevant elements)
- Useful for: "button is there but not clickable", "text is invisible", "element is hidden"

### 1.4 Build Error Stream Capture

**Modify:** `src/capture.ts` (extend process output parsing)

The `serve` command already wraps the dev process and captures stdout/stderr. Extend to:
- Parse Vite error output (already partially captured, needs structured parsing)
- Parse webpack compilation errors
- Parse TypeScript compiler errors (`tsc`)
- Parse PostCSS/stylelint errors
- Parse ESLint output
- Store structured build errors in the ring buffer with:
  - Error type, file, line, message
  - Tool that generated the error (vite/tsc/eslint/etc.)
- **Auto-surface** build errors in `debug_investigate` without user pasting them

**Existing code to reuse:** `RingBuffer<T>` in `src/capture.ts`, error parsing patterns in `src/context.ts`

### 1.5 Visual Diff on Verify

**Modify:** `debug_verify` in `src/mcp.ts`

When `debug_verify` runs after a fix and visual adapters are available:
1. Capture post-fix screenshot
2. Store both pre-fix (from investigate) and post-fix screenshot refs in session
3. Report: "Visual state captured before and after fix"
4. On `debug_cleanup`, both screenshots are saved with the diagnosis

### 1.6 Lighthouse/Performance Capture

**New tool:** `debug_perf` (or integrated as option in `debug_verify`)

**New file:** `src/perf.ts`

- Run Lighthouse via CLI: `npx lighthouse <url> --output=json --quiet --chrome-flags="--headless"`
- Capture key metrics: LCP, FID/INP, CLS, total blocking time, speed index
- Store perf snapshot in session
- When called during verify, compare before/after metrics
- `debug_patterns` can detect perf regressions across sessions ("LCP increased 40% after commit abc123")

**Prerequisite:** Chrome must be available (most dev machines have it). Graceful skip if not.

---

## Phase 2: "Make It Smart" — Triage + Efficiency (v0.7)

**Why second:** Once the toolkit can see more (Phase 1), making it smarter about when to engage and how deeply to investigate multiplies that value.

### 2.1 Triage Gate in `debug_investigate`

**Modify:** `src/context.ts` (new `triageError()` function, called before full `investigate()`)

Classification levels:
- **Trivial** (self-explanatory error + single file + known pattern): Return fix hint + file location in <100ms. Skip git diff, env scan, memory search.
  - Examples: missing import, undefined variable, syntax error, CSS @import ordering
- **Medium** (known error type, needs some context): Run source context + memory recall. Skip env scan.
  - Examples: type mismatch, failed assertion, known framework error
- **Complex** (ambiguous, multi-file, no pattern match): Full pipeline.
  - Examples: "page is blank", race conditions, intermittent failures

Classification signals:
- Error message clarity (parseable error code → trivial)
- Stack trace depth (1 frame → likely trivial, 5+ → complex)
- Memory match confidence (high → can shortcut)
- Number of files involved

### 2.2 Smarter Activation Rules

**Modify:** Rules template in `src/index.ts` (generated during `init`)

Updated `.claude/rules/debug-toolkit.md` heuristics:
- **Always use toolkit:** Runtime crashes, multi-file stack traces, "it doesn't work" without clear error, recurring issues, performance regressions
- **Skip toolkit:** Syntax errors visible in editor, typos, single-line config issues, errors where the agent already has full context from the user's message
- **Use toolkit for memory only:** When the error is clear but might be recurring — call `debug_recall` instead of full `debug_investigate`

### 2.3 Auto-Learning

**Modify:** `debug_verify` in `src/mcp.ts`, `src/memory.ts`

When `debug_verify` passes (fix confirmed):
- Auto-extract diagnosis from the session (error type, cause file, what changed)
- Auto-save to memory without requiring explicit `debug_cleanup` call
- `debug_cleanup` becomes optional — for adding extra notes, custom causal chains, or manual marker removal
- Existing `cleanupSession()` in `src/cleanup.ts` still handles marker removal

### 2.4 Preventive Suggestions

**Modify:** `debug_patterns` in `src/memory.ts`

After detecting patterns, generate actionable recommendations:
- **Lint rule suggestions:** "3 CSS import ordering bugs → add `stylelint-order` plugin"
- **Refactoring signals:** "File X in 15% of sessions → consider splitting"
- **Config suggestions:** "TypeScript strict mode would catch 40% of your type errors"
- Store recommendations in memory
- Surface proactively on next `debug_investigate` in the same area

**Recommendation engine:** Pattern-to-suggestion mapping (start with hardcoded rules, can be expanded):
- Repeated CSS errors → stylelint/postcss config
- Repeated type errors → tsconfig strict options
- Repeated null/undefined → optional chaining patterns
- Hot files → refactoring opportunity

---

## Phase 3: "Make It Remember" — Memory Overhaul (v0.8)

**Why last:** Memory improvements compound over time — they need sessions from Phases 1–2 to be meaningful.

### 3.1 Confidence Scoring

**Modify:** `src/memory.ts` (memory data model + recall ranking)

Each memory entry gets a composite score (0.0–1.0):
- **Age factor** (0.3 weight): Linear decay over 90 days
- **File drift factor** (0.4 weight): Git diff stat since memory was saved — high changes = lower confidence
- **Usage factor** (0.3 weight): Was this memory's fix applied when recalled? Track recall→verify success

Memories below 0.3 confidence are auto-demoted (still searchable but not in auto-recall).

**Existing staleness tracking to extend:** `src/memory.ts` already has `staleness` based on git SHA. Extend to full confidence model.

### 3.2 Exportable Knowledge Packs

**New file:** `src/packs.ts`
**New CLI commands:** `export`, `import`

Export format (versioned JSON):
```json
{
  "version": "1.0",
  "name": "react-common-errors",
  "description": "Debug patterns from React projects",
  "entries": [
    {
      "errorSignature": "Cannot read properties of undefined",
      "category": "runtime/null-reference",
      "fix": "Add optional chaining or null check before array access",
      "files": ["*.tsx", "*.jsx"],
      "confidence": 0.85,
      "frequency": 12
    }
  ],
  "patterns": [...],
  "recommendations": [...]
}
```

CLI:
- `npx debug-toolkit export [--filter=react|css|typescript|all]` — export from this project
- `npx debug-toolkit import <file-or-url>` — import into this project's memory
- Imported memories are tagged as "external" with lower initial confidence (0.5)

### 3.3 Proactive Memory

**Modify:** `debug_investigate` in `src/mcp.ts`

During investigation, if memory search finds a match with >0.8 confidence:
- Surface the past fix **immediately** in the response header, before full investigation results
- Mark as "Suggested from memory (85% confidence)"
- Agent can verify/apply directly without waiting for full pipeline
- Track whether the suggestion was used (feeds back into confidence scoring)

### 3.4 Memory Decay + Archival

**Modify:** `src/memory.ts`

- Memories with confidence <0.2 for 30+ days → auto-archive
- Archived memories move to `.debug/archive/` — not in active search index
- `debug_recall --include-archived` can still search them
- If the same error pattern re-emerges and matches an archived memory → auto-restore with fresh confidence

---

## Critical Files to Modify

| File | Phase | Changes |
|------|-------|---------|
| `src/mcp.ts` | 1,2,3 | New tool (`debug_perf`), triage gate, auto-learning, proactive memory |
| `src/context.ts` | 1,2 | Visual context capture, triage classification |
| `src/capture.ts` | 1 | Build error stream parsing (Vite/tsc/PostCSS/webpack) |
| `src/memory.ts` | 2,3 | Preventive suggestions, confidence scoring, decay/archival |
| `src/session.ts` | 1 | Add visual data (screenshots, DOM state, perf metrics) to session model |
| `src/adapters.ts` | 1 | **New** — MCP tool discovery for Ghost OS / Claude Preview |
| `src/perf.ts` | 1 | **New** — Lighthouse runner + metric extraction |
| `src/packs.ts` | 3 | **New** — Export/import knowledge packs |
| `src/index.ts` | 2,3 | New CLI commands (export, import), updated init rules |
| `src/cleanup.ts` | 2 | Make cleanup optional (auto-learning in verify) |

---

## Verification Plan

### Phase 1 Verification
1. Run `npx debug-toolkit serve -- npm run dev` on a Vite+React project
2. Introduce a CSS error → verify build error is captured without pasting
3. Introduce a visual bug → verify screenshot is auto-captured (requires Ghost OS or Preview)
4. Run `debug_investigate` → confirm visual context is in the response
5. Fix the bug → run `debug_verify` → confirm before/after screenshots saved
6. Run `debug_perf` → confirm Lighthouse metrics captured

### Phase 2 Verification
1. Trigger a trivial error (missing import) → verify triage classifies as trivial and returns fast
2. Trigger a complex error (multi-file crash) → verify full pipeline runs
3. Fix a bug with `debug_verify` passing → verify auto-learning saved diagnosis without `debug_cleanup`
4. Create 3+ similar bugs → run `debug_patterns` → verify preventive suggestion is generated

### Phase 3 Verification
1. Create a memory, wait (or simulate time), then recall → verify confidence score reflects age
2. Modify the file where a memory was saved → recall → verify confidence reflects file drift
3. Export knowledge pack → import into a fresh project → verify memories are available with "external" tag
4. Trigger an error matching a high-confidence memory → verify proactive suggestion appears before full investigation
5. Let a memory decay below threshold → verify it moves to archive → trigger same error → verify auto-restore
