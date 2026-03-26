#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import treeKill from "tree-kill";
import { pipeProcess } from "./capture.js";
import { startProxy, detectPort } from "./proxy.js";
import { setCwd, startMcpServer } from "./mcp.js";
import { exportPack, importPack } from "./packs.js";
import { installHook, uninstallHook } from "./hook.js";
import { cleanupFromManifest } from "./cleanup.js";
import { banner, info, success, warn, error, dim, section, kv, ready, printHelp, sym, c, select, spinner, type SelectOption } from "./cli.js";
import { detectEnvironment, formatDoctorReport, listInstallable, installIntegration, type EnvironmentCapabilities } from "./adapters.js";

// --- Parse ---

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const cmd = args[0] ?? "mcp"; // DEFAULT: pure MCP server (zero-config!)

  if (["clean", "init", "install", "uninstall", "doctor", "demo", "help", "--help", "-h", "mcp", "export", "import"].includes(cmd)) {
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
    warn("Some checks failed — debug-toolkit will still install but serve mode may not work");
    info(`  ${c.dim}Fix the issues above, then run: npx debug-toolkit init${c.reset}`);
  }

  // Write MCP config — .mcp.json at project root (Claude Code v2.x standard)
  const mcpPath = join(cwd, ".mcp.json");

  const existing: any = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, "utf-8")) : { mcpServers: {} };
  existing.mcpServers ??= {};

  // Register ONLY the pure MCP server (lightweight, no app startup)
  existing.mcpServers["debug-toolkit"] = {
    command: "npx",
    args: ["-y", "debug-toolkit"],
  };

  // REMOVE any previously registered serve mode (from older versions)
  // Serve mode should NOT be an always-on MCP server — it launches the
  // dev server which is too heavy and may fail during Claude Code startup.
  delete existing.mcpServers["debug-toolkit-serve"];

  writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
  success(`MCP config ${sym.arrow} ${mcpPath}`);

  // Save serve command for reference (not auto-started)
  const serveArgs = ["-y", "debug-toolkit", "serve"];
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
  const rulesPath = join(rulesDir, "debug-toolkit.md");
  writeFileSync(rulesPath, `# debug-toolkit — activation rules

## TRIGGER: Any error, failure, or bug
When you encounter ANY of these, call debug_investigate BEFORE reading code manually:
- Stack trace → debug_investigate({ error })
- Test failure → debug_investigate({ error })
- "Wrong output" / visual bug → debug_investigate({ error, files: [...] })
- Bug report → debug_investigate({ error, files: [...] })

Note: The toolkit auto-triages errors. Trivial errors (missing imports, syntax errors)
get a fast-path response with a fix hint. Complex errors get the full investigation.

## SKIP toolkit for:
- Syntax errors you can already see in the editor
- Single-character typos with obvious fixes
- Errors where the user already pasted the full context and fix is obvious

## Use debug_recall (not full investigate) when:
- The error is clear but might be recurring
- You want to check if this was solved before

## TRIGGER: After fixing any bug
The toolkit auto-saves to memory when debug_verify passes.
Only call debug_cleanup if you need to:
- Remove debug instrumentation from source files
- Add a custom diagnosis or rootCause chain

## TRIGGER: Before claiming fix works
ALWAYS call debug_verify({ command: "npm test" })

## TRIGGER: Periodically check for patterns
Call debug_patterns to see recurring issues and preventive suggestions.

## WHY
debug_investigate returns error classification, source code, git diff, environment,
AND past solutions in one call. Trivial errors get fast-path responses in <100ms.
`);
  success(`Activation rules ${sym.arrow} ${rulesPath}`);

  // Detect environment capabilities (used for SKILL.md + optional output)
  const caps = detectEnvironment(cwd);
  const checks = formatDoctorReport(caps);

  // Build capabilities table for SKILL.md
  const capsTable = [
    "",
    "## Available Capabilities",
    "",
    "| Capability | Status |",
    "|---|---|",
    `| Core debugging | ✓ Installed |`,
    `| Performance (Lighthouse) | ${caps.perf.lighthouseAvailable ? "✓ Available" : "✗ Not installed — \\`npm install -g lighthouse\\`"} |`,
    `| Visual (Ghost OS) | ${caps.visual.ghostOsConfigured ? "✓ Configured" : "✗ Not configured"} |`,
    `| Visual (Claude Preview) | ${caps.visual.claudePreviewConfigured ? "✓ Configured" : "✗ Not configured"} |`,
    "",
    "Run `npx debug-toolkit doctor` to refresh this status.",
  ].join("\n");

  // Install SKILL.md — Claude Code auto-discovers skills from .claude/skills/
  const skillDir = join(cwd, ".claude", "skills", "debug-toolkit");
  if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");

  // Find the SKILL.md from the installed package (dist/../SKILL.md)
  let skillContent: string | null = null;
  for (const p of [join(__dirname, "..", "SKILL.md"), join(__dirname, "SKILL.md")]) {
    if (existsSync(p)) { skillContent = readFileSync(p, "utf-8"); break; }
  }

  if (skillContent) {
    writeFileSync(skillPath, skillContent + capsTable);
    success(`Skill installed ${sym.arrow} ${skillPath}`);
  } else {
    // Inline fallback — write the essential skill content
    writeFileSync(skillPath, `---
name: debug-toolkit
description: "Closed-loop debugging for AI agents. Use for runtime errors, stack traces, test failures, AND logic/behavior bugs. Start every debugging task with debug_investigate."
tools: ["debug_investigate", "debug_recall", "debug_patterns", "debug_instrument", "debug_capture", "debug_verify", "debug_cleanup", "debug_session"]
---

# debug-toolkit

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
` + capsTable);
    success(`Skill installed ${sym.arrow} ${skillPath}`);
  }

  if (isTauri) {
    section("TAURI SUPPORT");
    info(`${c.green}${sym.check}${c.reset} Rust stack trace parsing (panics + backtraces)`);
    info(`${c.green}${sym.check}${c.reset} Tauri error classification (invoke, capability, plugin)`);
    info(`${c.green}${sym.check}${c.reset} Rust code instrumentation (eprintln! with markers)`);
    info(`${c.green}${sym.check}${c.reset} Tauri log file auto-discovery and tailing`);
    info(`${c.green}${sym.check}${c.reset} RUST_BACKTRACE=1 auto-enabled in serve mode`);
    dim("");
  }

  section("READY");
  info(`${c.green}${sym.check}${c.reset} ${c.cyan}debug-toolkit${c.reset} registered as MCP server (auto-starts with Claude Code)`);
  dim("");
  info(`${c.dim}For live browser/terminal capture, run separately:${c.reset}`);
  info(`  ${c.cyan}npx debug-toolkit serve -- ${devCmd.join(" ")}${c.reset}`);
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
    dim("  Run 'npx debug-toolkit doctor' anytime to check your setup.");
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

