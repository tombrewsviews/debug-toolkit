import { describe, it, expect } from "vitest";
import { isGhostConnected, resetConnectionState } from "../src/ghost-bridge.js";

describe("ghost bridge", () => {
  it("should report not connected by default", () => {
    expect(isGhostConnected()).toBe(false);
  });

  it("should expose resetConnectionState", () => {
    // Just verify the function exists and doesn't throw
    resetConnectionState();
    expect(isGhostConnected()).toBe(false);
  });
});
