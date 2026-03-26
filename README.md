# debug-toolkit

Closed-loop debugging for AI coding agents. One MCP server gives your agent the ability to **see code running** — not just read and write it.

```
npx debug-toolkit demo            # see it work (no AI needed)
npx debug-toolkit init            # install in your project
npx debug-toolkit export [path]   # export debug memory as a knowledge pack
npx debug-toolkit import <path>   # import a knowledge pack into this project
```

## What's New in v0.10

- **Write-Ahead Log (WAL)** — Memory mutations (`timesRecalled` increments, archival flags) are appended as single JSON lines instead of rewriting the entire file. Full compaction only runs when the WAL exceeds 50 entries or 100KB. `recall()` went from O(full file I/O) to O(append one line).
- **Store cache with mtime validation** — `loadStore()` now caches the deserialized store and checks the file's `mtime` before re-reading. Repeated reads in the same session hit memory, not disk.
- **Multi-project index safety** — The inverted index now uses a per-`cwd` cache map (up to 5 projects) instead of a single global variable. Two projects in the same MCP process no longer share/corrupt each other's search index.
- **Incremental index updates** — `remember()` adds the new entry's keywords directly to the cached index instead of invalidating and rebuilding from scratch. Full rebuild only happens on WAL compaction.
- **Staleness TTL cache** — Git staleness checks are cached for 5 minutes per entry. Repeated `recall()` calls within that window skip all `git log` subprocess spawns entirely.
- **Pattern detection cache** — `detectPatterns()` results are cached by a generation counter that only increments on actual mutations. Calling `debug_patterns` twice without changes returns instantly.
- **Deferred archival** — `archiveStaleMemories()` moved out of the hot path. It now runs at most once per hour (on MCP startup and `debug_cleanup`), not on every recall/patterns/stats call.
- **Physical purge** — Archived entries are moved to `.debug/archive/YYYY-MM.json` monthly files and removed from `memory.json`. The main file actually shrinks. `exportPack` can include archived entries with `includeArchived: true`.
- **Budget overflow guard** — `fitToBudget` now guarantees responses fit the token target. If progressive compression isn't enough, a nuclear option strips everything except preserved keys. The `_budget` metadata includes `overflowHandled: true` when this fires.

## What's New in v0.9

- **Inverted index recall** — Memory search is now O(1) via a prebuilt inverted index instead of linear scan. The index maps keywords → entry IDs, is cached in-memory, and auto-invalidates on writes. Recall is now instant regardless of memory size.
- **Batch git staleness** — Replaced N+1 `git rev-list` calls (one per file per entry) with a single `git log --name-only` per SHA. Staleness checking is now 10–50x faster for entries referencing multiple files.
- **Token budget system** — Every `debug_investigate` response is now auto-compressed to fit within a 4,000-token budget. Progressive compression: truncates arrays → shortens strings → summarizes objects → strips environment data. Preserved keys (`nextStep`, `rootCause`, `severity`) are never truncated.
- **Explain mode** — Pass `explain: true` to `debug_recall` to see WHY each result scored its confidence level, with a factor-by-factor breakdown (age, file drift, usage) and an interpretation for each. `debug_investigate` also includes a `_triageExplanation` showing why the error was classified as trivial/medium/complex.
- **Conditional instrumentation** — `debug_instrument` now accepts a `condition` parameter. Pass `"value === null"` or `"count > 100"` and the logging wraps in an `if` block — works across JS/TS, Python, Go, and Rust. No more log spam for high-frequency code paths.
- **Debug telemetry** — Every verified fix is tracked in `.debug/telemetry.json` with outcome (fixed/workaround/abandoned), duration, error type, and whether memory was used. `debug_patterns` now includes a telemetry section with fix rate, memory effectiveness, and top error types. `debug_investigate` shows historical fix rates for recognized error types.

## What's New in v0.8

