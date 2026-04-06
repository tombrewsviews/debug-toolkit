> Part of the [StackPack](https://github.com/stackpackdev) ecosystem — the complete toolkit for building software in the agent age.

# stackpack-debug

Runtime DevTools for AI agents. Gives your agent the same signals a developer sees in browser DevTools and terminal — console logs, network errors, build failures, runtime exceptions — over MCP, so it can debug from captured output instead of guessing from source code.

```bash
npm i -g stackpack-debug            # install globally (one time)
spdg                               # guided setup (first time) or menu (returning)
```

## Quick Start

```bash
npm i -g stackpack-debug
cd your-project
spdg
```

**First time?** The guided setup detects your project, installs MCP config, checks optional integrations, and offers to install missing tools — all interactively.

**Already set up?** You get a menu: check health, re-run setup, start serve mode, install integrations, or export/import knowledge.

**From Claude Code?** The MCP server starts silently — zero change to existing behavior. (Detection: `stdout.isTTY` distinguishes human terminal from MCP client.)

### Direct Commands (for scripts and CI)

```
spdg init            # non-interactive setup
spdg doctor          # check environment + optional integrations
spdg serve -- npm run dev   # start dev server with capture + live activity feed
spdg demo            # see it work (no AI needed)
spdg export [path]   # export debug memory as a knowledge pack
spdg import <path>   # import a knowledge pack into this project
```

## What Happens During Setup

`spdg` (or `spdg init`) does the following:

1. **Detects your project** — reads `package.json`, identifies Tauri/Vite/React projects
2. **Preflight checks** — validates Node.js version, dependencies, git, Rust (if Tauri)
3. **Writes `.mcp.json`** — registers the MCP server for Claude Code
4. **Installs pre-commit hook** — blocks accidental commits containing debug markers
5. **Creates activation rules** — `.claude/rules/stackpack-debug.md` tells Claude when to use the toolkit
6. **Installs SKILL.md** — `.claude/skills/stackpack-debug/SKILL.md` with a dynamic capabilities table
7. **Checks optional integrations** — reports what's available and what's missing with fix commands

### Optional Integrations

| Integration | What It Enables | How to Get It |
|-------------|----------------|---------------|
| **Lighthouse** | `debug_perf` — Web Vitals snapshots (LCP, CLS, INP) | `npm install -g lighthouse` |
| **Chrome** | Headless browser for Lighthouse | Install from [google.com/chrome](https://google.com/chrome) |
| **Ghost OS** | Auto-screenshots, DOM capture, element inspection for visual bugs | `brew install ghostwright/ghost-os/ghost-os` (macOS) |
| **Claude Preview** | Browser preview screenshots and inspection | Built into Claude Code |

All optional — the toolkit works without any of them. When a tool needs an integration that's missing, you get a clear setup message instead of a cryptic error.

### Ghost OS Deep Integration

When Ghost OS is installed, stackpack-debug connects to it internally as an MCP client — no manual orchestration needed:

```
debug_investigate detects CSS bug
  → internally calls ghost_screenshot + ghost_read
  → saves screenshot to .debug/screenshots/
  → returns: { visualCapture: { screenshot, elementsFound }, visualHint }

debug_verify after fix
  → auto-captures after-fix screenshot
  → returns: { visualVerification: { before, after } }
```

The agent never needs to call Ghost OS tools directly. Visual capture is automatic for CSS/layout bugs (configurable via `.debug/config.json`):

```json
{
  "visual": {
    "autoCapture": "auto",
    "captureOnInvestigate": true,
    "captureOnVerify": true
  }
}
```

Options: `"auto"` (default — captures on visual bugs), `"manual"` (agent-triggered via `debug_visual`), `"off"`.

Without Ghost OS, all visual features gracefully fall back to advisory hints. The `debug://status` report includes a **Visual Debugging** section showing connection state, last error, and setup instructions — so the agent always knows why visual capture isn't working instead of failing silently.

### Installing Integrations

Optional integrations (Lighthouse, Chrome, Ghost OS) are auto-installed during `spdg` setup. The agent can also check and install them mid-conversation via the `debug_setup` MCP tool:

```
debug_setup({ action: "check" })
→ { available: ["Chrome"], missing: ["Lighthouse", "Ghost OS"], autoInstallable: ["lighthouse"] }

debug_setup({ action: "install", integration: "lighthouse" })
→ { success: true, message: "Lighthouse installed successfully" }
```

| Integration | Auto-Install | Agent-Installable | Method |
|---|---|---|---|
| Lighthouse | ✅ | ✅ | `npm install -g lighthouse` |
| Chrome | ✅ (macOS/Linux) | ✅ | `brew install --cask google-chrome` (macOS) |
| Ghost OS | ✅ (macOS) | ✅ | `brew install ghostwright/ghost-os/ghost-os` |
| Claude Preview | ✅ Built-in | N/A | Already in Claude Code |

### Health Check

Run anytime to verify your setup:

```bash
spdg doctor
```

```
  CORE
  ✓ Node.js 22.19.0
  ✓ Git available
  ✓ .debug/ directory exists

  PERFORMANCE (optional)
  ✗ Lighthouse not found
      npm install -g lighthouse
  ✓ Chrome available

  VISUAL DEBUGGING (optional)
  ✓ Ghost OS configured
  ✓ Built into Claude Code desktop
```

### Capability-Aware Runtime

The MCP server detects available integrations at startup and connects to Ghost OS if available. Tool behavior adapts:

- **Visual bugs:** If Ghost OS is connected, `debug_investigate` auto-captures screenshots and DOM state. If not, it suggests manual tools or shows setup guidance. If capture fails, the agent gets a diagnostic explaining why (not a silent failure).
- **Performance:** If Lighthouse isn't installed, `debug_perf` returns setup instructions immediately instead of failing after a 60-second timeout. For Tauri/Electron apps, metrics are flagged as low-reliability with alternative profiling advice.
- **Browser logs:** Status report separates browser errors by source context — webview, external Chrome, or Lighthouse-triggered — so the agent doesn't waste time investigating artifacts.
- **Verification:** If a visual bug was captured during investigation, `debug_verify` auto-captures an after-fix screenshot for comparison.
- **SKILL.md:** Includes a capabilities table so the agent knows upfront which tools are available — no wasted calls.

## See It Work

Run `spdg demo` — creates a temp project with a real bug, walks through the full debug loop, no AI needed:

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

## The Problem

When an AI agent hits a bug, it reads code and guesses a fix. You run it, paste the error back, the agent guesses again. Repeat 5-8 times.

stackpack-debug eliminates that loop. It captures terminal output, browser console, and build errors from the running app — then serves them to the agent proactively. The agent sees what's happening at runtime, not just what's written in files.

## How It Works

### Two modes

**Serve mode** (recommended) — wraps your dev server to capture everything:
```bash
spdg serve -- npm run dev     # web project
spdg serve -- npm run tauri -- dev  # Tauri project
```

**Pure MCP mode** — just the tools, no capture:
```bash
spdg   # setup only, agent calls tools manually
```

### Architecture

```
┌─────────────────────┐     .debug/live-context.json     ┌──────────────────┐
│ SERVE PROCESS       │ ──────── writes every 5s ───────→ │ MCP PROCESS      │
│                     │                                    │                  │
│ • stdout/stderr     │                                    │ debug://status   │
│   capture           │                                    │ (live resource)  │
│ • browser console   │                                    │                  │
│   via proxy/plugin  │                                    │ debug_investigate│
│ • build error       │                                    │ (deep analysis)  │
│   parsing           │                                    │                  │
└─────────────────────┘                                    └──────────────────┘
```

### Agent workflow

```
1. Read debug://status  → see live terminal/browser/build errors instantly
2. debug_investigate    → deep analysis + source code + git + past solutions
3. debug_instrument     → add logging if more info needed
4. debug_capture        → collect runtime output (or wait for it with wait=true)
5. (apply fix)
6. debug_verify         → confirm fix, auto-save to memory
7. debug_cleanup        → save diagnosis for future sessions
```

**Tool decision tree** — the activation rules teach the agent which tools to reach for:

| Signal needed | Tool | When to use |
|---|---|---|
| Runtime errors, app state | `debug://status` | Always first |
| Deep error analysis | `debug_investigate` | Stack traces, error messages |
| Performance metrics | `debug_perf` | Slow page loads, layout shifts |
| Visual/layout state | `debug_visual` | Overlap, misalignment, CSS bugs |
| Long-running output | `debug_capture` with `wait: true` | Async ops, build processes, generation tasks |
| Past solutions | `debug_recall` | Recurring errors |

For complex or multi-signal bugs, use `/debug-all` — runs all diagnostic tools in parallel for maximum coverage.

### Tauri / Electron support

For apps with embedded webviews, the HTTP proxy can't inject scripts. stackpack-debug provides a **Vite plugin** that injects console capture directly:

```typescript
// vite.config.ts — auto-configured during `spdg` setup for Tauri projects
import debugToolkit from "stackpack-debug/vite-plugin";
export default defineConfig({ plugins: [debugToolkit()] });
```

This forwards `console.log/warn/error`, global errors, and failed network requests from the webview back to the toolkit via WebSocket.

## Setup

### Any project (JS/TS/Python/Go)

```bash
spdg
```

Guided setup: detects your project, writes `.mcp.json`, installs hooks and rules. Restart Claude Code and you're done.

### Tauri projects (auto-detected)

```bash
cd my-tauri-app
spdg
```

If `src-tauri/` exists, stackpack-debug automatically:
- Sets dev command to `cargo tauri dev`
- Enables `RUST_BACKTRACE=1` and `RUST_LOG=info`
- Parses Rust panics, backtraces, and cargo build errors
- Discovers and tails `tauri-plugin-log` files from platform-specific paths
- Detects Tauri-specific errors (invoke, capability, plugin, window, asset)

### Manual MCP config

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "stackpack-debug": {
      "command": "npx",
      "args": ["-y", "stackpack-debug"]
    }
  }
}
```

## Two Modes

**Pure MCP** (default) — Just the MCP server on stdio. Agent gets all tools. No wrapper needed.

```bash
spdg
```

**Serve** — Wraps your dev server. Adds browser console/network capture via HTTP proxy + WebSocket, plus a **live activity feed** showing what the toolkit does for the agent in real time.

```bash
spdg serve -- npm run dev
spdg serve -- cargo tauri dev
```

Activity feed output (in your terminal while the agent debugs):
```
  ⚡ investigate — "TypeError: Cannot read property 'x'" (triage: medium, files: 2, memoryHits: 1)
  💡 recall — found 1 past fix (87% confidence)
  🔧 instrument — added [DBG_001] to App.tsx:42
  📡 capture — drained buffers (total: 12, tagged: 3)
  ✓  verify — PASSED (duration: 45s, captures: 16, outcome: fixed)
  ─────────────────────────────────────────────────
  SESSION
  Duration: 45s | Outcome: fixed | Memory: saved
  ─────────────────────────────────────────────────
