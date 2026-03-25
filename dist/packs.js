/**
 * packs.ts — Exportable knowledge packs.
 *
 * Export project debug knowledge as shareable JSON packs.
 * Import external packs into a project's memory.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
function memoryPath(cwd) {
    return join(cwd, ".debug", "memory.json");
}
function loadStore(cwd) {
    const p = memoryPath(cwd);
    if (!existsSync(p))
        return { version: 2, entries: [] };
    try {
        return JSON.parse(readFileSync(p, "utf-8"));
    }
    catch {
        return { version: 2, entries: [] };
    }
}
function atomicWrite(filePath, data) {
    const dir = dirname(filePath);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp_${process.pid}`;
    writeFileSync(tmp, data);
    renameSync(tmp, filePath);
}
function tokenize(text) {
    return text.toLowerCase().replace(/[^a-z0-9_./\-]/g, " ").split(/\s+/).filter((w) => w.length > 2);
}
export function exportPack(cwd, outPath, options) {
    const store = loadStore(cwd);
    let entries = store.entries;
    if (options?.filter) {
        const f = options.filter.toLowerCase();
        entries = entries.filter((e) => String(e.category ?? "").toLowerCase().includes(f) ||
            String(e.errorType ?? "").toLowerCase().includes(f) ||
            (Array.isArray(e.files) && e.files.some((file) => String(file).toLowerCase().includes(f))));
    }
    const pack = {
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
            rootCause: e.rootCause ?? null,
        })),
    };
    atomicWrite(outPath, JSON.stringify(pack, null, 2));
    return { path: outPath, entries: pack.entries.length };
}
export function importPack(cwd, packPath) {
    const pack = JSON.parse(readFileSync(packPath, "utf-8"));
    const store = loadStore(cwd);
    const existingKeys = new Set(store.entries.map((e) => `${e.errorType}:${e.diagnosis}`));
    let imported = 0;
    for (const entry of pack.entries) {
        const key = `${entry.errorType}:${entry.diagnosis}`;
        if (existingKeys.has(key))
            continue;
        store.entries.push({
            id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date().toISOString(),
            problem: entry.problem,
            errorType: entry.errorType,
            category: entry.category,
            diagnosis: entry.diagnosis,
            files: entry.files,
            keywords: tokenize(`${entry.problem} ${entry.diagnosis} ${entry.files.join(" ")}`),
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
//# sourceMappingURL=packs.js.map