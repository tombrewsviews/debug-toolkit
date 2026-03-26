/**
 * utils.ts — Shared utilities for memory and pack modules.
 */
import { existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
export function memoryPath(cwd) {
    return join(cwd, ".debug", "memory.json");
}
export function atomicWrite(filePath, data) {
    const dir = dirname(filePath);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp_${process.pid}`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, filePath);
}
export function walPath(cwd) {
    return join(cwd, ".debug", "memory.wal");
}
export function archiveDirPath(cwd) {
    return join(cwd, ".debug", "archive");
}
export function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9_./\-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);
}
//# sourceMappingURL=utils.js.map