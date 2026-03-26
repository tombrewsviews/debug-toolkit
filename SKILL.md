---
name: debug-toolkit
description: "Closed-loop debugging for AI agents. Use for runtime errors, stack traces, test failures, AND logic/behavior bugs (wrong output, visual mismatch, unexpected values). Provides error classification, source context, git history, cross-session memory with staleness detection and causal chains, and pattern detection. Start every debugging task with debug_investigate."
tools: ["debug_investigate", "debug_recall", "debug_patterns", "debug_instrument", "debug_capture", "debug_verify", "debug_cleanup", "debug_session", "debug_perf"]
---

# debug-toolkit

You have access to a debugging toolkit via MCP. These tools let you SEE code running — not just read and write it. They learn from every debug session and get smarter over time.

## When to Use

Use these tools whenever you encounter:
- A runtime error or stack trace
- A test failure
- Code that runs but produces wrong output
- A visual/rendering bug ("looks wrong", "doesn't match")
- A logic bug ("wrong value", "should be X but is Y")
- A bug report from the user

**Do NOT debug manually** (exploring code with Read/Grep/Agent) when debug-toolkit is available. Start with `debug_investigate` — it gives you everything in one call.

## The Workflow

**ALWAYS start with `debug_investigate`.** It auto-recalls past solutions and auto-triages the error.

```
1. debug_investigate  → understand the error + auto-recall past fixes
                        (trivial errors get fast-path response with fixHint)
2. debug_instrument   → add logging if investigation wasn't enough
3. debug_capture      → collect runtime output
4. (apply fix)        → edit the code
5. debug_verify       → confirm the fix works (auto-saves to memory on pass)
6. debug_cleanup      → (optional) add custom rootCause chain or remove instrumentation
```

## Tool Reference

### debug_investigate
**Start here.** Works for BOTH runtime errors AND logic bugs. Auto-searches debug memory for past solutions. Now includes a **triage gate**: trivial errors (simple syntax mistakes, missing imports, obvious typos) are auto-detected and receive a fast-path response with `triage: "trivial"` and a `fixHint` — no full pipeline needed. Complex errors proceed through the full investigation pipeline.

For runtime errors (stack traces):
```
Input: { error: "<stack trace>" }
```

For logic/behavior bugs (no stack trace):
```
Input: { error: "description of what's wrong", files: ["src/Component.tsx", "src/utils.ts"] }
```

Optional: `sessionId` (reuse existing), `problem` (description for new session)

Output includes:
- `sessionId` — use in subsequent tool calls
- `error` — type, category, severity, suggestion
- `sourceCode` — code snippets at crash site or from hint files
- `git` — branch, recent changes to relevant files
- `environment` — Node version, frameworks, env vars (secrets redacted)
- `pastSolutions` — previous diagnoses for similar errors (with staleness + causal chain)
- `proactiveSuggestion` — present when a past fix with >80% confidence matches this error. Contains `diagnosis`, `rootCause`, `confidence`, and `fixHint`. Apply directly — skip instrumentation and capture.
- `nextStep` — what to do next
- `buildErrors` — array of build/lint errors auto-captured from the dev server (Vite, tsc, webpack, ESLint). Each entry: `{ tool, file, line, code, message }`
- `visualHint` — present when a visual/CSS bug is detected: `{ isVisualBug, message, suggestedActions }`. Use screenshot tools when this is set.
- `visualError` — boolean, `true` when the error is classified as a visual/rendering bug

### debug_recall
Explicitly search past debug sessions. Returns diagnoses ranked by relevance with staleness info, causal chains, and **confidence scores**.
```
Input: { query: "TypeError Cannot read properties email", limit?: 5 }
```
Each match includes:
- `diagnosis` — what was found last time
- `rootCause` — `{ trigger, errorFile, causeFile, fixDescription }`
- `stale` — whether the referenced files have changed since the diagnosis
- `staleness` — reason if stale (e.g., "2 file(s) changed in 3 commit(s)")
- `relevance` — keyword overlap percentage
- `confidence` — percentage (0–100) indicating how reliable this fix is. Computed from entry age, file drift since the fix was recorded, and how many times the fix has been successfully applied. Higher confidence = more reliable fix.

### debug_patterns
Detect patterns across ALL past sessions. No input required.
```
Input: {}
```
Pattern types detected:
- `recurring_error` — same error type in same file (3+ times = warning, 5+ = critical)
- `hot_file` — files appearing in many debug sessions (fragile code)
- `regression` — bugs that were fixed but came back (missing test coverage)
- `error_cluster` — multiple errors in a short time window (cascading failure)

**Preventive suggestions**: when patterns are detected, the response includes a `suggestions` array with actionable recommendations:
```
suggestions: [
  {
    category: "lint" | "config" | "refactor" | "test" | "dependency",
    priority: "high" | "medium" | "low",
    action: "Add eslint rule no-unsafe-optional-chaining",
    rationale: "TypeError has recurred 5 times in src/api.ts"
  }
]
```

