/**
 * Terminal UI utilities — colors, symbols, formatting, interactive selector.
 * Zero dependencies. Works in any terminal.
 */
import { getPackageVersion } from "./utils.js";
const VERSION = getPackageVersion();
const isColor = process.env.NO_COLOR === undefined && process.stderr.isTTY;
// --- ANSI colors ---
const c = {
    reset: isColor ? "\x1b[0m" : "",
    bold: isColor ? "\x1b[1m" : "",
    dim: isColor ? "\x1b[2m" : "",
    green: isColor ? "\x1b[32m" : "",
    yellow: isColor ? "\x1b[33m" : "",
    blue: isColor ? "\x1b[34m" : "",
    magenta: isColor ? "\x1b[35m" : "",
    cyan: isColor ? "\x1b[36m" : "",
    red: isColor ? "\x1b[31m" : "",
    gray: isColor ? "\x1b[90m" : "",
    white: isColor ? "\x1b[97m" : "",
    bgGreen: isColor ? "\x1b[42m" : "",
    bgBlue: isColor ? "\x1b[44m" : "",
    bgCyan: isColor ? "\x1b[46m" : "",
    inverse: isColor ? "\x1b[7m" : "",
    hideCursor: isColor ? "\x1b[?25l" : "",
    showCursor: isColor ? "\x1b[?25h" : "",
    clearLine: isColor ? "\x1b[2K\x1b[1G" : "",
    moveUp: (n) => isColor ? `\x1b[${n}A` : "",
};
// --- Symbols ---
export const sym = {
    check: isColor ? "✓" : "[OK]",
    cross: isColor ? "✗" : "[FAIL]",
    arrow: isColor ? "→" : "->",
    dot: isColor ? "●" : "*",
    circle: isColor ? "○" : "-",
    bar: isColor ? "│" : "|",
    dash: isColor ? "─" : "-",
    bolt: isColor ? "⚡" : "!",
    pointer: isColor ? "❯" : ">",
};
// --- Log functions (all go to stderr, stdout reserved for MCP) ---
export function banner() {
    const lines = [
        "",
        `  ${c.bold}${c.cyan}stackpack-debug${c.reset} ${c.dim}v${VERSION}${c.reset}`,
        `  ${c.dim}Your AI agent's debugging superpower — investigate, fix, and learn from every bug.${c.reset}`,
        "",
    ];
    process.stderr.write(lines.join("\n") + "\n");
}
export function info(msg) {
    process.stderr.write(`  ${msg}\n`);
}
export function success(msg) {
    process.stderr.write(`  ${c.green}${sym.check}${c.reset} ${msg}\n`);
}
export function warn(msg) {
    process.stderr.write(`  ${c.yellow}${sym.bolt}${c.reset} ${msg}\n`);
}
export function error(msg) {
    process.stderr.write(`  ${c.red}${sym.cross}${c.reset} ${msg}\n`);
}
export function dim(msg) {
    process.stderr.write(`  ${c.dim}${msg}${c.reset}\n`);
}
export function section(title) {
    process.stderr.write(`\n  ${c.bold}${title}${c.reset}\n`);
}
export function kv(key, value) {
    process.stderr.write(`  ${c.dim}${key}${c.reset} ${value}\n`);
}
// --- Animated Spinner ---
const SPINNER_FRAMES = isColor ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];
export function spinner(msg) {
    if (!process.stderr.isTTY) {
        // Non-interactive: just print and return no-op
        process.stderr.write(`  ${msg}\n`);
        return { update() { }, stop() { } };
    }
    let frame = 0;
    let currentMsg = msg;
    process.stderr.write(c.hideCursor);
    process.stderr.write(`  ${c.cyan}${SPINNER_FRAMES[0]}${c.reset} ${c.dim}${currentMsg}${c.reset}`);
    const timer = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        process.stderr.write(`${c.clearLine}  ${c.cyan}${SPINNER_FRAMES[frame]}${c.reset} ${c.dim}${currentMsg}${c.reset}`);
    }, 80);
    return {
        update(newMsg) {
            currentMsg = newMsg;
        },
        stop(finalMsg) {
            clearInterval(timer);
            process.stderr.write(c.clearLine);
            if (finalMsg) {
                process.stderr.write(`  ${finalMsg}\n`);
            }
            process.stderr.write(c.showCursor);
        },
    };
}
export function ready(toolCount) {
    process.stderr.write(`\n  ${c.bgBlue}${c.white}${c.bold} READY ${c.reset} ${c.bold}${toolCount} MCP tools available${c.reset}\n\n`);
}
export function select(prompt, options) {
    // Fallback for non-TTY — use numbered input
    if (!process.stdin.isTTY) {
        return selectFallback(prompt, options);
    }
    return new Promise((resolve) => {
        let selected = 0;
        // 4 lines per option (label + desc + detail + blank separator) + 1 prompt line
        const totalLines = options.length * 4 + 1;
        function render(first = false) {
            if (!first) {
                process.stderr.write(c.moveUp(totalLines));
            }
            process.stderr.write(`${c.clearLine}  ${c.bold}${prompt}${c.reset} ${c.dim}(↑↓ to move, enter to select)${c.reset}\n`);
            for (let i = 0; i < options.length; i++) {
                const opt = options[i];
                const isSel = i === selected;
                const pointer = isSel ? `${c.cyan}${sym.pointer}${c.reset}` : " ";
                const label = isSel ? `${c.bold}${c.white}${opt.label}${c.reset}` : `  ${opt.label}`;
                process.stderr.write(`${c.clearLine}  ${pointer} ${label}\n`);
                process.stderr.write(`${c.clearLine}    ${c.dim}${opt.desc}${c.reset}\n`);
                process.stderr.write(`${c.clearLine}    ${c.dim}${opt.detail}${c.reset}\n`);
                process.stderr.write(`${c.clearLine}\n`); // blank separator line
            }
        }
        process.stderr.write(c.hideCursor);
        render(true);
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf-8");
        function onData(key) {
            if (key === "\x1b[A") {
                selected = (selected - 1 + options.length) % options.length;
                render();
            }
            else if (key === "\x1b[B") {
                selected = (selected + 1) % options.length;
                render();
            }
            else if (key === "\r" || key === "\n") {
                cleanup();
                resolve(selected);
            }
            else if (key === "\x03" || key === "\x1b") {
                cleanup();
                resolve(-1);
            }
        }
        function cleanup() {
            stdin.removeListener("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stderr.write(c.showCursor);
            // Clear the selector and show the chosen option
            process.stderr.write(c.moveUp(totalLines));
            for (let i = 0; i < totalLines; i++) {
                process.stderr.write(`${c.clearLine}\n`);
            }
            process.stderr.write(c.moveUp(totalLines));
            if (selected >= 0 && selected < options.length) {
                process.stderr.write(`  ${c.bold}${prompt}${c.reset} ${c.cyan}${options[selected].label}${c.reset}\n\n`);
            }
        }
        stdin.on("data", onData);
    });
}
async function selectFallback(prompt, options) {
    const { createInterface } = await import("node:readline");
    process.stderr.write(`  ${c.bold}${prompt}${c.reset}\n`);
    for (let i = 0; i < options.length; i++) {
        process.stderr.write(`  ${c.cyan}${i + 1}${c.reset}) ${options[i].label}\n`);
        process.stderr.write(`     ${c.dim}${options[i].desc}${c.reset}\n`);
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise((resolve) => {
        rl.question(`  ${c.dim}Enter choice [1]: ${c.reset}`, (a) => {
            rl.close();
            resolve(a.trim());
        });
    });
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < options.length)
        return idx;
    return 0;
}
export function printHelp() {
    console.log(`
  ${c.bold}${c.cyan}stackpack-debug${c.reset} ${c.dim}v${VERSION}${c.reset}
  ${c.dim}Your AI agent's debugging superpower — investigate, fix, and learn from every bug.${c.reset}

  ${c.bold}INSTALL${c.reset}
    ${c.green}npm i -g stackpack-debug${c.reset}     ${c.dim}install globally for the ${c.reset}spdg${c.dim} command${c.reset}

  ${c.bold}QUICK START${c.reset}
    ${c.green}spdg${c.reset}                        ${c.dim}guided setup (in terminal) or MCP server (in Claude Code)${c.reset}

  ${c.bold}COMMANDS${c.reset}
    ${c.dim}(no args)${c.reset}         guided setup (interactive) or MCP server (non-interactive)
    init              non-interactive setup (writes .mcp.json, hooks, rules)
    update            update to latest version + refresh SKILL.md and rules
    doctor            check environment + optional integrations
    serve             start dev server with browser + activity capture
    export [path]     export debug memory to a portable knowledge pack
    import <path>     import a knowledge pack into this project
    uninstall         remove stackpack-debug from this project (preserves .debug/)
    demo              self-contained demo (no AI needed)

  ${c.bold}TWO MODES${c.reset}
    ${c.white}Pure MCP${c.reset}   Just add to your MCP config. No wrapper needed.
               ${c.dim}Agent gets: investigate, instrument, capture, verify, cleanup${c.reset}

    ${c.white}Serve${c.reset}      ${c.green}spdg serve -- npm run dev${c.reset}
               ${c.dim}Everything above + browser capture + live activity feed${c.reset}

  ${c.bold}TOOLS + RESOURCES${c.reset} ${c.dim}(what the AI agent sees)${c.reset}
    ${c.white}Resources (live data):${c.reset}
    ${c.cyan}debug://status${c.reset}      ${c.bold}Live runtime state${c.reset} ${c.dim}— terminal errors, browser console, build errors${c.reset}
    ${c.dim}debug://methodology${c.reset}  ${c.dim}Debugging guide${c.reset}

    ${c.white}Tools:${c.reset}
    ${c.cyan}debug_investigate${c.reset}   ${c.bold}Error in ${sym.arrow} full context out${c.reset} ${c.dim}+ runtime context + auto-recall${c.reset}
    ${c.cyan}debug_recall${c.reset}        Search past sessions ${c.dim}(confidence + staleness + explain mode)${c.reset}
    ${c.cyan}debug_patterns${c.reset}      Detect recurring errors, hot files, regressions ${c.dim}+ telemetry${c.reset}
    ${c.cyan}debug_instrument${c.reset}    Add tagged logging ${c.dim}(conditional instrumentation supported)${c.reset}
    ${c.cyan}debug_capture${c.reset}       Collect runtime output ${c.dim}(paginated)${c.reset}
    ${c.cyan}debug_verify${c.reset}        Run command, check pass/fail ${c.dim}(auto-saves to memory)${c.reset}
    ${c.cyan}debug_cleanup${c.reset}       Remove instrumentation ${c.dim}+ save diagnosis + causal chain${c.reset}
    ${c.cyan}debug_session${c.reset}       View session state
    ${c.cyan}debug_perf${c.reset}          Lighthouse Web Vitals ${c.dim}(before/after comparison)${c.reset}
    ${c.cyan}debug_visual${c.reset}        Screenshots + DOM capture ${c.dim}(via Ghost OS)${c.reset}
    ${c.cyan}debug_setup${c.reset}         Check/install integrations, check for & apply updates

  ${c.bold}SECURITY${c.reset}
    ${c.green}${sym.check}${c.reset} Path traversal protection    ${c.green}${sym.check}${c.reset} Auto-redact secrets
    ${c.green}${sym.check}${c.reset} Localhost-only proxy         ${c.green}${sym.check}${c.reset} Pre-commit safety hook
    ${c.green}${sym.check}${c.reset} .debug/ auto-gitignored      ${c.green}${sym.check}${c.reset} Atomic file writes
`);
}
export { c };
//# sourceMappingURL=cli.js.map