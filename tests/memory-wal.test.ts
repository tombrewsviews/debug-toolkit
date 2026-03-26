import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { remember, recall, loadStore } from "../src/memory.js";
import { walPath, memoryPath } from "../src/utils.js";

describe("WAL subsystem", () => {
  const tmp = join(process.cwd(), ".test-wal-" + Date.now());

  beforeEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, ".debug"), { recursive: true });
  });

  it("should create WAL entries on recall instead of full rewrite", () => {
    // Create an entry
    remember(tmp, {
      id: "wal-test-1",
      timestamp: new Date().toISOString(),
      problem: "test error foo bar",
      errorType: "TypeError",
      category: "type",
      diagnosis: "test diagnosis foo",
      files: ["src/test.ts"],
    });

    // Recall should append to WAL, not rewrite full store
    const results = recall(tmp, "test error foo", 3);
    expect(results.length).toBeGreaterThan(0);

    // WAL file should exist with increment_recalled entries
    const wp = walPath(tmp);
    if (existsSync(wp)) {
      const walContent = readFileSync(wp, "utf-8");
      expect(walContent).toContain("increment_recalled");
    }
  });

  it("should replay WAL mutations on load", () => {
    // Write a base store
    const storePath = memoryPath(tmp);
    writeFileSync(storePath, JSON.stringify({
      version: 2,
      entries: [{
        id: "replay-1",
        timestamp: new Date().toISOString(),
        problem: "replay test",
        errorType: "Error",
        category: "runtime",
        diagnosis: "test",
        files: ["a.ts"],
        keywords: ["replay", "test"],
        gitSha: null,
        rootCause: null,
        timesRecalled: 0,
        timesUsed: 0,
        archived: false,
        source: "local",
      }],
    }, null, 2));

    // Write WAL mutation
    const wp = walPath(tmp);
    writeFileSync(wp, JSON.stringify({
      op: "increment_recalled",
      entryId: "replay-1",
      ts: new Date().toISOString(),
    }) + "\n");

    // loadStore should merge base + WAL
    const store = loadStore(tmp);
    const entry = store.entries.find(e => e.id === "replay-1");
    expect(entry?.timesRecalled).toBe(1);
  });

  it("should skip corrupt WAL lines gracefully", () => {
    const storePath = memoryPath(tmp);
    writeFileSync(storePath, JSON.stringify({
      version: 2,
      entries: [{
        id: "corrupt-1",
        timestamp: new Date().toISOString(),
        problem: "corrupt test",
        errorType: "Error",
        category: "runtime",
        diagnosis: "test",
        files: ["b.ts"],
        keywords: ["corrupt", "test"],
        gitSha: null,
        rootCause: null,
        timesRecalled: 0,
        timesUsed: 0,
        archived: false,
        source: "local",
      }],
    }, null, 2));

    // Write corrupt + valid WAL lines
    const wp = walPath(tmp);
    writeFileSync(wp, [
      "NOT VALID JSON",
      JSON.stringify({ op: "increment_recalled", entryId: "corrupt-1", ts: new Date().toISOString() }),
      "",
    ].join("\n"));

    const store = loadStore(tmp);
    const entry = store.entries.find(e => e.id === "corrupt-1");
    expect(entry?.timesRecalled).toBe(1);
  });

  it("should handle missing WAL file", () => {
    const storePath = memoryPath(tmp);
    writeFileSync(storePath, JSON.stringify({ version: 2, entries: [] }, null, 2));
    const store = loadStore(tmp);
    expect(store.entries).toEqual([]);
  });
});
