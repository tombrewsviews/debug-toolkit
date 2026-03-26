import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { remember, recall } from "../src/memory.js";

describe("multi-cwd index safety", () => {
  const tmp1 = join(process.cwd(), ".test-cwd1-" + Date.now());
  const tmp2 = join(process.cwd(), ".test-cwd2-" + Date.now());

  beforeEach(() => {
    for (const d of [tmp1, tmp2]) {
      rmSync(d, { recursive: true, force: true });
      mkdirSync(join(d, ".debug"), { recursive: true });
    }
  });

  it("should return correct results for different projects", () => {
    remember(tmp1, {
      id: "cwd1-entry",
      timestamp: new Date().toISOString(),
      problem: "alpha bravo charlie",
      errorType: "TypeError",
      category: "type",
      diagnosis: "project one issue",
      files: ["src/one.ts"],
    });

    remember(tmp2, {
      id: "cwd2-entry",
      timestamp: new Date().toISOString(),
      problem: "delta echo foxtrot",
      errorType: "RangeError",
      category: "range",
      diagnosis: "project two issue",
      files: ["src/two.ts"],
    });

    const results1 = recall(tmp1, "alpha bravo charlie", 3);
    const results2 = recall(tmp2, "delta echo foxtrot", 3);

    expect(results1.some(r => r.id === "cwd1-entry")).toBe(true);
    expect(results1.some(r => r.id === "cwd2-entry")).toBe(false);
    expect(results2.some(r => r.id === "cwd2-entry")).toBe(true);
    expect(results2.some(r => r.id === "cwd1-entry")).toBe(false);
  });
});
