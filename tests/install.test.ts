import { describe, it, expect } from "vitest";
import { detectEnvironment, listInstallable } from "../src/adapters.js";

describe("integration installer", () => {
  it("should list all 3 integrations (lighthouse, chrome, ghost-os)", () => {
    const caps = detectEnvironment(process.cwd());
    const integrations = listInstallable(caps);
    expect(integrations).toHaveLength(3);
    expect(integrations.map((i) => i.id)).toEqual(["lighthouse", "chrome", "ghost-os"]);
  });

  it("should mark lighthouse as auto-installable and ghost-os on macOS", () => {
    const caps = detectEnvironment(process.cwd());
    const integrations = listInstallable(caps);
    expect(integrations.find((i) => i.id === "lighthouse")?.autoInstallable).toBe(true);
    expect(integrations.find((i) => i.id === "ghost-os")?.autoInstallable).toBe(process.platform === "darwin");
  });

  it("should provide install commands for auto-installable integrations", () => {
    const caps = detectEnvironment(process.cwd());
    const integrations = listInstallable(caps);
    const lh = integrations.find((i) => i.id === "lighthouse");
    expect(lh?.installCommand).toBe("npm install -g lighthouse");
  });

  it("should include capability and diskSize fields", () => {
    const caps = detectEnvironment(process.cwd());
    const integrations = listInstallable(caps);
    for (const intg of integrations) {
      expect(intg.capability).toBeTruthy();
      expect(intg.diskSize).toBeTruthy();
      expect(intg.packageName).toBeTruthy();
    }
  });
});
