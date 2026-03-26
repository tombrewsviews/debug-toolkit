/**
 * utils.ts — Shared utilities for memory and pack modules.
 */

import { existsSync, writeFileSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export function memoryPath(cwd: string): string {
  return join(cwd, ".debug", "memory.json");
}

export function atomicWrite(filePath: string, data: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp_${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, filePath);
}

export function walPath(cwd: string): string {
  return join(cwd, ".debug", "memory.wal");
}

export function archiveDirPath(cwd: string): string {
  return join(cwd, ".debug", "archive");
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_./\-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

export function screenshotDir(cwd: string): string {
  return join(cwd, ".debug", "screenshots");
}

export function saveScreenshot(cwd: string, sessionId: string, phase: string, base64Data: string): string {
  const dir = screenshotDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filename = `${sessionId}_${phase}_${Date.now()}.png`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, Buffer.from(base64Data, "base64"), { mode: 0o600 });
  return filepath;
}
