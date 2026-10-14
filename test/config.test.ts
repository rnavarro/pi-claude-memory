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

describe("loadConfig guard behavior", () => {
  it("warns (rather than silently defaulting) on a present-but-invalid numeric value", async () => {
    // The call sites used to be gated by `typeof n.X === "number"`, so a
    // string like "9000" never reached num() and defaulted silently —
    // exactly the case a user needs feedback for.
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "pcm-cfg-"));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({
        "pi-claude-memory": { shutdownTimeoutMs: "9000", reviewIntervalTurns: 2.5 },
      }),
    );
    const origHome = process.env.HOME;
    process.env.HOME = home;
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { loadConfig, DEFAULT_CONFIG } = await import("../src/config.js");
      const cfg = loadConfig();
      // Both invalid values fall back, and the user is told.
      expect(cfg.shutdownTimeoutMs).toBe(DEFAULT_CONFIG.shutdownTimeoutMs);
      expect(cfg.reviewIntervalTurns).toBe(DEFAULT_CONFIG.reviewIntervalTurns);
      const msgs = warn.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes("shutdownTimeoutMs"))).toBe(true);
      expect(msgs.some((m) => m.includes("reviewIntervalTurns"))).toBe(true);
    } finally {
      warn.mockRestore();
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  });
});

describe("correction and tool-call trigger settings", () => {
  async function loadWith(settings: Record<string, unknown>) {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "pcm-cfg-"));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ "pi-claude-memory": settings }),
    );
    const origHome = process.env.HOME;
    const origAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { loadConfig } = await import("../src/config.js");
      return { cfg: loadConfig(), msgs: warn.mock.calls.map((c) => String(c[0])) };
    } finally {
      warn.mockRestore();
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = origAgentDir;
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("subagent defaults: no reviewer, 8000-byte index", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config.js");
    expect(DEFAULT_CONFIG.subagentAutoLearn).toBe(false);
    expect(DEFAULT_CONFIG.subagentIndexMaxBytes).toBe(8000);
  });

  it("subagentIndexMaxBytes above the 25KB startup limit falls back loudly", async () => {
    const { cfg, msgs } = await loadWith({ subagentIndexMaxBytes: 30000 });
    expect(cfg.subagentIndexMaxBytes).toBe(8000);
    expect(msgs.some((m) => m.includes("subagentIndexMaxBytes"))).toBe(true);
  });

  it("isSubagentProcess reads PI_SUBAGENT_CHILD=1 only", async () => {
    const { isSubagentProcess } = await import("../src/config.js");
    expect(isSubagentProcess({ PI_SUBAGENT_CHILD: "1" })).toBe(true);
    expect(isSubagentProcess({ PI_SUBAGENT_CHILD: "0" })).toBe(false);
    expect(isSubagentProcess({})).toBe(false);
  });

  it("defaults: corrections on, 25 tool calls, 60 s debounce", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config.js");
    expect(DEFAULT_CONFIG.reviewOnCorrection).toBe(true);
    expect(DEFAULT_CONFIG.reviewEveryToolCalls).toBe(25);
    expect(DEFAULT_CONFIG.reviewTriggerDebounceSeconds).toBe(60);
  });

  it("accepts the off values (false, 0, 0)", async () => {
    const { cfg, msgs } = await loadWith({
      reviewOnCorrection: false,
      reviewEveryToolCalls: 0,
      reviewTriggerDebounceSeconds: 0,
    });
    expect(cfg.reviewOnCorrection).toBe(false);
    expect(cfg.reviewEveryToolCalls).toBe(0);
    expect(cfg.reviewTriggerDebounceSeconds).toBe(0);
    expect(msgs).toHaveLength(0);
  });

  it("falls back loudly on invalid numbers and ignores a non-boolean switch", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config.js");
    const { cfg, msgs } = await loadWith({
      reviewOnCorrection: "no",
      reviewEveryToolCalls: -1,
      reviewTriggerDebounceSeconds: 1.5,
    });
    expect(cfg.reviewOnCorrection).toBe(true);
    expect(cfg.reviewEveryToolCalls).toBe(DEFAULT_CONFIG.reviewEveryToolCalls);
    expect(cfg.reviewTriggerDebounceSeconds).toBe(DEFAULT_CONFIG.reviewTriggerDebounceSeconds);
    expect(msgs.some((m) => m.includes("reviewEveryToolCalls"))).toBe(true);
    expect(msgs.some((m) => m.includes("reviewTriggerDebounceSeconds"))).toBe(true);
  });
});
