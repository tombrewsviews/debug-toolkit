import { readFileSync, statSync, renameSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { validateFilePath, validateExpression } from "./security.js";
import { newInstrumentationId, nextMarkerTag, indexMarker, saveSession, MAX_FILE_SIZE, } from "./session.js";
const EXT_MAP = {
    ".js": "js",
    ".jsx": "js",
    ".mjs": "js",
    ".cjs": "js",
    ".ts": "ts",
    ".tsx": "ts",
    ".mts": "ts",
    ".cts": "ts",
    ".py": "py",
    ".go": "go",
    ".rs": "rs",
};
function detectLanguage(filePath) {
    return EXT_MAP[extname(filePath)] ?? "unknown";
}
// --- Indentation detection ---
function getIndentation(line) {
    const match = line.match(/^(\s*)/);
    return match ? match[1] : "";
}
// --- Marker generation ---
function wrapInstrumentation(lang, tag, expression, indent, condition) {
    switch (lang) {
        case "js":
        case "ts":
            if (condition) {
                return `${indent}if (${condition}) console.log("[${tag}]", ${expression});`;
            }
            return `${indent}/* __DBG_START_${tag}__ */ console.log("[${tag}]", ${expression}); /* __DBG_END_${tag}__ */`;
        case "py":
            if (condition) {
                return `${indent}if ${condition}:\n${indent}    print(f"[${tag}] {${expression}}")`;
            }
            return `${indent}# __DBG_START_${tag}__\n${indent}print(f"[${tag}] {${expression}}")\n${indent}# __DBG_END_${tag}__`;
        case "go":
            if (condition) {
                return `${indent}if ${condition} {\n${indent}\tfmt.Printf("[${tag}] %v\\n", ${expression})\n${indent}}`;
            }
            return `${indent}/* __DBG_START_${tag}__ */ fmt.Printf("[${tag}] %v\\n", ${expression}) /* __DBG_END_${tag}__ */`;
        case "rs":
            if (condition) {
                return `${indent}if ${condition} {\n${indent}    eprintln!("[${tag}] {:?}", ${expression});\n${indent}}`;
            }
            return `${indent}/* __DBG_START_${tag}__ */ eprintln!("[${tag}] {:?}", ${expression}); /* __DBG_END_${tag}__ */`;
        default:
            if (condition) {
                return `${indent}if (${condition}) console.log("[${tag}]", ${expression});`;
            }
            return `${indent}/* __DBG_START_${tag}__ */ console.log("[${tag}]", ${expression}); /* __DBG_END_${tag}__ */`;
    }
}
export function instrumentFile(opts) {
    const { cwd, session, filePath, lineNumber, expression, hypothesisId, condition } = opts;
    // Security: validate file path and expression
    const safePath = validateFilePath(filePath, cwd);
    const safeExpression = validateExpression(expression);
    // Safety: check file size
    const stat = statSync(safePath);
    if (stat.size > MAX_FILE_SIZE) {
        throw new Error(`File too large (${stat.size} bytes). Max ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
    }
    const lang = detectLanguage(safePath);
    const content = readFileSync(safePath, "utf-8");
    const lines = content.split("\n");
    // Clamp line number to valid range
    const insertAt = Math.min(Math.max(lineNumber, 0), lines.length);
    // Detect indentation from the target line (or the line before it)
    const targetLine = lines[insertAt] ?? lines[insertAt - 1] ?? "";
    const indent = getIndentation(targetLine);
    const tag = nextMarkerTag();
    const insertedCode = wrapInstrumentation(lang, tag, safeExpression, indent, condition);
    // Insert the instrumentation lines
    const instrumentLines = insertedCode.split("\n");
    lines.splice(insertAt, 0, ...instrumentLines);
    // Atomic write: write to tmp file then rename
    const tmpPath = `${safePath}.dbg_tmp_${Date.now()}`;
    writeFileSync(tmpPath, lines.join("\n"));
    renameSync(tmpPath, safePath);
    // Record with hypothesis link
    const record = {
        id: newInstrumentationId(),
        filePath: safePath,
        lineNumber: insertAt,
        markerTag: tag,
        language: lang,
        insertedCode,
        active: true,
        hypothesisId: hypothesisId ?? null,
    };
    session.instrumentation.push(record);
    // Index marker → hypothesis for O(1) lookup during capture linking
    indexMarker(session, tag, hypothesisId ?? null);
    // Single save (no separate manifest file)
    saveSession(cwd, session);
    return { record, markerTag: tag, insertedCode };
}
//# sourceMappingURL=instrument.js.map