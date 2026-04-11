#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import treeKill from "tree-kill";
import { pipeProcess, startLiveContextWriter } from "./capture.js";
import { startProxy, detectPort } from "./proxy.js";
import { setCwd, startMcpServer } from "./mcp.js";
import { exportPack, importPack } from "./packs.js";
import { installHook, uninstallHook } from "./hook.js";
import { cleanupFromManifest } from "./cleanup.js";
import { startActivityFeed } from "./activity.js";
import { startLoopWatcher } from "./watcher.js";
import { banner, info, success, warn, error, dim, section, kv, printHelp, sym, c, select, spinner, type SelectOption } from "./cli.js";
import { detectEnvironment, formatDoctorReport, listInstallable, installIntegration, type EnvironmentCapabilities } from "./adapters.js";
import { checkForUpdate, getPackageVersion } from "./utils.js";

// --- Parse ---

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const cmd = args[0] ?? "mcp"; // DEFAULT: pure MCP server (zero-config!)

  if (["clean", "init", "uninstall", "doctor", "demo", "help", "--help", "-h", "mcp", "export", "import", "update"].includes(cmd)) {
    return { command: cmd.replace(/^-+/, ""), port: null as number | null, childCommand: [] as string[] };
  }
  if (cmd !== "serve") return { command: "mcp", port: null as number | null, childCommand: [] as string[] };

  let port: number | null = null;
  const child: string[] = [];
  let past = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--") { past = true; continue; }
    if (past) { child.push(args[i]); continue; }
    if (args[i] === "--port" && args[i + 1]) { port = parseInt(args[i + 1], 10); i++; }
  }
  return { command: "serve", port, childCommand: child };
}

// --- /debug-all Command Template ---

const DEBUG_ALL_COMMAND = `---
description: Full diagnostic playbook for stackpack-debug — run ALL signals in parallel for maximum coverage
---

# stackpack-debug — Full Diagnostic Playbook

Use this when debugging any bug, error, or unexpected behavior. This runs ALL diagnostic tools in parallel for maximum signal coverage, instead of just reading debug://status and guessing.

## Phase 1: Blast (parallel signal collection)

Run ALL of these in parallel — do not wait for one before starting the next:

1. **Read \`debug://status\`** — live situation report (terminal, browser, build, TypeScript errors)
2. **Call \`debug_perf\`** — Lighthouse performance snapshot (also triggers browser errors as a side effect)
3. **Call \`debug_visual\`** — screenshot + DOM state (requires Ghost OS)
4. **Call \`debug_capture\`** — drain any buffered runtime events

\`\`\`
# All four in one parallel batch:
Read debug://status
debug_perf({ sessionId, url: "http://localhost:1420", phase: "before" })
debug_visual({ sessionId, action: "screenshot" })
debug_capture({ sessionId })
\`\`\`

## Phase 2: Analyze (cross-reference signals)

Read all four results and look for:
- **Errors in multiple signals** — these are the real bugs (e.g., terminal error + browser error = confirmed issue)
- **Errors ONLY in tsc output** — likely pre-existing warnings (dead code, unused imports), not runtime issues
- **Errors ONLY during Lighthouse** — tagged as "Lighthouse-triggered" in status; may not reproduce normally but still indicate real code issues
- **New errors vs pre-existing** — compare timestamps; warnings present since app startup are likely noise

### Noise filtering
- \`warning: function X is never used\` → dead code, not a bug
- \`warning: unused variable\` → pre-existing, skip unless it correlates with a runtime failure
- Focus on: type mismatches, null access, network failures, render errors

## Phase 3: Investigate (deep dive)

For each distinct error found in Phase 1:

\`\`\`
debug_investigate({ error: "<specific error text>", files: ["suspect-file.tsx"] })
\`\`\`

- If \`proactiveSuggestion\` returns with >80% confidence → apply directly
- If \`triage: "trivial"\` → apply \`fixHint\` directly
- If past solutions found → check \`stale\` field before trusting

## Phase 4: Fix & Verify

\`\`\`
# Apply the fix, then:
debug_verify({ sessionId, command: "npm run build" })

# If performance was an issue:
debug_perf({ sessionId, url: "http://localhost:1420", phase: "after" })
\`\`\`

## Phase 5: Cleanup

\`\`\`
debug_cleanup({ sessionId, diagnosis: "one-line root cause", rootCause: { trigger, errorFile, causeFile, fixDescription } })
\`\`\`

---

## Important: Lighthouse in Tauri/Electron Apps

Lighthouse runs in headless Chrome, which does NOT have \`window.__TAURI__\` or Electron's \`contextBridge\`. This means:
- **Performance metrics are UNRELIABLE** — they measure headless Chrome, not your actual webview
- **Browser errors ARE still valuable** — Lighthouse loading the page can trigger real code-path errors (missing APIs, failed network calls, rendering issues)
- The toolkit will warn you when a non-browser framework is detected

## Important: Ghost OS for Visual Debugging

- If \`debug_visual\` returns an error about Ghost OS not being connected, **skip visual capture** — do not retry repeatedly
- Note the gap in your investigation ("visual state unknown — Ghost OS not available")
- Consider using \`debug_perf\` as an alternative signal source (it loads the page and can trigger visible errors)

## Monitoring Long-Running Processes

For ML pipelines, build processes, or intermittent bugs:
1. Read \`debug://status\` → note the current state
2. Wait for the process to progress
3. Read \`debug://status\` again → look for CHANGES between reads
4. Use \`debug_capture\` to drain any new buffered events
5. Repeat until the process completes or the bug manifests

The status report is a snapshot, not a live stream. You must poll it to see changes.
`;

