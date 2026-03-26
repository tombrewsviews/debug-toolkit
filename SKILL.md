---
name: debug-toolkit
description: "Closed-loop debugging for AI agents. Use for ALL bugs — runtime errors, layout issues, visual glitches, wrong behavior, performance problems, test failures. Provides runtime context, screenshots, browser capture, performance profiling, and cross-session memory. ALWAYS start with debug_investigate before reading code manually."
tools: ["debug_investigate", "debug_recall", "debug_patterns", "debug_instrument", "debug_capture", "debug_verify", "debug_cleanup", "debug_session", "debug_perf", "debug_visual", "debug_setup"]
---

# debug-toolkit

You have a debugging toolkit via MCP. These tools let you SEE code running — not just read and write it. They capture browser state, take screenshots, profile performance, and learn from every session.

## IMPORTANT: Always Use the Toolkit First

**Do NOT debug manually** (exploring code with Read/Grep/Agent) when debug-toolkit is available. Call `debug_investigate` FIRST — it gives you error classification, source context, git history, build errors, browser state, AND past solutions in one call.

The toolkit is your primary debugging tool. Use it for:
- Runtime errors and stack traces
- Layout bugs ("overlaps", "misaligned", "broken on resize")
- Visual glitches ("flickers", "wrong color", "disappears")
- Wrong behavior ("should do X but does Y")
- Performance issues ("slow", "laggy", "takes too long")
- Test failures
- Any bug report from the user

## The Workflow

```
1. debug_investigate  → understand the bug + auto-recall past fixes + auto-capture visual state
2. debug_visual       → capture screenshots/DOM if visual bug (auto if Ghost OS connected)
3. debug_perf         → profile if performance issue (requires Lighthouse)
4. debug_instrument   → add logging if investigation wasn't enough
5. debug_capture      → collect runtime output
6. (apply fix)
7. debug_verify       → confirm fix works (auto-saves to memory)
8. debug_cleanup      → (optional) add rootCause chain or remove instrumentation
```

**Shortcuts:**
- Trivial errors → `debug_investigate` returns `triage: "trivial"` with `fixHint` — apply directly
- Past fix found → `proactiveSuggestion` with >80% confidence — apply directly
- Visual bug → `debug_investigate` auto-captures screenshot if Ghost OS is connected

## Tool Reference

### debug_investigate
**Start here. Always.** Works for runtime errors, logic bugs, layout issues, and visual problems.

```
# Runtime error (stack trace)
Input: { error: "<stack trace>" }

# Layout/visual/behavior bug (no stack trace)
Input: { error: "timestamps overlap when many items in timeline", files: ["src/Timeline.tsx", "src/index.css"] }

# Bug report from user
Input: { error: "sidebar overlaps main content on resize", problem: "layout bug on resize" }
```

Output includes:
- `sessionId` — use in all subsequent calls
- `error` — type, category, severity, suggestion
- `sourceCode` — code at crash site or from hint files
- `git` — branch, recent changes to relevant files
- `buildErrors` — auto-captured from dev server (Vite, tsc, webpack, ESLint)
- `pastSolutions` — previous fixes for similar bugs (with staleness + confidence)
- `proactiveSuggestion` — high-confidence past fix (>80%) — apply directly
- `visualHint` — set when visual/CSS bug detected: `{ isVisualBug, message, suggestedActions }`
- `visualCapture` — auto-captured screenshot + DOM state (if Ghost OS connected)
- `nextStep` — what to do next

### debug_visual
Capture visual state — screenshots, element inspection, annotated views, before/after comparison. **Requires Ghost OS.**

```
Input: { sessionId, action: "screenshot" | "inspect" | "annotate" | "compare" }
```

Actions:
- `screenshot` — capture current screen state
- `inspect` — find elements by query (`query` param)
- `annotate` — labeled screenshot with numbered interactive elements
- `compare` — before/after comparison (requires previous screenshot)

Use this for layout bugs, visual glitches, CSS issues, responsive problems. The screenshot gives you ground truth about what the user actually sees.