- **Confidence scoring** — recall results now include a `confidence` percentage (0–100) for each past fix. Confidence is computed from entry age, file drift since the fix was recorded, and how many times the fix has been successfully applied. Higher confidence = more reliable fix, so agents can prioritize the most trustworthy solutions first.
- **Proactive memory** — `debug_investigate` now surfaces a `proactiveSuggestion` when a past fix with >80% confidence matches the current error. The suggestion includes the diagnosis, root cause, and a `fixHint` — the agent can apply it directly without running the full investigation pipeline.
- **Knowledge packs** — export and import debug memory across projects. `npx debug-toolkit export [path]` writes a portable `.json` pack; `npx debug-toolkit import <path>` seeds a project with it. Share hard-won fixes across teams or bootstrap a new repo with known solutions.
- **Memory archival** — stale, low-confidence entries are automatically archived and excluded from recall results. Archived entries live in `.debug/archive/` and are never deleted, but they stay out of search results to keep recall fast and relevant.

## What's New in v0.7

- **Smart triage gate** — `debug_investigate` now auto-triages errors before running the full pipeline. Trivial errors (syntax mistakes, missing imports, obvious typos) get a fast-path response with `triage: "trivial"` and a `fixHint` in under 100ms. Complex errors still get the full investigation.
- **Auto-learning** — fixes now auto-save to memory when `debug_verify` passes. No need to call `debug_cleanup` just to persist a diagnosis. `debug_cleanup` is now optional — use it when you want to add a custom `rootCause` causal chain or remove instrumentation markers.
- **Preventive suggestions** — `debug_patterns` now returns a `suggestions` array alongside detected patterns. Each suggestion has a `category` (lint, config, refactor, test, dependency), `priority`, `action`, and `rationale` — so the agent can proactively fix systemic issues before they recur.
- **Smarter activation rules** — updated SKILL.md guidance: skip the toolkit for obvious 2-second fixes, use `debug_recall` first for recurring errors, and fast-path trivial triage responses without instrumentation.

## What's New in v0.6

- **Build error auto-capture** — Vite, tsc, webpack, and ESLint errors are detected automatically from the dev server. `debug_investigate` now returns a `buildErrors` array so the agent sees compile/lint failures without manual log hunting.
- **Visual bug detection** — Investigation responses include a `visualHint` field when a CSS or rendering bug is detected. It flags `isVisualBug`, explains the issue, and suggests using screenshot tools before attempting a fix.
- **Lighthouse performance snapshots** — New `debug_perf` tool captures Web Vitals (LCP, CLS, INP, TBT, Speed Index) for any URL. Supports before/after comparison to confirm performance fixes.
- **Extended session model** — Sessions now carry visual context (screenshot references) and performance data alongside the existing error, instrumentation, and memory state.

## See It Work

Run `npx debug-toolkit demo` — creates a temp project with a real bug, walks through the full debug loop, no AI needed:

```
━━━ Step 1: debug_investigate ━━━
  tool: debug_investigate
  ✓ Error type: TypeError — type
  ✓ Source: src/api.ts:8
     >> 8 |   const names = users.map(u => u.name);  // BUG: users can be undefined
  ✓ Suggestion: Check for null/undefined values being accessed as objects

━━━ Step 2: debug_instrument ━━━
  tool: debug_instrument
  ✓ Marker: DBG_001
  ✓ Hypothesis: "getUsers() returns undefined"

━━━ Step 3: debug_capture ━━━
  tool: debug_capture
  ✓ Tagged output: [DBG_001] users = undefined
  ✓ Hypothesis confirmed → CONFIRMED

━━━ Step 5: debug_verify ━━━
  ✓ Exit code: 0   ✓ Errors: 0   ✓ Verdict: PASSED

━━━ Step 6: debug_cleanup ━━━
  ✓ Diagnosis saved to memory
  ✓ Causal chain: src/api.ts (error) → src/db.ts (cause)

━━━ Step 7: debug_recall (new session, same error) ━━━
  ✓ Past diagnosis found: 67% relevance
  ✓ Root cause: getUsers() returns undefined when db not connected
  ✓ Look at: src/db.ts (not src/api.ts)
  → Agent can skip investigation entirely and apply the known fix!

━━━ Step 8: debug_patterns ━━━
  [WARNING] TypeError has occurred 4 times in src/api.ts
  [WARNING] Possible regression: was fixed before but reappeared
```

<details>
<summary>Full demo output (value report)</summary>

