import { resolve, relative } from "node:path";
import { realpathSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
// --- Path traversal protection ---
/**
 * Validate that a file path is within the project root.
 * Resolves symlinks and rejects paths that escape the boundary.
 */
export function validateFilePath(filePath, projectRoot) {
    // Resolve the project root to its real path (handles symlinks like /tmp → /private/tmp)
    const realRoot = existsSync(projectRoot) ? realpathSync(projectRoot) : resolve(projectRoot);
    // Resolve filePath: if absolute, resolve it independently then check containment
    const rawResolved = resolve(projectRoot, filePath);
    const resolved = existsSync(rawResolved) ? realpathSync(rawResolved) : resolve(realRoot, relative(resolve(projectRoot), rawResolved));
    // Check the resolved path is within project root
    const rel = relative(realRoot, resolved);
    if (rel.startsWith("..") || resolve(rel) === rel) {
        throw new Error(`Security: path "${filePath}" resolves outside project root "${projectRoot}"`);
    }
    // If file exists, also check the real path (resolves symlinks)
    if (existsSync(resolved)) {
        const real = realpathSync(resolved);
        const realRel = relative(realRoot, real);
        if (realRel.startsWith("..")) {
            throw new Error(`Security: symlink "${filePath}" points outside project root`);
        }
    }
    // Reject system paths (only if project root is NOT inside them)
    const dangerous = ["/etc/", "/usr/", "/bin/", "/sbin/", "/var/", "/root/"];
    for (const prefix of dangerous) {
        if (resolved.startsWith(prefix) && !realRoot.startsWith(prefix.slice(0, -1))) {
            throw new Error(`Security: refusing to access system path "${resolved}"`);
        }
    }
    return resolved;
}
// --- Command injection protection ---
const SHELL_METACHAR_RE = /[;&|`$(){}[\]!<>\\]/;
/**
 * Validate a command string for obvious injection attempts.
 * We allow commands but reject chaining operators.
 */
export function validateCommand(command) {
    const trimmed = command.trim();
    if (!trimmed)
        throw new Error("Security: empty command");
    // Block obvious shell injection patterns
    if (trimmed.includes("&&") || trimmed.includes("||") || trimmed.includes(";")) {
        // Allow these only if they look like a normal dev command
        // e.g., "npm run build && npm test" is fine
        // But "; rm -rf /" is not
        const parts = trimmed.split(/[;&|]+/).map((s) => s.trim());
        for (const part of parts) {
            if (part.startsWith("rm ") || part.startsWith("curl ") ||
                part.includes("> /") || part.includes("| sh") ||
                part.includes("eval ") || part.includes("exec ")) {
                throw new Error(`Security: potentially dangerous command "${part}"`);
            }
        }
    }
    return trimmed;
}
// --- Sensitive data redaction ---
const REDACTION_PATTERNS = [
    // Authorization headers in captured output
    [/(?:Authorization|Bearer|Token|X-API-Key)[:=]\s*["']?[A-Za-z0-9._\-/+=]{8,}["']?/gi, "[REDACTED_AUTH]"],
    // JWT tokens
    [/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[REDACTED_JWT]"],
    // Common secret patterns in env vars and output
    [/(?:password|passwd|secret|api_key|apikey|access_token|private_key|credentials?)[\s=:]+["']?[^\s"']{8,}["']?/gi, "[REDACTED_SECRET]"],
    // AWS keys
    [/(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g, "[REDACTED_AWS_KEY]"],
    // Connection strings with credentials
    [/(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@/gi, "[REDACTED_CONNECTION_STRING]://***@"],
    // GitHub tokens
    [/gh[pousr]_[A-Za-z0-9_]{36,}/g, "[REDACTED_GITHUB_TOKEN]"],
    // npm tokens
    [/npm_[A-Za-z0-9]{36,}/g, "[REDACTED_NPM_TOKEN]"],
    // Generic hex secrets (32+ chars, likely API keys)
    [/(?:key|token|secret|password)["']?\s*[:=]\s*["']?[a-f0-9]{32,}["']?/gi, "[REDACTED_HEX_SECRET]"],
];
/**
 * Redact sensitive information from captured text.
 */
export function redactSensitiveData(text) {
    let result = text;
    for (const [pattern, replacement] of REDACTION_PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}
/**
 * Redact sensitive headers from captured network requests.
 */
export function redactHeaders(headers) {
    const sensitiveHeaders = new Set([
        "authorization",
        "cookie",
        "set-cookie",
        "x-api-key",
        "x-auth-token",
        "proxy-authorization",
    ]);
    const redacted = {};
    for (const [key, value] of Object.entries(headers)) {
        if (sensitiveHeaders.has(key.toLowerCase())) {
            redacted[key] = "[REDACTED]";
        }
        else {
            redacted[key] = value;
        }
    }
    return redacted;
}
// --- Auto .gitignore management ---
/**
 * Ensure .debug/ is in .gitignore.
 */
export function ensureGitignore(projectRoot) {
    const gitignorePath = resolve(projectRoot, ".gitignore");
    if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, "utf-8");
        if (content.includes(".debug/") || content.includes(".debug")) {
            return; // Already ignored
        }
        appendFileSync(gitignorePath, "\n# stackpack-debug session data\n.debug/\n");
    }
    else {
        writeFileSync(gitignorePath, "# stackpack-debug session data\n.debug/\n");
    }
}
// --- Expression sanitization ---
/**
 * Validate that an instrumentation expression is safe to inject.
 * Prevents code injection via the expression parameter.
 */
export function validateExpression(expression) {
    const trimmed = expression.trim();
    if (!trimmed)
        throw new Error("Empty expression");
    // Block only actual code execution patterns, not property access
    const dangerous = [
        /\beval\s*\(/,
        /\bFunction\s*\(/,
        /\bprocess\.exit\s*\(/,
        /\brequire\s*\(\s*['"`]/,
        /\bimport\s*\(\s*['"`]/,
        /\bexec\s*\(/,
        /\bexecSync\s*\(/,
        /\bspawn\s*\(/,
    ];
    for (const pattern of dangerous) {
        if (pattern.test(trimmed)) {
            throw new Error(`Security: expression "${trimmed}" contains potentially dangerous code`);
        }
    }
    return trimmed;
}
//# sourceMappingURL=security.js.map