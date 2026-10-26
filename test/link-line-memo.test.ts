// The per-line link-parse memo.
//
// `parseLinkLine` is the one function every index reader and every publish pass
// funnels through, and the fit planner asks about the SAME line several times
// per operation: once for the parked/already-archived split, once for cluster
// sizes over the whole index, once for per-line file/byte/tier, once for the
// archived counts, once for the "was it already archived" set, and once more in
// the writer's replace/append scan. On the live store that was 24,627 parses of
// 2,830 lines for a single publish (measured; the audit's number on a slightly
// smaller index was 24,591).
//
// Three things have to hold, and each has a test here:
//
//   1. mechanism  every DISTINCT line is parsed once per operation, and the
//                 rest of the asks are memo hits. The memo is per operation: a
//                 second operation parses again (no module-level cache to go
//                 stale or grow).
//   2. equivalence the memoized path returns exactly what the pre-change
//                 `parseLinkLine` returns for every line of the real store's
//                 MEMORY.md and for the shapes the store does not happen to
//                 contain right now: malformed lines, trailing whitespace,
//                 duplicates, absolute hrefs, anchors, CRLF, tabs, pins.
//                 `parseLinkLine` is kept as the reference the test compares
//                 against — the memo path delegates to it on a miss, so the
//                 reference is the pre-change implementation itself, not a
//                 re-written copy of it.
//   3. identity   a line is only ever served from the memo when it is the SAME
//                 line. Memo identity is the line text, so a changed line is a
//                 different key; and nothing is shared across operations, so no
//                 caller can hold a parse past a write that changed the line.

import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLinkLineMemo,
  fitIndexToExcerpt,
  isClusterSignpost,
  isPinnedIndexLine,
  linkParseStats,
  type ParsedLinkLine,
  parseLinkLine,
  parseLinkLineCached,
  resetLinkParseStats,
} from "../src/index-parser.js";

/** The operator's real Claude Code store, resolved without $HOME (the test
 *  setup replaces HOME with a temp dir). userInfo() reads the passwd entry. */
const REAL_STORE_ROOT = join(userInfo().homedir, ".claude", "projects");

/** Every real MEMORY.md line on this machine, read-only. The index is the
 *  corpus that matters: it is what a publish actually walks. */
function realIndexLines(): string[] {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = readdirSync(REAL_STORE_ROOT);
  } catch {
    return out;
  }
  for (const project of projects) {
    let content: string;
    try {
      content = readFileSync(join(REAL_STORE_ROOT, project, "memory", "MEMORY.md"), "utf8");
    } catch {
      continue;
    }
    out.push(...content.split("\n"));
  }
  return out;
}

/** Shapes the live store does not necessarily hold today, so the memo is pinned
 *  against the grammar's edges rather than inferred from today's data. */
const EDGE_LINES: string[] = [
  // Ordinary shapes
  "- [Plain](plain.md) — a summary",
  "- [No summary](bare.md)",
  "- [A](a.md) - hyphen instead of an em dash",
  "- [A](a.md) — em dash",
  "- [Spaced title](spaced.md) — summary",
  // Pin markers: `⛔` anywhere in the line, or `[pin]` in the summary
  "- ⛔ [Critical rule](rule.md) — pinned by marker",
  "- [Pin via summary](p.md) — [pin] kept",
  "- ⭐ [Star](s.md) — s",
  "- ⚡ [Fast](f.md) — x",
  // Href spellings the parser explicitly supports
  "- [Absolute](/home/user/.claude/memory/abs.md) — cross-tier",
  "- [Dotted](./dot.md) — ./ spelling",
  "- [Dotted-abs](/home/user/.claude/memory/./norm.md) — normalised",
  "- [Parent](../other/dir.md) — dir/../ spelling",
  "- [Anchor](a.md#section) — fragment",
  "- [Anchor deep](a.md#section-with-dashes) — fragment",
  // Whitespace: must trim exactly as before
  "- [Trail](t.md) — summary with trailing spaces   ",
  "- [Trail no summary](t.md)   ",
  "- [Trail title](t.md) — \ttabbed summary\t",
  "-\t[A](tab.md) — tab after the dash",
  "- [A](a.md) — s\r",
  "   ",
  "",
  // Malformed: every one of these must stay null (or stay whatever it was)
  "- [Unclosed](",
  "- [Unclosed title](u.md",
  "[No dash](nodash.md) — s",
  "- x (notalink.md) — s",
  "- [](empty-title.md) — s",
  "- [Empty href]() — s",
  "- [Nested [brackets] here](nested.md) — s",
  "- [Paren](p(1).md) — s",
  "- [Bad](bad.md) — trailing (paren",
  "## Key Architecture Patterns",
  "prose about ⛔ pins and [pin] markers",
  "- [Duplicate](dup.md) — appears twice",
  "- [Duplicate](dup.md) — appears twice",
  "- [Title](same.md) — first of two spellings",
  "- [Title](same.md) — second, different summary",
  "- [Ünïcode ñ](unicode.md) — accents in the title and the summary",
];

/** The corpus: real index lines (duplicates and all) plus the edge shapes. */
function corpus(): string[] {
  return [...realIndexLines(), ...EDGE_LINES];
}

