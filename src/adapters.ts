/**
 * adapters.ts — MCP tool discovery for visual integrations.
 *
 * Detects available tools from Ghost OS and Claude Preview at runtime.
 * All visual features gracefully degrade when no tools are available.
 */

// ━━━ Environment Capability Detection ━━━

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./utils.js";

export interface DoctorCheck {
  group: "core" | "perf" | "visual";
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface EnvironmentCapabilities {
  core: {
    nodeVersion: string;
    nodeOk: boolean;
    gitAvailable: boolean;
    debugDirExists: boolean;
  };
  perf: {
    lighthouseAvailable: boolean;
    chromeAvailable: boolean;
  };
  visual: {
    ghostOsConfigured: boolean;
    claudePreviewConfigured: boolean;
  };
}

function checkNodeVersion(): { version: string; ok: boolean } {
  const v = process.versions.node;
  const [major, minor] = v.split(".").map(Number);
  const ok = (major > 22) || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);
  return { version: v, ok };
}

function checkGit(): boolean {
  try { execSync("git --version", { stdio: "pipe", timeout: 3000 }); return true; } catch { return false; }
}

function checkLighthouse(cwd: string): boolean {
  // Fast check: local binary
  if (existsSync(join(cwd, "node_modules", ".bin", "lighthouse"))) return true;
  // Fallback: global
  try { execSync("lighthouse --version", { stdio: "pipe", timeout: 5000 }); return true; } catch { return false; }
}

function checkChrome(): boolean {
  const platform = process.platform;
  if (platform === "darwin") {
    return existsSync("/Applications/Google Chrome.app");
  }
  if (platform === "linux") {
    try { execSync("which google-chrome || which chromium-browser", { stdio: "pipe", timeout: 3000 }); return true; } catch { return false; }
  }
  if (platform === "win32") {
    const paths = [
      join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    return paths.some(existsSync);
  }
  return false;
}

export function detectVisualToolsFromConfig(cwd: string): { ghostOs: boolean; claudePreview: boolean } {
  const result = { ghostOs: false, claudePreview: false };
  // Check .mcp.json (Claude Code v2)
  for (const configFile of [".mcp.json", join(".claude", "mcp.json")]) {
    const p = join(cwd, configFile);
    if (!existsSync(p)) continue;
    try {
      const config = JSON.parse(readFileSync(p, "utf-8"));
      const servers = config.mcpServers ?? {};
      for (const name of Object.keys(servers)) {
        const lower = name.toLowerCase();
        if (lower.includes("ghost")) result.ghostOs = true;
        if (lower.includes("preview") || lower.includes("claude_preview") || lower.includes("claude-preview")) result.claudePreview = true;
      }
    } catch { /* skip corrupt config */ }
  }
  return result;
}

export function detectEnvironment(cwd: string): EnvironmentCapabilities {
  const node = checkNodeVersion();
  const visualConfig = detectVisualToolsFromConfig(cwd);
  return {
    core: {
      nodeVersion: node.version,
      nodeOk: node.ok,
      gitAvailable: checkGit(),
      debugDirExists: existsSync(join(cwd, ".debug")),
    },
    perf: {
      lighthouseAvailable: checkLighthouse(cwd),
      chromeAvailable: checkChrome(),
    },
    visual: {
      ghostOsConfigured: visualConfig.ghostOs,
      claudePreviewConfigured: visualConfig.claudePreview,
    },
  };
}

export function formatDoctorReport(caps: EnvironmentCapabilities): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // Core
  checks.push({
    group: "core", name: "Node.js",
    status: caps.core.nodeOk ? "pass" : "fail",
    message: caps.core.nodeOk ? `Node.js ${caps.core.nodeVersion}` : `Node.js ${caps.core.nodeVersion} (requires ≥20.19 or ≥22.12)`,
    fix: caps.core.nodeOk ? undefined : "Update Node.js: https://nodejs.org",
  });
  checks.push({
    group: "core", name: "Git",
    status: caps.core.gitAvailable ? "pass" : "fail",
    message: caps.core.gitAvailable ? "Git available" : "Git not found",
    fix: caps.core.gitAvailable ? undefined : "Install Git: https://git-scm.com",
  });
  checks.push({
    group: "core", name: ".debug dir",
    status: caps.core.debugDirExists ? "pass" : "warn",
    message: caps.core.debugDirExists ? ".debug/ directory exists" : ".debug/ not found (created on first use)",
  });

  // Performance
  checks.push({
    group: "perf", name: "Lighthouse",
    status: caps.perf.lighthouseAvailable ? "pass" : "warn",
    message: caps.perf.lighthouseAvailable ? "Lighthouse available" : "Lighthouse not found",
    fix: caps.perf.lighthouseAvailable ? undefined : "npm install -g lighthouse",
  });
  checks.push({
    group: "perf", name: "Chrome",
    status: caps.perf.chromeAvailable ? "pass" : "warn",
    message: caps.perf.chromeAvailable ? "Chrome available" : "Chrome not detected",
    fix: caps.perf.chromeAvailable ? undefined : "Install Chrome: https://google.com/chrome",
  });

  // Visual
  checks.push({
    group: "visual", name: "Ghost OS",
    status: caps.visual.ghostOsConfigured ? "pass" : "warn",
    message: caps.visual.ghostOsConfigured ? "Ghost OS configured" : "Ghost OS not configured",
    fix: caps.visual.ghostOsConfigured ? undefined : "Add ghost-os MCP server to .mcp.json",
  });
  checks.push({
    group: "visual", name: "Claude Preview",
    status: caps.visual.claudePreviewConfigured ? "pass" : "warn",
    message: caps.visual.claudePreviewConfigured ? "Claude Preview configured" : "Claude Preview not configured",
    fix: caps.visual.claudePreviewConfigured ? undefined : "Add Claude Preview MCP server to .mcp.json",
  });

  return checks;
}