// --- Init ---

function initCommand(cwd: string): void {
  banner();
  section("SETUP");

  let devCmd = ["npm", "run", "dev"];
  let isTauri = false;
  let servePort: number | null = null;
  let serveEnv: Record<string, string> | null = null;
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      // Detect Tauri project
      const hasTauriCli = pkg.devDependencies?.["@tauri-apps/cli"] || pkg.dependencies?.["@tauri-apps/cli"];
      const hasTauriScript = pkg.scripts?.["tauri"];
      if ((hasTauriCli || hasTauriScript) && existsSync(join(cwd, "src-tauri"))) {
        isTauri = true;
        // Use npm-installed @tauri-apps/cli, NOT cargo tauri (which may not be installed)
        devCmd = ["npm", "run", "tauri", "--", "dev"];
        success(`Detected ${c.bold}Tauri${c.reset} project: ${c.bold}${pkg.name ?? "unknown"}${c.reset}`);

        // Detect dev server port from vite.config.{ts,js,mts,mjs} or default
        servePort = 1420; // Vite default for Tauri
        for (const ext of ["ts", "js", "mts", "mjs"]) {
          try {
            const viteConfPath = join(cwd, `vite.config.${ext}`);
            if (existsSync(viteConfPath)) {
              const viteConf = readFileSync(viteConfPath, "utf-8");
              const portMatch = viteConf.match(/port\s*:\s*(\d+)/);
              if (portMatch) { servePort = parseInt(portMatch[1], 10); break; }
            }
          } catch {}
        }

        // Build PATH that works across environments:
        // 1. Current Node binary dir (fnm, nvm, volta, asdf, mise, homebrew, system)
        // 2. Current process PATH (inherits whatever shell env the user has)
        // We snapshot the user's actual PATH at init time rather than guessing paths.
        const currentNodeBin = process.execPath.replace(/[/\\]node(\.exe)?$/, "");
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
        const isWindows = process.platform === "win32";
        const sep = isWindows ? ";" : ":";

        // Start with current Node, then add Rust paths, then fall back to system
        const pathParts: string[] = [currentNodeBin];

        // Add cargo bin (cross-platform)
        const cargoBin = join(home, ".cargo", "bin");
        if (existsSync(cargoBin)) pathParts.push(cargoBin);

        // Detect active Rust toolchain dynamically instead of hardcoding arch
        try {
          const rustcPath = execSync("rustup which rustc 2>/dev/null", { cwd, timeout: 5000 })
            .toString().trim();
          if (rustcPath) {
            const rustcBin = rustcPath.replace(/[/\\]rustc(\.exe)?$/, "");
            if (!pathParts.includes(rustcBin)) pathParts.push(rustcBin);
          }
        } catch {
          // Fallback: try default stable toolchain
          try {
            const defaultToolchain = execSync("rustup default 2>/dev/null", { cwd, timeout: 5000 })
              .toString().trim().split(/\s/)[0]; // e.g., "stable-aarch64-apple-darwin"
            if (defaultToolchain) {
              const toolchainBin = join(home, ".rustup", "toolchains", defaultToolchain, "bin");
              if (existsSync(toolchainBin)) pathParts.push(toolchainBin);
            }
          } catch {}
        }

        // Platform-appropriate system paths
        if (isWindows) {
          pathParts.push(
            join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs"),
            join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
          );
        } else {
          // macOS + Linux: include homebrew (both Intel and ARM Mac), system bins
          if (existsSync("/opt/homebrew/bin")) pathParts.push("/opt/homebrew/bin"); // ARM Mac
          if (existsSync("/home/linuxbrew/.linuxbrew/bin")) pathParts.push("/home/linuxbrew/.linuxbrew/bin"); // Linux brew
          pathParts.push("/usr/local/bin", "/usr/bin", "/bin");
        }

        serveEnv = {
          PATH: [...new Set(pathParts)].filter(Boolean).join(sep),
        };

        // Detect RUSTUP_TOOLCHAIN from tauri script (some projects pin a specific toolchain)
        const tauriScript = pkg.scripts?.["tauri"] ?? "";
        const toolchainMatch = tauriScript.match(/RUSTUP_TOOLCHAIN=(\S+)/);
        if (toolchainMatch) {
          serveEnv.RUSTUP_TOOLCHAIN = toolchainMatch[1];
        }
      } else {
        const detected = detectDevCommand(cwd);
        devCmd = detected.cmd.split(" ");
        success(`Detected project: ${c.bold}${pkg.name ?? "unknown"}${c.reset}`);
      }
    } catch {}
  }

  // ── Preflight checks ──
  section("PREFLIGHT");
  let preflightOk = true;

  // Check Node.js version
  const nodeVer = process.versions.node;
  const [nodeMajor, nodeMinor] = nodeVer.split(".").map(Number);
  const nodeOk = nodeMajor >= 22 || (nodeMajor === 20 && nodeMinor >= 19);
  if (nodeOk) {
    success(`Node.js ${nodeVer}`);
  } else {
    warn(`Node.js ${nodeVer} — some tools (Vite 6+) require >=20.19 or >=22.12`);
    info(`  ${c.dim}Fix: nvm install 22 && nvm use 22${c.reset}`);
    preflightOk = false;
  }

  // Check npm dependencies installed
  if (existsSync(pkgPath) && !existsSync(join(cwd, "node_modules"))) {
    warn("node_modules not found — run npm install first");
    info(`  ${c.dim}Fix: npm install${c.reset}`);
    preflightOk = false;
  } else {
    success("Dependencies installed");
  }

  if (isTauri) {
    // Check Rust toolchain
    try {
      const rustcVer = execSync("rustc --version", {
        cwd, timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...serveEnv },
      }).toString().trim();
      success(`Rust: ${rustcVer}`);
    } catch {
      warn("rustc not found — Tauri requires the Rust toolchain");
      const rustFix = process.platform === "win32"
        ? "winget install --id Rustlang.Rustup"
        : "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh";
      info(`  ${c.dim}Fix: ${rustFix}${c.reset}`);
      preflightOk = false;
    }

    // Check @tauri-apps/cli is actually installed in node_modules
    const tauriBinName = process.platform === "win32" ? "tauri.cmd" : "tauri";
    const tauriCliBin = join(cwd, "node_modules", ".bin", tauriBinName);
    if (existsSync(tauriCliBin)) {
      success("@tauri-apps/cli installed");
    } else if (existsSync(join(cwd, "node_modules"))) {
      warn("@tauri-apps/cli not found in node_modules");
      info(`  ${c.dim}Fix: npm install${c.reset}`);
      preflightOk = false;
    }
  }

  if (preflightOk) {
    success(`${c.green}All checks passed${c.reset}`);
  } else {
    warn("Some checks failed — stackpack-debug will still install but serve mode may not work");
    info(`  ${c.dim}Fix the issues above, then run: npx stackpack-debug init${c.reset}`);
  }

  // Write MCP config — .mcp.json at project root (Claude Code v2.x standard)
  const mcpPath = join(cwd, ".mcp.json");

  const existing: any = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, "utf-8")) : { mcpServers: {} };
  existing.mcpServers ??= {};

  // Register ONLY the pure MCP server (lightweight, no app startup)
  existing.mcpServers["stackpack-debug"] = {
    command: "npx",
    args: ["-y", "stackpack-debug@latest"],
  };

  // REMOVE any previously registered serve mode (from older versions)
  // Serve mode should NOT be an always-on MCP server — it launches the
  // dev server which is too heavy and may fail during Claude Code startup.
  delete existing.mcpServers["stackpack-debug-serve"];

  writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
  success(`MCP config ${sym.arrow} ${mcpPath}`);

  // Save serve command for reference (not auto-started)
  const serveArgs = ["-y", "stackpack-debug", "serve"];
  if (servePort) serveArgs.push("--port", String(servePort));
  serveArgs.push("--", ...devCmd);
  const serveCmd = `npx ${serveArgs.join(" ")}`;
  const serveCmdPath = join(cwd, ".debug", "serve-command.txt");
  if (!existsSync(join(cwd, ".debug"))) mkdirSync(join(cwd, ".debug"), { recursive: true });
  writeFileSync(serveCmdPath, serveCmd + "\n");
  dim(`  Serve command saved to ${serveCmdPath}`);

  // Hook
  const h = installHook(cwd);
  if (h.installed) success(h.message);

  // Activation rules — Claude Code loads .claude/rules/*.md into every conversation
  const rulesDir = join(cwd, ".claude", "rules");
  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
  const rulesPath = join(rulesDir, "stackpack-debug.md");
  writeFileSync(rulesPath, `# stackpack-debug — MANDATORY for any bug or issue

This project has stackpack-debug running. It captures live runtime data from the running app.

## RULE: Start debugging with the toolkit, not with file exploration.

Before using Read/Grep/Bash to explore code, check the toolkit first.
It provides runtime context that file reading cannot:
- Terminal output (compiler warnings, panics, app state logs)
- Browser console (console.error, IPC failures, network errors)
- TypeScript errors (proactive tsc --noEmit)
- Build errors, git diffs, past solutions, screenshots

The toolkit returns source context, runtime state, and past solutions in one call.
Then use Read/Grep to dive deeper into the specific files it identifies.

## Step 1: Read debug://status

Read the \`debug://status\` MCP resource FIRST. It's a live situation report updated every 5 seconds showing everything happening in the running app right now.

## Step 2: Call debug_investigate

\`\`\`
debug_investigate({ error: "<stack trace or bug description>", files: ["suspect-files.tsx"] })
\`\`\`

Returns: 50-line source context, TypeScript errors, git diff content, terminal output, browser console, past solutions, visual state — everything needed to fix the bug.

## Step 3: After fixing, call debug_verify

\`\`\`
debug_verify({ sessionId, command: "npm run build" })
\`\`\`

## Tool decision tree — pick the right tool for the signal

| Signal needed | Tool | When to use |
|---|---|---|
| Runtime errors, app state | \`debug://status\` | Always first |
| Deep error analysis | \`debug_investigate\` | Stack traces, error messages |
| Performance metrics | \`debug_perf\` | "slow", "laggy", load time issues |
| Visual/layout state | \`debug_visual\` | "overlap", "misaligned", layout bugs |
| Long-running output | \`debug_capture\` with \`wait: true\` | Async ops, build processes, generation tasks |
| Past solutions | \`debug_recall\` | Recurring errors, "this happened before" |

For performance bugs: \`debug_perf\` first, then investigate errors it triggers.
For visual bugs: \`debug_visual\` screenshot first, then investigate with file context.
For async/long-running: \`debug_capture\` with \`wait: true\` to block until output arrives.

## Triggers — use toolkit when user says:

bug, error, issue, crash, panic, broken, fails, fix, debug, investigate, review errors, check the app, what's wrong, doesn't work, overlap, misaligned, layout, visual, slow, laggy, performance, test failure

## Full Diagnostic Sweep

For complex bugs or when initial investigation is inconclusive, use \`/debug-all\` — runs all diagnostic tools in parallel (status + perf + visual + capture) for maximum signal coverage.

## SKIP ONLY for:
- New features with no existing bug
- Obvious typos the user already identified
`);
  success(`Activation rules ${sym.arrow} ${rulesPath}`);

  // Detect environment capabilities (used for doctor output)
  const caps = detectEnvironment(cwd);
  const checks = formatDoctorReport(caps);

  // Install/update SKILL.md — Claude Code auto-discovers skills from .claude/skills/
  updateSkillMd(cwd);
  const skillPath = join(cwd, ".claude", "skills", "stackpack-debug", "SKILL.md");
  success(`Skill installed ${sym.arrow} ${skillPath}`);

  // Install /debug-all command — Claude Code discovers commands from .claude/commands/
  const commandsDir = join(cwd, ".claude", "commands");
  if (!existsSync(commandsDir)) mkdirSync(commandsDir, { recursive: true });
  const commandPath = join(commandsDir, "debug-all.md");
  writeFileSync(commandPath, DEBUG_ALL_COMMAND);
  success(`Command installed ${sym.arrow} ${commandPath}`);

  if (isTauri) {
    section("TAURI SUPPORT");
    info(`${c.green}${sym.check}${c.reset} Rust stack trace parsing (panics + backtraces)`);
    info(`${c.green}${sym.check}${c.reset} Tauri error classification (invoke, capability, plugin)`);
    info(`${c.green}${sym.check}${c.reset} Rust code instrumentation (eprintln! with markers)`);
    info(`${c.green}${sym.check}${c.reset} Tauri log file auto-discovery and tailing`);
    info(`${c.green}${sym.check}${c.reset} RUST_BACKTRACE=1 auto-enabled in serve mode`);

    // Auto-configure Vite plugin for webview console capture
    let vitePluginAdded = false;
    for (const ext of ["ts", "js", "mts", "mjs"]) {
      const viteConfPath = join(cwd, `vite.config.${ext}`);
      if (!existsSync(viteConfPath)) continue;
      try {
        const viteConf = readFileSync(viteConfPath, "utf-8");
        if (viteConf.includes("stackpack-debug/vite-plugin") || viteConf.includes("debugToolkit")) {
          info(`${c.green}${sym.check}${c.reset} Vite plugin already configured (webview console capture)`);
          vitePluginAdded = true;
        } else {
          // Add import and plugin to vite.config
          let modified = viteConf;
          // Add import after last import statement
          const lastImportIdx = modified.lastIndexOf("\nimport ");
          if (lastImportIdx !== -1) {
            const lineEnd = modified.indexOf("\n", lastImportIdx + 1);
            modified = modified.slice(0, lineEnd + 1)
              + `import debugToolkit from "stackpack-debug/vite-plugin";\n`
              + modified.slice(lineEnd + 1);
          } else {
            modified = `import debugToolkit from "stackpack-debug/vite-plugin";\n` + modified;
          }

          // Add plugin to plugins array
          const pluginsMatch = modified.match(/plugins\s*:\s*\[/);
          if (pluginsMatch && pluginsMatch.index !== undefined) {
            const insertAt = pluginsMatch.index + pluginsMatch[0].length;
            modified = modified.slice(0, insertAt)
              + `\n      debugToolkit(),`
              + modified.slice(insertAt);
          }

          writeFileSync(viteConfPath, modified);
          success(`Vite plugin added ${sym.arrow} ${viteConfPath} (webview console capture)`);
          vitePluginAdded = true;
        }
        break;
      } catch {}
    }
    if (!vitePluginAdded) {
      warn("Could not auto-configure Vite plugin for webview console capture");
      dim("    Add manually: import debugToolkit from 'stackpack-debug/vite-plugin' to vite.config");
    }
    dim("");
  }

  section("READY");
  info(`${c.green}${sym.check}${c.reset} ${c.cyan}stackpack-debug${c.reset} registered as MCP server (auto-starts with Claude Code)`);
  dim("");
  info(`${c.dim}For live browser/terminal capture, run separately:${c.reset}`);
  info(`  ${c.cyan}npx stackpack-debug serve -- ${devCmd.join(" ")}${c.reset}`);
  dim("");
  info("Restart Claude Code to activate.");
  dim(`Config: ${mcpPath}\n`);

  // Optional capability check
  const optionals = checks.filter((c) => c.group !== "core" && c.status === "warn");
  if (optionals.length > 0) {
    section("OPTIONAL CAPABILITIES");
    for (const check of checks.filter((c) => c.group !== "core")) {
      if (check.status === "pass") success(check.message);
      else {
        warn(check.message);
        if (check.fix) dim(`    ${check.fix}`);
      }
    }
    info("");
    dim("  Run 'npx stackpack-debug doctor' anytime to check your setup.");
  }
}

