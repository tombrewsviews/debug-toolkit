---
name: stackpack-debug
description: "Runtime DevTools for AI agents. Captures terminal output, browser console, build errors, TypeScript errors, git diffs, and screenshots from the running app. MANDATORY for: any bug, error, issue, warning, crash, panic, layout problem, visual glitch, wrong behavior, performance issue, test failure, reviewing the running app, checking app health. Read debug://status FIRST — it's a live situation report. Read debug://errors for errors only. Call debug_investigate for deep analysis."
tools: ["debug_investigate", "debug_recall", "debug_patterns", "debug_instrument", "debug_capture", "debug_verify", "debug_cleanup", "debug_session", "debug_perf", "debug_visual", "debug_setup"]
---

# stackpack-debug — Runtime DevTools for AI Agents

The toolkit captures what's actually happening at runtime — terminal output, browser console, build errors, TypeScript errors, git diffs, screenshots, and cross-session memory. It gives you the same signals a developer sees in browser DevTools and terminal.

## CRITICAL: Read debug://status FIRST

**Before ANY investigation, read the `debug://status` resource.** It's a live situation report containing:
- Full terminal output (not just errors — app state logs too)
- Browser console (all logs, errors, warnings, network failures)
- Build errors (Vite, tsc, webpack, ESLint)
- TypeScript errors (proactive `tsc --noEmit`)
- Git activity (recent commits, uncommitted changes)
- Tauri logs (auto-discovered)
- Active debug sessions

This is updated every 5 seconds. It tells you what's happening RIGHT NOW without any tool call.

## Quick Error Check: debug://errors

**Read `debug://errors` when you only need errors.** Compact, deduplicated view of errors/warnings from ALL sources (terminal, browser, build, TypeScript). No noise, no app logs — just signal.

## When to Activate — MANDATORY

**You MUST use the toolkit when the user mentions ANY of these:**

- "bug", "error", "issue", "warning", "crash", "panic", "exception"
- "fix", "debug", "investigate", "diagnose", "troubleshoot"
- "broken", "fails", "doesn't work", "wrong", "unexpected"
- "review errors", "review issues", "check the app", "what's wrong"
- "layout", "overlap", "misaligned", "cut off", "hidden", "clipped"
- "flicker", "flash", "glitch", "visual", "looks wrong", "UI bug"
- "slow", "laggy", "performance", "takes too long", "freezes"
- "test failure", "test fails", "tests broken"
- User describes something that should work but doesn't
- User asks to review, check, or audit the running app
- User pastes a stack trace, error message, or console output
- User references console errors, build warnings, or compiler output
- User says "it crashes", "it panics", "it shows an error"

**Do NOT use only when:**
- User asks for a brand new feature with no existing bug
- User asks to refactor working code with no problems
- The fix is an obvious typo the user already identified

## Why This Beats Manual File Reading

`debug_investigate` returns in ONE call what would take 20+ file reads:

| What you get | Manual approach | Toolkit |
|---|---|---|
| Source code at crash site | Read 3-5 files guessing | 50-line window around exact line |
| Runtime errors | Ask user to paste | Auto-captured from terminal |
| Browser console | Cannot access | All console.log/warn/error |
| TypeScript errors | Run tsc yourself | Auto-runs tsc --noEmit |
| Git changes | Run git diff yourself | Actual diff content included |
| Build errors | Check terminal yourself | Parsed and structured |
| Past solutions | Don't exist | Cross-session memory with confidence |
| Visual state | Cannot see | Screenshot + DOM via Ghost OS |

**Never manually grep/read files for debugging when the toolkit is available.** The toolkit sees runtime state; file reading sees static code.

## The Workflow

```
1. Read debug://status         → see what's happening right now
2. debug_investigate            → deep analysis with runtime context + memory
3. debug_visual                 → screenshot/DOM if visual bug
4. debug_perf                   → profile if performance issue
5. (apply fix)
6. debug_verify                 → confirm fix works (auto-saves to memory)
```

**Shortcuts:**
- `triage: "trivial"` → apply `fixHint` directly
- `proactiveSuggestion` with >80% confidence → apply directly
- `visualHint.isVisualBug` → use `debug_visual` for screenshots

## Tool Reference

### debug_investigate
**Start here. Always.** Returns: error classification, source code (50-line window), runtime output (terminal + browser + Tauri logs), TypeScript errors, git diff content, build errors, past solutions, visual state.

```
# Runtime error
{ error: "<stack trace>" }

# Layout/behavior bug
{ error: "timestamps overlap in timeline", files: ["src/Timeline.tsx"] }

# Review running app
{ error: "Review all errors and warnings", files: [] }
```

### debug_visual
Screenshot, element inspection, annotated view, before/after comparison. **Requires Ghost OS.**
```
{ sessionId, action: "screenshot" | "inspect" | "annotate" | "compare" }
```

### debug_perf
Lighthouse performance profiling with before/after comparison.
```
{ sessionId, url: "http://localhost:1420", phase: "before" | "after" }
```

### debug_recall
Search past debug sessions for similar bugs.
```
{ query: "timestamps overlap in timeline", limit?: 5 }
```

### debug_patterns
Detect systemic issues across all past sessions. Finds recurring errors, hot files, regressions.

### debug_instrument
Add tagged debug logging. Supports JS/TS, Python, Go, Rust.
```
{ sessionId, filePath, lineNumber, expression: "state.items.length" }
```

### debug_capture
Run a command and capture output, or drain buffered events. SessionId is optional — omit to read console output directly.
```
{ command?: "npm test", source?: "browser", filter?: "SCROLL-DEBUG", level?: "error" }
```

### debug_verify
Confirm a fix works. **Auto-saves to memory on pass.**
```
{ sessionId, command: "npm test", expectNoErrors?: true }
```

### debug_cleanup
Remove instrumentation and save diagnosis to memory.
```
{ sessionId, diagnosis?: "root cause was..." }
```

### debug_session
Lightweight session status.

### debug_setup
Check/install integrations, check for updates, or update stackpack-debug.
```
{ action: "check" | "install" | "connect" | "disconnect" | "check-update" | "update" }
```
- `check-update` — compare installed version against npm registry
- `update` — update stackpack-debug to latest, then restart Claude Code

## Rules

1. **Read `debug://status` BEFORE investigating.** It's free context.
2. **ALWAYS call `debug_investigate` for any bug.** Even layout bugs, visual issues, or "review the app" requests.
3. **Never manually explore code for debugging** when the toolkit is available. The toolkit sees runtime state that files cannot show.
4. Read `nextStep` in every response — it tells you what to do.
5. If `proactiveSuggestion` with >80% confidence → apply directly, then verify.
6. For visual bugs, pass suspect file paths in `files` AND use `debug_visual`.
7. **ALWAYS run `debug_verify` before claiming a fix works.**
8. Pass `sessionId` from `debug_investigate` to all subsequent calls.
