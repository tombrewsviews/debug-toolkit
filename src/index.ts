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
import { installHook } from "./hook.js";
import { cleanupFromManifest } from "./cleanup.js";
import { banner, info, success, warn, error, dim, section, kv, ready, printHelp, sym, c } from "./cli.js";

// --- Parse ---

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const cmd = args[0] ?? "mcp"; // DEFAULT: pure MCP server (zero-config!)

  if (["clean", "init", "demo", "help", "--help", "-h", "mcp"].includes(cmd)) {
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

When you encounter ANY of these, call \`debug_investigate\` BEFORE reading code manually:

| Trigger | Action |
|---------|--------|
| Stack trace or error output | \`debug_investigate({ error: "<paste stack trace>" })\` |
| Test failure | \`debug_investigate({ error: "<test output>" })\` |
| "Wrong output" / "doesn't match" / visual bug | \`debug_investigate({ error: "<description>", files: ["src/..."] })\` |
| User reports a bug | \`debug_investigate({ error: "<user's description>", files: ["likely files"] })\` |

## TRIGGER: After fixing any bug

ALWAYS call \`debug_cleanup\` with:
- \`diagnosis\`: one-line root cause
- \`rootCause\`: \`{ trigger, errorFile, causeFile, fixDescription }\`

This saves the diagnosis for future sessions. Skipping this wastes the work.

## TRIGGER: Before claiming a fix works

ALWAYS call \`debug_verify({ command: "npm test" })\` or equivalent.
Never say "the fix works" without verification output.

## WHY

\`debug_investigate\` returns error classification, source code, git diff, environment, AND past solutions — all in one call. Manually reading files with Read/Grep gives you less context and takes more turns.

The debug memory system learns from every session. The more you use it, the faster future debugging becomes.
`);
  success(`Activation rules ${sym.arrow} ${rulesPath}`);

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
    writeFileSync(skillPath, skillContent);
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
`);
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

    // DEFAULT: Pure MCP server. No dev server wrapping needed.
    // Just start the MCP server on stdio. The agent gets 6 tools instantly.
    case "mcp": {
      await startMcpServer();
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
