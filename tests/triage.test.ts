import { describe, it, expect } from "vitest";
import { triageError, type TriageResult } from "../src/triage.js";

describe("Error triage", () => {
  it("should classify missing import as trivial", () => {
    const result = triageError("ReferenceError: foo is not defined\n    at Object.<anonymous> (src/app.ts:5:1)");
    expect(result.level).toBe("trivial");
    expect(result.skipFullPipeline).toBe(true);
  });

  it("should classify syntax error as trivial", () => {
    const result = triageError("SyntaxError: Unexpected token '}' at src/index.ts:10:5");
    expect(result.level).toBe("trivial");
  });

  it("should classify single-frame type error as medium", () => {
    const result = triageError("TypeError: Cannot read properties of undefined (reading 'map')\n    at UserList (src/UserList.tsx:15:20)");
    expect(result.level).toBe("medium");
  });

  it("should classify deep multi-file stack as complex", () => {
    const error = `Error: Connection failed
    at Database.connect (src/db.ts:45:10)
    at UserService.init (src/services/user.ts:12:5)
    at App.bootstrap (src/app.ts:8:3)
    at Server.listen (src/server.ts:20:7)
    at main (src/index.ts:5:1)`;
    const result = triageError(error);
    expect(result.level).toBe("complex");
    expect(result.skipFullPipeline).toBe(false);
  });

  it("should classify ambiguous description as complex", () => {
    const result = triageError("the page is blank after login");
    expect(result.level).toBe("complex");
  });

  it("should classify known framework error as medium", () => {
    const result = triageError("Error: Cannot find module './components/App'\n    at require (node:internal/modules/cjs/loader:1080:19)\n    at Object.<anonymous> (src/index.ts:3:1)");
    expect(result.level).toBe("medium");
  });

  it("should include fix hint for trivial errors", () => {
    const result = triageError("ReferenceError: useState is not defined\n    at App (src/App.tsx:5:10)");
    expect(result.level).toBe("trivial");
    expect(result.fixHint).toBeDefined();
    expect(result.fixHint).toContain("import");
  });
});