```

## Tools

### debug_investigate

**Start here.** Give it an error message or stack trace. Returns:

- Error classification (type, category, severity, suggestion)
- Source code at the exact crash site (highlighted)
- Git context (branch, commit, recent changes to those files)
- Runtime environment (Node/Rust version, frameworks, env vars — secrets redacted)
- Past solutions from memory (with staleness info and causal chains)
- Triage classification (trivial/medium/complex) with explanation
- Proactive suggestions from high-confidence memory matches
- Auto-captured screenshot + DOM state on visual bugs (via Ghost OS, when connected)
- Token-budgeted response (auto-compressed to fit context windows)

```
Input:  { error: "TypeError: Cannot read properties of undefined (reading 'map')" }
Output: { error, sourceCode, git, environment, pastSolutions, nextStep, triage, _budget }

Input:  { error: "the nav bar overlaps the hero section", files: ["src/Nav.css"] }
Output: { ..., visualCapture: { screenshot, elementsFound }, visualHint: { isVisualBug: true } }

Input:  { error: "LoginForm shows wrong email after submit" }
Output: { sourceCode: [{ file: "src/LoginForm.tsx", errorLine: 42, snippet: "...email..." }], ... }
```

**Behavior bugs without stack traces:** When no stack trace or files are provided, the engine infers relevant files from the description — extracting component names, CSS classes, HTML tags, route paths, and quoted strings. It then targets the source output to lines containing those terms instead of dumping the file header.

### debug_recall

Search past debug sessions for similar errors. Returns diagnoses ranked by confidence × relevance, with staleness tracking and causal chains. Pass `explain: true` for a factor-by-factor confidence breakdown.

```
Input:  { query: "TypeError undefined map", explain: true }
Output: { matches: [{ diagnosis, stale, rootCause, confidence, _explanation }] }
```

### debug_patterns

Detect systemic issues across all past sessions + debug telemetry:

| Pattern | What it finds |
|---------|--------------|
| **Recurring error** | Same error type in same file, 3+ times |
| **Hot file** | Files in 15%+ of debug sessions |
| **Regression** | Bug fixed once, came back |
| **Error cluster** | Multiple errors within 2 hours |

Also returns: `suggestions` (preventive actions), `telemetry` (fix rate, memory effectiveness, top errors).

### debug_instrument

Add tagged logging to source files. Supports JS/TS, Python, Go, and Rust. Supports conditional instrumentation:

| Language | Output |
|----------|--------|
| JS/TS | `console.log("[DBG_001]", expr)` |
| Python | `print(f"[DBG_001] {expr}")` |
| Go | `fmt.Printf("[DBG_001] %v\n", expr)` |
| Rust | `eprintln!("[DBG_001] {:?}", expr)` |

Pass `condition: "value === null"` to wrap the log in an `if` block — no spam on high-frequency code paths.

### debug_capture

Three modes:

1. **Run a command** — `{ command: "npm test" }` — captures stdout/stderr
2. **Drain buffers** — `{}` — snapshot of buffered terminal/browser/Tauri log events
3. **Wait for output** — `{ wait: true }` — blocks until new output arrives (up to 60s)

Wait mode is designed for long-running processes (image generation, builds, async operations) where the agent would otherwise poll `debug://status` repeatedly. Tagged output is linked to hypotheses. Results are paginated.

