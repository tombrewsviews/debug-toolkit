/**
 * Validate that a file path is within the project root.
 * Resolves symlinks and rejects paths that escape the boundary.
 */
export declare function validateFilePath(filePath: string, projectRoot: string): string;
/**
 * Validate a command string for obvious injection attempts.
 * We allow commands but reject chaining operators.
 */
export declare function validateCommand(command: string): string;
/**
 * Redact sensitive information from captured text.
 */
export declare function redactSensitiveData(text: string): string;
/**
 * Redact sensitive headers from captured network requests.
 */
export declare function redactHeaders(headers: Record<string, string>): Record<string, string>;
/**
 * Ensure .debug/ is in .gitignore.
 */
export declare function ensureGitignore(projectRoot: string): void;
/**
 * Validate that an instrumentation expression is safe to inject.
 * Prevents code injection via the expression parameter.
 */
export declare function validateExpression(expression: string): string;