// --- Doctor ---

function doctorCommand(cwd: string): void {
  const caps = detectEnvironment(cwd);
  const checks = formatDoctorReport(caps);

  const groups: Array<{ title: string; key: string }> = [
    { title: "CORE", key: "core" },
    { title: "PERFORMANCE (optional)", key: "perf" },
    { title: "VISUAL DEBUGGING (optional)", key: "visual" },
  ];

  for (const group of groups) {
    section(group.title);
    for (const check of checks.filter((c) => c.group === group.key)) {
      if (check.status === "pass") success(check.message);
      else if (check.status === "warn") {
        warn(check.message);
        if (check.fix) dim(`    ${check.fix}`);
      } else {
        error(check.message);
        if (check.fix) dim(`    ${check.fix}`);
      }
    }
  }
  info("");
}

// --- Interactive Prompts (zero dependencies) ---

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// --- Menu Options ---

function buildMenuOptions(cwd: string): SelectOption[] {
  const { cmd: devCmd } = detectDevCommand(cwd);
  return [
    {
      label: "Start dev server with capture",
      desc: `Runs ${devCmd} with browser console, network, and build error capture.`,
      detail: "Launches behind an HTTP proxy with auto-capture. Stop anytime with Ctrl+C.",
    },
    {
      label: "Check setup health",
      desc: "Verify your environment — shows what's working and what's missing.",
      detail: "Quick scan of Node, Git, Lighthouse, Chrome, Ghost OS, and Claude Preview.",
    },
    {
      label: "Re-run setup",
      desc: "Regenerate MCP config, hooks, and activation rules from scratch.",
      detail: "Use after moving the project, updating Node, or if something looks broken.",
    },
  ];
}

