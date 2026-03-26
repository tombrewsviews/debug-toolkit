import { describe, it, expect, afterAll } from "vitest";
import { exportPack, importPack, type KnowledgePack } from "../src/packs.js";
import { remember } from "../src/memory.js";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Knowledge packs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dbt-pack-"));
  const tmp2 = mkdtempSync(join(tmpdir(), "dbt-pack2-"));

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tmp2, { recursive: true, force: true });
  });

  it("should export memory as a knowledge pack", () => {
    remember(tmp, {
      id: "test_1", timestamp: new Date().toISOString(),
      problem: "CSS import ordering", errorType: "SyntaxError",
      category: "syntax", diagnosis: "Move @import to top of file",
      files: ["src/index.css"],
    });

    const outPath = join(tmp, "export.json");
    const result = exportPack(tmp, outPath);
    expect(result.entries).toBe(1);
    expect(existsSync(outPath)).toBe(true);

    const pack = JSON.parse(readFileSync(outPath, "utf-8")) as KnowledgePack;
    expect(pack.version).toBe("1.0");
    expect(pack.entries).toHaveLength(1);
    expect(pack.entries[0].diagnosis).toBe("Move @import to top of file");
  });

  it("should import a knowledge pack into a fresh project", () => {
    const packPath = join(tmp, "export.json");
    const result = importPack(tmp2, packPath);
    expect(result.imported).toBe(1);
    expect(result.total).toBe(1);
  });

  it("should not duplicate on re-import", () => {
    const packPath = join(tmp, "export.json");
    const result = importPack(tmp2, packPath);
    expect(result.total).toBe(1);
  });

  it("should throw on invalid pack version", () => {
    const badPack = join(tmp, "bad-version.json");
    writeFileSync(badPack, JSON.stringify({ version: "99.0", entries: [] }));
    expect(() => importPack(tmp2, badPack)).toThrow("Unsupported pack version");
  });
});