describe("parseLinkLine memo", () => {
  it("parses each distinct index line once per operation", () => {
    const input = corpus();
    // Signpost lines are stripped before the planner starts, so they are never
    // parsed and are not part of the distinct-line count.
    const distinct = new Set(input.filter((line) => !isClusterSignpost(line))).size;
    expect(input.length).toBeGreaterThan(1000);

    resetLinkParseStats();
    fitIndexToExcerpt(input, { maxLines: 40, recencyAt: () => 1 });
    const stats = linkParseStats();

    expect(stats.parses).toBe(distinct);
    expect(stats.memoHits).toBeGreaterThan(0);
  });

  it("does not carry a memo across operations", () => {
    const input = corpus();
    const distinct = new Set(input.filter((line) => !isClusterSignpost(line))).size;

    // Two planner calls are two operations. If the memo were module-level, the
    // second call would parse nothing — and would be reading lines that a write
    // between the calls could have changed.
    resetLinkParseStats();
    fitIndexToExcerpt(input, { maxLines: 40, recencyAt: () => 1 });
    fitIndexToExcerpt(input, { maxLines: 40, recencyAt: () => 1 });
    expect(linkParseStats().parses).toBe(2 * distinct);
  });

  it("shares a caller's memo across the writer's scan and the fit", () => {
    // The publish path parses every line once to find the target's own line and
    // then hands the same content to the planner. With one memo the fit adds no
    // parses of its own; without one it would double the count.
    const input = corpus().filter((line) => !isClusterSignpost(line));
    const distinct = new Set(input).size;
    const memo = createLinkLineMemo();

    resetLinkParseStats();
    for (const line of input) parseLinkLineCached(line, memo);
    fitIndexToExcerpt(input, { maxLines: 40, recencyAt: () => 1, memo });

    expect(linkParseStats().parses).toBe(distinct);
  });
});

describe("memoized parse equals the pre-change parse", () => {
  // The reference is `parseLinkLine` itself: the memo path delegates to it on a
  // miss, so a difference can only come from the memo (a key collision, a stale
  // answer, a null mistaken for a cache miss), never from a second copy of the
  // grammar that could drift.
  const input = corpus();

  it("agrees on every line of the corpus, cold and warm", () => {
    expect(input.length).toBeGreaterThan(1000);
    const memo = createLinkLineMemo();

    resetLinkParseStats();
    const cold = input.map((line) => parseLinkLineCached(line, memo));
    const afterCold = linkParseStats();
    const warm = input.map((line) => parseLinkLineCached(line, memo));
    const afterWarm = linkParseStats();

    const distinct = new Set(input).size;
    expect(afterCold.parses).toBe(distinct);
    // A warm pass runs the grammar zero times, so the warm comparison below is
    // comparing memo answers, not fresh parses.
    expect(afterWarm.parses).toBe(afterCold.parses);
    expect(afterWarm.memoHits - afterCold.memoHits).toBe(input.length);

    for (let i = 0; i < input.length; i++) {
      const reference = parseLinkLine(input[i] as string);
      expect(cold[i]).toStrictEqual(reference);
      expect(warm[i]).toStrictEqual(reference);
    }
  });

  it("pins the corpus itself: it holds links, prose, pins and malformed lines", () => {
    // Guards the guard: if the corpus ever lost its edge shapes, both sides of
    // the comparison would agree on nothing interesting.
    const parsed = corpus().map((line) => parseLinkLine(line));
    const links = parsed.filter((p): p is ParsedLinkLine => p !== null);
    expect(links.length).toBeGreaterThan(1000);
    expect(parsed.some((p) => p === null)).toBe(true);
    expect(corpus().some((line) => isPinnedIndexLine(line))).toBe(true);
    expect(corpus()).toContain("- [Unclosed](");
    expect(
      corpus().filter((line) => line === "- [Duplicate](dup.md) — appears twice"),
    ).toHaveLength(2);
    // Trailing whitespace is trimmed by the reference, and the memo must keep it
    // that way rather than keying on a normalised line.
    expect(parseLinkLine("- [Trail](t.md) — summary with trailing spaces   ")?.summary).toBe(
      "summary with trailing spaces",
    );
    expect(parseLinkLine("- [Anchor](a.md#section)")?.href).toBe("a.md#section");
    expect(parseLinkLine("- [Absolute](/home/user/.claude/memory/abs.md) — cross-tier")?.href).toBe(
      "/home/user/.claude/memory/abs.md",
    );
  });

  it("treats a changed line as a different key, never a hit", () => {
    const memo = createLinkLineMemo();
    resetLinkParseStats();
    const before = parseLinkLineCached("- [A](a.md) — old summary", memo);
    const after = parseLinkLineCached("- [A](a.md) — new summary", memo);
    const rewroteToProse = parseLinkLineCached("A is no longer a link", memo);

    expect(before?.summary).toBe("old summary");
    expect(after?.summary).toBe("new summary");
    expect(rewroteToProse).toBeNull();
    // Three distinct lines, three parses, no hits: the memo never guesses.
    expect(linkParseStats()).toEqual({ parses: 3, memoHits: 0 });

    // The same line twice is one parse and one hit, including the null answer.
    resetLinkParseStats();
    parseLinkLineCached("A is no longer a link", memo);
    parseLinkLineCached("- [A](a.md) — old summary", memo);
    expect(linkParseStats()).toEqual({ parses: 0, memoHits: 2 });
  });
});