### debug_instrument
Add tagged logging to source files. Each marker links to a hypothesis.
```
Input: { sessionId, filePath, lineNumber, expression: "req.body", hypothesis?: "body is undefined" }
```
Supports JS/TS (`console.log`), Python (`print`), Rust (`eprintln!`), Go (`fmt.Println`).
Respects indentation. Markers are tagged (e.g., `[DBG_001]`) for capture linking.

### debug_capture
Run a command and capture output, or drain buffered terminal/browser events. Also reads Tauri log files automatically.
```
Input: { sessionId, command?: "npm test", limit?: 30 }
```
If no command given and nothing buffered, it suggests asking the user to run their app.
Returns tagged captures linked to hypotheses, errors separated from normal output.

### debug_verify
After applying a fix, run this to confirm it works. Reports pass/fail with evidence. **Auto-learning**: when the fix passes, the session diagnosis is automatically saved to memory — no manual `debug_cleanup` required just for saving.
```
Input: { sessionId, command: "npm test", expectNoErrors?: true }
```
Output: `{ passed, exitCode, errorCount, errors, output }`

### debug_cleanup
Remove ALL instrumentation from source files, verify removal, and save diagnosis to memory. **Now optional** — use it when you want to add a custom `rootCause` causal chain for richer future recall, or when you added instrumentation markers that need to be removed. If no instrumentation was added and `debug_verify` passed, the session is already persisted to memory.
```
Input: {
  sessionId,
  diagnosis?: "root cause was...",
  rootCause?: {
    trigger: "missing null check",
    errorFile: "src/api.ts",
    causeFile: "src/db.ts",
    fixDescription: "added null check before .map()"
  }
}
```
Files involved (from instrumentation, investigation, and rootCause) are saved to memory.
The git SHA is captured for staleness tracking.

**Always provide both `diagnosis` AND `rootCause`** — this is the most valuable data for future sessions.

### debug_session
Lightweight view of current session state.
```
Input: { sessionId }
```
Returns: hypotheses, active instruments, recent captures (summarized).

### debug_perf
Capture a Lighthouse performance snapshot for a URL. Use `phase` to compare before and after a fix.
```
Input: { sessionId, url, phase?: "before" | "after" }
```
- Omit `phase` (or use `"before"`) to take a baseline snapshot.
- Pass `phase: "after"` to compare against the stored baseline.

Returns Web Vitals:
- `LCP` — Largest Contentful Paint
- `CLS` — Cumulative Layout Shift
- `INP` — Interaction to Next Paint
- `TBT` — Total Blocking Time
- `speedIndex` — Speed Index

When `phase` is `"after"`, the response also includes a `comparison` object showing delta and regression/improvement for each metric.

### Knowledge Packs (CLI)
Export and import debug memory across projects.
```bash
npx debug-toolkit export [path]   # Export memory to a .json knowledge pack
npx debug-toolkit import <path>   # Import a knowledge pack into this project
```
Use knowledge packs to share hard-won debug knowledge across teams or seed a new project with known fixes. Exported packs include all diagnoses, causal chains, and confidence metadata.

### Memory Archival (automatic)
Old low-confidence entries are automatically archived and excluded from recall results. Entries are archived when their confidence score drops below the threshold due to age, file drift, or disuse. Archived entries are stored in `.debug/archive/` and never deleted — they can be manually reviewed but do not appear in search results.

## MCP Resource

### debug://methodology
Always-available debugging methodology. Covers the full workflow, anti-patterns to avoid, error pattern shortcuts, and guidance on causal chains, staleness, and pattern detection.

## Rules
1. NEVER skip debug_investigate for non-trivial errors. It's the highest-leverage step.
2. **Skip the toolkit** for obvious errors you can fix immediately (e.g., a clear typo the user just showed you). Use judgment — don't invoke MCP for a 2-second fix.
3. Read `nextStep` in every response — it tells you what to do.
4. If past solutions are found via `debug_recall`, apply the known fix directly without re-investigating. Use `debug_recall` first for recurring errors you've seen before.
5. If `debug_investigate` returns `triage: "trivial"`, apply the `fixHint` directly — skip instrumentation and capture.
5a. If `debug_investigate` returns a `proactiveSuggestion` (confidence >80%), apply the suggested fix directly — this is a high-confidence known fix. No further investigation needed.
6. For logic bugs, pass suspect file paths in the `files` parameter.
7. ALWAYS run debug_verify before claiming a fix works. It auto-saves the fix to memory on pass.
8. `debug_cleanup` is optional when no instrumentation was added and `debug_verify` passed. Use it to add a `rootCause` causal chain or remove instrumentation markers.
9. Run debug_patterns periodically to spot systemic issues. Act on `suggestions` — they prevent future bugs.
10. The `sessionId` from debug_investigate must be passed to all subsequent tool calls.
11. If `visualHint.isVisualBug` is true, use screenshot tools before attempting a fix.
12. Use debug_perf with `phase: "before"` before a perf fix and `phase: "after"` to confirm improvement.
