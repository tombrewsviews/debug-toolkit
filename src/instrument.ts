import { readFileSync, statSync, renameSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { validateFilePath, validateExpression } from "./security.js";
import {
  type DebugSession,
  type InstrumentationRecord,
  newInstrumentationId,
  nextMarkerTag,
  indexMarker,
  saveSession,
  MAX_FILE_SIZE,
} from "./session.js";

// --- Language detection ---

type Language = "js" | "ts" | "py" | "go" | "rs" | "unknown";

const EXT_MAP: Record<string, Language> = {
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

function detectLanguage(filePath: string): Language {
  return EXT_MAP[extname(filePath)] ?? "unknown";
}

// --- Indentation detection ---

function getIndentation(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : "";
}

// --- Marker generation ---

function wrapInstrumentation(
  lang: Language,
  tag: string,
  expression: string,
  indent: string,
): string {
  switch (lang) {
    case "js":
    case "ts":
      return `${indent}/* __DBG_START_${tag}__ */ console.log("[${tag}]", ${expression}); /* __DBG_END_${tag}__ */`;
    case "py":
      return `${indent}# __DBG_START_${tag}__\n${indent}print(f"[${tag}] {${expression}}")\n${indent}# __DBG_END_${tag}__`;
    case "go":
      return `${indent}/* __DBG_START_${tag}__ */ fmt.Printf("[${tag}] %v\\n", ${expression}) /* __DBG_END_${tag}__ */`;
    case "rs":
      return `${indent}/* __DBG_START_${tag}__ */ eprintln!("[${tag}] {:?}", ${expression}); /* __DBG_END_${tag}__ */`;
    default:
      return `${indent}/* __DBG_START_${tag}__ */ console.log("[${tag}]", ${expression}); /* __DBG_END_${tag}__ */`;
  }
}

// --- Public API ---

export interface InstrumentOptions {
  cwd: string;
  session: DebugSession;
  filePath: string;
  lineNumber: number;
  expression: string;
  hypothesisId?: string;
}

export interface InstrumentResult {
  record: InstrumentationRecord;
  markerTag: string;
  insertedCode: string;
}

export function instrumentFile(opts: InstrumentOptions): InstrumentResult {
  const { cwd, session, filePath, lineNumber, expression, hypothesisId } = opts;

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
  const insertedCode = wrapInstrumentation(lang, tag, safeExpression, indent);

  // Insert the instrumentation lines
  const instrumentLines = insertedCode.split("\n");
  lines.splice(insertAt, 0, ...instrumentLines);

  // Atomic write: write to tmp file then rename
  const tmpPath = `${safePath}.dbg_tmp_${Date.now()}`;
  writeFileSync(tmpPath, lines.join("\n"));
  renameSync(tmpPath, safePath);

  // Record with hypothesis link
  const record: InstrumentationRecord = {
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
