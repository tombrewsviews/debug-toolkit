/**
 * utils.ts — Shared utilities for memory and pack modules.
 */

import { existsSync, writeFileSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

export function getPackageVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(dir, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface UpdateCheck {
  current: string;
  latest: string;
  updateAvailable: boolean;
  updateCommand: string;
}

export function checkForUpdate(): UpdateCheck {
  const current = getPackageVersion();
  try {
    const latest = execSync("npm view stackpack-debug version", { encoding: "utf-8", timeout: 5_000 }).trim();
    const updateAvailable = latest !== current && compareSemver(latest, current) > 0;
    return {
      current,
      latest,
      updateAvailable,
      updateCommand: "npx -y stackpack-debug@latest",
    };
  } catch {
    return { current, latest: current, updateAvailable: false, updateCommand: "npx -y stackpack-debug@latest" };
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

export function runSelfUpdate(): { success: boolean; from: string; to: string; message: string } {
  const before = getPackageVersion();
  try {
    // Clear npx cache and re-fetch latest
    execSync("npx -y stackpack-debug@latest --version", { encoding: "utf-8", timeout: 30_000, stdio: "pipe" });
    // Re-check what version we'd get now
    const after = execSync("npm view stackpack-debug version", { encoding: "utf-8", timeout: 5_000 }).trim();
    return {
      success: true,
      from: before,
      to: after,
      message: before === after
        ? `Already on latest version (${after}).`
        : `Updated from ${before} to ${after}. Restart Claude Code to use the new version.`,
    };
  } catch (e) {
    return { success: false, from: before, to: before, message: `Update failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

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