// ━━━ Integration Installation ━━━

export interface InstallableIntegration {
  id: string;
  name: string;
  capability: string;          // what it enables — shown first
  packageName: string;         // the software package name
  description: string;         // what the package does
  available: boolean;
  autoInstallable: boolean;
  installCommand: string | null;
  manualSteps: string | null;
  diskSize: string;            // approximate disk space
}

export function listInstallable(caps: EnvironmentCapabilities): InstallableIntegration[] {
  const platform = process.platform;

  const chromeCmd = platform === "darwin"
    ? "brew install --cask google-chrome"
    : platform === "linux"
      ? "wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo dpkg -i google-chrome-stable_current_amd64.deb && rm google-chrome-stable_current_amd64.deb"
      : null;

  return [
    {
      id: "lighthouse",
      name: "Lighthouse",
      capability: "Performance profiling — measure Web Vitals (LCP, CLS, INP, TBT) before and after fixes",
      packageName: "lighthouse",
      description: "Google's open-source tool for auditing web page performance.",
      available: caps.perf.lighthouseAvailable,
      autoInstallable: true,
      installCommand: "npm install -g lighthouse",
      manualSteps: null,
      diskSize: "~45MB",
    },
    {
      id: "chrome",
      name: "Chrome",
      capability: "Headless browser — required for Lighthouse to run performance audits",
      packageName: "google-chrome",
      description: "Chrome runs headless in the background. No windows opened during testing.",
      available: caps.perf.chromeAvailable,
      autoInstallable: chromeCmd !== null,
      installCommand: chromeCmd,
      manualSteps: "Install from https://google.com/chrome",
      diskSize: "~150MB",
    },
    {
      id: "ghost-os",
      name: "Ghost OS",
      capability: "Visual debugging — auto-capture screenshots, inspect DOM elements, compare before/after",
      packageName: "ghost-os",
      description: "macOS accessibility bridge for visual UI automation. Requires Accessibility permission.",
      available: caps.visual.ghostOsConfigured,
      autoInstallable: process.platform === "darwin",
      installCommand: process.platform === "darwin" ? "brew install ghostwright/ghost-os/ghost-os" : null,
      manualSteps: process.platform === "darwin"
        ? "After install, run 'ghost setup' to configure permissions"
        : "Ghost OS is macOS only",
      diskSize: "~25MB",
    },
  ];
}

export function installIntegration(id: string, cwd: string): { success: boolean; message: string } {
  const caps = detectEnvironment(cwd);
  const integrations = listInstallable(caps);
  const target = integrations.find((i) => i.id === id);

  if (!target) return { success: false, message: `Unknown integration: ${id}` };
  if (target.available) return { success: true, message: `${target.name} is already available` };
  if (!target.autoInstallable || !target.installCommand) {
    return { success: false, message: `${target.name} requires manual setup: ${target.manualSteps}` };
  }

  try {
    execSync(target.installCommand, { stdio: "pipe", timeout: 180_000 });

    // Post-install hook for Ghost OS: write MCP config
    if (id === "ghost-os") {
      try {
        configureGhostOs(cwd);
      } catch { /* non-fatal */ }
    }

    return { success: true, message: `${target.name} installed successfully` };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { success: false, message: `Failed to install ${target.name}: ${err}. Manual: ${target.installCommand}` };
  }
}

function configureGhostOs(cwd: string): void {
  const mcpPath = join(cwd, ".mcp.json");
  let config: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    try { config = JSON.parse(readFileSync(mcpPath, "utf-8")); } catch { config = {}; }
  }
  if (!config.mcpServers) config.mcpServers = {};
  const servers = config.mcpServers as Record<string, unknown>;
  if (!servers["ghost-os"]) {
    servers["ghost-os"] = {
      command: "ghost",
      args: ["mcp"],
    };
    atomicWrite(mcpPath, JSON.stringify(config, null, 2));
  }
}
