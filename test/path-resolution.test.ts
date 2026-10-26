// Path resolution cost: one realpath per unique path per operation, and none
// at all for an entry lstat shows is not a symlink.
//
// Every index read and write resolves one path per LINK LINE, and each of those
// resolutions was a realpathSync — an lstat walk per path component, on the main
// thread. A stall profile of a live pi session showed ~240 samples inside
// realpathSync from this extension alone, all of it per-line: a 100-line index
// pointing at one topic cost 100 resolutions of that topic. These tests count
// the real syscalls (node:fs is wrapped, not stubbed, so the numbers are real)
// and pin three separate mechanisms:
//
//   1. memoisation      — a path shared by many lines is resolved once;
//   2. symlink shortcut — a non-symlink leaf is never realpath'd;
//   3. operation scope  — the memo dies with the operation, so a later
//                         operation cannot read a stale resolution.
//
// (3) is a guard, not a speed-up: it passes before the fix too. It exists so
// that a module-level cache — the tempting way to make (1) look even better —
// fails loudly instead of resurrecting a path that changed between operations.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExistingIndexSummary } from "../src/auto-learn.js";
import { lineTargetsFile, parseIndexContent } from "../src/index-parser.js";
import { writeMemory } from "../src/memory-writer.js";
import type { MemoryDir, ResolveResult } from "../src/types.js";

/** Call log for the three syscalls this extension made expensive. */
const calls = vi.hoisted(() => ({
  enabled: false,
  realpath: [] as string[],
  lstat: [] as string[],
  stat: [] as string[],
}));

// Wrap, never stub: every counted call still lands on the real syscall, so a
// test that asserts LESS work cannot pass by making the work disappear.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const record = (list: string[]) => (path: unknown) => {
    if (calls.enabled) list.push(String(path));
  };
  return {
    ...actual,
    realpathSync: (path: Parameters<typeof actual.realpathSync>[0], options?: unknown) => {
      record(calls.realpath)(path);
      return (actual.realpathSync as (...args: unknown[]) => string)(path, options);
    },
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0], options?: unknown) => {
      record(calls.lstat)(path);
      return (actual.lstatSync as (...args: unknown[]) => unknown)(path, options);
    },
    statSync: (path: Parameters<typeof actual.statSync>[0], options?: unknown) => {
      record(calls.stat)(path);
      return (actual.statSync as (...args: unknown[]) => unknown)(path, options);
    },
  };
});

interface Measured<T> {
  result: T;
  realpath: string[];
  lstat: string[];
  stat: string[];
}

/** Run `fn` with the syscall log on, returning it with what it cost. */
function measure<T>(fn: () => T): Measured<T> {
  calls.realpath = [];
  calls.lstat = [];
  calls.stat = [];
  calls.enabled = true;
  try {
    const result = fn();
    return {
      result,
      realpath: [...calls.realpath],
      lstat: [...calls.lstat],
      stat: [...calls.stat],
    };
  } finally {
    calls.enabled = false;
  }
}

const isTopicPath = (p: string) => p.endsWith(".md") && !p.endsWith("MEMORY.md");

