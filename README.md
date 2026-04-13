> Part of the [StackPack](https://github.com/stackpackdev) ecosystem — the complete toolkit for building software in the agent age.

# stackpack-debug

Runtime DevTools for AI agents. Gives your agent the same signals a developer sees in browser DevTools and terminal — console logs, network errors, build failures, runtime exceptions, server-side errors, and configuration state — over MCP, so it can debug from captured output instead of guessing from source code.

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

**Ghost OS** (macOS only) enables auto-screenshots on visual/CSS bugs via `debug_investigate` and before/after comparison on `debug_verify`. When not installed, all visual features gracefully fall back to advisory hints — no tools break. Only `debug_visual` requires it explicitly. Configurable via `.debug/config.json` (`"visual.autoCapture": "auto" | "manual" | "off"`).

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

The MCP server detects available integrations at startup. Tools adapt to what's installed — missing integrations return setup instructions instead of cryptic errors. The agent always knows what's available via `debug_setup({ action: "check" })` and the SKILL.md capabilities table.

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

The MCP server starts automatically when Claude Code opens your project (via `.mcp.json`). The tools are always available — no extra steps needed.

### Start your dev server through `spdg`

Always start your dev server through stackpack-debug. Run `spdg` and pick "Start dev server with capture", or use the command directly:

```bash
spdg serve -- npm run dev           # web project
spdg serve -- npm run tauri -- dev  # Tauri project
```

**When you start your dev server through `spdg`:** the toolkit captures browser console, network requests, and build errors in real time. `debug://status` shows live runtime data.

**When you start your dev server normally** (`npm run dev`): the MCP tools still work, but they only have terminal output, TypeScript errors, git diffs, and file analysis. No browser console, no network capture.

The capture works by running your dev server behind a lightweight HTTP proxy that injects a script into your app's HTML. The script forwards `console.log/error`, unhandled exceptions, and failed network requests back to the toolkit via WebSocket.

### Architecture

```
┌─────────────────────┐     .debug/live-context.json     ┌──────────────────┐
│ SERVE PROCESS       │ ──────── writes every 5s ───────→ │ MCP PROCESS      │
│                     │                                    │                  │
│ • stdout/stderr     │                                    │ debug://status   │
│   capture           │                                    │ (live resource)  │
│ • runtime error     │                                    │                  │
│   parsing (stderr)  │                                    │ debug_investigate│
│ • browser console   │                                    │ (deep analysis)  │
│   via proxy/plugin  │                                    │                  │
│ • build error       │                                    │ • config state   │
│   parsing           │                                    │   (.env files)   │
└─────────────────────┘                                    └──────────────────┘
```

### Agent workflow

```
1. Read debug://status  → see live terminal/browser/build errors instantly
2. debug_investigate    → deep analysis + source code + git + past solutions
3. debug_hypothesis     → log what you think the root cause is and why
4. debug_instrument     → add logging if more info needed
5. debug_capture        → collect runtime output (or wait for it with wait=true)
6. (apply fix)
7. debug_verify         → confirm fix, auto-save to memory (3+ failures → escalation)
8. debug_cleanup        → save diagnosis for future sessions
```

**Tool decision tree** — the activation rules teach the agent which tools to reach for:

| Signal needed | Tool | When to use |
|---|---|---|
| Runtime errors, app state | `debug://status` | Always first |
| Deep error analysis | `debug_investigate` | Stack traces, error messages |
| Server-side runtime errors | `debug://status` | Unhandled rejections, console.error in API routes |
| Configuration/provider state | `debug://status` | Wrong endpoint, setting resets, provider mismatch |
| Performance metrics | `debug_perf` | Slow page loads, layout shifts |
| Visual/layout state | `debug_visual` | Overlap, misalignment, CSS bugs |
| Long-running output | `debug_capture` with `wait: true` | Async ops, build processes, generation tasks |
| Server-side logs for a request | `debug_capture` with `command: "curl ..."` | Localhost requests — includes correlated `serverLogs` |
| Recent output (drain-safe) | `debug_capture` with `recent: 10000` | When normal capture returns empty, or after prior drain |
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

## Activity Feed

When running in serve mode, your terminal shows a live feed of what the agent is doing:
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
- Error chain unwrapping (RetryError, AI SDK wrappers — extracts HTTP status, URL, provider)
- Server-side runtime errors (unhandled rejections, stack traces, connection errors from stderr)
- Configuration state (AI provider settings, model selection, env file values with persistence tracking)
- Provider/endpoint mismatch detection (flags when the app hits a different provider than expected)
- Configuration drift hints (suggests checking persistence when settings may have been lost)
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

### debug_hypothesis

Record a hypothesis before attempting a fix. Creates an auditable investigation trail so you don't repeat failed approaches. Update status to `confirmed` or `rejected` after testing.

```
Input:  { sessionId, hypothesis: "The null check in middleware is missing because req.user is undefined when auth skips" }
Output: { hypothesisId: "hyp_abc", text: "...", status: "testing", allHypotheses: [...] }

Input:  { sessionId, hypothesisId: "hyp_abc", status: "rejected", evidence: ["error persists after adding null check"] }
Output: { hypothesisId: "hyp_abc", status: "rejected", nextStep: "Form a NEW hypothesis..." }
```

After 2+ rejected hypotheses, suggests running `debug_patterns` to detect systemic issues you may be missing.

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

Four modes:

1. **Run a command** — `{ command: "npm test" }` — captures stdout/stderr. When the command targets `localhost`, correlated server-side logs are included in the `serverLogs` field.
2. **Peek buffers** — `{}` — snapshot of buffered terminal/browser/Tauri log events (non-destructive — safe to call multiple times)
3. **Wait for output** — `{ wait: true }` — blocks until new output arrives (up to 60s)
4. **Recent window** — `{ recent: 10000 }` — reads from an immutable 60-second buffer that survives buffer rotation. Use when normal capture returns empty.

Wait mode is designed for long-running processes (image generation, builds, async operations) where the agent would otherwise poll `debug://status` repeatedly. Tagged output is linked to hypotheses. Results are paginated.

### debug_verify

After applying a fix, run the test command and get a clear pass/fail with exit code and error output. Auto-saves the diagnosis to memory on pass. Tracks outcome in telemetry.

**Escalation rule:** After 3+ failed fix attempts, triggers an escalation that forces re-investigation. The response includes all failed approaches, rejected hypotheses, and specific recommendations — your mental model of the bug is likely wrong and you should stop fixing symptoms.

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
npm test                    # 77 tests across 19 files
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
  mcp.ts           — 14 tools + 1 resource + MCP server + Ghost OS bridge
  activity.ts      — Live activity feed (file-based IPC between MCP and serve terminal)
  ghost-bridge.ts  — MCP client for Ghost OS (screenshots, DOM, inspect)
  context.ts       — Investigation engine (stack parsing, source, git, env)
  memory.ts        — WAL-backed memory with inverted index + staleness + patterns
  capture.ts       — Ring buffers, terminal pipe, build/runtime error parsing, config state, Tauri logs
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

### v0.23.0 — Transparent Capture

- **Network topology engine** — detects running dev servers via `lsof`, maps inbound connections (browsers) and outbound connections (backends like Ollama, Postgres, Redis), and cross-references with config state to flag missing expected connections.
- **Three capture tiers** — every `debug://status` response now shows a capture mode indicator (FULL / ACTIVE COLLECTION / PARTIAL / STATIC) with exactly what data sources are available and what's missing.
- **"Monitor running app" CLI mode** — new menu option in `spdg` that attaches to an already-running dev server without restarting it. Provides network topology, config state, tsc polling, browser capture server, and loop detection.
- **MCP inline collection** — when no `spdg serve` or monitor is running, the MCP server actively scans for dev server ports and includes network topology in `debug://status`. No more "Dev server not running" dead ends.
- **Missing connection alerts** — when config says `OLLAMA_BASE_URL=localhost:11434` but the server has no outbound connection to port 11434, the status report flags it with an actionable warning.
- **Network correlation in debug_investigate** — investigation responses include network topology with hints like "Server has inbound connections but no outbound — request may be stuck in middleware."

### v0.22.0 — Auto-Upgrade on Startup

- **Background self-upgrade** — every time you run `spdg` (or any CLI command), the toolkit checks npm for a newer version and upgrades in the background. No manual `spdg update` needed — you're always on the latest version by the next restart.
- **Non-blocking** — the upgrade runs in a detached child process. The CLI starts instantly; the upgrade message appears in the terminal when it finishes (typically 5-10s).
- **MCP session upgrade** — the MCP server also triggers a background upgrade on first `debug://status` read, so even headless sessions stay current.
- **Auto-refresh** — after upgrading, SKILL.md, activation rules, and commands are refreshed automatically to match the new version.
- **Zero-config** — no flags, no settings. Works with both global installs (`npm i -g`) and npx usage.

### v0.21.0 — Server-Side Visibility + Configuration Awareness

- **Runtime error parsing** — stderr output is now parsed for Node.js runtime errors: unhandled promise rejections, uncaught exceptions (TypeError, ReferenceError, etc.), connection errors (ECONNREFUSED, ETIMEDOUT), server error logs (`[ERROR]`, HTTP 4xx/5xx), and `console.error` with stack traces. These appear as a dedicated "Runtime Errors (server-side)" section in `debug://status` with type, file location, message, and stack trace — errors that were previously invisible because they didn't reach browser devtools.
- **Multiline stack trace accumulator** — stack traces split across multiple stderr chunks are reassembled before parsing (100ms accumulation window), so `Error: message` followed by `    at fn (file:line)` in separate writes are captured as a single structured error.
- **Configuration state in status** — `debug://status` now shows a "Configuration State" section with AI provider settings, model selection, and endpoint URLs read from `.env`, `.env.local`, `.env.development`, and `process.env`. Values are redacted (API keys show 7-char prefix only, URLs show host only), and each entry tracks its persistence source (`env-file` vs `env-var`). Warns when all provider settings are env-var-only (will reset on server restart).
- **Config state in investigations** — `debug_investigate` returns `configState` with provider-related settings and `runtimeErrors` with structured server-side errors, giving the agent immediate visibility into configuration bugs without needing to read env files manually.
- **Runtime errors in severity summary** — unhandled rejections and uncaught exceptions are classified as `fatal` in the issues summary; other runtime errors as `error`. Health trend tracking includes these new signals.
- **Updated activation rules** — new trigger words: "resets", "setting", "config", "provider", "wrong endpoint", "wrong model". Updated tool decision tree with server-side runtime errors and configuration state signals.

### v0.20.0 — Systematic Debugging Discipline

- **`debug_hypothesis` tool** — Record hypotheses before attempting fixes, creating an auditable investigation trail. Create, update, confirm, or reject hypotheses with supporting evidence. After 2+ rejected hypotheses, suggests checking `debug_patterns` for systemic issues.
- **Escalation rule in `debug_verify`** — After 3+ failed fix attempts, triggers an escalation that forces re-investigation instead of more guessing. Returns failed approaches, rejected hypotheses, and 6 specific recommendations. Takes priority over loop detection warnings.

### v0.19.0 — Diagnostic Reliability + Configuration Awareness

- **Immutable recent window** — 60-second append-only buffer captures all terminal output before dedup. Immune to buffer drain, so server-side logs are never lost between tool calls. Exposed via `debug_capture` `recent` parameter.
- **Non-destructive buffer reads** — `debug_capture` default mode uses `peek()` instead of `drain()`, preventing data loss across sequential tool calls. Session-level dedup prevents re-adding entries.
- **Error chain unwrapping** — `debug_investigate` recursively unwraps `RetryError`, `AI_APICallError`, `CausedBy` chains. Extracts `httpStatus`, `url`, `provider`, and `responseBody` from nested errors that would otherwise show as `"Error"`.
- **Provider mismatch detection** — cross-references error chain URLs with browser network events to detect when the app is hitting the wrong provider (e.g., Anthropic instead of Ollama). Surfaces `providerMismatch` and `configDrift` fields with actionable suggestions.
- **Request-response correlation** — when `debug_capture` runs a command against `localhost`, it captures server-side logs generated during that request window and includes them as `serverLogs` in the response.
- **Recent API calls in status** — `debug://status` now shows a "Recent API Calls" section with method, URL, and status for all browser API requests, giving immediate visibility into what endpoints the app is hitting.
- **Error annotations in status** — terminal errors are now classified inline with suggestions (e.g., "rate-limit: API rate limit — check which provider...").
- **Enhanced network capture** — browser capture script now tracks all API calls (not just failures) to `/api/`, provider endpoints, and local servers. Error responses include response body snippets (up to 500 chars).
- **New `classifyError` rules** — `429/rate-limit`, `AI_APICallError`, `ETIMEDOUT`, state persistence patterns (`override is null`, `configuration reset`, `falling back to default`).
- **Smart triage hints** — when triage is "complex" with wrapped errors, provides specific debugging suggestions including provider info, HTTP status, and error chain visualization.
- **Updated agent rules** — new sections for debugging wrapped/generic errors, empty terminal output recovery, and configuration/state bugs with hypothesis generation guidance.

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
