import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveScreenshot, screenshotDir } from "../src/utils.js";

describe("screenshot storage", () => {
  const tmp = join(process.cwd(), ".test-screenshots-" + Date.now());

  beforeEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
  });

  it("should save a base64 PNG to .debug/screenshots/", () => {
    const fakeBase64 = Buffer.from("fake-png-data").toString("base64");
    const path = saveScreenshot(tmp, "test-session", "investigate", fakeBase64);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain(".debug/screenshots/");
    expect(path).toContain("test-session_investigate_");
    expect(path).toMatch(/\.png$/);
    // Verify content round-trips
    const content = readFileSync(path);
    expect(content.toString()).toBe("fake-png-data");
  });

  it("should create screenshots directory if missing", () => {
    const dir = screenshotDir(tmp);
    expect(existsSync(dir)).toBe(false);
    saveScreenshot(tmp, "s1", "test", Buffer.from("x").toString("base64"));
    expect(existsSync(dir)).toBe(true);
  });
});