### debug_verify

After applying a fix, run the test command and get a clear pass/fail with exit code and error output. Auto-saves the diagnosis to memory on pass. Tracks outcome in telemetry.

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

Capture a Lighthouse performance snapshot for a URL. Pass `phase: "before"` before a fix and `phase: "after"` to get a comparison. Requires Lighthouse + Chrome (run `spdg doctor` to check).

**Tauri/Electron aware:** When a desktop app framework is detected, the response includes `metricsReliability: "low"` with a disclaimer that Lighthouse runs in headless Chrome (not the native webview), alternative profiling advice for the framework, and a count of browser errors triggered during the audit (which ARE still valuable for finding real bugs).

```
Input:  { sessionId, url, phase?: "before" | "after" }
Output: { LCP, CLS, INP, TBT, speedIndex, metricsReliability, comparison? }
```

### debug_visual

Capture visual state via Ghost OS — screenshot, element inspection, annotated view, or before/after comparison. Requires Ghost OS to be installed and connected.

```
Input:  { sessionId, action: "screenshot" }
Output: { screenshot: ".debug/screenshots/spdg_xxx_manual_123.png" }

Input:  { sessionId, action: "inspect", query: "#nav-bar" }
Output: { elements: [{ role: "AXGroup", name: "nav-bar", actionable: true }], count: 1 }

Input:  { sessionId, action: "annotate" }
Output: { screenshot: "...", labels: [{ id: 1, role: "AXButton", name: "Submit", x: 620, y: 350 }] }

Input:  { sessionId, action: "compare" }
Output: { before: ".debug/screenshots/..._investigate_...", after: ".debug/screenshots/..._compare_..." }
```

