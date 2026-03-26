/**
 * context.ts — Automatic context gathering engine.
 *
 * The #1 insight: developers waste most debugging time gathering context,
 * not fixing bugs. This module automates that entirely.
 *
 * Given an error string, it:
 *   1. Parses stack frames to find relevant source files
 *   2. Reads those files (the exact lines around the error)
 *   3. Gets the git diff showing recent changes to those files
 *   4. Captures the runtime environment
 *   5. Returns a single structured object with everything the agent needs
 */

import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename, relative, isAbsolute, resolve } from "node:path";
import { redactSensitiveData } from "./security.js";

// --- Stack trace parsing (Node.js, Python, Go, Rust) ---

export interface StackFrame {
  fn: string;
  file: string;
  line: number;
  col: number | null;
  isUserCode: boolean;
}

// Match "at FnName (file:line:col)" or "at file:line:col"
const NODE_FRAME = /at\s+(?:([\w$.< >\[\]]+?)\s+)?\(?([^\s()]+):(\d+):(\d+)\)?/gm;
const PY_FRAME = /File "(.+?)", line (\d+)(?:, in (.+))?/g;
// Rust backtrace: "   4: my_app::handler at ./src-tauri/src/main.rs:15:10"
const RUST_FRAME = /^\s*\d+:\s+([\w:<>]+)(?:\s+at\s+(.+?):(\d+)(?::(\d+))?)?$/gm;
// Rust panic location: "thread 'main' panicked at 'msg', src/main.rs:15:10"
const RUST_PANIC = /panicked at (?:'[^']*'|"[^"]*"),\s*(.+?):(\d+):(\d+)/;
// Cargo error: "error[E0308]: mismatched types\n --> src/main.rs:15:10"
const CARGO_ERROR_LOC = /-->\s*(.+?):(\d+):(\d+)/g;

