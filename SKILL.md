---
name: debug-toolkit
description: "Debugging toolkit with runtime context capture. MUST use for: any bug, error, issue, warning, crash, panic, layout problem, visual glitch, wrong behavior, performance issue, test failure, code review of running app, checking app health, reviewing errors, investigating issues. Read debug://status for live app state. Call debug_investigate for deep analysis."
tools: ["debug_investigate", "debug_recall", "debug_patterns", "debug_instrument", "debug_capture", "debug_verify", "debug_cleanup", "debug_session", "debug_perf", "debug_visual", "debug_setup"]
---

# debug-toolkit

A debugging toolkit via MCP that captures what's actually happening at runtime — terminal output, browser console, build errors, screenshots, performance metrics, and cross-session memory.

## Live Status: debug://status

**Read the `debug://status` resource to see what's happening right now.** It shows:
- Terminal errors/warnings (Rust panics, compiler warnings)
- Browser console errors (console.error, failed fetches, IPC errors)
- Build errors (Vite, tsc, webpack, ESLint)
- Tauri logs
- Active debug sessions

This is pre-processed and always current (updated every 5 seconds by the dev server).
Read it BEFORE investigating — it tells you what's wrong without any tool call.

## When to Activate

Call `debug_investigate` for deep analysis when the user mentions ANY of these:

**Direct triggers** — the user says:
- "bug", "error", "issue", "warning", "crash", "panic", "exception"
- "fix", "debug", "investigate", "diagnose", "troubleshoot"
- "broken", "fails", "doesn't work", "wrong", "unexpected"
- "review errors", "review issues", "check the app", "what's wrong"
- "layout", "overlap", "misaligned", "cut off", "hidden", "clipped"
- "flicker", "flash", "glitch", "visual", "looks wrong", "UI bug"
- "slow", "laggy", "performance", "takes too long", "freezes"
- "test failure", "test fails", "tests broken"

**Contextual triggers** — even if the user doesn't say "bug":
- User describes something that should work but doesn't
- User asks to review, check, or audit the running app
- User pastes a stack trace or error message
- User references console errors or warnings
- Build output shows errors or warnings
- User says "it crashes" or "it panics"

**Do NOT use the toolkit only when:**
- User asks for a new feature with no existing bug
- User asks to refactor working code
- User asks a question that doesn't involve a problem
- The fix is an obvious typo the user already identified

## Why Use the Toolkit Instead of Manual Exploration

`debug_investigate` returns in ONE call:
- Error classification with fix suggestions
- Source code at the crash site
- Git context (branch, recent changes to relevant files)
- **Live runtime output** from the running dev server:
  - Terminal errors, warnings, panics from the process
  - Browser console logs (console.error, console.warn, etc.)
  - Tauri log files (auto-discovered)
  - Build errors from Vite/tsc/webpack/ESLint
- Past solutions from memory (with confidence scores)
- Visual state capture (screenshot + DOM if Ghost OS connected)

Manual Read/Grep **misses all runtime context**. The agent that greps through files to find bugs is working blind — the toolkit gives you eyes.

## The Workflow

```
1. debug_investigate  → understand the bug + runtime context + past fixes + visual state
2. debug_visual       → capture screenshots/DOM if visual bug (auto if Ghost OS connected)
3. debug_perf         → profile if performance issue (requires Lighthouse)
4. debug_instrument   → add logging if investigation wasn't enough
5. debug_capture      → collect runtime output after changes
6. (apply fix)
7. debug_verify       → confirm fix works (auto-saves to memory)
8. debug_cleanup      → (optional) add rootCause chain or remove instrumentation
```

**Shortcuts:**
- Trivial errors → `debug_investigate` returns `triage: "trivial"` with `fixHint` — apply directly
- Past fix found → `proactiveSuggestion` with >80% confidence — apply directly
- Visual bug → auto-captures screenshot if Ghost OS is connected

## Tool Reference

### debug_investigate
**Start here. Always.** One call gives you everything — error classification, source code, runtime output, git context, past solutions.