// --- Auto-install missing integrations ---

async function autoInstallMissing(cwd: string): Promise<void> {
  const caps = detectEnvironment(cwd);
  const missing = listInstallable(caps).filter((i) => !i.available);
  const autoInstallable = missing.filter((i) => i.autoInstallable);

  if (autoInstallable.length === 0) return;

  info(`Enabling additional capabilities...\n`);
  for (const intg of autoInstallable) {
    const sp = spinner(`Installing ${intg.name}...`);
    const result = installIntegration(intg.id, cwd);
    if (result.success) {
      sp.stop(`${c.green}${sym.check}${c.reset} ${intg.capability.split("—")[0].trim()}`);
    } else {
      sp.stop(`${c.yellow}${sym.bolt}${c.reset} ${intg.name}: ${result.message}`);
    }
  }
  info("");
}

// --- SKILL.md auto-update (runs on every npx spdg / init) ---

function updateSkillMd(cwd: string): boolean {
  const caps = detectEnvironment(cwd);
  const capsTable = [
    "",
    "## Available Capabilities",
    "",
    "| Capability | Status |",
    "|---|---|",
    `| Core debugging | ✓ Installed |`,
    `| Performance (Lighthouse) | ${caps.perf.lighthouseAvailable ? "✓ Available" : "✗ Not installed — \\`npm install -g lighthouse\\`"} |`,
    `| Visual (Ghost OS) | ${caps.visual.ghostOsConfigured ? "✓ Configured" : "✗ Not configured"} |`,
    `| Visual (Claude Preview) | ✓ Built into Claude Code desktop |`,
    "",
    "Run `npx stackpack-debug doctor` to refresh this status.",
  ].join("\n");

  const skillDir = join(cwd, ".claude", "skills", "stackpack-debug");
  if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");

  // Find the SKILL.md from the installed package (dist/../SKILL.md)
  let skillContent: string | null = null;
  for (const p of [join(__dirname, "..", "SKILL.md"), join(__dirname, "SKILL.md")]) {
    if (existsSync(p)) { skillContent = readFileSync(p, "utf-8"); break; }
  }

  const finalContent = skillContent
    ? skillContent + capsTable
    : `---
name: stackpack-debug
description: "Closed-loop debugging for AI agents. Use for runtime errors, stack traces, test failures, AND logic/behavior bugs. Start every debugging task with debug_investigate."
tools: ["debug_investigate", "debug_recall", "debug_patterns", "debug_instrument", "debug_capture", "debug_verify", "debug_cleanup", "debug_session"]
---

# stackpack-debug

You have access to a debugging toolkit via MCP. Start every debugging task with \`debug_investigate\`.

## When to Use
- Runtime error or stack trace
- Test failure
- Wrong output / visual bug / logic bug
- Bug report from a user

## Workflow
1. debug_investigate → understand the error + auto-recall past fixes
2. debug_instrument → add logging if needed
3. debug_capture → collect runtime output
4. (apply fix)
5. debug_verify → confirm the fix works
6. debug_cleanup → remove markers, save diagnosis to memory
` + capsTable;

  // Only write if content changed (avoid unnecessary FS writes)
  try {
    const existing = existsSync(skillPath) ? readFileSync(skillPath, "utf-8") : "";
    if (existing === finalContent) return false;
  } catch {}

  writeFileSync(skillPath, finalContent);
  return true;
}

