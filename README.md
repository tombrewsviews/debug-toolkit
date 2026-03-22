# debug-toolkit

Closed-loop debugging for AI coding agents. One MCP server gives your agent the ability to **see code running** — not just read and write it.

```
npx debug-toolkit demo     # see it work (no AI needed)
npx debug-toolkit init     # install in your project
```

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

## Architecture

15 files, 3,451 lines of TypeScript. 4 npm dependencies.

```
src/
  mcp.ts          473 lines  — 8 tools + 1 resource + MCP server
  context.ts      420 lines  — Investigation engine (stack parsing, source, git, env)
  demo.ts         398 lines  — Self-contained interactive demo
  memory.ts       369 lines  — Cross-session memory with staleness + patterns
  capture.ts      276 lines  — Ring buffers, terminal pipe, Tauri log tailing
  proxy.ts        200 lines  — HTTP proxy + HTML injection + WebSocket
  index.ts        204 lines  — CLI entry point (mcp, serve, init, demo, clean)
  security.ts     185 lines  — Path traversal, expression validation, redaction
  session.ts      162 lines  — Data model, atomic persistence, marker index
  injected.js     151 lines  — Browser console/network/error capture script
  instrument.ts   140 lines  — Language-aware instrumentation (JS/TS/Py/Go/Rust)
  cleanup.ts      126 lines  — Single-pass marker removal with verification
  cli.ts          125 lines  — ANSI terminal UI
  hook.ts         122 lines  — Git pre-commit hook
  methodology.ts  100 lines  — Always-available debugging guide
```

## License

MIT
