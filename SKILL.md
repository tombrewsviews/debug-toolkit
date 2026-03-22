---
name: debug-toolkit
description: Closed-loop debugging for AI agents with cross-session memory. Investigate errors, recall past fixes, detect patterns, instrument code, capture output, verify fixes, auto-cleanup with causal chains. Start every debugging task with debug_investigate.
tools: ["debug_investigate", "debug_recall", "debug_patterns", "debug_instrument", "debug_capture", "debug_verify", "debug_cleanup", "debug_session"]
---

# debug-toolkit

You have access to a debugging toolkit via MCP. These tools let you SEE code running — not just read and write it. They also learn from every debug session and get smarter over time.

## When to Use

Use these tools whenever you encounter:
- A runtime error or stack trace
- A test failure
- Code that runs but produces wrong output
- A bug report from the user

## The Workflow

**ALWAYS start with `debug_investigate`.** It auto-recalls past solutions.

```
1. debug_investigate  → understand the error + auto-recall past fixes
2. debug_instrument   → add logging if investigation wasn't enough
3. debug_capture      → collect runtime output
4. (apply fix)        → edit the code
5. debug_verify       → confirm the fix works
6. debug_cleanup      → remove markers, save diagnosis + causal chain
```

## Tool Reference

### debug_investigate
**Start here.** Parses error text, finds source files, shows the exact lines, gets git context. Auto-searches memory for past solutions with staleness info.
```
Input: { error: "<stack trace>", problem?: "description" }
Output: { error, sourceCode, git, environment, pastSolutions?, nextStep }
```
Past solutions include `stale` (has code changed?) and `rootCause` (causal chain from last fix).

### debug_recall
Explicitly search past debug sessions. Returns diagnoses with staleness and causal chains.
```
Input: { query: "TypeError Cannot read properties email" }
Output: { matches: [{ problem, diagnosis, stale, staleness?, rootCause? }] }
```

### debug_patterns
Detect patterns across ALL past sessions. Use periodically.
```
Input: {}
Output: { patterns: [{ type, severity, message }] }
```
Pattern types: `recurring_error`, `hot_file`, `regression`, `error_cluster`.

### debug_instrument
Add tagged logging. Each marker links to a hypothesis.
```
Input: { sessionId, filePath, lineNumber, expression: "req.body", hypothesis?: "body is undefined" }
```

### debug_capture
Run a command and capture output, or drain buffered events.
```
Input: { sessionId, command?: "npm test", limit?: 30 }
```

### debug_verify
After applying a fix, run the test command and check pass/fail.
```
Input: { sessionId, command: "npm test" }
```

### debug_cleanup
Remove ALL instrumentation, save diagnosis + causal chain to memory.
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
**Always provide rootCause** — it's the most valuable data for future sessions.

### debug_session
Lightweight view of current session state.
```
Input: { sessionId }
```

## Rules
1. NEVER skip debug_investigate. It's the highest-leverage step.
2. Read `nextStep` in every response — it tells you what to do.
3. If past solutions are found, check `stale` — fresh solutions can be trusted.
4. Instrument 1-2 files, not 10. Narrow first.
5. ALWAYS run debug_verify before claiming a fix works.
6. ALWAYS provide `rootCause` in debug_cleanup — it teaches the system.
7. Run debug_patterns periodically to spot systemic issues.
