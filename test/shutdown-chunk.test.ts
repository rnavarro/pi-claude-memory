import { describe, expect, it } from "vitest";
import { composeShutdownChunk } from "../src/index.js";

describe("composeShutdownChunk", () => {
  it("returns the live chunk untouched when there is no snapshot", () => {
    expect(composeShutdownChunk(null, "live material", 100)).toBe("live material");
  });

  it("caps a long live chunk with a truncation marker", () => {
    const out = composeShutdownChunk(null, "x".repeat(200), 50);
    // The kept portion is the TAIL (newest turns), flagged as a prefix cut.
    expect(out).toBe(`... [truncated]\n${"x".repeat(50)}`);
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
    expect(out).toContain("short old");
    expect(out).toContain("y".repeat(900));
  });

  it("keeps the TAIL of the live branch, not its head", () => {
    // Regression guard for the round-4 fix: budgeting the snapshot was only
    // half the bug. Truncating the live side from the front retained the
    // OLDEST turns of the session and discarded the conversation that had
    // just ended — backwards for a shutdown review.
    const older = "OLDEST_TURN_MARKER";
    const newest = "NEWEST_TURN_MARKER";
    const live = `${older}${"m".repeat(2000)}${newest}`;
    const out = composeShutdownChunk(null, live, 300);
    expect(out).toContain(newest);
    expect(out).not.toContain(older);
    expect(out.startsWith("... [truncated]")).toBe(true);
  });

  it("keeps the live tail even when a snapshot takes its half", () => {
    const live = `${"m".repeat(2000)}NEWEST_TURN_MARKER`;
    const out = composeShutdownChunk(`SNAPSHOT_HEAD${"s".repeat(9000)}`, live, 1000);
    expect(out).toContain("NEWEST_TURN_MARKER");
    expect(out).toContain("### Pre-compaction snapshot");
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
