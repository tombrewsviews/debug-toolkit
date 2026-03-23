---
name: debug-toolkit
description: "Closed-loop debugging for AI agents. Use for runtime errors, stack traces, test failures, AND logic/behavior bugs (wrong output, visual mismatch, unexpected values). Provides error classification, source context, git history, cross-session memory with staleness detection and causal chains, and pattern detection. Start every debugging task with debug_investigate."
tools: ["debug_investigate", "debug_recall", "debug_patterns", "debug_instrument", "debug_capture", "debug_verify", "debug_cleanup", "debug_session"]
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

**ALWAYS start with `debug_investigate`.** It auto-recalls past solutions.

```
1. debug_investigate  → understand the error + auto-recall past fixes
2. debug_instrument   → add logging if investigation wasn't enough
3. debug_capture      → collect runtime output
4. (apply fix)        → edit the code
5. debug_verify       → confirm the fix works
6. debug_cleanup      → remove markers, save diagnosis + causal chain to memory
```

## Tool Reference

### debug_investigate
**Start here.** Works for BOTH runtime errors AND logic bugs. Auto-searches debug memory for past solutions.

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
- `nextStep` — what to do next

### debug_recall
Explicitly search past debug sessions. Returns diagnoses ranked by relevance with staleness info and causal chains.
```
Input: { query: "TypeError Cannot read properties email", limit?: 5 }
```
Each match includes:
- `diagnosis` — what was found last time
- `rootCause` — `{ trigger, errorFile, causeFile, fixDescription }`
- `stale` — whether the referenced files have changed since the diagnosis
- `staleness` — reason if stale (e.g., "2 file(s) changed in 3 commit(s)")
- `relevance` — keyword overlap percentage

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
After applying a fix, run this to confirm it works. Reports pass/fail with evidence.
```
Input: { sessionId, command: "npm test", expectNoErrors?: true }
```
Output: `{ passed, exitCode, errorCount, errors, output }`

### debug_cleanup
Remove ALL instrumentation from source files, verify removal, and save diagnosis to memory.
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

## MCP Resource

### debug://methodology
Always-available debugging methodology. Covers the full workflow, anti-patterns to avoid, error pattern shortcuts, and guidance on causal chains, staleness, and pattern detection.

## Rules
1. NEVER skip debug_investigate. It's the highest-leverage step.
2. Read `nextStep` in every response — it tells you what to do.
3. If past solutions are found, check `stale` — fresh solutions can be trusted.
4. For logic bugs, pass suspect file paths in the `files` parameter.
5. ALWAYS run debug_verify before claiming a fix works.
6. ALWAYS provide both `diagnosis` AND `rootCause` in debug_cleanup — it teaches the system.
7. Run debug_patterns periodically to spot systemic issues.
8. The `sessionId` from debug_investigate must be passed to all subsequent tool calls.