// --- Guided Setup (TTY entrypoint) ---

async function guidedSetup(cwd: string): Promise<void> {
  banner();

  // Check if already initialized
  const mcpExists = existsSync(join(cwd, ".mcp.json")) || existsSync(join(cwd, ".claude", "mcp.json"));

  if (mcpExists) {
    success(`Already set up in this project. Ready to use in Claude Code.\n`);

    // Check for updates
    const update = checkForUpdate();
    if (update.updateAvailable) {
      warn(`\n  ${c.yellow}${c.bold}Update available: v${update.current} → v${update.latest}${c.reset}`);
      info(`  Run: ${c.cyan}npx stackpack-debug@latest${c.reset}`);
      info(`  Or in Claude Code: ${c.cyan}debug_setup action='update'${c.reset}\n`);
    }

    // Silently update SKILL.md and command on every run (picks up new content from package updates)
    updateSkillMd(cwd);
    const commandsDir = join(cwd, ".claude", "commands");
    if (!existsSync(commandsDir)) mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, "debug-all.md"), DEBUG_ALL_COMMAND);

    // Auto-install missing integrations on every run
    await autoInstallMissing(cwd);

    await mainMenu(cwd);
    return;
  }

  // Fresh project — guided init
  info("Welcome! Let's set up stackpack-debug for this project.\n");

  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) success(`Detected project: ${c.bold}${pkg.name}${c.reset}`);
    } catch { /* skip */ }
  }

  const proceed = await ask(`  ${c.dim}Set up stackpack-debug? (Y/n): ${c.reset}`);
  if (proceed.toLowerCase() === "n") {
    info("Setup cancelled. Run 'npx stackpack-debug' anytime to try again.");
    return;
  }

  // Run the full init
  initCommand(cwd);

  // Auto-install all available integrations
  info("");
  await autoInstallMissing(cwd);

  // Show capability summary
  section("YOUR AGENT CAN NOW");
  success("Investigate errors — classify, locate source, show git context");
  success("Instrument code — add conditional logging in JS/TS, Python, Go, Rust");
  success("Capture runtime output — terminal, browser console, build errors");
  success("Verify fixes — run tests, confirm pass/fail");
  success("Learn from every fix — recall past solutions, detect patterns");

  // Check what was installed
  const capsAfterInstall = detectEnvironment(cwd);
  const allIntegrations = listInstallable(capsAfterInstall);
  if (allIntegrations.find((i) => i.id === "lighthouse")?.available) {
    success("Profile performance — Lighthouse Web Vitals before/after comparison");
  }
  if (allIntegrations.find((i) => i.id === "ghost-os")?.available) {
    success("Debug visually — auto-capture screenshots, inspect DOM elements");
  }

  dim("");
  dim("  Claude Code Preview is supported automatically in Claude Code desktop.");

  // After setup, show menu for next steps
  info("");
  success(`Setup complete! Choose what to do next, or press ${c.dim}Esc${c.reset} to exit.\n`);
  await mainMenu(cwd);
}

