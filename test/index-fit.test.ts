// The index fit planner: keep the LIVE region of MEMORY.md inside Claude Code's
// startup excerpt by moving the oldest non-pinned link lines below an
// `## Archive` heading.
//
// Bounds are passed explicitly instead of relying on the real 200/25000 pair, so
// a handful of lines exercises the same path a thousand-entry store does.

import { describe, expect, it } from "vitest";
import {
  ARCHIVE_HEADING,
  excerptBytes,
  fitIndexToExcerpt,
  fitsExcerpt,
  isPinnedIndexLine,
} from "../src/index-parser.js";

const link = (n: number) => `- [E${n}](e${n}.md) — s${n}`;
const links = (count: number) => Array.from({ length: count }, (_, i) => link(i + 1));
/** The live region: everything above the heading, minus a trailing separator. */
const liveOf = (lines: string[]) => {
  const marker = lines.indexOf(ARCHIVE_HEADING);
  const live = marker < 0 ? [...lines] : lines.slice(0, marker);
  if (live.at(-1) === "") live.pop();
  return live;
};

describe("fitIndexToExcerpt", () => {
  it("moves the oldest links below the heading until the live region fits", () => {
    const fit = fitIndexToExcerpt([...links(10), ""], { maxLines: 4 });

    expect(fit.cannotFit).toBe(false);
    expect(fit.demoted).toEqual(["e1.md", "e2.md", "e3.md", "e4.md", "e5.md", "e6.md"]);
    const live = liveOf(fit.lines);
    expect(live).toHaveLength(4);
    // The newest entry stays visible; the oldest ones do not.
    expect(live).toContain(link(10));
    expect(live).not.toContain(link(1));
    // Nothing is destroyed: every original line is still in the file.
    for (const line of links(10)) expect(fit.lines).toContain(line);
  });

  it("never moves prose or headings, only link lines", () => {
    const fit = fitIndexToExcerpt(["# Title", "prose one", ...links(6), "prose two", ""], {
      maxLines: 4,
    });

    const live = liveOf(fit.lines);
    expect(live).toContain("# Title");
    expect(live).toContain("prose one");
    expect(live.indexOf("# Title")).toBeLessThan(live.indexOf("prose one"));
    // Nine source lines against a four-line bound: demotion stops as soon as the
    // prose that remains fits, so five links move and the sixth stays visible.
    expect(fit.demoted).toEqual(["e1.md", "e2.md", "e3.md", "e4.md", "e5.md"]);
    expect(live).toHaveLength(4);
  });

  it("never demotes a pinned line, and reports cannotFit instead", () => {
    const pinned = Array.from({ length: 6 }, (_, i) => `- ⛔ [P${i}](p${i}.md) — s`);
    const fit = fitIndexToExcerpt([...pinned, ""], { maxLines: 2 });

    expect(fit.demoted).toEqual([]);
    expect(fit.cannotFit).toBe(true);
    expect(fit.lines).not.toContain(ARCHIVE_HEADING);
  });

  it("demotes unpinned lines while keeping a pinned one visible", () => {
    const pin = "- ⛔ [Pin](pin.md) — keep";
    const fit = fitIndexToExcerpt([pin, link(1), link(2), link(3), ""], { maxLines: 2 });

    expect(liveOf(fit.lines)).toContain(pin);
    expect(fit.demoted).toEqual(["e1.md", "e2.md"]);
    expect(fit.cannotFit).toBe(false);
  });

  it("measures UTF-8 bytes, not characters, when the byte bound binds first", () => {
    // Every line is short in line-count terms, so only the byte bound can force
    // a demotion here.
    const heavy = Array.from({ length: 6 }, (_, i) => `- [H${i}](h${i}.md) — ${"→".repeat(30)}`);
    const fit = fitIndexToExcerpt([...heavy, ""], { maxLines: 200, maxBytes: 300 });

    const live = liveOf(fit.lines);
    expect(live.length).toBeLessThan(6);
    expect(excerptBytes(live)).toBeLessThanOrEqual(300);
    expect(fitsExcerpt(live, 200, 300)).toBe(true);
  });

  it("is idempotent: refitting its own output changes nothing and reports nothing", () => {
    const once = fitIndexToExcerpt([...links(10), ""], { maxLines: 4 });
    const twice = fitIndexToExcerpt(once.lines, { maxLines: 4 });

    expect(twice.demoted).toEqual([]);
    expect(twice.lines).toEqual(once.lines);
  });

  it("reuses an existing heading instead of adding a second one", () => {
    const once = fitIndexToExcerpt([...links(10), ""], { maxLines: 4 });
    const twice = fitIndexToExcerpt(once.lines, { maxLines: 4 });

    expect(twice.lines.filter((l) => l === ARCHIVE_HEADING)).toHaveLength(1);
  });

  it("promotes a newer line that another writer appended below the heading", () => {
    // Claude Code appends at end-of-file, which is below the heading once one
    // exists. Without promotion this entry would be invisible forever: the live
    // region already fits, so nothing would ever reconsider it.
    const first = fitIndexToExcerpt([...links(6), ""], { maxLines: 3 });
    const appendedByCc = [...first.lines.slice(0, first.lines.length - 1), link(99), ""];
    // Recency is what makes this work: e99 is the newest topic, so it outranks
    // every line this planner archived earlier.
    const recency = (name: string) => (name === "e99.md" ? 9000 : Number(name.slice(1, -3)) * 100);

    const second = fitIndexToExcerpt(appendedByCc, { maxLines: 3, recencyAt: recency });

    expect(liveOf(second.lines)).toContain(link(99));
    expect(second.cannotFit).toBe(false);
  });

  it("keeps prose that was authored below the heading below it", () => {
    const fit = fitIndexToExcerpt([...links(6), "", ARCHIVE_HEADING, "hand-written note", ""], {
      maxLines: 3,
    });

    const marker = fit.lines.indexOf(ARCHIVE_HEADING);
    expect(fit.lines.slice(marker)).toContain("hand-written note");
    expect(liveOf(fit.lines)).not.toContain("hand-written note");
  });

  it("preserves the final newline and does not invent a blank line", () => {
    const withNewline = fitIndexToExcerpt(["# P", "- [A](a.md) — a", ""]);
    expect(withNewline.lines.join("\n")).toBe("# P\n- [A](a.md) — a\n");

    const withoutNewline = fitIndexToExcerpt(["# P"]);
    expect(withoutNewline.lines.join("\n")).toBe("# P");
  });

  it("recognises the pin markers the parser recognises", () => {
    expect(isPinnedIndexLine("- ⛔ [A](a.md) — a")).toBe(true);
    expect(isPinnedIndexLine("- [A](a.md) — [pin] a")).toBe(true);
    expect(isPinnedIndexLine("- [A](a.md) — a")).toBe(false);
    // Prose that merely mentions a pin marker is not a pinned entry.
    expect(isPinnedIndexLine("prose about ⛔ pins")).toBe(false);
  });

  it("does not mistake a link whose title contains Archive for the heading", () => {
    const archiveTopic = "- [Archive](archive.md) — the archive topic";
    const fit = fitIndexToExcerpt([archiveTopic, link(1), ""]);

    expect(fit.demoted).toEqual([]);
    expect(fit.lines).toContain(archiveTopic);
  });
});
