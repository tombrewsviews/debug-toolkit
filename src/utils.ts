/**
 * utils.ts — Shared utilities for memory and pack modules.
 */

import { existsSync, writeFileSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";

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

/**
 * Runs a background self-upgrade on startup. Non-blocking — spawns the upgrade
 * in a child process and calls `onResult` when it completes.
 *
 * Strategy:
 * 1. Check npm registry for latest version (fast, ~1-2s)
 * 2. If a newer version exists, upgrade in-place (global or npx cache)
 * 3. Notify the caller with the result so it can print a message
 *
 * The child process is unref'd so it won't keep the parent alive if the user
 * exits before the upgrade finishes.
 */
export function backgroundSelfUpgrade(onResult: (result: {
  upgraded: boolean;
  from: string;
  to: string;
  message: string;
}) => void): void {
  const current = getPackageVersion();

  // Spawn a detached node process that checks + upgrades
  const script = `
    const { execSync } = require("child_process");
    try {
      const latest = execSync("npm view stackpack-debug version", { encoding: "utf-8", timeout: 10000 }).trim();
      const current = ${JSON.stringify(current)};
      const pa = latest.split(".").map(Number);
      const pb = current.split(".").map(Number);
      let newer = false;
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) { newer = true; break; }
        if ((pa[i] || 0) < (pb[i] || 0)) break;
      }
      if (!newer) {
        process.stdout.write(JSON.stringify({ upgraded: false, from: current, to: current, message: "" }));
        process.exit(0);
      }
      // Try global install first, fall back to npx cache refresh
      try {
        execSync("npm install -g stackpack-debug@latest", { stdio: "pipe", timeout: 60000 });
      } catch {
        execSync("npx -y stackpack-debug@latest --version", { stdio: "pipe", timeout: 30000 });
      }
      process.stdout.write(JSON.stringify({ upgraded: true, from: current, to: latest, message: "upgraded" }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ upgraded: false, from: ${JSON.stringify(current)}, to: ${JSON.stringify(current)}, message: "check-failed" }));
    }
  `;

  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });

  let stdout = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.on("close", () => {
    try {
      const result = JSON.parse(stdout);
      onResult(result);
    } catch {
      // Silent — upgrade check failed, no big deal
    }
  });
  child.unref();
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
