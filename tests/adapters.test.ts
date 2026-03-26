import { describe, it, expect } from "vitest";
import { detectEnvironment, detectVisualToolsFromConfig } from "../src/adapters.js";

describe("Adapter discovery", () => {
  it("should detect environment capabilities", () => {
    const caps = detectEnvironment(process.cwd());
    expect(caps.core.nodeVersion).toBeTruthy();
    expect(typeof caps.core.gitAvailable).toBe("boolean");
    expect(typeof caps.perf.lighthouseAvailable).toBe("boolean");
  });

  it("should detect visual tools from config", () => {
    // With a non-existent directory, should return false for both
    const result = detectVisualToolsFromConfig("/tmp/nonexistent-" + Date.now());
    expect(result.ghostOs).toBe(false);
    expect(result.claudePreview).toBe(false);
  });
});