### debug_setup

Check, install, and manage integrations from within the agent conversation.

```
Input:  { action: "check" }
Output: { integrations: [...], summary: { available, missing, autoInstallable } }

Input:  { action: "install", integration: "lighthouse" }
Output: { success: true, message: "Lighthouse installed successfully" }

Input:  { action: "connect" }
Output: { connected: true, message: "Ghost OS connected successfully" }

Input:  { action: "disconnect" }
Output: { disconnected: true, message: "Ghost OS disconnected" }
```

## Memory System

stackpack-debug learns from every session. The memory system is designed to scale:

**Write-Ahead Log** — Mutations are appended as single JSON lines instead of rewriting the entire file. Full compaction runs when the WAL exceeds 50 entries or 100KB.

**Inverted Index** — Keyword-based recall uses a per-project inverted index with incremental updates. Searches are instant regardless of memory size.

**Staleness with TTL Cache** — Git checks are cached for 5 minutes. Repeated recalls within that window skip all subprocess spawns.

**Confidence Scoring** — Each memory entry has a composite confidence score (0–100) based on age, file drift, and usage. High-confidence matches are surfaced proactively.

**Causal Chains** — Records where the error appeared vs. where the actual bug was. Next time, the agent goes straight to the cause file instead of the symptom.

**Pattern Detection** — Detects recurring errors, hot files, regressions, and error clusters. Results are cached by generation counter — recomputed only when data changes.

