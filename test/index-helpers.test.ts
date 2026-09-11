// Tests for the pure helpers in index.ts that bound what a paid review sees.
// These are module-private lifecycle functions with real logic but no module
// state dependency, so they are testable without mocking Pi's runtime.

import { describe, expect, it } from "vitest";
import {
  appendToToolResultChunk,
  serializeMessageEntries,
  toolResultToText,
} from "../src/index.js";

describe("appendToToolResultChunk", () => {
  it("returns the buffer unchanged for empty text", () => {
    expect(appendToToolResultChunk("existing", "")).toBe("existing");
  });

  it("separates appended entries with a blank line", () => {
    expect(appendToToolResultChunk("a", "b")).toBe("a\n\nb");
  });

  it("starts the buffer with the first entry and no separator", () => {
    expect(appendToToolResultChunk("", "first")).toBe("first");
  });

  it("clamps to the cap keeping the TAIL (most recent)", () => {
    const out = appendToToolResultChunk("OLDEST", "x".repeat(20_000) + "NEWEST");
    expect(out.length).toBe(8000);
    expect(out).toContain("NEWEST");
    expect(out).not.toContain("OLDEST");
  });

  it("bounds an oversized single result to exactly the cap", () => {
    // The previous slice(overflow+1) math left the buffer at MAX+1 here, and
    // could exceed the cap entirely for a result larger than it.
    const out = appendToToolResultChunk("", "y".repeat(50_000));
    expect(out.length).toBe(8000);
  });
});

describe("serializeMessageEntries", () => {
  const entry = (role: string, content: unknown) => ({ message: { role, content } }) as never;

  it("serializes string content", () => {
    expect(serializeMessageEntries([entry("user", "hello")])).toBe("### user\nhello");
  });

  it("concatenates text parts of array content", () => {
    const out = serializeMessageEntries([
      entry("assistant", [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ]);
    expect(out).toBe("### assistant\none\ntwo");
  });

  it("skips non-text parts and drops entries with no text", () => {
    const out = serializeMessageEntries([
      entry("user", [{ type: "image", data: "zzz" }]),
      entry("user", "kept"),
    ]);
    expect(out).toBe("### user\nkept");
    expect(out).not.toContain("zzz");
  });

  it("keeps only the last 20 messages", () => {
    const many = Array.from({ length: 25 }, (_, i) => entry("user", `m${i}`));
    const out = serializeMessageEntries(many);
    expect(out).not.toContain("m0"); // dropped as too old
    expect(out).toContain("m24"); // newest retained
    expect(out).toContain("m5"); // window starts here
  });
});

describe("toolResultToText", () => {
  it("prefixes the tool name and joins text parts", () => {
    const out = toolResultToText({
      toolName: "bash",
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
    } as never);
    expect(out).toBe("#### bash\nline1\nline2");
  });

  it("returns empty string when there is no text content", () => {
    const out = toolResultToText({
      toolName: "bash",
      content: [{ type: "image", data: "x" }],
    } as never);
    expect(out).toBe("");
  });
});
