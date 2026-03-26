import { describe, it, expect, afterAll } from "vitest";
import { createSession, saveSession, loadSession } from "../src/session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Session visual context", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dbt-test-"));

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("should persist visualContext on session", () => {
    const session = createSession(tmp, "visual bug");
    session.visualContext = {
      screenshots: [{ id: "ss_1", timestamp: new Date().toISOString(), tool: "ghost_screenshot", reference: "/tmp/ss.png" }],
      domSnapshot: null,
    };
    session.perfSnapshots = [];
    saveSession(tmp, session);

    const loaded = loadSession(tmp, session.id);
    expect(loaded.visualContext).toBeDefined();
    expect(loaded.visualContext!.screenshots).toHaveLength(1);
    expect(loaded.visualContext!.screenshots[0].tool).toBe("ghost_screenshot");
    expect(loaded.perfSnapshots).toEqual([]);
  });
});