```
┌─────────────────────────────────────────────────────────┐
│  VALUE REPORT                                           │
└─────────────────────────────────────────────────────────┘
  What the agent gathered in one debug session:

    ✓ Error classification     TypeError, type error, severity high
    ✓ Source code at crash     Exact line with surrounding context
    ✓ Git context              Branch, commit, recent changes
    ✓ Runtime environment      Node version, frameworks, env vars (redacted)
    ✓ Instrumented values      users = undefined (tagged, linked to hypothesis)
    ✓ Verification result      Exit code 0, 0 errors
    ✓ Causal chain             error in api.ts caused by bug in db.ts
    ✓ Diagnosis persisted      Searchable in future sessions
    ✓ Git SHA tagged           Staleness detection for future recall
    ✓ Pattern detection        Recurring errors, hot files, regressions

  Data points collected: 17
  Time elapsed: 2.9s
  Memory entries: 4
  Patterns detected: 5

  Without debug-toolkit:
    User pastes error → agent guesses fix → repeat 5-8 times
    Typical: 8-12 conversation turns, no learning

  With debug-toolkit:
    investigate → instrument → capture → fix → verify → cleanup
    1-2 turns with full context. Diagnosis saved for next time.
```

</details>

## The Problem

When an AI agent hits a bug, it reads code and guesses a fix. You run it, paste the error back, the agent guesses again. Repeat 5-8 times.

debug-toolkit eliminates that loop. The agent investigates the error, instruments the code, captures runtime output, verifies the fix, and cleans up — all through MCP tool calls. No copy-pasting. No manual log hunting.

## How It Works

```
investigate → instrument → capture → fix → verify → cleanup
```

One debug session. Full context. Diagnosis saved for next time.

```
┌─────────────────────────────────────────────────────────┐
│  Agent gets error from user                             │
│  ↓                                                      │
│  debug_investigate  → error type, source code, git,     │
│                       environment, past solutions        │
│  ↓                                                      │
│  debug_instrument   → adds tagged logging to source     │
│  ↓                                                      │
│  debug_capture      → collects runtime output           │
│  ↓                                                      │
│  Agent applies fix                                      │
│  ↓                                                      │
│  debug_verify       → runs tests, confirms fix          │
│  ↓                                                      │
│  debug_cleanup      → removes markers, saves diagnosis  │
│                       + causal chain to memory           │
│  ↓                                                      │
│  Next session: debug_investigate auto-recalls the fix   │
└─────────────────────────────────────────────────────────┘
```

## Setup

### Any project (JS/TS/Python/Go)

```bash
npx debug-toolkit init
```

Generates `.claude/mcp.json`, installs a pre-commit safety hook, detects your dev command. Restart Claude Code and you're done.

### Tauri projects (auto-detected)

```bash
cd my-tauri-app
npx debug-toolkit init
```

If `src-tauri/` exists, debug-toolkit automatically:
- Sets dev command to `cargo tauri dev`
- Enables `RUST_BACKTRACE=1` and `RUST_LOG=info`
- Parses Rust panics, backtraces, and cargo build errors
- Discovers and tails `tauri-plugin-log` files from platform-specific paths
- Detects Tauri-specific errors (invoke, capability, plugin, window, asset)

### Manual MCP config

Add to `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "debug-toolkit": {
      "command": "npx",
      "args": ["-y", "debug-toolkit"]
    }
  }
}
```

## Two Modes

**Pure MCP** (default) — Just the MCP server on stdio. Agent gets all tools. No wrapper needed.

```bash
npx debug-toolkit
```

**Serve** — Wraps your dev server. Adds browser console/network capture via HTTP proxy + WebSocket.

```bash
npx debug-toolkit serve -- npm run dev
npx debug-toolkit serve -- cargo tauri dev
```

## Tools

### debug_investigate

**Start here.** Give it an error message or stack trace. Returns:

- Error classification (type, category, severity, suggestion)
- Source code at the exact crash site (highlighted)
- Git context (branch, commit, recent changes to those files)
- Runtime environment (Node/Rust version, frameworks, env vars — secrets redacted)
- Past solutions from memory (with staleness info and causal chains)

```
Input:  { error: "TypeError: Cannot read properties of undefined (reading 'map')" }
Output: { error, sourceCode, git, environment, pastSolutions, nextStep }
```

### debug_recall

Search past debug sessions for similar errors. Returns diagnoses ranked by relevance, with staleness tracking (has the code changed since?) and causal chains (where was the actual bug?).

```
Input:  { query: "TypeError undefined map" }
Output: { matches: [{ diagnosis, stale, rootCause }] }
```

