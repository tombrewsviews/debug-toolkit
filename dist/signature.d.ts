/**
 * signature.ts — Error signature normalization.
 *
 * Produces a stable fingerprint for an error so that the same bug
 * produces the same signature regardless of line number shifts,
 * minor wording changes, or which developer encounters it.
 *
 * Used by local memory (remember/recall) and team sync (deduplication).
 */
/**
 * Normalize an error into a stable 16-char hex signature.
 *
 * Strips line/column numbers, lowercases, hashes (type + file + topFrame).
 * Two stack traces pointing to the same bug with different line numbers
 * produce the same signature.
 */
export declare function normalizeSignature(errorType: string, sourceFile: string, topFrame: string | null): string;
/**
 * Compute a signature from an error message and optional file context.
 * Convenience wrapper that extracts type + file from a raw error string.
 */
export declare function signatureFromError(errorText: string, sourceFile: string | null): string;
