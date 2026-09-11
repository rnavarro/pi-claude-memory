import { describe, expect, it } from "vitest";
import { composeShutdownChunk } from "../src/index.js";

describe("composeShutdownChunk", () => {
  it("returns the live chunk untouched when there is no snapshot", () => {
    expect(composeShutdownChunk(null, "live material", 100)).toBe("live material");
  });

  it("caps a long live chunk with a truncation marker", () => {
    const out = composeShutdownChunk(null, "x".repeat(200), 50);
    expect(out.startsWith("x".repeat(50))).toBe(true);
    expect(out).toContain("[truncated]");
  });

  it("does NOT let a cap-sized snapshot evict the live branch", () => {
    // The regression: the snapshot was prepended, then the tail was cut, so
    // a full-size snapshot left 0 bytes for post-compaction material.
    const snapshot = `OLD_${"a".repeat(9997)}`;
    const live = "CURRENT_CONVERSATION_MATERIAL";
    const out = composeShutdownChunk(snapshot, live, 1000);
    expect(out).toContain("CURRENT_CONVERSATION_MATERIAL");
    // Snapshot is held to half the budget.
    expect(out.length).toBeLessThanOrEqual(1000 + 40); // markers + header slack
  });

  it("gives leftover room to the live chunk when the snapshot is small", () => {
    const out = composeShutdownChunk("short old", "y".repeat(900), 1000);
    expect(out).not.toContain("[truncated]");
    expect(out).toContain("short old");
    expect(out).toContain("y".repeat(900));
  });

  it("marks the snapshot half when it exceeds its share", () => {
    const out = composeShutdownChunk("s".repeat(10_000), "live", 1000);
    expect(out).toContain("### Pre-compaction snapshot");
    expect(out).toContain("[truncated]");
    expect(out).toContain("live");
  });

  it("handles a zero cap without throwing", () => {
    expect(() => composeShutdownChunk("s", "l", 0)).not.toThrow();
  });
});
