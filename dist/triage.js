/**
 * triage.ts — Error complexity classification.
 *
 * Classifies errors as trivial/medium/complex to determine
 * how much of the investigation pipeline to run.
 *
 * Trivial: self-explanatory, single file, known pattern → fast-path
 * Medium: known type, needs some context → partial pipeline
 * Complex: ambiguous, multi-file, no pattern → full pipeline
 */
import { classifyError } from "./context.js";
// Patterns that are self-explanatory with known fixes
const TRIVIAL_PATTERNS = [
    { test: /ReferenceError:.*is not defined/i, hint: "Check for missing import or typo in variable/function name." },
    { test: /SyntaxError/i, hint: "Check for missing brackets, quotes, or invalid syntax at the indicated line." },
    { test: /ERR_MODULE_NOT_FOUND/i, hint: "Add .js extension to the import or check the path." },
    { test: /ENOENT.*no such file/i, hint: "The file path doesn't exist — check for typos." },
    { test: /@import must precede/i, hint: "Move @import statements to the top of the CSS file, before other rules." },
    { test: /Unexpected token/i, hint: "Syntax error — check the indicated line for missing or extra characters." },
];
// Count user-code stack frames (excludes node_modules, node:internal, etc.)
const USER_FRAME_RE = /at\s+(?:[\w$.< >\[\]]+?\s+)?\(?([^\s()]+):(\d+):(\d+)\)?/gm;
const INTERNAL_PATH = /node_modules|node:|\.cargo|\/rustc\//;
function countUserFrames(error) {
    let count = 0;
    let m;
    USER_FRAME_RE.lastIndex = 0;
    while ((m = USER_FRAME_RE.exec(error)) !== null) {
        if (!INTERNAL_PATH.test(m[1]))
            count++;
    }
    return count;
}
export function triageError(errorText) {
    const classification = classifyError(errorText);
    const userFrames = countUserFrames(errorText);
    // Check for trivial patterns first
    for (const { test, hint } of TRIVIAL_PATTERNS) {
        if (test.test(errorText) && userFrames <= 1) {
            return {
                level: "trivial",
                skipFullPipeline: true,
                skipEnvScan: true,
                skipMemorySearch: true,
                fixHint: hint,
                classification,
            };
        }
    }
    // No stack trace + no known error type → complex (ambiguous)
    if (userFrames === 0 && classification.type === "Unknown") {
        return {
            level: "complex",
            skipFullPipeline: false,
            skipEnvScan: false,
            skipMemorySearch: false,
            fixHint: null,
            classification,
        };
    }
    // Deep stack (5+ user frames) → complex
    if (userFrames >= 5) {
        return {
            level: "complex",
            skipFullPipeline: false,
            skipEnvScan: false,
            skipMemorySearch: false,
            fixHint: null,
            classification,
        };
    }
    // Known error type with some stack → medium
    return {
        level: "medium",
        skipFullPipeline: false,
        skipEnvScan: true,
        skipMemorySearch: false,
        fixHint: classification.suggestion || null,
        classification,
    };
}
//# sourceMappingURL=triage.js.map