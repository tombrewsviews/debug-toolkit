/**
 * signature.ts — Error signature normalization.
 *
 * Produces a stable fingerprint for an error so that the same bug
 * produces the same signature regardless of line number shifts,
 * minor wording changes, or which developer encounters it.
 *
 * Used by local memory (remember/recall) and team sync (deduplication).
 */
import { createHash } from "node:crypto";
/**
 * Normalize an error into a stable 16-char hex signature.
 *
 * Strips line/column numbers, lowercases, hashes (type + file + topFrame).
 * Two stack traces pointing to the same bug with different line numbers
 * produce the same signature.
 */
export function normalizeSignature(errorType, sourceFile, topFrame) {
    // Strip line:col suffixes — same bug at line 42 vs line 47 is the same bug
    const file = stripLineNumbers(sourceFile);
    // Normalize frame — keep function name + file, drop line/col
    const frame = topFrame ? stripLineNumbers(topFrame.replace(/^\s*at\s+/, "")) : "";
    const raw = `${errorType}::${file}::${frame}`.toLowerCase().trim();
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
/**
 * Compute a signature from an error message and optional file context.
 * Convenience wrapper that extracts type + file from a raw error string.
 */
export function signatureFromError(errorText, sourceFile) {
    const errorType = extractErrorType(errorText);
    const file = sourceFile ?? extractFileFromError(errorText) ?? "unknown";
    const topFrame = extractTopFrame(errorText);
    return normalizeSignature(errorType, file, topFrame);
}
// --- Helpers ---
function stripLineNumbers(s) {
    return s
        .replace(/:\d+:\d+\)?$/g, "") // file:line:col or file:line:col)
        .replace(/:\d+\)?$/g, "") // file:line or file:line)
        .replace(/\((\S+)\)/, "$1") // unwrap (file) → file
        .trim();
}
/**
 * Extract the error type from an error message.
 * Handles: TypeError, ReferenceError, SyntaxError, Rust panics, cargo errors, etc.
 */
function extractErrorType(text) {
    // JS/TS: TypeError: ..., ReferenceError: ..., etc.
    const jsMatch = text.match(/^((?:Uncaught\s+)?(?:\w+Error|EvalError|RangeError|URIError))\s*:/m);
    if (jsMatch)
        return jsMatch[1].replace(/^Uncaught\s+/, "");
    // Rust panic
    if (/thread\s+'[^']*'\s+panicked\s+at/.test(text))
        return "RustPanic";
    // Cargo error code
    const cargoMatch = text.match(/error\[E(\d+)\]/);
    if (cargoMatch)
        return `CargoError[E${cargoMatch[1]}]`;
    // Python
    const pyMatch = text.match(/^(\w+Error|\w+Exception)\s*:/m);
    if (pyMatch)
        return pyMatch[1];
    // Go panic
    if (/^panic:/m.test(text))
        return "GoPanic";
    // HTTP status
    const httpMatch = text.match(/\b(4\d{2}|5\d{2})\b/);
    if (httpMatch)
        return `HTTP${httpMatch[1]}`;
    // Build errors
    if (/TS\d{4}/.test(text))
        return "TypeScriptError";
    if (/ERR_MODULE_NOT_FOUND/.test(text))
        return "ModuleNotFound";
    if (/ENOENT/.test(text))
        return "ENOENT";
    if (/ECONNREFUSED/.test(text))
        return "ECONNREFUSED";
    return "Unknown";
}
/**
 * Extract the primary file path from an error message or stack trace.
 */
function extractFileFromError(text) {
    // Node.js: at function (file:line:col)
    const nodeMatch = text.match(/at\s+\S+\s+\(([^)]+?):\d+:\d+\)/);
    if (nodeMatch)
        return nodeMatch[1];
    // Node.js: at file:line:col
    const nodeMatch2 = text.match(/at\s+(\S+?):\d+:\d+/);
    if (nodeMatch2)
        return nodeMatch2[1];
    // Python: File "path", line N
    const pyMatch = text.match(/File\s+"([^"]+)",\s+line\s+\d+/);
    if (pyMatch)
        return pyMatch[1];
    // Rust: at ./src/main.rs:15:10
    const rustMatch = text.match(/at\s+(\.\/?[^\s:]+):\d+:\d+/);
    if (rustMatch)
        return rustMatch[1];
    // Cargo: --> src/main.rs:15:10
    const cargoMatch = text.match(/-->\s+([^\s:]+):\d+:\d+/);
    if (cargoMatch)
        return cargoMatch[1];
    // TypeScript: src/file.ts(15,10)
    const tsMatch = text.match(/([^\s(]+\.tsx?)\(\d+,\d+\)/);
    if (tsMatch)
        return tsMatch[1];
    return null;
}
/**
 * Extract the top user-code frame from a stack trace.
 */
function extractTopFrame(text) {
    const lines = text.split("\n");
    for (const line of lines) {
        // Skip node_modules, internal, and framework frames
        if (/node_modules|<anonymous>|node:internal|\.cargo/.test(line))
            continue;
        // Node.js frame
        const nodeMatch = line.match(/at\s+(\S+)\s+\(([^)]+)\)/);
        if (nodeMatch)
            return `${nodeMatch[1]}@${nodeMatch[2]}`;
        // Simple at file:line:col
        const simpleMatch = line.match(/at\s+(\S+:\d+:\d+)/);
        if (simpleMatch)
            return simpleMatch[1];
        // Python frame
        const pyMatch = line.match(/File\s+"([^"]+)",\s+line\s+\d+,\s+in\s+(\S+)/);
        if (pyMatch)
            return `${pyMatch[2]}@${pyMatch[1]}`;
        // Rust frame
        const rustMatch = line.match(/\d+:\s+(\S+)\s+at\s+(\S+)/);
        if (rustMatch)
            return `${rustMatch[1]}@${rustMatch[2]}`;
    }
    return null;
}
//# sourceMappingURL=signature.js.map