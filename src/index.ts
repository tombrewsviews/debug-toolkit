#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

        // Detect Vite port from vite.config or default
        servePort = 1420; // Vite default for Tauri
        try {
          const viteConfPath = join(cwd, "vite.config.ts");
          if (existsSync(viteConfPath)) {
            const viteConf = readFileSync(viteConfPath, "utf-8");
            const portMatch = viteConf.match(/port\s*:\s*(\d+)/);
            if (portMatch) servePort = parseInt(portMatch[1], 10);
          }
        } catch {}

        // Detect Rust toolchain from tauri script or use default
        serveEnv = {
          PATH: [
            "/opt/homebrew/bin",
            join(process.env.HOME ?? "", ".cargo/bin"),
            join(process.env.HOME ?? "", ".rustup/toolchains/stable-aarch64-apple-darwin/bin"),
            "/usr/local/bin", "/usr/bin", "/bin",
          ].join(":"),
        };
        // Check if the tauri script sets RUSTUP_TOOLCHAIN
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
      const rustcVer = execSync("rustc --version 2>/dev/null", {
        cwd, timeout: 5000,
        env: { ...process.env, ...serveEnv },
      }).toString().trim();
      success(`Rust: ${rustcVer}`);
    } catch {
      warn("rustc not found — Tauri requires the Rust toolchain");
      info(`  ${c.dim}Fix: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh${c.reset}`);
      preflightOk = false;
    }

    // Check @tauri-apps/cli is actually installed in node_modules
    const tauriCliBin = join(cwd, "node_modules", ".bin", "tauri");
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

  // OPTION A: Pure MCP mode (zero-config, no proxy)
  existing.mcpServers["debug-toolkit"] = {
    command: "npx",
    args: ["-y", "debug-toolkit"],
  };

  // OPTION B: With dev server wrapping (full capture)
  const serveArgs = ["-y", "debug-toolkit", "serve"];
  if (servePort) serveArgs.push("--port", String(servePort));
  serveArgs.push("--", ...devCmd);

  const serveConfig: Record<string, unknown> = {
    command: "npx",
    args: serveArgs,
  };
  if (serveEnv) serveConfig.env = serveEnv;

  existing.mcpServers["debug-toolkit-serve"] = serveConfig;

  writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
  success(`MCP config ${sym.arrow} ${mcpPath}`);

  // Hook
  const h = installHook(cwd);
  if (h.installed) success(h.message);

  if (isTauri) {
    section("TAURI SUPPORT");
    info(`${c.green}${sym.check}${c.reset} Rust stack trace parsing (panics + backtraces)`);
    info(`${c.green}${sym.check}${c.reset} Tauri error classification (invoke, capability, plugin)`);
    info(`${c.green}${sym.check}${c.reset} Rust code instrumentation (eprintln! with markers)`);
    info(`${c.green}${sym.check}${c.reset} Tauri log file auto-discovery and tailing`);
    info(`${c.green}${sym.check}${c.reset} RUST_BACKTRACE=1 auto-enabled in serve mode`);
    dim("");
  }

  section("TWO MODES");
  info(`${c.cyan}debug-toolkit${c.reset}        ${c.dim}Pure MCP server — investigate, instrument, verify${c.reset}`);
  info(`${c.cyan}debug-toolkit serve${c.reset}   ${c.dim}+ dev server wrapping for ${isTauri ? "Tauri" : "browser"} capture${c.reset}`);
  dim("");
  info("Both modes registered. Restart Claude Code to activate.");
  dim(`Edit ${mcpPath} to customize\n`);
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