### debug_patterns

Detect systemic issues across all past sessions:

| Pattern | What it finds |
|---------|--------------|
| **Recurring error** | Same error type in same file, 3+ times |
| **Hot file** | Files in 15%+ of debug sessions |
| **Regression** | Bug fixed once, came back |
| **Error cluster** | Multiple errors within 2 hours |

### debug_instrument

Add tagged logging to source files. Supports JS/TS, Python, Go, and Rust:

| Language | Output |
|----------|--------|
| JS/TS | `console.log("[DBG_001]", expr)` |
| Python | `print(f"[DBG_001] {expr}")` |
| Go | `fmt.Printf("[DBG_001] %v\n", expr)` |
| Rust | `eprintln!("[DBG_001] {:?}", expr)` |

Each marker links to a hypothesis. Respects indentation. Auto-cleans on cleanup.

### debug_capture

Run a command and capture output, or drain buffered events from terminal, browser, and Tauri log files. Tagged output is linked to hypotheses. Results are paginated.

### debug_verify

After applying a fix, run the test command and get a clear pass/fail with exit code and error output.

### debug_cleanup

Remove ALL instrumentation, verify files are restored, and save the diagnosis + causal chain to memory. Provide `rootCause` to teach the system where the actual bug was:

```json
{
  "diagnosis": "getUsers() returns undefined when db not connected",
  "rootCause": {
    "trigger": "missing db.connect() call",
    "errorFile": "src/api.ts",
    "causeFile": "src/db.ts",
    "fixDescription": "added connect() before query"
  }
}
```

### debug_session

Lightweight view of current state: hypotheses, active instruments, recent captures.

### debug_perf

Capture a Lighthouse performance snapshot for a URL. Pass `phase: "before"` before a fix and `phase: "after"` to get a comparison.

```
Input:  { sessionId, url, phase?: "before" | "after" }
Output: { LCP, CLS, INP, TBT, speedIndex, comparison? }
```

## Memory System

debug-toolkit learns from every session:

**Recall** — When you investigate a new error, it auto-searches past diagnoses. If a similar error was solved before, the agent gets the previous diagnosis, which files were involved, and the causal chain.

**Staleness** — Every diagnosis is tagged with the git SHA. When recalled, the system checks if the referenced files have changed. Stale diagnoses are flagged but still shown.

**Causal chains** — Records where the error appeared vs. where the actual bug was. Next time, the agent goes straight to the cause file instead of the symptom.

**Patterns** — Detects recurring errors, hot files, regressions, and error clusters across all sessions.

## Language Support

| Feature | JS/TS | Python | Go | Rust/Tauri |
|---------|-------|--------|----|------------|
| Stack trace parsing | Node.js frames | Python tracebacks | — | Panics, backtraces, cargo errors |
| Error classification | TypeError, ReferenceError, etc. | — | — | Panic, borrow, Tauri IPC/capability/plugin |
| Code instrumentation | `console.log` | `print()` | `fmt.Printf` | `eprintln!` |
| Source extraction | Yes | Yes | Yes | Yes |
| Log file tailing | — | — | — | `tauri-plugin-log` auto-discovery |
| Environment detection | package.json, frameworks | Python version | — | Cargo.toml, tauri.conf.json, plugins |

## Security

- **Path traversal protection** — all file operations validated against project root
- **Expression validation** — blocks `eval`, `require`, `exec` in instrumentation
- **Secret redaction** — tokens, API keys, passwords, JWTs auto-redacted before storage
- **Localhost-only proxy** — binds to 127.0.0.1
- **Pre-commit hook** — blocks commits containing debug markers
- **Atomic writes** — temp file + rename, no corruption on crash
- **`.debug/` auto-gitignored**

## Testing the New Features

### Run the test suite

```bash
npm test                    # 63 tests across 15 files
npm run test:watch          # watch mode
```

### Test Phase 1: Visual + Build Integration

**Build error capture:**
1. Run `npx debug-toolkit serve -- npm run dev` on a Vite project
2. Introduce a CSS error (e.g., misplace an `@import`)
3. Call `debug_investigate` — the `buildErrors` array should contain the parsed error without you pasting it