async function mainMenu(cwd: string): Promise<void> {
  // Menu loop — keeps returning to menu after each action
  while (true) {
    const choice = await select("What would you like to do?", buildMenuOptions(cwd));

    if (choice === -1) {
      // Escape or Ctrl+C — exit gracefully
      info(`${c.dim}Run ${c.reset}npx stackpack-debug${c.dim} anytime to come back.${c.reset}\n`);
      break;
    }

    switch (choice) {
      case 0: await guidedServe(cwd); return; // serve takes over, don't loop
      case 1: doctorCommand(cwd); break;
      case 2: initCommand(cwd); break;
    }

    // After command completes, show separator before next menu
    info("");
  }
}

function detectDevCommand(cwd: string): { cmd: string; isTauri: boolean } {
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      // Detect Tauri project
      const hasTauriCli = pkg.devDependencies?.["@tauri-apps/cli"] || pkg.dependencies?.["@tauri-apps/cli"];
      const hasTauriScript = pkg.scripts?.["tauri"];
      if ((hasTauriCli || hasTauriScript) && existsSync(join(cwd, "src-tauri"))) {
        return { cmd: "npm run tauri -- dev", isTauri: true };
      }
      if (pkg.scripts?.dev) return { cmd: "npm run dev", isTauri: false };
      if (pkg.scripts?.start) return { cmd: "npm start", isTauri: false };
      if (pkg.scripts?.serve) return { cmd: "npm run serve", isTauri: false };
    } catch { /* skip */ }
  }
  return { cmd: "npm run dev", isTauri: false };
}

