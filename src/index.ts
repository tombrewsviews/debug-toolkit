#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import treeKill from "tree-kill";
import { pipeProcess } from "./capture.js";
import { startProxy, detectPort } from "./proxy.js";
import { setCwd, startMcpServer } from "./mcp.js";
import { exportPack, importPack } from "./packs.js";
import { installHook } from "./hook.js";
import { cleanupFromManifest } from "./cleanup.js";
import { banner, info, success, warn, error, dim, section, kv, ready, printHelp, sym, c } from "./cli.js";
import { detectEnvironment, formatDoctorReport, type EnvironmentCapabilities } from "./adapters.js";

// --- Parse ---

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const cmd = args[0] ?? "mcp"; // DEFAULT: pure MCP server (zero-config!)

  if (["clean", "init", "doctor", "demo", "help", "--help", "-h", "mcp", "export", "import"].includes(cmd)) {
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
        if (pkg.scripts?.dev) devCmd = ["npm", "run", "dev"];
        else if (pkg.scripts?.start) devCmd = ["npm", "start"];
        else if (pkg.scripts?.serve) devCmd = ["npm", "run", "serve"];
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
  banner();
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
  info("Run 'npx debug-toolkit doctor' anytime to check your setup.");
}

// --- Interactive Prompts (zero dependencies) ---

function ask(question: string): Promise<string> {
  const { createInterface } = require("node:readline") as typeof import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askChoice(question: string, options: Array<{ key: string; label: string }>): Promise<string> {
  info(question);
  for (const opt of options) {
    info(`  ${c.cyan}${opt.key}${c.reset}) ${opt.label}`);
  }
  const answer = await ask(`\n  ${c.dim}Enter choice [${options[0].key}]: ${c.reset}`);
  const match = options.find((o) => o.key === answer.toLowerCase());
  return match?.key ?? options[0].key;
}

// --- Guided Setup (TTY entrypoint) ---

async function guidedSetup(cwd: string): Promise<void> {
  banner();

  // Check if already initialized
  const mcpExists = existsSync(join(cwd, ".mcp.json")) || existsSync(join(cwd, ".claude", "mcp.json"));

  if (mcpExists) {
    info("debug-toolkit is already set up in this project.\n");
    const choice = await askChoice("What would you like to do?", [
      { key: "1", label: "Check setup health (doctor)" },
      { key: "2", label: "Re-run setup" },
      { key: "3", label: "Start dev server with capture" },
      { key: "4", label: "Export debug knowledge" },
      { key: "5", label: "Import debug knowledge" },
    ]);
    switch (choice) {
      case "1": doctorCommand(cwd); break;
      case "2": initCommand(cwd); break;
      case "3": await guidedServe(cwd); break;
      case "4": await guidedExport(cwd); break;
      case "5": await guidedImport(cwd); break;
    }
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

  // Offer optional installs
  const caps = detectEnvironment(cwd);
  if (!caps.perf.lighthouseAvailable) {
    info("");
    const installLh = await ask(`  ${c.dim}Install Lighthouse for performance profiling? (y/N): ${c.reset}`);
    if (installLh.toLowerCase() === "y") {
      info("Installing lighthouse globally...");
      try {
        execSync("npm install -g lighthouse", { stdio: "inherit", timeout: 120_000 });
        success("Lighthouse installed");
      } catch {
        warn("Installation failed — install manually: npm install -g lighthouse");
      }
    }
  }
}

async function guidedServe(cwd: string): Promise<void> {
  let defaultCmd = "npm run dev";
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.dev) defaultCmd = "npm run dev";
      else if (pkg.scripts?.start) defaultCmd = "npm start";
      else if (pkg.scripts?.serve) defaultCmd = "npm run serve";
    } catch { /* skip */ }
  }

  const cmd = await ask(`  ${c.dim}Dev command [${defaultCmd}]: ${c.reset}`);
  const finalCmd = cmd || defaultCmd;
  info(`Starting: npx debug-toolkit serve -- ${finalCmd}\n`);

  const child = spawn(process.execPath, [process.argv[1], "serve", "--", ...finalCmd.split(" ")], {
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