let tmpDir: string;
let dir: MemoryDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcm-paths-"));
  dir = {
    tier: "project",
    dir: tmpDir,
    indexPath: join(tmpDir, "MEMORY.md"),
    label: "paths",
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Spellings of one file. The FIRST is deliberately not the literal
 * `(topic.md)` shape the writer's regex fast path matches: with the plain
 * spelling first, `findIndex` short-circuits on line one and the per-line cost
 * this file measures never runs. */
function hrefSpellings(name: string): string[] {
  return [`./${name}.md`, `sub/../${name}.md`, `${tmpDir}/${name}.md`, `././${name}.md`];
}

function seedTopic(name: string, body = "body\n"): string {
  const path = join(tmpDir, `${name}.md`);
  writeFileSync(path, `---\ntype: reference\n---\n${body}`);
  return path;
}

const update = {
  name: "topic",
  description: "an updated fact",
  type: "reference" as const,
  body: "body\n",
  pinned: false,
  allowOverwrite: true,
};

describe("an index write resolves each unique path once", () => {
  it("costs one path resolution for 100 lines that all name the same topic", () => {
    seedTopic("topic");
    const spellings = hrefSpellings("topic");
    const seeded = Array.from(
      { length: 100 },
      (_, i) => `- [Entry ${i}](${spellings[i % spellings.length]}) — summary ${i}`,
    );
    writeFileSync(dir.indexPath, `${seeded.join("\n")}\n`);

    // A NEW topic, so every one of the 100 existing lines is compared against
    // the target and none of them short-circuits as a match. This is the
    // stalled case from the profile: an append to a large index resolved every
    // line's href, one realpath each.
    const cost = measure(() => writeMemory(dir, { ...update, name: "fresh" }));

    expect(cost.result.ok).toBe(true);
    // None of these 100 spellings is a symlink, so none of them earns a
    // realpath. Only the directory holding them is canonicalised, once.
    expect(cost.realpath.filter(isTopicPath)).toEqual([]);
    expect(cost.realpath.length).toBeLessThanOrEqual(2);
    // Behaviour: nothing was mistaken for a match, so the entry is appended and
    // every seeded line survives untouched.
    const after = readFileSync(dir.indexPath, "utf8").split("\n");
    for (const line of seeded) expect(after).toContain(line);
    const parsed = parseIndexContent(readFileSync(dir.indexPath, "utf8"), tmpDir);
    expect(parsed.entries).toHaveLength(101);
    expect(parsed.entries.at(-1)?.href).toBe("fresh.md");
  });

  it("replaces the existing line instead of appending a duplicate", () => {
    seedTopic("topic");
    const spellings = hrefSpellings("topic");
    const seeded = Array.from(
      { length: 100 },
      (_, i) => `- [Entry ${i}](${spellings[i % spellings.length]}) — summary ${i}`,
    );
    writeFileSync(dir.indexPath, `${seeded.join("\n")}\n`);

    const cost = measure(() => writeMemory(dir, update));

    expect(cost.result.ok).toBe(true);
    expect(cost.realpath.filter(isTopicPath)).toEqual([]);
    // The recursive-looking hrefs all name one file, so the first line is the
    // entry being written: it is replaced in place, not duplicated.
    const parsed = parseIndexContent(readFileSync(dir.indexPath, "utf8"), tmpDir);
    expect(parsed.entries).toHaveLength(100);
    expect(parsed.entries[0]?.summary).toBe(update.description);
  });
});

describe("realpath is skipped for a leaf lstat shows is not a symlink", () => {
  it("resolves a plain topic through its directory, and a symlinked one directly", () => {
    const target = seedTopic("topic");
    symlinkSync(target, join(tmpDir, "linked.md"));

    const plain = measure(() => lineTargetsFile("- [A](topic.md) — s", tmpDir, target));
    expect(plain.result).toBe(true);
    expect(plain.realpath.filter(isTopicPath)).toEqual([]);

    const linked = measure(() => lineTargetsFile("- [B](linked.md) — s", tmpDir, target));
    expect(linked.result).toBe(true);
    // A symlink is the one case that needs the kernel to walk the chain.
    expect(linked.realpath.filter((p) => p.endsWith("linked.md"))).toHaveLength(1);
  });

  it("still reports a mismatch when two different files are involved", () => {
    seedTopic("topic");
    seedTopic("other");
    const target = join(tmpDir, "topic.md");

    expect(lineTargetsFile("- [A](other.md) — s", tmpDir, target)).toBe(false);
  });
});

describe("the cache is scoped to one operation", () => {
  it("pays its own resolution per operation instead of sharing one globally", () => {
    seedTopic("topic");
    const spellings = hrefSpellings("topic");
    const content = `${Array.from({ length: 100 }, (_, i) => `- [Entry ${i}](${spellings[i % spellings.length]}) — s`).join("\n")}\n`;

    const first = measure(() => parseIndexContent(content, tmpDir));
    const second = measure(() => parseIndexContent(content, tmpDir));

    for (const cost of [first, second]) {
      expect(cost.realpath.filter(isTopicPath)).toEqual([]);
      // The directory, and only the directory. Two operations, two pays — a
      // module-level memo would show one, and the per-line cost would show 100.
      expect(cost.realpath).toEqual([realpathSync(tmpDir)]);
    }
  });

  it("does not serve a resolution from before the filesystem changed", () => {
    const a = seedTopic("a");
    const b = seedTopic("b");
    symlinkSync(a, join(tmpDir, "linked.md"));
    const content = "- [L](linked.md) — s\n";

    const before = parseIndexContent(content, tmpDir).entries[0]?.filePath;
    unlinkSync(join(tmpDir, "linked.md"));
    symlinkSync(b, join(tmpDir, "linked.md"));
    const after = parseIndexContent(content, tmpDir).entries[0]?.filePath;

    expect(before).toBe(realpathSync(a));
    expect(after).toBe(realpathSync(b));
    expect(after).not.toBe(before);
  });
});

describe("the reviewer's own index read resolves each unique path once", () => {
  it("costs one path resolution per topic, not one per index line", () => {
    const topics = Array.from({ length: 30 }, (_, i) => `topic-${String(i).padStart(2, "0")}`);
    const lines: string[] = [];
    for (const name of topics) {
      seedTopic(name, `body of ${name}\n`);
      // Five spellings of the same file per topic: a hand-edited index really
      // does accumulate these, and every one of them used to be a realpath.
      for (const href of hrefSpellings(name).concat([`${name}.md`])) {
        lines.push(`- [${name}](${href}) — about ${name}`);
      }
    }
    writeFileSync(dir.indexPath, `${lines.join("\n")}\n`);

    const resolved: ResolveResult = { project: dir, warnings: [], orphanStores: [] };
    const cost = measure(() => buildExistingIndexSummary(resolved));

    expect(cost.realpath.filter(isTopicPath)).toEqual([]);
    expect(cost.realpath.length).toBeLessThanOrEqual(2);
    // Behaviour: every one of the 150 lines still names an owned topic, and all
    // 30 identities are advertised.
    const identityBlock = cost.result.split(/^SUMMARIES/m)[0] ?? cost.result;
    for (const name of topics) expect(identityBlock).toContain(`- ${name}\n`);
    expect(identityBlock).not.toContain("point outside this store");
  });
});

describe("the fit planner's recency lookup stats each unique file once", () => {
  it("costs one stat per topic for duplicate lines, and keeps the recency order", () => {
    const topics = Array.from({ length: 70 }, (_, i) => `topic-${String(i).padStart(2, "0")}`);
    const lines: string[] = [];
    const stamp = Date.UTC(2024, 0, 1);
    for (const [i, name] of topics.entries()) {
      const path = seedTopic(name, `body of ${name}\n`);
      // Distinct mtimes so the demotion order is decided by recency, not by
      // position. Oldest first.
      utimesSync(path, new Date(stamp + i * 60_000), new Date(stamp + i * 60_000));
      // Three lines per topic: the index really does hold duplicates, and the
      // planner's ages used to be computed per LINE.
      for (let copy = 0; copy < 3; copy++) {
        lines.push(`- [${name} ${copy}](${name}.md) — about ${name}`);
      }
    }
    writeFileSync(dir.indexPath, `${lines.join("\n")}\n`);

    const cost = measure(() =>
      writeMemory(
        dir,
        { ...update, name: "fresh", description: "fresh" },
        {
          demoteIndexOverflow: true,
        },
      ),
    );

    expect(cost.result.ok).toBe(true);
    // 71 files (70 seeded + the one being written), not 211 lines: each unique
    // path is stat'd exactly once, which is what makes every element distinct.
    const stats = cost.stat.filter(isTopicPath);
    expect(stats.length).toBe(new Set(stats).size);
    expect(stats).toHaveLength(71);
    // Behaviour: the oldest topics are the ones archived.
    const after = readFileSync(dir.indexPath, "utf8").split("\n");
    const marker = after.indexOf("## Archive");
    expect(marker).toBeGreaterThan(-1);
    const archived = after.slice(marker).filter((l) => l.includes("topic-"));
    expect(archived.some((l) => l.includes("topic-00"))).toBe(true);
    expect(archived.some((l) => l.includes("topic-69"))).toBe(false);
  });
});

describe("the writer still creates directories it needs", () => {
  it("writes into a store that does not exist yet", () => {
    const nested = join(tmpDir, "made", "on", "demand");
    mkdirSync(dirname(nested), { recursive: true });
    const freshDir: MemoryDir = {
      tier: "project",
      dir: nested,
      indexPath: join(nested, "MEMORY.md"),
      label: "nested",
    };
    const res = writeMemory(freshDir, { ...update, name: "first" });
    expect(res.ok).toBe(true);
    expect(readFileSync(freshDir.indexPath, "utf8")).toContain("first.md");
  });
});
