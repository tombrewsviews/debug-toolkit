/**
 * Terminal UI utilities — colors, symbols, formatting.
 * Zero dependencies. Works in any terminal.
 */

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
};

// --- Log functions (all go to stderr, stdout reserved for MCP) ---

export function banner(): void {
  const lines = [
    "",
    `  ${c.bold}${c.cyan}debug-toolkit${c.reset} ${c.dim}v0.3.0${c.reset}`,
    `  ${c.dim}closed-loop debugging for AI agents${c.reset}`,
    "",
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

export function info(msg: string): void {
  process.stderr.write(`  ${c.blue}${sym.dot}${c.reset} ${msg}\n`);
}

export function success(msg: string): void {
  process.stderr.write(`  ${c.green}${sym.check}${c.reset} ${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`  ${c.yellow}${sym.bolt}${c.reset} ${msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`  ${c.red}${sym.cross}${c.reset} ${msg}\n`);
}

export function dim(msg: string): void {
  process.stderr.write(`  ${c.dim}${msg}${c.reset}\n`);
}

export function section(title: string): void {
  process.stderr.write(`\n  ${c.bold}${title}${c.reset}\n`);
}

export function kv(key: string, value: string): void {
  process.stderr.write(`  ${c.dim}${key}${c.reset} ${value}\n`);
}

export function ready(toolCount: number): void {
  process.stderr.write(
    `\n  ${c.bgBlue}${c.white}${c.bold} READY ${c.reset} ${c.bold}${toolCount} MCP tools available${c.reset}\n\n`,
  );
}

export function printHelp(): void {
  console.log(`
  ${c.bold}${c.cyan}debug-toolkit${c.reset} ${c.dim}v0.3.0${c.reset}
  ${c.dim}Closed-loop debugging for AI agents${c.reset}

  ${c.bold}SETUP${c.reset} ${c.dim}(one time)${c.reset}
    ${c.green}npx debug-toolkit init${c.reset}

  ${c.bold}TWO MODES${c.reset}
    ${c.white}Pure MCP${c.reset}   Just add to your MCP config. No wrapper needed.
               ${c.dim}Agent gets: investigate, instrument, capture, verify, cleanup${c.reset}

    ${c.white}Serve${c.reset}      ${c.green}npx debug-toolkit serve -- npm run dev${c.reset}
               ${c.dim}Everything above + browser console/network capture via proxy${c.reset}

  ${c.bold}9 TOOLS + 1 RESOURCE${c.reset} ${c.dim}(what the AI agent sees)${c.reset}
    ${c.cyan}debug_investigate${c.reset}   ${c.bold}Error in ${sym.arrow} full context out${c.reset} ${c.dim}+ auto-recall past fixes${c.reset}
    ${c.cyan}debug_recall${c.reset}        Search past sessions ${c.dim}(with staleness + causal chains)${c.reset}
    ${c.cyan}debug_patterns${c.reset}      Detect recurring errors, hot files, regressions
    ${c.cyan}debug_instrument${c.reset}    Add tagged logging to source files
    ${c.cyan}debug_capture${c.reset}       Collect runtime output ${c.dim}(paginated)${c.reset}
    ${c.cyan}debug_verify${c.reset}        Run command, check pass/fail
    ${c.cyan}debug_cleanup${c.reset}       Remove instrumentation ${c.dim}+ save diagnosis + causal chain${c.reset}
    ${c.cyan}debug_session${c.reset}       View session state
    ${c.dim}debug://methodology${c.reset}  ${c.dim}Always-available debugging guide (MCP resource)${c.reset}

  ${c.bold}THE WORKFLOW${c.reset}
    ${c.dim}1.${c.reset} ${c.cyan}debug_recall${c.reset}       ${c.dim}${sym.arrow} check if solved before${c.reset}
    ${c.dim}2.${c.reset} ${c.cyan}debug_investigate${c.reset}  ${c.dim}${sym.arrow} understand the error${c.reset}
    ${c.dim}3.${c.reset} ${c.cyan}debug_instrument${c.reset}   ${c.dim}${sym.arrow} add logging to probe${c.reset}
    ${c.dim}4.${c.reset} ${c.cyan}debug_capture${c.reset}      ${c.dim}${sym.arrow} collect evidence${c.reset}
    ${c.dim}5.${c.reset} ${c.white}apply fix${c.reset}           ${c.dim}${sym.arrow} agent edits code${c.reset}
    ${c.dim}6.${c.reset} ${c.cyan}debug_verify${c.reset}       ${c.dim}${sym.arrow} confirm it works${c.reset}
    ${c.dim}7.${c.reset} ${c.cyan}debug_cleanup${c.reset}      ${c.dim}${sym.arrow} remove markers, save to memory${c.reset}

  ${c.bold}SECURITY${c.reset}
    ${c.green}${sym.check}${c.reset} Path traversal protection    ${c.green}${sym.check}${c.reset} Auto-redact secrets
    ${c.green}${sym.check}${c.reset} Localhost-only proxy         ${c.green}${sym.check}${c.reset} Pre-commit safety hook
    ${c.green}${sym.check}${c.reset} .debug/ auto-gitignored      ${c.green}${sym.check}${c.reset} Atomic file writes
`);
}

export { c };
