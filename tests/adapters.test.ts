import { describe, it, expect } from "vitest";
import { detectVisualTools, type VisualCapabilities } from "../src/adapters.js";

describe("Adapter discovery", () => {
  it("should return no capabilities when no tools available", () => {
    const caps = detectVisualTools([]);
    expect(caps.canScreenshot).toBe(false);
    expect(caps.canReadDom).toBe(false);
    expect(caps.screenshotTool).toBeNull();
    expect(caps.domTool).toBeNull();
  });

  it("should detect Ghost OS screenshot capability", () => {
    const tools = ["ghost_screenshot", "ghost_read", "ghost_inspect"];
    const caps = detectVisualTools(tools);
    expect(caps.canScreenshot).toBe(true);
    expect(caps.screenshotTool).toBe("ghost_screenshot");
    expect(caps.canReadDom).toBe(true);
    expect(caps.domTool).toBe("ghost_read");
  });

  it("should detect Claude Preview capabilities", () => {
    const tools = ["preview_screenshot", "preview_snapshot"];
    const caps = detectVisualTools(tools);
    expect(caps.canScreenshot).toBe(true);
    expect(caps.screenshotTool).toBe("preview_screenshot");
    expect(caps.canReadDom).toBe(true);
    expect(caps.domTool).toBe("preview_snapshot");
  });

  it("should prefer Ghost OS over Preview when both available", () => {
    const tools = ["ghost_screenshot", "ghost_read", "preview_screenshot", "preview_snapshot"];
    const caps = detectVisualTools(tools);
    expect(caps.screenshotTool).toBe("ghost_screenshot");
    expect(caps.domTool).toBe("ghost_read");
  });
});