// --- Guided Setup (TTY entrypoint) ---

async function guidedSetup(cwd: string): Promise<void> {
  banner();

  // Check if already initialized
  const mcpExists = existsSync(join(cwd, ".mcp.json")) || existsSync(join(cwd, ".claude", "mcp.json"));

  if (mcpExists) {
    success(`Already set up in this project. Ready to use in Claude Code.\n`);

    // Auto-install missing integrations on every run
    await autoInstallMissing(cwd);

    await mainMenu(cwd);
    return;
  }

  // Fresh project — guided init
  info("Welcome! Let's set up debug-toolkit for this project.\n");

  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) success(`Detected project: ${c.bold}${pkg.name}${c.reset}`);
    } catch { /* skip */ }
  }

  const proceed = await ask(`  ${c.dim}Set up debug-toolkit? (Y/n): ${c.reset}`);
  if (proceed.toLowerCase() === "n") {
    info("Setup cancelled. Run 'npx debug-toolkit' anytime to try again.");
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
      info(`${c.dim}Run ${c.reset}npx debug-toolkit${c.dim} anytime to come back.${c.reset}\n`);
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
  info(`Starting: ${c.bold}npx debug-toolkit serve -- ${devCmd}${c.reset}\n`);

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

async function installCommand(cwd: string): Promise<void> {
  const caps = detectEnvironment(cwd);
  const integrations = listInstallable(caps);
  const available = integrations.filter((i) => i.available);
  const missing = integrations.filter((i) => !i.available);
  const installable = missing.filter((i) => i.autoInstallable);

  // Show what's already enabled
  if (available.length > 0) {
    section("ENABLED");
    for (const intg of available) {
      success(`${c.bold}${intg.capability.split("—")[0].trim()}${c.reset} ${c.dim}(${intg.packageName})${c.reset}`);
    }
  }

  // Claude Preview note
  info("");
  dim("  Claude Code Preview is supported automatically when using Claude Code desktop.");

  if (missing.length === 0) {
    info("");
    success("All capabilities are enabled!");
    return;
  }

  // Build selector options — "Enable all" first, then individual
  const selectorOptions: SelectOption[] = [];

  if (installable.length > 1) {
    const totalSize = installable.map((i) => i.diskSize).join(" + ");
    selectorOptions.push({
      label: `Enable all capabilities (${installable.map((i) => i.name).join(", ")})`,
      desc: `Installs everything needed for full performance + visual debugging.`,
      detail: `Disk space: ${totalSize}. All open-source. Remove anytime with npm/brew uninstall.`,
    });
  }

  for (const intg of missing) {
    if (intg.autoInstallable) {
      selectorOptions.push({
        label: intg.capability.split("—")[0].trim(),
        desc: `${intg.packageName} — ${intg.description}`,
        detail: `Runs: ${c.dim}${intg.installCommand}${c.reset} (${intg.diskSize})`,
      });
    } else {
      selectorOptions.push({
        label: intg.capability.split("—")[0].trim(),
        desc: `${intg.packageName} — ${intg.description}`,
        detail: `${c.yellow}Manual:${c.reset} ${intg.manualSteps}`,
      });
    }
  }

  selectorOptions.push({
    label: "Skip for now",
    desc: "You can enable these anytime from this menu.",
    detail: "",
  });

  section("CAPABILITIES TO ENABLE");
  info("");
  const choice = await select("What would you like to enable?", selectorOptions);

  if (choice === -1 || choice === selectorOptions.length - 1) {
    // Esc or "Skip for now"
    return;
  }

  let toInstall: typeof missing;
  if (installable.length > 1 && choice === 0) {
    // "Enable all"
    toInstall = installable;
  } else {
    // Individual choice — offset by 1 if "Enable all" was shown
    const offset = installable.length > 1 ? 1 : 0;
    const intg = missing[choice - offset];
    if (!intg || !intg.autoInstallable) {
      warn(`${missing[choice - offset]?.name ?? "This"} requires manual setup.`);
      return;
    }
    toInstall = [intg];
  }

  info("");
  for (const intg of toInstall) {
    const sp = spinner(`Installing ${intg.name}...`);
    const result = installIntegration(intg.id, cwd);
    if (result.success) {
      sp.stop(`${c.green}${sym.check}${c.reset} ${result.message}`);
    } else {
      sp.stop(`${c.yellow}${sym.bolt}${c.reset} ${result.message}`);
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const cwd = resolve(process.cwd());
  setCwd(cwd);

  switch (parsed.command) {
    case "help": printHelp(); break;

    case "demo": {
      const { runDemo } = await import("./demo.js");
      await runDemo();
      break;
    }

    case "init": initCommand(cwd); break;

    case "doctor": doctorCommand(cwd); break;

    case "install": await installCommand(cwd); break;

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
        console.error("Usage: debug-toolkit import <pack-file>");
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
      info("Removing debug-toolkit from this project...\n");

      let removed = 0;

      // 1. Remove MCP config entries
      for (const p of [join(cwd, ".mcp.json"), join(cwd, ".claude", "mcp.json")]) {
        if (existsSync(p)) {
          try {
            const config = JSON.parse(readFileSync(p, "utf-8"));
            const servers = config.mcpServers as Record<string, unknown> | undefined;
            if (servers?.["debug-toolkit"]) {
              delete servers["debug-toolkit"];
              writeFileSync(p, JSON.stringify(config, null, 2));
              success(`Removed debug-toolkit from ${p.replace(cwd + "/", "")}`);
              removed++;
            }
          } catch { /* skip */ }
        }
      }

      // 2. Remove activation rules
      const rulesPath = join(cwd, ".claude", "rules", "debug-toolkit.md");
      if (existsSync(rulesPath)) {
        unlinkSync(rulesPath);
        success("Removed activation rules");
        removed++;
      }

      // 3. Remove SKILL.md
      const skillDir = join(cwd, ".claude", "skills", "debug-toolkit");
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
        success(`debug-toolkit removed. Restart Claude Code to apply changes.`);
      } else {
        dim("Nothing to remove — debug-toolkit was not configured in this project.");
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
        dim("  Usage: debug-toolkit serve -- <command>");
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

      startMcpServer().catch((e) => error(`MCP: ${e}`));
      ready(8);

      const cleanup = () => {
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