**Deferred Archival** — Stale entries are archived at most once per hour (not on every search). Archived entries are physically moved to `.debug/archive/YYYY-MM.json` monthly files — the main memory file actually shrinks.

**Knowledge Packs** — Export and import debug memory across projects. `exportPack` supports `includeArchived: true` to include archived entries.

**Telemetry** — Every verified fix is tracked with outcome, duration, error type, and memory effectiveness. Capped at 500 entries.

## Language Support

| Feature | JS/TS | Python | Go | Rust/Tauri |
|---------|-------|--------|----|------------|
| Stack trace parsing | Node.js frames | Python tracebacks | — | Panics, backtraces, cargo errors |
| Error classification | TypeError, ReferenceError, etc. | — | — | Panic, borrow, Tauri IPC/capability/plugin |
| Code instrumentation | `console.log` | `print()` | `fmt.Printf` | `eprintln!` |
| Conditional instrumentation | `if (cond) console.log(...)` | `if cond: print(...)` | `if cond { fmt.Printf(...) }` | `if cond { eprintln!(...) }` |
| Source extraction | Yes | Yes | Yes | Yes |
| Log file tailing | — | — | — | `tauri-plugin-log` auto-discovery |
| Environment detection | package.json, frameworks | Python version | — | Cargo.toml, tauri.conf.json, plugins |

## Security

- **Path traversal protection** — all file operations validated against project root
- **Expression validation** — blocks `eval`, `require`, `exec` in instrumentation
- **Secret redaction** — tokens, API keys, passwords, JWTs auto-redacted before storage
- **Localhost-only proxy** — binds to 127.0.0.1
- **Pre-commit hook** — blocks commits containing debug markers
- **Atomic writes** — temp file + rename via WAL, no corruption on crash
- **`.debug/` auto-gitignored**
- **Pack import sanitization** — path traversal blocked, pack version validated

## Testing

```bash
npm test                    # 79 tests across 19 files
npm run test:watch          # watch mode
spdg demo     # full workflow with real bug
spdg doctor   # verify environment setup
```

## Prerequisites

### Required

| Requirement | Minimum Version | Check |
|-------------|----------------|-------|
| **Node.js** | ≥20.19 or ≥22.12 | `node --version` |
| **npm** | Comes with Node | `npm --version` |
| **Git** | Any recent version | `git --version` |

### Optional (for enhanced capabilities)

