#!/usr/bin/env node
import { spawn } from "node:child_process";
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
function parseArgs(argv) {
    const args = argv.slice(2);
    const cmd = args[0] ?? "mcp"; // DEFAULT: pure MCP server (zero-config!)
    if (["clean", "init", "demo", "help", "--help", "-h", "mcp"].includes(cmd)) {
        return { command: cmd.replace(/^-+/, ""), port: null, childCommand: [] };
    }
    if (cmd !== "serve")
        return { command: "mcp", port: null, childCommand: [] };
    let port = null;
    const child = [];
    let past = false;
    for (let i = 1; i < args.length; i++) {
        if (args[i] === "--") {
            past = true;
            continue;
        }
        if (past) {
            child.push(args[i]);
            continue;
        }
        if (args[i] === "--port" && args[i + 1]) {
            port = parseInt(args[i + 1], 10);
            i++;
        }
    }
    return { command: "serve", port, childCommand: child };
}
// --- Init ---
function initCommand(cwd) {
    banner();
    section("SETUP");
    let devCmd = ["npm", "run", "dev"];
    let isTauri = false;
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            // Detect Tauri project
            const hasTauriCli = pkg.devDependencies?.["@tauri-apps/cli"] || pkg.dependencies?.["@tauri-apps/cli"];
            const hasTauriScript = pkg.scripts?.["tauri"];
            if ((hasTauriCli || hasTauriScript) && existsSync(join(cwd, "src-tauri"))) {
                isTauri = true;
                devCmd = ["cargo", "tauri", "dev"];
                success(`Detected ${c.bold}Tauri${c.reset} project: ${c.bold}${pkg.name ?? "unknown"}${c.reset}`);
            }
            else {
                if (pkg.scripts?.dev)
                    devCmd = ["npm", "run", "dev"];
                else if (pkg.scripts?.start)
                    devCmd = ["npm", "start"];
                else if (pkg.scripts?.serve)
                    devCmd = ["npm", "run", "serve"];
                success(`Detected project: ${c.bold}${pkg.name ?? "unknown"}${c.reset}`);
            }
        }
        catch { }
    }
    // Write MCP config
    const claudeDir = join(cwd, ".claude");
    if (!existsSync(claudeDir))
        mkdirSync(claudeDir, { recursive: true });
    const mcpPath = join(claudeDir, "mcp.json");
    const existing = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, "utf-8")) : { mcpServers: {} };
    existing.mcpServers ??= {};
    // OPTION A: Pure MCP mode (zero-config, no proxy)
    existing.mcpServers["debug-toolkit"] = {
        command: "npx",
        args: ["-y", "debug-toolkit"],
    };
    // OPTION B: With dev server wrapping (full capture)
    existing.mcpServers["debug-toolkit-serve"] = {
        command: "npx",
        args: ["-y", "debug-toolkit", "serve", "--", ...devCmd],
    };
    writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
    success(`MCP config ${sym.arrow} ${mcpPath}`);
    // Hook
    const h = installHook(cwd);
    if (h.installed)
        success(h.message);
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
async function main() {
    const parsed = parseArgs(process.argv);
    const cwd = resolve(process.cwd());
    setCwd(cwd);
    switch (parsed.command) {
        case "help":
            printHelp();
            break;
        case "demo": {
            const { runDemo } = await import("./demo.js");
            await runDemo();
            break;
        }
        case "init":
            initCommand(cwd);
            break;
        case "clean": {
            banner();
            info("Scanning for debug markers...");
            const r = cleanupFromManifest(cwd);
            if (r.cleaned === 0)
                success("Clean — no markers found.");
            else {
                success(`${r.cleaned} file(s) cleaned`);
                for (const f of r.filesProcessed)
                    dim(`  ${sym.arrow} ${f}`);
                if (!r.verified)
                    for (const e of r.errors)
                        error(e);
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
            if (!childEnv.RUST_BACKTRACE)
                childEnv.RUST_BACKTRACE = "1";
            if (!childEnv.RUST_LOG)
                childEnv.RUST_LOG = "info";
            const child = spawn(childCmd, {
                shell: true,
                stdio: ["inherit", "pipe", "pipe"],
                cwd,
                env: childEnv,
            });
            pipeProcess(child);
            installHook(cwd);
            let proxyHandle = null;
            if (child.stdout) {
                try {
                    const target = parsed.port ?? (await detectPort(child.stdout));
                    const listen = parsed.port ? parsed.port + 1 : target + 1000;
                    proxyHandle = startProxy({ targetPort: target, listenPort: listen });
                    kv("proxy", `http://localhost:${listen} ${sym.arrow} :${target}`);
                }
                catch (e) {
                    warn(`Proxy unavailable: ${e instanceof Error ? e.message : ""}`);
                }
            }
            startMcpServer().catch((e) => error(`MCP: ${e}`));
            ready(8);
            const cleanup = () => {
                if (child.pid)
                    treeKill(child.pid, "SIGTERM");
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
//# sourceMappingURL=index.js.map