async function guidedServe(cwd: string): Promise<void> {
  const { cmd: devCmd } = detectDevCommand(cwd);
  info(`Starting: ${c.bold}npx stackpack-debug serve -- ${devCmd}${c.reset}\n`);

  const child = spawn(process.execPath, [process.argv[1], "serve", "--", ...devCmd.split(" ")], {
    stdio: "inherit",
    cwd,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  // Keep the process alive
  await new Promise(() => {});
}

async function guidedExport(cwd: string): Promise<void> {
  const outPath = await ask(`  ${c.dim}Export path [./debug-knowledge.json]: ${c.reset}`);
  const finalPath = outPath || join(cwd, "debug-knowledge.json");
  const result = exportPack(cwd, finalPath);
  success(`Exported ${result.entries} entries to ${result.path}`);
}

async function guidedImport(cwd: string): Promise<void> {
  const packPath = await ask(`  ${c.dim}Pack file path: ${c.reset}`);
  if (!packPath) { warn("No path provided."); return; }
  if (!existsSync(packPath)) { error(`File not found: ${packPath}`); return; }
  const result = importPack(cwd, packPath);
  success(`Imported ${result.imported} entries (${result.total} total in memory)`);
}

// --- Install ---


// --- Main ---

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const cwd = resolve(process.cwd());
  setCwd(cwd);

  switch (parsed.command) {
    case "help": printHelp(); break;

    case "update": {
      banner();
      section("UPDATE");

      // Check current vs latest
      const update = checkForUpdate();
      info(`Current version: ${c.bold}v${update.current}${c.reset}`);
      info(`Latest version:  ${c.bold}v${update.latest}${c.reset}\n`);

      if (!update.updateAvailable) {
        success("Already on the latest version.\n");
        break;
      }

      // Fetch latest
      info(`Updating stackpack-debug ${c.dim}v${update.current} → v${update.latest}${c.reset}...\n`);
      try {
        execSync("npm install -g stackpack-debug@latest", { stdio: "inherit", timeout: 60_000 });
        success(`Updated to v${update.latest}\n`);
      } catch {
        // Fallback: not installed globally, clear npx cache instead
        try {
          execSync("npx -y stackpack-debug@latest --version", { stdio: "pipe", timeout: 30_000 });
          success(`Updated npx cache to v${update.latest}\n`);
        } catch (e2) {
          error(`Update failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
          info(`Try manually: ${c.cyan}npm install -g stackpack-debug@latest${c.reset}`);
          break;
        }
      }

      // Re-run init to refresh SKILL.md, rules, and commands
      section("REFRESH");
      info("Updating SKILL.md, activation rules, and commands...\n");
      initCommand(cwd);

      info("");
      success("Update complete. Restart Claude Code to use the new version.\n");
      break;
    }

    case "demo": {
      const { runDemo } = await import("./demo.js");
      await runDemo();
      break;
    }

    case "init": initCommand(cwd); break;

    case "doctor": doctorCommand(cwd); break;

    // "install" removed — integrations are auto-installed during init/setup

    case "export": {
      const outPath = process.argv[3] ?? join(cwd, ".debug", "knowledge-pack.json");
      const filterArg = process.argv.find((a) => a.startsWith("--filter="));
      const filter = filterArg?.split("=")[1];
      const result = exportPack(cwd, outPath, { filter });
      console.log(`Exported ${result.entries} entries to ${result.path}`);
      break;
    }

    case "import": {
      const packPath = process.argv[3];
      if (!packPath) {
        console.error("Usage: stackpack-debug import <pack-file>");
        process.exit(1);
      }
      const result = importPack(cwd, packPath);
      console.log(`Imported ${result.imported} new entries (${result.total} total)`);
      break;
    }

    case "clean": {
      banner();
      info("Scanning for debug markers...");
      const r = cleanupFromManifest(cwd);
      if (r.cleaned === 0) success("Clean — no markers found.");
      else {
        success(`${r.cleaned} file(s) cleaned`);
        for (const f of r.filesProcessed) dim(`  ${sym.arrow} ${f}`);
        if (!r.verified) for (const e of r.errors) error(e);
      }
      process.exit(r.verified ? 0 : 1);
      break;
    }

    case "uninstall": {
      banner();
      section("UNINSTALL");
      info("Removing stackpack-debug from this project...\n");

      let removed = 0;

      // 1. Remove MCP config entries
      for (const p of [join(cwd, ".mcp.json"), join(cwd, ".claude", "mcp.json")]) {
        if (existsSync(p)) {
          try {
            const config = JSON.parse(readFileSync(p, "utf-8"));
            const servers = config.mcpServers as Record<string, unknown> | undefined;
            if (servers?.["stackpack-debug"]) {
              delete servers["stackpack-debug"];
              writeFileSync(p, JSON.stringify(config, null, 2));
              success(`Removed stackpack-debug from ${p.replace(cwd + "/", "")}`);
              removed++;
            }
          } catch { /* skip */ }
        }
      }

      // 2. Remove activation rules
      const rulesPath = join(cwd, ".claude", "rules", "stackpack-debug.md");
      if (existsSync(rulesPath)) {
        unlinkSync(rulesPath);
        success("Removed activation rules");
        removed++;
      }

      // 3. Remove SKILL.md
      const skillDir = join(cwd, ".claude", "skills", "stackpack-debug");
      if (existsSync(skillDir)) {
        for (const f of readdirSync(skillDir)) unlinkSync(join(skillDir, f));
        rmdirSync(skillDir);
        success("Removed SKILL.md");
        removed++;
      }

      // 4. Remove pre-commit hook
      const hookResult = uninstallHook(cwd);
      if (hookResult.removed) {
        success("Removed pre-commit hook");
        removed++;
      }

      // 5. Note about .debug/ directory
      if (existsSync(join(cwd, ".debug"))) {
        info("");
        dim(`  ${c.yellow}Note:${c.reset} .debug/ directory preserved (contains debug memory and telemetry).`);
        dim(`  To delete: ${c.reset}rm -rf .debug/${c.dim}`);
      }

      info("");
      if (removed > 0) {
        success(`stackpack-debug removed. Restart Claude Code to apply changes.`);
      } else {
        dim("Nothing to remove — stackpack-debug was not configured in this project.");
      }
      break;
    }

    // DEFAULT: Context-aware entrypoint.
    // TTY (human in terminal) → guided setup/menu
    // Non-TTY (MCP client)   → start MCP server silently
    case "mcp": {
      if (process.stdout.isTTY) {
        await guidedSetup(cwd);
      } else {
        await startMcpServer();
      }
      break;
    }

    case "serve": {
      if (parsed.childCommand.length === 0) {
        error("No command specified");
        dim("  Usage: stackpack-debug serve -- <command>");
        process.exit(1);
      }

      const childCmd = parsed.childCommand.join(" ");
      banner();
      kv("process", childCmd);

      // Auto-enable Rust backtraces for Tauri/Rust projects
      const childEnv = { ...process.env };
      if (!childEnv.RUST_BACKTRACE) childEnv.RUST_BACKTRACE = "1";
      if (!childEnv.RUST_LOG) childEnv.RUST_LOG = "info";

      const child = spawn(childCmd, {
        shell: true,
        stdio: ["inherit", "pipe", "pipe"],
        cwd,
        env: childEnv,
      });
      pipeProcess(child);
      installHook(cwd);

      let proxyHandle: { close: () => void } | null = null;
      if (child.stdout) {
        try {
          const target = parsed.port ?? (await detectPort(child.stdout));
          const listen = parsed.port ? parsed.port + 1 : target + 1000;
          proxyHandle = startProxy({ targetPort: target, listenPort: listen });
          kv("proxy", `http://localhost:${listen} ${sym.arrow} :${target}`);
        } catch (e) {
          warn(`Proxy unavailable: ${e instanceof Error ? e.message : ""}`);
        }
      }

      // MCP server runs in a separate process (via .mcp.json config).
      // Don't start it here — stdio is shared with the child dev server.

      // Live activity feed — shows MCP tool calls in this terminal
      const activityFeed = startActivityFeed(cwd);

      // Live context writer — writes .debug/live-context.json every 5s for MCP to read
      const liveContextWriter = startLiveContextWriter(cwd);

      // Loop watcher — monitors live context for error patterns and alerts the user
      // This is what makes stackpack-debug useful even when a closed agent (Lovable, Bolt)
      // is editing the code: the user sees loop warnings in this terminal
      const loopWatcher = startLoopWatcher(cwd);

      const cleanup = () => {
        activityFeed.stop();
        liveContextWriter.stop();
        loopWatcher.stop();
        if (child.pid) treeKill(child.pid, "SIGTERM");
        proxyHandle?.close();
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      child.on("close", (code) => {
        dim(`Process exited (${code})`);
        proxyHandle?.close();
        process.exit(code ?? 0);
      });
      break;
    }
  }
}

main().catch((e) => { error(String(e)); process.exit(1); });

export { fitToBudget, estimateTokens } from "./budget.js";
export { explainTriage, explainConfidence, explainArchival } from "./explain.js";
export { recordOutcome, getTelemetry, getFixRateForError } from "./telemetry.js";
export { connectToGhostOs, disconnectGhostOs, isGhostConnected } from "./ghost-bridge.js";