### debug_perf
Lighthouse performance profiling. Capture Web Vitals before and after a fix.

```
Input: { sessionId, url: "http://localhost:1420", phase: "before" | "after" }
```

Returns: LCP, CLS, INP, TBT, Speed Index. On `phase: "after"`, includes delta comparison showing improvement/regression for each metric.

Use for: slow page loads, jank, layout shift, interaction delay.

### debug_recall
Search past debug sessions for similar bugs. Returns diagnoses ranked by relevance.

```
Input: { query: "timestamps overlap in timeline", limit?: 5, explain?: true }
```

Each match includes `diagnosis`, `rootCause`, `confidence`, `stale` (whether code changed since fix).

### debug_patterns
Detect systemic issues across all past sessions. No input required.

Detects: recurring errors, hot files, regressions, error clusters. Returns preventive suggestions.

### debug_instrument
Add tagged debug logging to source files. Linked to hypotheses for tracking.

```
Input: { sessionId, filePath, lineNumber, expression: "state.items.length", hypothesis?: "too many items causes overlap" }
```

Supports JS/TS, Python, Go, Rust. Markers tagged `[DBG_001]` for capture linking.

### debug_capture
Run a command and capture output, or drain buffered terminal/browser events.

```
Input: { sessionId, command?: "npm test", limit?: 30 }
```

Returns tagged captures linked to hypotheses, errors separated from normal output. Auto-reads Tauri logs.

### debug_verify
After applying a fix, confirm it works. **Auto-saves to memory on pass.**

```
Input: { sessionId, command: "npm test", expectNoErrors?: true }
```

If Ghost OS connected and a "before" screenshot exists, auto-captures "after" screenshot for visual comparison.

### debug_cleanup
Remove instrumentation and save diagnosis to memory. **Optional** if no instrumentation was added and `debug_verify` passed.

```
Input: { sessionId, diagnosis?: "root cause was...", rootCause?: { trigger, errorFile, causeFile, fixDescription } }
```

**Always provide `diagnosis` AND `rootCause`** — this is the most valuable data for future sessions.

### debug_session
Lightweight session status — hypotheses, active instruments, recent captures.

### debug_setup
Check and install integrations (Lighthouse, Chrome, Ghost OS). The agent can install missing tools mid-conversation.

```
Input: { action: "check" | "install" | "connect" | "disconnect", integration?: "lighthouse" | "chrome" | "ghost-os" }
```

## Integrations

### Ghost OS (visual debugging)
When connected, provides screenshots, DOM inspection, and element annotation. Auto-captures on visual bugs detected by `debug_investigate`. Install via `debug_setup({ action: "install", integration: "ghost-os" })`.

### Lighthouse (performance profiling)
Captures Web Vitals for any URL. Use `debug_perf` with before/after comparison to measure fix impact. Install via `debug_setup({ action: "install", integration: "lighthouse" })`.

### Claude Preview
When available, provides browser preview screenshots and DOM snapshots as an alternative to Ghost OS.

## MCP Resource

### debug://methodology
Always-available debugging methodology. Read this before your first session.

## Rules

1. **ALWAYS call debug_investigate first** for any bug — even layout and visual issues. Never skip it to grep through code.
2. Skip the toolkit ONLY for obvious typos or 2-second fixes where the user already showed you the answer.
3. Read `nextStep` in every response — it tells you what to do.
4. If `triage: "trivial"` → apply `fixHint` directly.
5. If `proactiveSuggestion` with >80% confidence → apply directly.
6. If `visualHint.isVisualBug` is true → use `debug_visual` to capture screenshots before fixing.
7. For layout/visual bugs, ALWAYS pass suspect file paths in the `files` parameter.
8. ALWAYS run `debug_verify` before claiming a fix works.
9. For performance bugs, use `debug_perf` with `phase: "before"` and `phase: "after"`.
10. The `sessionId` from `debug_investigate` must be passed to all subsequent calls.
11. Run `debug_patterns` periodically to spot systemic issues.
