import { describe, expect, it, vi } from "vitest";
import { num } from "../src/config.js";

describe("num — numeric config validation", () => {
  it("accepts a valid in-range integer and returns it", () => {
    expect(num(10, "x", 100, 1, 1000)).toBe(10);
  });

  it("rejects fractional values (falls back, keeps a default)", () => {
    // Fractional shutdownTimeoutMs would previously reach AbortSignal.timeout
    // and throw — validate and fall back instead.
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(num(4.5, "shutdownTimeoutMs", 5000, 100, 600000)).toBe(5000);
    expect(num(-3.2, "x", 3, 1, 1000)).toBe(3);
    warn.mockRestore();
  });

  it("rejects negative and zero where a positive minimum is required", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(num(-10, "reviewIntervalTurns", 10, 1, 1000)).toBe(10);
    expect(num(0, "reviewMaxOutputTokens", 2048, 1, 200000)).toBe(2048);
    warn.mockRestore();
  });

  it("falls back on out-of-range, non-finite, and non-numeric inputs", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(num(999999, "reviewIntervalTurns", 10, 1, 1000)).toBe(10);
    expect(num(Number.POSITIVE_INFINITY, "injectTokenCap", 5000, 0, 1000000)).toBe(5000);
    expect(num(Number.NaN, "injectTokenCap", 5000, 0, 1000000)).toBe(5000);
    expect(num("50" as unknown, "x", 7, 1, 100)).toBe(7);
    expect(num(null, "x", 7, 1, 100)).toBe(7);
    expect(num(undefined, "x", 7, 1, 100)).toBe(7);
    warn.mockRestore();
  });
});