```
# Runtime error (stack trace)
{ error: "<paste the stack trace>" }

# Layout/visual/behavior bug
{ error: "timestamps overlap when many items in timeline", files: ["src/Timeline.tsx", "src/index.css"] }

# Review running app for issues
{ error: "Review all errors and warnings in the running app", files: ["src/App.tsx"] }

# User bug report
{ error: "sidebar overlaps main content on resize", problem: "layout bug on resize" }
```

Output includes:
- `sessionId` — use in all subsequent calls
- `error` — type, category, severity, suggestion
- `sourceCode` — code at crash site or from hint files
- `git` — branch, recent changes to relevant files
- `buildErrors` — from dev server (Vite, tsc, webpack, ESLint)
- `runtimeContext` — **live output from the running app**:
  - `terminalErrors` — stderr/stdout errors, warnings, panics
  - `browserConsole` — console.log/warn/error from browser/webview
  - `tauriLogs` — Tauri-specific log files
  - `recentBuildErrors` — parsed build errors
  - `terminalBufferSize` / `browserBufferSize` — buffer sizes
- `pastSolutions` — previous fixes with staleness + confidence
- `proactiveSuggestion` — high-confidence past fix (>80%)
- `visualHint` — set for visual/CSS bugs
- `visualCapture` — screenshot + DOM state (if Ghost OS connected)
- `nextStep` — what to do next

### debug_visual
Capture visual state — screenshots, element inspection, annotated views, before/after comparison. **Requires Ghost OS.**

```
{ sessionId, action: "screenshot" | "inspect" | "annotate" | "compare" }
```

### debug_perf
Lighthouse performance profiling with before/after comparison.

```
{ sessionId, url: "http://localhost:1420", phase: "before" | "after" }
```

Returns: LCP, CLS, INP, TBT, Speed Index with deltas on "after" phase.

### debug_recall
Search past debug sessions for similar bugs.

```
{ query: "timestamps overlap in timeline", limit?: 5, explain?: true }
```

### debug_patterns
Detect systemic issues across all past sessions. No input required. Finds recurring errors, hot files, regressions.

### debug_instrument
Add tagged debug logging. Supports JS/TS, Python, Go, Rust.

```
{ sessionId, filePath, lineNumber, expression: "state.items.length", hypothesis?: "too many items causes overlap" }
```

### debug_capture
Run a command and capture output, or drain buffered terminal/browser events.

```
{ sessionId, command?: "npm test", limit?: 30 }
```

### debug_verify
Confirm a fix works. **Auto-saves to memory on pass.**

```
{ sessionId, command: "npm test", expectNoErrors?: true }
```

### debug_cleanup
Remove instrumentation and save diagnosis to memory.

```
{ sessionId, diagnosis?: "root cause was...", rootCause?: { trigger, errorFile, causeFile, fixDescription } }
```

### debug_session
Lightweight session status — hypotheses, active instruments, recent captures.

### debug_setup
Check and install integrations mid-conversation.

```
{ action: "check" | "install" | "connect" | "disconnect", integration?: "lighthouse" | "chrome" | "ghost-os" }
```

## Rules

1. **ALWAYS call debug_investigate first** — even for layout bugs, visual issues, or "review the app" requests. It gives you runtime context that Read/Grep can never provide.
2. **Never manually explore code for debugging** when the toolkit is available. The toolkit sees runtime state; file reading sees static code.
3. Skip the toolkit ONLY for obvious typos or trivial fixes the user already identified.
4. Read `nextStep` in every response — it tells you what to do.
5. If `triage: "trivial"` → apply `fixHint` directly.
6. If `proactiveSuggestion` with >80% confidence → apply directly.
7. If `visualHint.isVisualBug` → use `debug_visual` for screenshots before fixing.
8. For layout/visual bugs, ALWAYS pass suspect file paths in `files`.
9. ALWAYS run `debug_verify` before claiming a fix works.
10. The `sessionId` from `debug_investigate` must be passed to all subsequent calls.