| Requirement | Platform | What It Enables | Install |
|-------------|----------|----------------|---------|
| **Lighthouse** | Any | `debug_perf` — Web Vitals profiling | `npm install -g lighthouse` |
| **Chrome** | Any | Headless browser for Lighthouse | [google.com/chrome](https://google.com/chrome) |
| **Ghost OS** | macOS only | Auto-screenshots, DOM capture, visual debugging | `brew install ghostwright/ghost-os/ghost-os` |
| **Homebrew** | macOS | Required for Ghost OS + Chrome auto-install | [brew.sh](https://brew.sh) |

### macOS-Specific (for Ghost OS)

Ghost OS requires system permissions that must be granted manually:

1. **Accessibility** — System Settings → Privacy & Security → Accessibility → Enable for Ghost OS
2. **Input Monitoring** — System Settings → Privacy & Security → Input Monitoring → Enable for Ghost OS
3. **Vision sidecar** (optional) — For web app visual grounding. Set up via `ghost setup`

These permissions cannot be granted programmatically. The first time Ghost OS runs, macOS will prompt for each permission.

### What `spdg doctor` Checks

Run `spdg doctor` to verify all prerequisites at once. It groups checks into:

- **Core** (required): Node.js version, Git, `.debug/` directory
- **Performance** (optional): Lighthouse CLI, Chrome binary
- **Visual** (optional): Ghost OS configuration, Claude Preview availability

## Architecture

27 source files, ~7,200 lines of TypeScript. 5 runtime dependencies, 1 dev dependency (vitest).

```
src/
  index.ts         — CLI entry (guided setup, init, doctor, serve, export, import)
  mcp.ts           — 13 tools + 1 resource + MCP server + Ghost OS bridge
  activity.ts      — Live activity feed (file-based IPC between MCP and serve terminal)
  ghost-bridge.ts  — MCP client for Ghost OS (screenshots, DOM, inspect)
  context.ts       — Investigation engine (stack parsing, source, git, env)
  memory.ts        — WAL-backed memory with inverted index + staleness + patterns
  capture.ts       — Ring buffers, terminal pipe, build error parsing, Tauri logs
  session.ts       — Data model, atomic persistence, visual + perf context
  instrument.ts    — Language-aware instrumentation (JS/TS/Py/Go/Rust)
  cleanup.ts       — Single-pass marker removal with verification
  adapters.ts      — Environment detection, capability checks, integration installer
  triage.ts        — Error complexity classification (trivial/medium/complex)
  suggestions.ts   — Preventive suggestions from debug patterns
  confidence.ts    — Memory confidence scoring (age, drift, usage)
  packs.ts         — Knowledge pack export/import (with archived entries)
  perf.ts          — Lighthouse CLI runner + metric extraction
  budget.ts        — Token budget estimation + response compression
  explain.ts       — Decision explainability (triage, confidence, archival)
  telemetry.ts     — Debug session outcome tracking + fix rates
  utils.ts         — Shared utilities (atomicWrite, tokenize, WAL paths, screenshots)
  demo.ts          — Self-contained interactive demo
  proxy.ts         — HTTP proxy + HTML injection + WebSocket
  security.ts      — Path traversal, expression validation, redaction
  cli.ts           — ANSI terminal UI + interactive prompts
  hook.ts          — Git pre-commit hook
  methodology.ts   — Always-available debugging guide
  injected.js      — Browser console/network/error capture script
```

## Changelog

### v0.15.0 — Session Intelligence + Tauri Deep Integration
- **Budget-protected past solutions** — `pastSolutions`, `proactiveSuggestion`, and `sourceCode` are now preserved during token budget compression. Top solution diagnosis inlined in `nextStep` so it survives even aggressive compression.
- **Status diff mode** — second+ reads of `debug://status` show a "Changes Since Last Check" section at the top with new event counts, eliminating full-dump scanning.
- **Child process tracking** — status report shows active and recently exited processes with PID, command, and runtime duration. Detects dead processes via signal check.
- **File existence cross-reference** — when browser errors reference local file paths (`asset://`, `file://`, ENOENT), status report checks if files exist on disk and reports the result with protocol/permission hints.
- **Session auto-expiry** — active sessions older than 24 hours (by last activity, not creation) are automatically expired. Status report only shows active sessions with resolved/expired counts.
- **Enhanced Tauri awareness** — new error patterns for `asset://` protocol scope, capability ACL, and config rebuild detection. Trivial triage for common Tauri config issues (missing asset scope, missing capability).

### v0.14.0 — Diagnostic Depth + Agent Workflow Intelligence
- **Ghost OS diagnostics** — `debug://status` shows visual debugging connection state, last error, and setup instructions. Failed visual captures return diagnostic info instead of failing silently.
- **Browser log source tagging** — status report separates browser errors by source context (webview vs external Chrome vs Lighthouse-triggered) so agents don't investigate artifacts.
- **Blocking capture** — `debug_capture` accepts `wait: true` to block until new output arrives (up to 60s), eliminating poll loops for long-running processes.
- **Tauri-aware perf** — `debug_perf` returns `metricsReliability: "low"` for Tauri/Electron apps, framework-specific profiling advice, and count of browser errors triggered during audit.
- **Smarter behavior bug investigation** — `debug_investigate` infers relevant files from description text (component names, CSS classes, HTML tags, route paths, quoted strings) and targets source output to matching lines instead of dumping file headers.
- **Tool decision tree in rules** — activation rules now teach agents when to use `debug_perf`, `debug_visual`, `debug_capture wait:true`, and `debug_recall` — not just the core investigate/verify flow.

### v0.11.0 — Live Activity Feed + `spdg` Alias
- **Live activity feed** in serve terminal — see what the toolkit does for the agent in real time
- File-based IPC (`activity.jsonl`) between MCP and serve processes
- Session summary on verify-pass and cleanup (duration, outcome, captures, memory)
- `spdg` CLI alias — short for `npx stackpack-debug`
- Removed redundant `install` command (integrations auto-install during setup)

### v0.10.0 — Memory Scaling + Integration Overhaul + Ghost OS
- Ghost OS deep integration — MCP client bridge for auto-screenshots, DOM capture
- `debug_visual` tool — screenshot, inspect, annotate, before/after compare
- Auto-capture on visual bugs (configurable: auto/manual/off)
- Before/after screenshot comparison on `debug_verify`
- Ghost OS brew-installable on macOS (auto-installed during setup)
- Write-Ahead Log eliminates full JSON rewrite on every recall
- Store cache with mtime validation, multi-project index safety
- Incremental index updates, staleness TTL cache, pattern detection cache
- Deferred archival (1hr cooldown), physical purge to monthly archive files
- Budget overflow guard with nuclear fallback
- `spdg doctor` — environment health check
- `debug_setup` MCP tool — check/install/connect/disconnect integrations
- Guided interactive setup via `spdg` (TTY-aware)
- Capability-aware runtime adapts to what's installed
- Dynamic SKILL.md capabilities table
- `@modelcontextprotocol/sdk` added for MCP client capabilities

### v0.9.0 — Performance + Observability
- Inverted index for O(1) memory recall
- Batch git staleness (10-50x faster)
- Token budget system (4K auto-compression)
- Explain mode for confidence breakdown
- Conditional instrumentation
- Debug telemetry (fix rates, memory effectiveness)

### v0.8.0 — Memory Intelligence
- Confidence scoring (age, drift, usage)
- Proactive memory (>80% confidence auto-suggests)
- Knowledge packs (export/import)
- Memory archival

### v0.7.0 — Smart Triage
- Triage gate (trivial/medium/complex)
- Auto-learning on verify pass
- Preventive suggestions
- Smarter activation rules

### v0.6.0 — Eyes + Build Integration
- Build error auto-capture (Vite, tsc, webpack, ESLint)
- Visual bug detection with screenshot hints
- Lighthouse performance snapshots
- Extended session model

## License

MIT
