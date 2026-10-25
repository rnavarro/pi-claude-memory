// The index fit planner: keep the LIVE region of MEMORY.md inside Claude Code's
// startup excerpt by moving the oldest non-pinned link lines below an
// `## Archive` heading.
//
// Bounds are passed explicitly instead of relying on the real 200/25000 pair, so
// a handful of lines exercises the same path a thousand-entry store does.

import { describe, expect, it } from "vitest";
import {
  ARCHIVE_HEADING,
  clusterKey,
  excerptBytes,
  fitIndexToExcerpt,
  fitsExcerpt,
  isClusterSignpost,
  isPinnedIndexLine,
  parseLinkLine,
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
  it("fits a store far past the bound without rescanning per demotion", () => {
    // 4,500 lines is the shape of a store with ~3,000 indexed topics: promote
    // mode pulls every archived link back into `live` and then demotes most of
    // them, which used to cost one full rescan per victim (11.7 s here) instead
    // of a single sort.
    const many: string[] = [];
    for (let i = 0; i < 3000; i++) many.push(link(i));
    many.push(ARCHIVE_HEADING);
    for (let i = 0; i < 1500; i++) many.push(`- [A${i}](a${i}.md) — s${i}`);
    const started = performance.now();
    const result = fitIndexToExcerpt(many, { recencyAt: (file) => 1000 + file.length });
    const elapsed = performance.now() - started;
    expect(result.cannotFit).toBe(false);
    const liveRegion = result.lines.slice(0, result.lines.indexOf(ARCHIVE_HEADING));
    expect(fitsExcerpt(liveRegion)).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });

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

describe("cluster-first, rule-protected demotion", () => {
  const entry = (stem: string) => `- [${stem}](${stem}.md) — about ${stem}`;
  const cluster = (key: string, n: number) =>
    Array.from({ length: n }, (_, i) => entry(`${key}-part${i}`));
  /** Recency from a fixed table: higher is newer; unknown files are oldest. */
  const recencyFrom = (order: string[]) => (file: string) => {
    const at = order.indexOf(file.replace(/\.md$/, ""));
    return at < 0 ? 1 : 1000 + at;
  };
  const stemsOf = (lines: string[]) =>
    lines.flatMap((l) => {
      const m = l.match(/\]\(([^)]+)\.md\)/);
      return m ? [m[1]] : [];
    });

  it("demotes a big cluster before an older lone feedback rule, and signposts it", () => {
    const input = [entry("feedback-old-rule"), ...cluster("hp-78k0", 6), entry("lone-fact"), ""];
    const order = [
      "feedback-old-rule",
      "lone-fact",
      ...stemsOf(input).filter((s) => s.startsWith("hp-")),
    ];
    const fit = fitIndexToExcerpt(input, { maxLines: 4, recencyAt: recencyFrom(order) });
    const live = liveOf(fit.lines);
    expect(stemsOf(live)).toContain("feedback-old-rule");
    expect(stemsOf(live)).toContain("lone-fact");
    const signposts = live.filter(isClusterSignpost);
    expect(signposts).toHaveLength(1);
    expect(signposts[0]).toMatch(
      /^- hp-78k0-\* — \d+ more entries listed below the Archive heading/,
    );
    expect(fit.cannotFit).toBe(false);
  });

  it("never loses or duplicates a link, and the signpost is not an entry", () => {
    const input = [...cluster("hp-78k0", 8), ...links(5), ""];
    const fit = fitIndexToExcerpt(input, { maxLines: 6, recencyAt: () => 0 });
    expect(stemsOf(fit.lines).sort()).toEqual(stemsOf(input).sort());
    for (const line of fit.lines.filter(isClusterSignpost)) {
      expect(parseLinkLine(line)).toBeNull();
    }
  });

  it("a second pass is byte-identical", () => {
    const input = [...cluster("hp-78k0", 8), ...cluster("esp-modbus", 5), ...links(5), ""];
    // Real recency, as the writer always supplies: promotion without a signal
    // is the documented degraded mode and is not expected to be stable.
    const opts = { maxLines: 8, recencyAt: recencyFrom(stemsOf(input)) };
    const once = fitIndexToExcerpt(input, opts);
    const twice = fitIndexToExcerpt(once.lines, opts);
    expect(twice.lines).toEqual(once.lines);
    expect(once.lines.filter(isClusterSignpost).length).toBeGreaterThan(0);
  });

  it("drops a signpost once its cluster has no archived member", () => {
    const input = [...cluster("hp-78k0", 6), ...links(2), ""];
    const recencyAt = recencyFrom(stemsOf(input));
    const fit = fitIndexToExcerpt(input, { maxLines: 4, recencyAt });
    expect(fit.lines.some(isClusterSignpost)).toBe(true);
    // The archived members are removed by hand (remove_memory edits lines).
    const pruned = fit.lines.filter(
      (l) => !/hp-78k0-part/.test(l) || liveOf(fit.lines).includes(l),
    );
    const refit = fitIndexToExcerpt(pruned, { maxLines: 4, recencyAt });
    expect(refit.lines.some(isClusterSignpost)).toBe(false);
  });

  it("folds a new cluster member in on the next overflow and updates the count", () => {
    const input = [...cluster("hp-78k0", 6), ...links(2), ""];
    // The fresh member is the newest write.
    const opts = { maxLines: 5, recencyAt: recencyFrom([...stemsOf(input), "hp-78k0-fresh"]) };
    const first = fitIndexToExcerpt(input, opts);
    const count = (lines: string[]) =>
      Number(lines.find(isClusterSignpost)?.match(/ (\d+) more /)?.[1] ?? 0);
    // The writer inserts a new line just above the Archive heading.
    const at = first.lines.indexOf(ARCHIVE_HEADING);
    const withNew = [...first.lines.slice(0, at), entry("hp-78k0-fresh"), ...first.lines.slice(at)];
    const second = fitIndexToExcerpt(withNew, opts);
    // The cluster absorbs the growth: its OLDEST live member moves out, the
    // fresh one stays, and the signpost count goes up by one.
    expect(liveOf(second.lines).some((l) => l.includes("hp-78k0-fresh.md"))).toBe(true);
    expect(liveOf(second.lines).some((l) => l.includes("hp-78k0-part4.md"))).toBe(false);
    expect(liveOf(second.lines).filter((l) => l.includes("(e"))).toHaveLength(2);
    expect(count(second.lines)).toBe(count(first.lines) + 1);
  });

  it("rules hold back only while they fit within half the byte bound", () => {
    const rules = Array.from({ length: 8 }, (_, i) => entry(`feedback-rule-number-${i}`));
    const fact = entry("plain-fact");
    const input = [...rules, fact, ""];
    // Rules are oldest; the fact is newest.
    const order = [...rules.map((_, i) => `feedback-rule-number-${i}`), "plain-fact"];
    const bound = excerptBytes([...rules.slice(0, 6), fact]);
    const fit = fitIndexToExcerpt(input, { maxBytes: bound, recencyAt: recencyFrom(order) });
    // Rules fill far more than half the bound, so the oldest rules leave and
    // the newer fact stays.
    expect(stemsOf(liveOf(fit.lines))).toContain("plain-fact");
    expect(stemsOf(liveOf(fit.lines))).not.toContain("feedback-rule-number-0");
  });

  it("the isRule callback overrides the slug convention", () => {
    const input = [entry("deploy-rule-a"), ...cluster("hp-78k0", 5), entry("lone-fact"), ""];
    const fit = fitIndexToExcerpt(input, {
      maxLines: 3,
      recencyAt: () => 0,
      isRule: (f) => f === "deploy-rule-a.md",
    });
    expect(stemsOf(liveOf(fit.lines))).toContain("deploy-rule-a");
  });

  it("clusters need clusterMin members", () => {
    expect(clusterKey("hp-78k0-flmd0.md")).toBe("hp-78k0");
    expect(clusterKey("single.md")).toBeNull();
    const fit = fitIndexToExcerpt([...cluster("hp-78k0", 4), ...links(4), ""], {
      maxLines: 6,
      recencyAt: () => 0,
    });
    expect(fit.lines.some(isClusterSignpost)).toBe(false);
  });
});
