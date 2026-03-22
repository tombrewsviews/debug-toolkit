/**
 * methodology.ts — The debugging methodology, served as an MCP resource.
 *
 * This is the "hot memory" tier — always available, always loaded.
 * It teaches the agent HOW to debug, not just gives it tools.
 */

export const METHODOLOGY = `# Debug Toolkit — Methodology

## The Rule
Diagnosis quality matters more than fix quality.
A wrong diagnosis wastes 5-10 agent turns. A wrong fix wastes 1.
Invest time understanding the error before touching the code.

## The Workflow

### Step 1: Investigate (ALWAYS start here)
Call \`debug_investigate\` with the error text.
You get back: error classification, source code at the crash site,
git context, runtime environment, AND any past solutions for similar errors.

If past solutions are returned, check the \`stale\` field:
- \`stale: false\` → the code hasn't changed since. Trust the diagnosis.
- \`stale: true\` → the code has changed. The diagnosis may still apply but verify.

If a \`rootCause\` is included, it tells you exactly which file caused
the error last time and what was done to fix it. Start there.

### Step 2: Form Hypotheses
Based on the investigation, form 2-3 theories about the root cause.
Rank them by likelihood. The most common causes are:
- Null/undefined access (TypeError)
- Missing import or dependency (ReferenceError, ModuleNotFoundError)
- Wrong API usage (check framework version in environment)
- Stale state (recent git changes may have introduced it)
- Environment mismatch (wrong Node version, missing env var)

### Step 3: Probe (only if needed)
If the investigation didn't reveal the cause, use \`debug_instrument\`
to add logging at the suspicious code path. Then \`debug_capture\` to
see what values flow through at runtime.

Tag each instrument with a hypothesis so captures are linked.

### Step 4: Fix
Apply the minimal fix. Change as few lines as possible.
If you're changing more than 10 lines, you probably have the wrong diagnosis.

### Step 5: Verify
Call \`debug_verify\` with the test command. Check exit code AND error output.
Do not trust "it compiles" — silent failures are the #1 problem.

### Step 6: Cleanup
Call \`debug_cleanup\` with:
- \`diagnosis\`: one-line root cause summary
- \`rootCause\`: the causal chain (trigger, errorFile, causeFile, fixDescription)

This removes all instrumentation and saves BOTH the diagnosis and the
causal chain to memory. Future agents can follow the chain directly.

## Causal Chains
When calling \`debug_cleanup\`, always provide a rootCause object:
- \`trigger\`: what caused the error ("missing null check", "wrong import path")
- \`errorFile\`: where the error appeared (the stack trace pointed here)
- \`causeFile\`: where the actual bug was (may be different!)
- \`fixDescription\`: what you changed ("added null check before .map()")

This is the most valuable data in the system. It teaches future agents
not just WHAT the error was, but WHY it happened and WHERE to look.

## Staleness
Every diagnosis is tagged with the git SHA at the time it was saved.
When recalled, the system checks if the referenced files have changed.
Stale diagnoses are ranked lower but still shown — many bugs recur
even after code changes.

## Patterns
Call \`debug_patterns\` periodically to see:
- **Recurring errors**: same error type in the same file (3+ times = refactor it)
- **Hot files**: files that keep appearing in debug sessions (fragile code)
- **Regressions**: bugs that were fixed but came back (missing test coverage)
- **Error clusters**: multiple errors in a short time (cascading failure)

## Anti-Patterns
- DO NOT skip Step 1 and jump to fixing. You will guess wrong.
- DO NOT instrument 10 files at once. Start with 1-2.
- DO NOT ignore the \`nextStep\` field in tool responses.
- DO NOT leave instrumentation in place after fixing.
- DO NOT apply a fix without running \`debug_verify\`.
- DO NOT skip the \`rootCause\` in cleanup. It's the highest-value data.

## Error Pattern Shortcuts
- \`TypeError: Cannot read properties of undefined\` → check the variable one level up in the call chain
- \`ECONNREFUSED\` → the server/API is not running, period
- \`Cannot find module\` → run npm install, then check import path
- \`ENOENT\` → the file doesn't exist, check spelling and case
- \`ERR_MODULE_NOT_FOUND\` → ESM issue, check file extensions and type:module
- \`401/403\` → auth problem, check token/env vars
- \`500\` → server-side, look at backend logs not frontend
`;
