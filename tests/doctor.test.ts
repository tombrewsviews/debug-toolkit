import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { detectEnvironment, formatDoctorReport, detectVisualToolsFromConfig } from "../src/adapters.js";

describe("environment detection", () => {
  const tmp = join(process.cwd(), ".test-doctor-" + Date.now());

  beforeEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
  });

  it("should detect current Node version as OK", () => {
    const caps = detectEnvironment(tmp);
    expect(caps.core.nodeVersion).toBeTruthy();
    expect(caps.core.nodeOk).toBe(true);
  });

  it("should detect git as available", () => {
    const caps = detectEnvironment(tmp);
    expect(caps.core.gitAvailable).toBe(true);
  });

  it("should detect .debug/ dir existence", () => {
    expect(detectEnvironment(tmp).core.debugDirExists).toBe(false);
    mkdirSync(join(tmp, ".debug"), { recursive: true });
    expect(detectEnvironment(tmp).core.debugDirExists).toBe(true);
  });

  it("should format doctor report with correct groups", () => {
    const caps = detectEnvironment(tmp);
    const report = formatDoctorReport(caps);
    expect(report.some((c) => c.group === "core")).toBe(true);
    expect(report.some((c) => c.group === "perf")).toBe(true);
    expect(report.some((c) => c.group === "visual")).toBe(true);
    // Core checks should pass
    expect(report.find((c) => c.name === "Node.js")?.status).toBe("pass");
    expect(report.find((c) => c.name === "Git")?.status).toBe("pass");
  });
});

describe("visual tools from config", () => {
  const tmp = join(process.cwd(), ".test-config-" + Date.now());

  beforeEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
  });

  it("should return false for both when no config exists", () => {
    const result = detectVisualToolsFromConfig(tmp);
    expect(result.ghostOs).toBe(false);
    expect(result.claudePreview).toBe(false);
  });

  it("should detect ghost-os from .mcp.json", () => {
    writeFileSync(join(tmp, ".mcp.json"), JSON.stringify({
      mcpServers: { "ghost-os": { command: "ghost" } },
    }));
    const result = detectVisualToolsFromConfig(tmp);
    expect(result.ghostOs).toBe(true);
    expect(result.claudePreview).toBe(false);
  });

  it("should detect Claude Preview from .mcp.json", () => {
    writeFileSync(join(tmp, ".mcp.json"), JSON.stringify({
      mcpServers: { "Claude_Preview": { command: "preview" } },
    }));
    const result = detectVisualToolsFromConfig(tmp);
    expect(result.claudePreview).toBe(true);
  });

  it("should handle corrupt config gracefully", () => {
    writeFileSync(join(tmp, ".mcp.json"), "NOT VALID JSON");
    const result = detectVisualToolsFromConfig(tmp);
    expect(result.ghostOs).toBe(false);
    expect(result.claudePreview).toBe(false);
  });
});
