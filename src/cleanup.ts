import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type DebugSession, saveSession } from "./session.js";

// --- Marker removal patterns ---

// JS/Go: single-line inline markers with /* */ comments
const INLINE_RE = /[ \t]*\/\*\s*__DBG_START_(\w+)__\s*\*\/.*?\/\*\s*__DBG_END_\1__\s*\*\/[ \t]*\n?/g;

// Python: multi-line block markers with # comments (handles indentation)
const BLOCK_RE = /[ \t]*#\s*__DBG_START_(\w+)__.*\n(?:[ \t]*.*\n)*?[ \t]*#\s*__DBG_END_\1__.*\n?/gm;

// Detection: any marker present?
const HAS_MARKER = /__DBG_(?:START|END)_\w+__/;

function removeMarkers(content: string): { cleaned: string; hadMarkers: boolean } {
  const hadMarkers = HAS_MARKER.test(content);
  if (!hadMarkers) return { cleaned: content, hadMarkers: false };

  let cleaned = content.replace(INLINE_RE, "");
  cleaned = cleaned.replace(BLOCK_RE, "");

  return { cleaned, hadMarkers: true };
}

function atomicWriteFile(path: string, data: string): void {
  const tmp = `${path}.dbg_clean_${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// --- Public API ---

export interface CleanupResult {
  cleaned: number;
  verified: boolean;
  errors: string[];
  filesProcessed: string[];
}

export function cleanupSession(cwd: string, session: DebugSession): CleanupResult {
  const errors: string[] = [];
  let cleaned = 0;
  const filesProcessed: string[] = [];

  const files = [...new Set(
    session.instrumentation.filter((r) => r.active).map((r) => r.filePath),
  )];

  for (const fp of files) {
    if (!existsSync(fp)) {
      errors.push(`File missing: ${fp}`);
      continue;
    }

    const content = readFileSync(fp, "utf-8");
    const { cleaned: result, hadMarkers } = removeMarkers(content);

    if (hadMarkers) {
      atomicWriteFile(fp, result);
      cleaned++;
      filesProcessed.push(fp);

      // Single-pass verify: check the content we just wrote
      if (HAS_MARKER.test(result)) {
        errors.push(`Markers remain after cleanup: ${fp}`);
      }
    }
  }

  // Mark all records inactive
  for (const r of session.instrumentation) r.active = false;
  session._markerIndex = {};
  session.status = "resolved";
  saveSession(cwd, session);

  return {
    cleaned,
    verified: errors.length === 0,
    errors,
    filesProcessed,
  };
}

/**
 * Emergency cleanup from manifest-less scan of session files.
 */
export function cleanupFromManifest(cwd: string): CleanupResult {
  // Scan all session files to find active instrumentation
  const sessionsDir = join(cwd, ".debug", "sessions");
  if (!existsSync(sessionsDir)) return { cleaned: 0, verified: true, errors: [], filesProcessed: [] };

  const allFiles = new Set<string>();

  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const session = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
      for (const r of session.instrumentation ?? []) {
        if (r.active) allFiles.add(r.filePath);
      }
    } catch { /* skip corrupt sessions */ }
  }

  if (allFiles.size === 0) return { cleaned: 0, verified: true, errors: [], filesProcessed: [] };

  const errors: string[] = [];
  let cleaned = 0;
  const filesProcessed: string[] = [];

  for (const fp of allFiles) {
    if (!existsSync(fp)) { errors.push(`Missing: ${fp}`); continue; }
    const content = readFileSync(fp, "utf-8");
    const { cleaned: result, hadMarkers } = removeMarkers(content);
    if (hadMarkers) {
      atomicWriteFile(fp, result);
      cleaned++;
      filesProcessed.push(fp);
      if (HAS_MARKER.test(result)) errors.push(`Markers remain: ${fp}`);
    }
  }

  return { cleaned, verified: errors.length === 0, errors, filesProcessed };
}
