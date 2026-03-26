import { describe, it, expect } from "vitest";
import { detectEnvironment, listInstallable } from "../src/adapters.js";

describe("integration installer", () => {
  it("should list all 4 integrations", () => {
    const caps = detectEnvironment(process.cwd());
    const integrations = listInstallable(caps);
    expect(integrations).toHaveLength(4);
    expect(integrations.map((i) => i.id)).toEqual(["lighthouse", "chrome", "ghost-os", "claude-preview"]);
  });

  it("should mark lighthouse and chrome as auto-installable", () => {
    const caps = detectEnvironment(process.cwd());
    const integrations = listInstallable(caps);
    expect(integrations.find((i) => i.id === "lighthouse")?.autoInstallable).toBe(true);
    expect(integrations.find((i) => i.id === "ghost-os")?.autoInstallable).toBe(false);
    expect(integrations.find((i) => i.id === "claude-preview")?.autoInstallable).toBe(false);
  });

  it("should provide install commands for auto-installable integrations", () => {
    const caps = detectEnvironment(process.cwd());
    const integrations = listInstallable(caps);
    const lh = integrations.find((i) => i.id === "lighthouse");
    expect(lh?.installCommand).toBe("npm install -g lighthouse");
  });

  it("should provide manual steps for non-installable integrations", () => {
    const caps = detectEnvironment(process.cwd());
    const integrations = listInstallable(caps);
    const ghost = integrations.find((i) => i.id === "ghost-os");
    expect(ghost?.manualSteps).toContain("ghost setup");
  });
});
