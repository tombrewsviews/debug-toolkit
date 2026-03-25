/**
 * packs.ts — Exportable knowledge packs.
 *
 * Export project debug knowledge as shareable JSON packs.
 * Import external packs into a project's memory.
 */

import { readFileSync, existsSync } from "node:fs";
import { memoryPath, atomicWrite, tokenize } from "./utils.js";

export interface KnowledgePack {
  version: "1.0";
  name: string;
  description: string;
  exportedAt: string;
  entries: PackEntry[];
}

export interface PackEntry {
  errorType: string;
  category: string;
  problem: string;
  diagnosis: string;
  files: string[];
  rootCause: { trigger: string; errorFile: string; causeFile: string; fixDescription: string } | null;
}

// Minimal store interface (avoids circular dependency with memory.ts)
interface MemoryStore {
  version: number;
  entries: Array<Record<string, unknown>>;
}

function loadStore(cwd: string): MemoryStore {
  const p = memoryPath(cwd);
  if (!existsSync(p)) return { version: 2, entries: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { version: 2, entries: [] };
  }
}

export function exportPack(
  cwd: string,
  outPath: string,
  options?: { name?: string; filter?: string },
): { path: string; entries: number } {
  const store = loadStore(cwd);
  let entries = store.entries;

  if (options?.filter) {
    const f = options.filter.toLowerCase();
    entries = entries.filter((e) =>
      String(e.category ?? "").toLowerCase().includes(f) ||
      String(e.errorType ?? "").toLowerCase().includes(f) ||
      (Array.isArray(e.files) && e.files.some((file: unknown) => String(file).toLowerCase().includes(f))),
    );
  }

  const pack: KnowledgePack = {
    version: "1.0",
    name: options?.name ?? "debug-knowledge",
    description: `Debug knowledge exported from ${cwd}`,
    exportedAt: new Date().toISOString(),
    entries: entries.map((e) => ({
      errorType: String(e.errorType ?? ""),
      category: String(e.category ?? ""),
      problem: String(e.problem ?? ""),
      diagnosis: String(e.diagnosis ?? ""),
      files: Array.isArray(e.files) ? e.files.map(String) : [],
      rootCause: e.rootCause as PackEntry["rootCause"] ?? null,
    })),
  };

  atomicWrite(outPath, JSON.stringify(pack, null, 2));
  return { path: outPath, entries: pack.entries.length };
}

export function importPack(
  cwd: string,
  packPath: string,
): { imported: number; total: number } {
  const pack = JSON.parse(readFileSync(packPath, "utf-8")) as KnowledgePack;

  if (pack.version !== "1.0") {
    throw new Error(`Unsupported pack version: ${pack.version}. Expected "1.0".`);
  }

  const store = loadStore(cwd);
  const existingKeys = new Set(store.entries.map((e) => `${e.errorType}:${e.diagnosis}`));

  let imported = 0;
  for (const entry of pack.entries) {
    const key = `${entry.errorType}:${entry.diagnosis}`;
    if (existingKeys.has(key)) continue;

    // Sanitize file paths — reject path traversal attempts
    const safeFiles = entry.files
      .map(String)
      .filter((f) => !f.includes("..") && !f.startsWith("/") && !f.startsWith("\\"));

    store.entries.push({
      id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      problem: entry.problem,
      errorType: entry.errorType,
      category: entry.category,
      diagnosis: entry.diagnosis,
      files: safeFiles,
      keywords: tokenize(`${entry.problem} ${entry.diagnosis} ${safeFiles.join(" ")}`),
      gitSha: null,
      rootCause: entry.rootCause,
      timesRecalled: 0,
      timesUsed: 0,
      archived: false,
      source: "external",
    });
    existingKeys.add(key);
    imported++;
  }

  atomicWrite(memoryPath(cwd), JSON.stringify(store, null, 2));
  return { imported, total: store.entries.length };
}
