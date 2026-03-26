/**
 * packs.ts — Exportable knowledge packs.
 *
 * Export project debug knowledge as shareable JSON packs.
 * Import external packs into a project's memory.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, archiveDirPath, tokenize } from "./utils.js";
import { loadStore, saveStore } from "./memory.js";

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

// loadStore and saveStore imported from memory.ts — single codepath for all store access

export function exportPack(
  cwd: string,
  outPath: string,
  options?: { name?: string; filter?: string; includeArchived?: boolean },
): { path: string; entries: number } {
  const store = loadStore(cwd);
  let entries = [...store.entries];

  if (options?.includeArchived) {
    const archDir = archiveDirPath(cwd);
    if (existsSync(archDir)) {
      for (const file of readdirSync(archDir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const arch = JSON.parse(readFileSync(join(archDir, file), "utf-8"));
          if (Array.isArray(arch.entries)) entries.push(...arch.entries);
        } catch { /* skip corrupt archive files */ }
      }
    }
  }

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

  saveStore(cwd, store);
  return { imported, total: store.entries.length };
}
