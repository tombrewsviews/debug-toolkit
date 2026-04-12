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
  contextLines = 15,
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
    [/asset:\/\/.*(?:failed|error|not.*(?:found|loaded))|asset.*protocol.*(?:error|scope|denied)/i, "tauri-asset-protocol", "error", "Asset protocol error — check 'security.assetProtocol.scope' in tauri.conf.json. The file may exist on disk but the protocol scope doesn't include its directory."],
    [/CannotDeserializeScope/i, "tauri-acl", "error", "Tauri ACL scope deserialization failed — check capability scope definitions"],
    [/not.*allowed.*by.*capabilities|capabilities?.*(?:permission|denied|missing)|ACL.*denied/i, "tauri-capability-acl", "error", "Tauri capability denied — add the permission to src-tauri/capabilities/*.json. Capabilities are validated at build time — restart 'cargo tauri dev' after changes."],
    [/tauri.*setup|Setup.*error/i, "tauri-setup", "fatal", "Tauri app setup failed — check the setup closure in Builder::setup()"],
    [/(?:tauri\.conf\.json|Cargo\.toml).*changed.*rebuild|full.*rebuild.*required/i, "tauri-config-rebuild", "warning", "tauri.conf.json or Cargo.toml changes require a full Rust rebuild. Stop and restart 'cargo tauri dev'."],
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
    [/AI_APICallError|APICallError/i, "ai-sdk-error", "error", "AI SDK API call failed — check provider URL, API key, and rate limits. Look for statusCode and responseBody in the full error."],
    [/\b429\b|rate.?limit/i, "rate-limit", "error", "API rate limit — check which provider is being called and consider switching to a fallback or adding backoff"],
    [/\b408\b|ETIMEDOUT|request.*timeout/i, "timeout", "error", "Request timed out — service may be slow or unreachable"],
    [/\b401\b/, "auth", "error", "Authentication failed — token may be expired"],
    [/\b403\b/, "authz", "error", "Permission denied — check authorization"],
    [/\b404\b/, "not-found", "error", "Endpoint doesn't exist — check the URL path"],
    [/\b5\d{2}\b/, "server", "error", "Server error — check the backend logs"],
    [/out of memory|heap/i, "memory", "fatal", "Process ran out of memory — check for leaks or increase limit"],
    [/SIGKILL|SIGTERM/i, "killed", "fatal", "Process was killed — may be OOM or timeout"],
    // State/persistence patterns
    [/override\s+is\s+null|setting\s+not\s+found|config(?:uration)?\s+(?:reset|lost|missing|not\s+(?:found|saved|persisted))/i, "state-persistence", "warning", "Configuration may not be persisted — check if settings are stored in a database/file or only in-memory (resets on server restart)"],
    [/default\s+(?:value|provider|config)\s+used|fall(?:ing)?\s*back\s+to\s+default/i, "state-fallback", "warning", "Falling back to defaults — the user's configuration may not have been loaded. Check persistence layer."],
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

// --- Error chain unwrapping ---

export interface UnwrappedError {
  outerMessage: string;
  innerErrors: Array<{ wrapper: string; message: string; attempts?: number }>;
  httpStatus: number | null;
  url: string | null;
  provider: string | null;
}

