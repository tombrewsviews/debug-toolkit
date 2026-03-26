import { describe, it, expect } from "vitest";
import { parseBuildError, type BuildError } from "../src/capture.js";

describe("Build error parsers", () => {
  it("should parse Vite/PostCSS error", () => {
    const output = `[vite:css][postcss] @import must precede all other statements (besides @charset or empty @layer)
1048|  @import url('https://fonts.googleapis.com/css2?family=Inter');
    |  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^`;
    const err = parseBuildError(output);
    expect(err).not.toBeNull();
    expect(err!.tool).toBe("vite");
    expect(err!.message).toContain("@import must precede");
  });

  it("should parse TypeScript compiler error", () => {
    const output = `src/App.tsx(15,3): error TS2322: Type 'string' is not assignable to type 'number'.`;
    const err = parseBuildError(output);
    expect(err).not.toBeNull();
    expect(err!.tool).toBe("tsc");
    expect(err!.file).toBe("src/App.tsx");
    expect(err!.line).toBe(15);
    expect(err!.code).toBe("TS2322");
  });

  it("should parse webpack error", () => {
    const output = `ERROR in ./src/index.js
Module not found: Error: Can't resolve './components/App' in '/project/src'`;
    const err = parseBuildError(output);
    expect(err).not.toBeNull();
    expect(err!.tool).toBe("webpack");
    expect(err!.message).toContain("Can't resolve");
  });

  it("should parse ESLint error", () => {
    const output = `/project/src/App.tsx
  15:3  error  'unused' is defined but never used  no-unused-vars`;
    const err = parseBuildError(output);
    expect(err).not.toBeNull();
    expect(err!.tool).toBe("eslint");
    expect(err!.line).toBe(15);
  });

  it("should return null for non-error output", () => {
    const output = `VITE v6.4.1  ready in 1014 ms`;
    const err = parseBuildError(output);
    expect(err).toBeNull();
  });
});
