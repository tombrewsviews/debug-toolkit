import { describe, it, expect } from "vitest";
import { isVisualError } from "../src/context.js";

describe("Visual error classification", () => {
  it("should detect CSS errors as visual", () => {
    expect(isVisualError("runtime", "src/index.css")).toBe(true);
    expect(isVisualError("runtime", "styles/main.scss")).toBe(true);
  });

  it("should detect layout/visual categories", () => {
    expect(isVisualError("logic", null, "the header looks broken on mobile")).toBe(true);
    expect(isVisualError("logic", null, "animation stutters on scroll")).toBe(true);
  });

  it("should not flag non-visual errors", () => {
    expect(isVisualError("type", "src/api.ts")).toBe(false);
    expect(isVisualError("network", null)).toBe(false);
  });

  it("should detect CSS-related error categories", () => {
    expect(isVisualError("syntax", "src/App.module.css")).toBe(true);
  });
});