/** Extract diagnostic info from wrapped/chained errors (RetryError, AI SDK, etc.) */
export function unwrapErrorChain(raw: string): UnwrappedError {
  const result: UnwrappedError = {
    outerMessage: raw.split("\n")[0] ?? "",
    innerErrors: [],
    httpStatus: null,
    url: null,
    provider: null,
  };

  // AI SDK RetryError pattern
  const retryMatch = raw.match(/Failed after (\d+) attempts?\. Last error: (.+)/);
  if (retryMatch) {
    result.innerErrors.push({ wrapper: "RetryError", attempts: parseInt(retryMatch[1]), message: retryMatch[2] });
  }

  // "Caused by:" chain (Rust-style and general)
  for (const m of raw.matchAll(/Caused by:\s*(.+)/gi)) {
    result.innerErrors.push({ wrapper: "CausedBy", message: m[1].trim() });
  }

  // HTTP status codes anywhere in the error
  const statusMatch = raw.match(/statusCode:\s*(\d{3})|status[:\s]+(\d{3})|HTTP\/\d\.\d\s+(\d{3})/);
  if (statusMatch) {
    result.httpStatus = parseInt(statusMatch[1] ?? statusMatch[2] ?? statusMatch[3]);
  }

  // URL extraction (API endpoint that was called)
  const urlMatch = raw.match(/url:\s*['"]?(https?:\/\/[^\s'"]+)/);
  if (urlMatch) {
    result.url = urlMatch[1];
    if (/anthropic\.com/i.test(result.url)) result.provider = "anthropic";
    else if (/openai\.com/i.test(result.url)) result.provider = "openai";
    else if (/googleapis\.com.*generativelanguage/i.test(result.url)) result.provider = "google";
    else if (/localhost|127\.0\.0\.1/i.test(result.url)) result.provider = "local";
  }

  // Rate limit detection
  if (result.httpStatus === 429 || /rate.?limit/i.test(raw)) {
    result.innerErrors.push({ wrapper: "RateLimit", message: "API rate limit exceeded" });
  }

  // Connection refused
  if (/ECONNREFUSED/i.test(raw)) {
    const portMatch = raw.match(/ECONNREFUSED.*?:(\d+)/);
    result.innerErrors.push({ wrapper: "ConnectionRefused", message: `Service not running on port ${portMatch?.[1] ?? "unknown"}` });
  }

  return result;
}

// --- Visual error detection ---

// --- Provider/endpoint mismatch detection ---

export interface ProviderMismatch {
  expected: string | null;
  actual: string;
  actualUrl: string;
  signal: string;
}

const PROVIDER_ENDPOINTS: Array<[RegExp, string]> = [
  [/anthropic\.com/i, "anthropic"],
  [/openai\.com/i, "openai"],
  [/googleapis\.com.*generativelanguage/i, "google"],
  [/localhost:\d{4,5}\/v1\//i, "local/ollama"],
  [/together\.ai/i, "together"],
  [/groq\.com/i, "groq"],
];

function inferProvider(url: string): string | null {
  for (const [pat, name] of PROVIDER_ENDPOINTS) {
    if (pat.test(url)) return name;
  }
  return null;
}

/**
 * Detect provider/endpoint mismatches from browser network events and error chain.
 * Looks for signals that the app is hitting a different provider than expected.
 */
export function detectProviderMismatch(
  errorChain: UnwrappedError,
  browserNetworkEvents: Array<{ url?: string; status?: number; method?: string; ok?: boolean }>,
  errorText: string,
): ProviderMismatch | null {
  // Check 1: Error chain has a URL — does the error text mention a different provider?
  if (errorChain.url && errorChain.provider) {
    const mentionsOllama = /ollama|localhost.*11434/i.test(errorText);
    const mentionsLocal = /local.*provider|provider.*local/i.test(errorText);
    if ((mentionsOllama || mentionsLocal) && errorChain.provider !== "local") {
      return {
        expected: "local/ollama",
        actual: errorChain.provider,
        actualUrl: errorChain.url,
        signal: "Error text mentions Ollama/local but request went to " + errorChain.provider,
      };
    }
  }

  // Check 2: Browser network shows API calls to unexpected endpoints
  const apiCalls = browserNetworkEvents.filter(e => e.url && inferProvider(e.url));
  const failedApiCalls = apiCalls.filter(e => e.status && e.status >= 400);
  const providers = new Set(apiCalls.map(e => inferProvider(e.url!)).filter(Boolean));

  // If we see both local and remote providers, and the remote one is failing, flag it
  if (providers.has("local/ollama") && failedApiCalls.length > 0) {
    for (const call of failedApiCalls) {
      const prov = inferProvider(call.url!);
      if (prov && prov !== "local/ollama") {
        return {
          expected: "local/ollama",
          actual: prov,
          actualUrl: call.url!,
          signal: `App is calling ${prov} (${call.status}) while also using local/ollama — possible provider misconfiguration`,
        };
      }
    }
  }

  // Check 3: All API calls going to a single unexpected provider with errors
  if (failedApiCalls.length > 0 && providers.size === 1) {
    const prov = [...providers][0]!;
    const allFailing = failedApiCalls.length === apiCalls.filter(e => inferProvider(e.url!) === prov).length;
    if (allFailing && errorChain.httpStatus === 429) {
      return {
        expected: null,
        actual: prov,
        actualUrl: failedApiCalls[0].url!,
        signal: `All requests to ${prov} are rate-limited (429) — is this the intended provider?`,
      };
    }
  }

  return null;
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

/**
 * Infer relevant files from a bug description when no stack trace or hint files are provided.
 * Extracts component names, file references, and matches against recent git changes.
 */
/**
 * Extract search terms from a bug description for targeted source reading.
 * Returns terms the user mentioned that we should highlight in source code.
 */
function extractSearchTerms(description: string): string[] {
  const terms: string[] = [];

  // Quoted strings — user is mentioning specific text in the UI
  const quoted = description.match(/["']([^"']{2,50})["']/g) ?? [];
  for (const q of quoted) terms.push(q.slice(1, -1));

  // "shows X but should show Y" / "displays X instead of Y" patterns
  const showsPattern = /(?:shows?|displays?|renders?|outputs?)\s+["']?(\w[\w\s]{1,30})["']?\s+(?:but|instead|rather)\s+(?:should|of)\s+(?:show|display|render|be)\s+["']?(\w[\w\s]{1,30})["']?/i;
  const showsMatch = showsPattern.exec(description);
  if (showsMatch) {
    terms.push(showsMatch[1].trim(), showsMatch[2].trim());
  }

  // CSS class names (.some-class)
  const cssClasses = description.match(/\.([a-z][\w-]+)/g) ?? [];
  for (const c of cssClasses) terms.push(c.slice(1));

  // JSX/HTML tags (<SomeTag)
  const htmlTags = description.match(/<([A-Z][\w.]+)/g) ?? [];
  for (const t of htmlTags) terms.push(t.slice(1));

  return [...new Set(terms)].slice(0, 10);
}

function inferFilesFromDescription(description: string, cwd: string): string[] {
  const files: string[] = [];

  // Extract PascalCase component names (React/Vue/Svelte conventions)
  // Broader: any PascalCase identifier, not just ones with known suffixes
  const componentNames = description.match(
    /\b[A-Z][a-zA-Z]{2,}(?:Page|View|Component|Screen|Modal|Dialog|Form|List|Card|Button|Input|Header|Footer|Sidebar|Nav|Menu|Tab|Panel|Widget|Item|Row|Cell)?\b/g
  )?.filter((n) => n.length >= 4 && !/^(?:React|Vue|Svelte|Angular|Node|Chrome|Safari|Firefox|HTML|CSS|JSON|HTTP|CORS|DOM|URL|API|SDK|CLI|App|The|This|That|When|What|How|But|And|Not|For)$/.test(n)) ?? [];

  // Extract quoted file references and file-like patterns
  const fileRefs = description.match(/\b[\w/.-]+\.(?:tsx?|jsx?|vue|svelte|py|rs|go)\b/g) ?? [];

  // Extract route paths (/some/path) that might map to page files
  const routePaths = description.match(/(?:^|\s)(\/[\w/-]+)/g)?.map((p) => p.trim()) ?? [];

  const searchTerms = [...new Set([...componentNames, ...fileRefs])];

  // Search recent git changes for matching files
  try {
    const recentFiles = execSync("git diff --name-only HEAD~5 2>/dev/null", {
      cwd, timeout: 5000, encoding: "utf-8",
    }).trim().split("\n").filter(Boolean);

    for (const name of searchTerms) {
      const baseName = name.replace(/\.[^.]+$/, "").toLowerCase();
      const matches = recentFiles.filter((f) => f.toLowerCase().includes(baseName));
      files.push(...matches.slice(0, 2));
    }
  } catch {}

  // Search common source directories for matching files (broader than just src/)
  if (files.length === 0 && searchTerms.length > 0) {
    const searchDirs = ["src", "app", "pages", "components", "lib", "views"].filter(
      (d) => existsSync(join(cwd, d))
    );
    if (searchDirs.length > 0) {
      try {
        const findCmd = searchDirs.map((d) =>
          `find ${d} -type f \\( -name '*.tsx' -o -name '*.ts' -o -name '*.jsx' -o -name '*.js' -o -name '*.vue' -o -name '*.svelte' \\)`
        ).join(" && ");
        const allFiles = execSync(findCmd + " 2>/dev/null", {
          cwd, timeout: 5000, encoding: "utf-8",
        }).trim().split("\n").filter(Boolean);

        for (const name of componentNames) {
          const lower = name.toLowerCase();
          const matches = allFiles.filter((f) => basename(f).toLowerCase().startsWith(lower));
          files.push(...matches.slice(0, 2));
        }

        // Route path matching: /settings → pages/settings, app/settings
        for (const route of routePaths) {
          const segments = route.split("/").filter(Boolean);
          if (segments.length === 0) continue;
          const lastSegment = segments[segments.length - 1].toLowerCase();
          const matches = allFiles.filter((f) => basename(f).toLowerCase().includes(lastSegment));
          files.push(...matches.slice(0, 2));
        }
      } catch {}
    }
  }

  return [...new Set(files)].slice(0, 5);
}

export function investigate(errorText: string, cwd: string, hintFiles?: string[]): InvestigationResult {
  const frames = parseStackFrames(errorText, cwd);
  let sourceCode = extractSourceSnippets(frames, cwd);

  // If no stack frames but hint files provided, extract source from those files
  if (sourceCode.length === 0 && hintFiles && hintFiles.length > 0) {
    sourceCode = extractSourceFromHintFiles(hintFiles, cwd);
  }

  // If still no source code and no hint files, try to infer from the description
  if (sourceCode.length === 0 && (!hintFiles || hintFiles.length === 0)) {
    const inferred = inferFilesFromDescription(errorText, cwd);
    if (inferred.length > 0) {
      const terms = extractSearchTerms(errorText);
      sourceCode = extractSourceFromHintFiles(inferred, cwd, terms.length > 0 ? terms : undefined);
    }
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
 *
 * When searchTerms are provided, finds lines containing those terms and shows
 * context around each match. Falls back to first 80 lines when no matches found.
 */
function extractSourceFromHintFiles(files: string[], cwd: string, searchTerms?: string[]): SourceSnippet[] {
  const snippets: SourceSnippet[] = [];
  for (const filePath of files.slice(0, 5)) { // Max 5 files
    const resolved = resolve(cwd, filePath);
    if (!existsSync(resolved)) continue;
    try {
      const content = readFileSync(resolved, "utf-8");
      const allLines = content.split("\n");

      // Try targeted extraction when search terms are provided
      if (searchTerms && searchTerms.length > 0) {
        const matchingLineNums: number[] = [];
        for (let i = 0; i < allLines.length; i++) {
          const lower = allLines[i].toLowerCase();
          for (const term of searchTerms) {
            if (lower.includes(term.toLowerCase())) {
              matchingLineNums.push(i);
              break;
            }
          }
        }

        if (matchingLineNums.length > 0) {
          // Show 15 lines of context around each match, merge overlapping ranges
          const CONTEXT = 15;
          const ranges: Array<[number, number]> = [];
          for (const lineNum of matchingLineNums) {
            const start = Math.max(0, lineNum - CONTEXT);
            const end = Math.min(allLines.length - 1, lineNum + CONTEXT);
            if (ranges.length > 0 && start <= ranges[ranges.length - 1][1] + 1) {
              ranges[ranges.length - 1][1] = end; // merge
            } else {
              ranges.push([start, end]);
            }
          }

          // Build output from merged ranges (cap at ~100 lines total)
          const parts: string[] = [];
          let totalLines = 0;
          for (const [start, end] of ranges) {
            if (totalLines > 100) { parts.push(`  ... (more matches omitted)`); break; }
            if (parts.length > 0) parts.push("  ---");
            for (let i = start; i <= end && totalLines <= 100; i++) {
              const marker = matchingLineNums.includes(i) ? ">" : " ";
              parts.push(`${marker}${String(i + 1).padStart(5)} | ${allLines[i]}`);
              totalLines++;
            }
          }

          snippets.push({
            file: resolved,
            relativePath: relative(cwd, resolved),
            startLine: ranges[0][0] + 1,
            endLine: ranges[ranges.length - 1][1] + 1,
            errorLine: matchingLineNums[0] + 1,
            lines: parts.join("\n"),
          });
          continue; // Skip fallback for this file
        }
      }

      // Fallback: show first 80 lines or full file if shorter
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