**Visual bug detection:**
1. Call `debug_investigate` with a CSS or layout error (e.g., `"the header looks broken on mobile"`, with `files: ["src/Header.css"]`)
2. Response should include `visualError: true` and a `visualHint` block suggesting screenshot tools

**Lighthouse performance:**
1. Start a dev server on localhost
2. Call `debug_perf` with `{ sessionId, url: "http://localhost:3000", phase: "before" }`
3. Make a change, then call again with `phase: "after"` — response includes a `comparison` with metric diffs

### Test Phase 2: Triage + Efficiency

**Triage gate (trivial fast-path):**
1. Call `debug_investigate` with a trivial error: `"ReferenceError: useState is not defined at App (src/App.tsx:5:10)"`
2. Response should return `triage: "trivial"` with a `fixHint` and skip the full pipeline (no git context, no env scan)

**Triage gate (complex full-path):**
1. Call `debug_investigate` with `"the page is blank after login"`
2. Response should return `triage: "complex"` with full investigation results

**Auto-learning:**
1. Run `debug_investigate` on an error, fix it, then call `debug_verify` with a passing command
2. The response should say "auto-saved to memory"
3. Call `debug_recall` with the same error — the auto-learned entry should appear

**Preventive suggestions:**
1. Create 3+ debug sessions with the same error type in the same file (use `debug_cleanup` with a diagnosis each time)
2. Call `debug_patterns` — response should include a `suggestions` array with actionable recommendations

### Test Phase 3: Memory Overhaul

**Confidence scoring:**
1. Create a memory entry via `debug_cleanup` with a diagnosis
2. Call `debug_recall` — results now include a `confidence` percentage
3. Recent entries with no file drift should score >80%

**Proactive memory:**
1. Build up a high-confidence memory entry (create, recall it, verify a fix using it)
2. Call `debug_investigate` with the same error pattern
3. Response should include `proactiveSuggestion` with the high-confidence match

**Knowledge pack export/import:**
```bash
# In project A (has debug memory):
npx debug-toolkit export ./my-knowledge.json

# In project B (fresh):
npx debug-toolkit import ./my-knowledge.json
```
Then call `debug_recall` in project B — imported entries should appear with `source: "external"`.

**Memory archival:**
1. Create entries, then simulate aging (modify the timestamp in `.debug/memory.json` to >30 days ago)
2. Modify the referenced files so they have high drift
3. Call `debug_recall` — archived entries should be excluded from results

### End-to-end smoke test

```bash
npx debug-toolkit demo     # full workflow with real bug
npm run build               # TypeScript compiles clean
npm test                    # 63 tests pass
```

## Architecture

24 source files, ~5,500 lines of TypeScript. 4 runtime dependencies, 1 dev dependency (vitest).

```
src/
  mcp.ts           — 10 tools + 1 resource + MCP server
  context.ts       — Investigation engine (stack parsing, source, git, env)
  memory.ts        — Cross-session memory with confidence + staleness + patterns
  capture.ts       — Ring buffers, terminal pipe, build error parsing, Tauri logs
  demo.ts          — Self-contained interactive demo
  proxy.ts         — HTTP proxy + HTML injection + WebSocket
  index.ts         — CLI entry (mcp, serve, init, demo, clean, export, import)
  security.ts      — Path traversal, expression validation, redaction
  session.ts       — Data model, atomic persistence, visual + perf context
  injected.js      — Browser console/network/error capture script
  instrument.ts    — Language-aware instrumentation (JS/TS/Py/Go/Rust)
  cleanup.ts       — Single-pass marker removal with verification
  triage.ts        — Error complexity classification (trivial/medium/complex)
  suggestions.ts   — Preventive suggestions from debug patterns
  confidence.ts    — Memory confidence scoring (age, drift, usage)
  packs.ts         — Knowledge pack export/import
  adapters.ts      — MCP tool discovery (Ghost OS, Claude Preview)
  perf.ts          — Lighthouse CLI runner + metric extraction
  cli.ts           — ANSI terminal UI
  hook.ts          — Git pre-commit hook
  methodology.ts   — Always-available debugging guide
  budget.ts        — Token budget estimation + response compression
  explain.ts       — Decision explainability (triage, confidence, archival)
  telemetry.ts     — Debug session outcome tracking + fix rates
  utils.ts         — Shared utilities (atomicWrite, tokenize, memoryPath)
```

## License

MIT
