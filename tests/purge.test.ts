import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { remember, loadStore, saveStore, purgeArchivedEntries } from "../src/memory.js";

describe("physical purge", () => {
  const tmp = join(process.cwd(), ".test-purge-" + Date.now());

  beforeEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, ".debug"), { recursive: true });
  });

  it("should move archived entries to archive files and shrink memory.json", () => {
    // Create an entry
    remember(tmp, {
      id: "purge-1",
      timestamp: "2025-01-15T00:00:00Z",
      problem: "old problem",
      errorType: "Error",
      category: "runtime",
      diagnosis: "old fix",
      files: ["a.ts"],
    });

    // Manually mark as archived
    const store = loadStore(tmp);
    store.entries[0].archived = true;
    saveStore(tmp, store);

    // Purge
    const result = purgeArchivedEntries(tmp);
    expect(result.purged).toBe(1);

    // Verify main store is empty
    const after = loadStore(tmp);
    expect(after.entries.length).toBe(0);

    // Verify archive file exists
    const archFile = join(tmp, ".debug", "archive", "2025-01.json");
    expect(existsSync(archFile)).toBe(true);
    const arch = JSON.parse(readFileSync(archFile, "utf-8"));
    expect(arch.entries.length).toBe(1);
    expect(arch.entries[0].id).toBe("purge-1");
  });

  it("should not purge non-archived entries", () => {
    remember(tmp, {
      id: "active-1",
      timestamp: "2025-03-15T00:00:00Z",
      problem: "active problem",
      errorType: "Error",
      category: "runtime",
      diagnosis: "active fix",
      files: ["b.ts"],
    });

    const result = purgeArchivedEntries(tmp);
    expect(result.purged).toBe(0);

    const after = loadStore(tmp);
    expect(after.entries.length).toBe(1);
  });

  it("should not duplicate entries on repeated purge", () => {
    remember(tmp, {
      id: "purge-2",
      timestamp: "2025-02-10T00:00:00Z",
      problem: "problem",
      errorType: "Error",
      category: "runtime",
      diagnosis: "fix",
      files: ["c.ts"],
    });

    const store = loadStore(tmp);
    store.entries[0].archived = true;
    saveStore(tmp, store);

    purgeArchivedEntries(tmp);

    // Add another archived entry with same month
    remember(tmp, {
      id: "purge-3",
      timestamp: "2025-02-20T00:00:00Z",
      problem: "problem 2",
      errorType: "Error",
      category: "runtime",
      diagnosis: "fix 2",
      files: ["d.ts"],
    });

    const store2 = loadStore(tmp);
    store2.entries[0].archived = true;
    saveStore(tmp, store2);

    purgeArchivedEntries(tmp);

    // Verify archive file has both entries, no duplicates
    const archFile = join(tmp, ".debug", "archive", "2025-02.json");
    const arch = JSON.parse(readFileSync(archFile, "utf-8"));
    expect(arch.entries.length).toBe(2);
    const ids = arch.entries.map((e: { id: string }) => e.id);
    expect(ids).toContain("purge-2");
    expect(ids).toContain("purge-3");
  });

  // Cleanup
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
});