function parseStackFrames(error: string, cwd: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const seen = new Set<string>();

  // Detect if this is a Rust error (parse Rust-specific formats FIRST,
  // before Node.js regex grabs "at file:line:col" from backtraces)
  const isRustError = /panicked at|stack backtrace:|error\[E\d+]|-->\s*\S+\.rs:/.test(error);

  let m;

  if (isRustError) {
    // Rust panic location
    const panic = RUST_PANIC.exec(error);
    if (panic) {
      const key = `${panic[1]}:${panic[2]}`;
      seen.add(key);
      frames.push({
        fn: "<panic>",
        file: panic[1],
        line: +panic[2],
        col: +panic[3],
        isUserCode: !panic[1].includes(".cargo") && !panic[1].includes("/rustc/"),
      });
    }

    // Rust backtrace frames
    RUST_FRAME.lastIndex = 0;
    while ((m = RUST_FRAME.exec(error)) !== null) {
      if (!m[2]) continue;
      const file = m[2].replace(/^\.\//, "");
      const key = `${file}:${m[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frames.push({
        fn: m[1],
        file,
        line: +m[3],
        col: m[4] ? +m[4] : null,
        isUserCode: !file.includes(".cargo") && !file.includes("/rustc/")
          && !file.includes("registry/src"),
      });
    }

    // Cargo compiler error locations
    CARGO_ERROR_LOC.lastIndex = 0;
    while ((m = CARGO_ERROR_LOC.exec(error)) !== null) {
      const key = `${m[1]}:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frames.push({
        fn: "<compile>",
        file: m[1],
        line: +m[2],
        col: +m[3],
        isUserCode: true,
      });
    }
  }

  // Node.js / JS / TS (skip if already parsed as Rust)
  if (!isRustError) {
    NODE_FRAME.lastIndex = 0;
    while ((m = NODE_FRAME.exec(error)) !== null) {
      const key = `${m[2]}:${m[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const file = m[2];
      frames.push({
        fn: m[1] ?? "<anonymous>",
        file,
        line: +m[3],
        col: +m[4],
        isUserCode: !file.includes("node_modules") && !file.startsWith("node:"),
      });
    }
  }

  // Python
  PY_FRAME.lastIndex = 0;
  while ((m = PY_FRAME.exec(error)) !== null) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frames.push({
      fn: m[3] ?? "<module>",
      file: m[1],
      line: +m[2],
      col: null,
      isUserCode: !m[1].includes("site-packages") && !m[1].includes("/lib/python"),
    });
  }

  return frames;
}

// --- Source code extraction ---

interface SourceSnippet {
  file: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  lines: string;
  errorLine: number;
}

function extractSourceSnippets(
  frames: StackFrame[],
  cwd: string,
  contextLines = 25,
): SourceSnippet[] {
  const snippets: SourceSnippet[] = [];
  const seen = new Set<string>();

  // Only user code frames, up to 3 files
  const userFrames = frames.filter((f) => f.isUserCode).slice(0, 3);

  for (const frame of userFrames) {
    let filePath = frame.file;

    // Resolve relative to cwd
    if (!isAbsolute(filePath)) filePath = join(cwd, filePath);
    if (!existsSync(filePath)) continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    try {
      const stat = statSync(filePath);
      if (stat.size > 1_000_000) continue; // Skip files > 1MB

      const content = readFileSync(filePath, "utf-8");
      const allLines = content.split("\n");
      const start = Math.max(0, frame.line - contextLines - 1);
      const end = Math.min(allLines.length, frame.line + contextLines);
      const slice = allLines.slice(start, end);

      // Number the lines
      const numbered = slice.map((l, i) => {
        const lineNum = start + i + 1;
        const marker = lineNum === frame.line ? " >> " : "    ";
        return `${marker}${lineNum} | ${l}`;
      }).join("\n");

      snippets.push({
        file: filePath,
        relativePath: relative(cwd, filePath),
        startLine: start + 1,
        endLine: end,
        lines: numbered,
        errorLine: frame.line,
      });
    } catch { /* skip unreadable files */ }
  }

  return snippets;
}

// --- Git context ---

interface GitContext {
  branch: string | null;
  commit: string | null;
  dirty: number;
  recentChanges: string | null; // diff of relevant files
}

function getGitContext(cwd: string, files: string[]): GitContext {
  const ctx: GitContext = { branch: null, commit: null, dirty: 0, recentChanges: null };

  try {
    ctx.branch = execFileSync("git", ["branch", "--show-current"], { cwd, timeout: 3000, stdio: "pipe" }).toString().trim();
    ctx.commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 3000, stdio: "pipe" }).toString().trim();

    const status = execFileSync("git", ["status", "--porcelain"], { cwd, timeout: 3000, stdio: "pipe" }).toString().trim();
    ctx.dirty = status ? status.split("\n").length : 0;

    // Get recent changes to relevant files — actual diff content, not just one-liners
    if (files.length > 0) {
      const relFiles = files.map((f) => relative(cwd, f)).filter((f) => !f.startsWith(".."));
      if (relFiles.length > 0) {
        const parts: string[] = [];

        // Recent commit one-liners for context
        try {
          const log = execFileSync(
            "git", ["log", "--oneline", "-5", "--", ...relFiles],
            { cwd, timeout: 5000, stdio: "pipe" },
          ).toString().trim();
          if (log) parts.push("Recent commits:\n" + log);
        } catch {}

        // Actual unstaged diff content (what the developer changed)
        try {
          const unstaged = execFileSync(
            "git", ["diff", "-U3", "--", ...relFiles],
            { cwd, timeout: 5000, stdio: "pipe" },
          ).toString().trim();
          if (unstaged) {
            // Truncate to ~4K to not blow context
            parts.push("Unstaged changes:\n" + (unstaged.length > 4000 ? unstaged.slice(0, 4000) + "\n... (truncated)" : unstaged));
          }
        } catch {}

        // Staged diff content
        try {
          const staged = execFileSync(
            "git", ["diff", "--cached", "-U3", "--", ...relFiles],
            { cwd, timeout: 5000, stdio: "pipe" },
          ).toString().trim();
          if (staged) {
            parts.push("Staged changes:\n" + (staged.length > 4000 ? staged.slice(0, 4000) + "\n... (truncated)" : staged));
          }
        } catch {}

        if (parts.length > 0) ctx.recentChanges = parts.join("\n\n");
      }
    }
  } catch { /* not a git repo */ }

  return ctx;
}

// --- Environment snapshot ---

interface EnvSnapshot {
  platform: string;
  node: string;
  python: string | null;
  rust: string | null;
  project: string | null;
  frameworks: Record<string, string>;
  envVars: Record<string, string>;
}

function getEnvironment(cwd: string): EnvSnapshot {
  const env: EnvSnapshot = {
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    python: null,
    rust: null,
    project: null,
    frameworks: {},
    envVars: {},
  };

  try { env.python = execSync("python3 --version 2>&1", { timeout: 2000 }).toString().trim(); } catch {}
  try { env.rust = execSync("rustc --version 2>&1", { timeout: 2000 }).toString().trim(); } catch {}

  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      env.project = pkg.name ?? null;
      for (const name of ["react", "next", "vue", "nuxt", "svelte", "express", "fastify", "vite", "typescript", "tailwindcss", "prisma", "drizzle", "@tauri-apps/api", "@tauri-apps/cli"]) {
        const v = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
        if (v) env.frameworks[name] = v;
      }
    } catch {}
  }

  // Detect Tauri project (Cargo.toml with tauri dependency)
  const tauriConfPath = join(cwd, "src-tauri", "tauri.conf.json");
  const cargoPath = join(cwd, "src-tauri", "Cargo.toml");
  if (existsSync(tauriConfPath)) {
    try {
      const conf = JSON.parse(readFileSync(tauriConfPath, "utf-8"));
      env.frameworks["tauri"] = conf.version ?? "v2";
      env.frameworks["tauri-identifier"] = conf.identifier ?? conf.bundle?.identifier ?? "unknown";
    } catch {}
  }
  if (existsSync(cargoPath)) {
    try {
      const cargo = readFileSync(cargoPath, "utf-8");
      const tauriVer = cargo.match(/tauri\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/);
      if (tauriVer) env.frameworks["tauri-core"] = tauriVer[1];
      // Detect plugins
      const plugins = [...cargo.matchAll(/tauri-plugin-(\w+)/g)].map((m) => m[1]);
      if (plugins.length > 0) env.frameworks["tauri-plugins"] = plugins.join(", ");
    } catch {}
  }

  for (const k of ["NODE_ENV", "PORT", "HOST", "DATABASE_URL", "API_URL", "RUST_BACKTRACE", "RUST_LOG"]) {
    if (process.env[k]) env.envVars[k] = redactSensitiveData(process.env[k]!);
  }

  return env;
}

// --- Error classification ---

export interface ErrorClassification {
  type: string;
  summary: string;
  category: string;
  severity: "fatal" | "error" | "warning";
  suggestion: string;
}

export function classifyError(raw: string): ErrorClassification {
  const r: ErrorClassification = {
    type: "Unknown",
    summary: raw.split("\n")[0]?.slice(0, 200) ?? "",
    category: "runtime",
    severity: "error",
    suggestion: "",
  };

  const tm = raw.match(/^(\w+Error):\s*(.*)/m);
  if (tm) { r.type = tm[1]; r.summary = tm[2]; }

  // Detect Rust panic first (overrides generic matching)
  const panicMatch = raw.match(/thread '(.+?)' panicked at (?:'([^']*)'|"([^"]*)")/);
  if (panicMatch) {
    r.type = "Panic";
    r.summary = panicMatch[2] ?? panicMatch[3] ?? "panic";
    r.category = "rust-panic";
    r.severity = "fatal";
    r.suggestion = "Rust panic — check the unwrap()/expect() call. Set RUST_BACKTRACE=1 for a full backtrace.";
    return r;
  }

  // Detect Cargo build errors
  const cargoErr = raw.match(/^error\[E(\d+)]: (.+)/m);
  if (cargoErr) {
    r.type = `CargoError[E${cargoErr[1]}]`;
    r.summary = cargoErr[2];
    r.category = "rust-compile";
    r.severity = "fatal";
    r.suggestion = `Rust compilation error E${cargoErr[1]}. Check the source location shown after "-->".`;
    return r;
  }

  const rules: Array<[RegExp, string, string, string]> = [
    // ── Tauri-specific (check before generic web errors) ──
    [/invoke\s+error|__TAURI_IPC__|ipc.*error/i, "tauri-ipc", "error", "Tauri invoke failed — check command registration in generate_handler![] and argument types"],
    [/capability.*not.*found|permission.*denied.*tauri|not allowed.*command/i, "tauri-capability", "error", "Tauri capability/permission error — add the command permission to src-tauri/capabilities/*.json"],
    [/PluginInitialization|plugin.*failed.*init/i, "tauri-plugin", "error", "Tauri plugin failed to initialize — check plugin setup in Builder::plugin()"],
    [/WindowLabelAlreadyExists|WebviewLabelAlreadyExists/i, "tauri-window", "error", "Duplicate window/webview label — use a unique label for each window"],
    [/WebviewNotFound|WindowNotFound/i, "tauri-window", "error", "Window/webview not found — check the label matches what was created"],
    [/AssetNotFound/i, "tauri-asset", "error", "Frontend asset not found — check frontendDist in tauri.conf.json points to your build output"],
    [/CannotDeserializeScope/i, "tauri-acl", "error", "Tauri ACL scope deserialization failed — check capability scope definitions"],
    [/tauri.*setup|Setup.*error/i, "tauri-setup", "fatal", "Tauri app setup failed — check the setup closure in Builder::setup()"],
    // ── Rust-specific ──
    [/unwrap\(\).*on.*None/i, "rust-panic", "fatal", "Called unwrap() on None — use match, if let, or ? operator instead"],
    [/unwrap\(\).*on.*Err/i, "rust-panic", "fatal", "Called unwrap() on Err — use match or ? operator to handle the error"],
    [/borrow.*already.*mutably|cannot borrow/i, "rust-borrow", "fatal", "Rust borrow checker error — check for overlapping mutable references"],
    [/overflow|underflow/i, "rust-arithmetic", "error", "Integer overflow/underflow — use checked_add/checked_sub or wrapping operations"],
    // ── General (JS/TS/Python/Go) ──
    [/TypeError/i, "type", "error", "Check for null/undefined values being accessed as objects"],
    [/ReferenceError/i, "reference", "error", "Check for typos in variable/function names or missing imports"],
    [/SyntaxError/i, "syntax", "fatal", "Check for missing brackets, quotes, or invalid syntax"],
    [/ECONNREFUSED/i, "network", "error", "The server/API isn't running — start it first"],
    [/ENOENT|no such file/i, "filesystem", "error", "File doesn't exist — check the path"],
    [/Cannot find module/i, "dependency", "error", "Run `npm install` to install missing dependencies"],
    [/ERR_MODULE_NOT_FOUND/i, "esm", "error", "Add .js extension to import or set type:module in package.json"],
    [/EACCES|Permission denied/i, "permissions", "error", "Check file permissions or run with elevated privileges"],
    [/\b401\b/, "auth", "error", "Authentication failed — token may be expired"],
    [/\b403\b/, "authz", "error", "Permission denied — check authorization"],
    [/\b404\b/, "not-found", "error", "Endpoint doesn't exist — check the URL path"],
    [/\b5\d{2}\b/, "server", "error", "Server error — check the backend logs"],
    [/out of memory|heap/i, "memory", "fatal", "Process ran out of memory — check for leaks or increase limit"],
    [/SIGKILL|SIGTERM/i, "killed", "fatal", "Process was killed — may be OOM or timeout"],
  ];

  for (const [pat, cat, sev, sugg] of rules) {
    if (pat.test(raw)) {
      r.category = cat;
      r.severity = sev as ErrorClassification["severity"];
      r.suggestion = sugg;
      break;
    }
  }

  // Logic/behavior bug detection — no known error pattern matched, check for prose descriptions
  if (r.type === "Unknown" && r.category === "runtime") {
    const logicPatterns = /wrong|incorrect|mismatch|should be|expected|doesn't match|off by|hardcoded|not (working|showing|rendering|updating|displaying)|broken|behav(e|ior|iour)|visual(ly)?|looks? (wrong|off|different|broken)|overlap|collaps|truncat|misalign|overflow|underflow|cropp|clip|hidden|squish|squash|stretch|shrink|wrap|spacing|gap|margin|padding|layout|resize|responsive|flicker|jank|stutter|laggy|slow/i;
    if (logicPatterns.test(raw)) {
      r.type = "LogicBug";
      r.category = "logic";
      r.severity = "warning";
      r.suggestion = "Logic/behavior bug — pass suspect file paths in the 'files' parameter for source context.";
    }
  }

  return r;
}

// --- Visual error detection ---

const CSS_EXTENSIONS = /\.(css|scss|sass|less|stylus|styl)$/i;
const VISUAL_KEYWORDS = /looks?\s+(wrong|off|different|broken)|layout|visual|css|style|animation|render|display|position|z-index|overflow|responsive|mobile|tablet|screen|viewport|font|color|opacity|margin|padding|align|flex|grid|stutter|flicker|overlap/i;

/**
 * Determine if an error is visual/CSS-related, warranting screenshot capture.
 */
export function isVisualError(
  category: string,
  file?: string | null,
  description?: string | null,
): boolean {
  // CSS file involvement
  if (file && CSS_EXTENSIONS.test(file)) return true;

  // Visual keywords in description — regardless of category
  if (description && VISUAL_KEYWORDS.test(description)) return true;

  return false;
}

// --- Main: investigate error (the compound operation) ---

export interface InvestigationResult {
  error: ErrorClassification;
  sourceCode: SourceSnippet[];
  git: GitContext;
  environment: EnvSnapshot;
  frames: StackFrame[];
}

export function investigate(errorText: string, cwd: string, hintFiles?: string[]): InvestigationResult {
  const frames = parseStackFrames(errorText, cwd);
  let sourceCode = extractSourceSnippets(frames, cwd);

  // If no stack frames but hint files provided, extract source from those files
  if (sourceCode.length === 0 && hintFiles && hintFiles.length > 0) {
    sourceCode = extractSourceFromHintFiles(hintFiles, cwd);
  }

  const relevantFiles = sourceCode.map((s) => s.file);
  const git = getGitContext(cwd, relevantFiles);
  const environment = getEnvironment(cwd);
  const error = classifyError(errorText);

  return { error, sourceCode, git, environment, frames };
}

/**
 * Extract source snippets from explicitly provided file paths.
 * Used for logic bugs where there's no stack trace to parse.
 */
function extractSourceFromHintFiles(files: string[], cwd: string): SourceSnippet[] {
  const snippets: SourceSnippet[] = [];
  for (const filePath of files.slice(0, 5)) { // Max 5 files
    const resolved = resolve(cwd, filePath);
    if (!existsSync(resolved)) continue;
    try {
      const content = readFileSync(resolved, "utf-8");
      const allLines = content.split("\n");
      // Show first 80 lines or full file if shorter
      const lines = allLines.slice(0, 80).map((l, i) => `${String(i + 1).padStart(6)} | ${l}`).join("\n");
      const truncated = allLines.length > 80 ? `\n  ... (${allLines.length - 80} more lines)` : "";
      snippets.push({
        file: resolved,
        relativePath: relative(cwd, resolved),
        startLine: 1,
        endLine: Math.min(allLines.length, 80),
        errorLine: 0,
        lines: lines + truncated,
      });
    } catch {}
  }
  return snippets;
}
