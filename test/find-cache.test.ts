// find_memory's per-call cost: a repeat query must not re-read the store.
//
// A search reads, parses and tokenises every topic body on every call, so an
// identical second query cost exactly what the first one did — the largest
// user-visible stall per tool call measured in this extension (2,768 body
// reads, 5,536 lstats, 2,768 stats for the live store, ~195 ms). These tests
// pin the memo that removes it, and they count real syscalls through a wrapping
// mock rather than asserting on a wall clock, so a slower machine cannot make
// them pass or fail.
//
// The three properties that matter, in order:
//   1. a repeat query issues no body reads at all (only the freshness stat);
//   2. a file whose mtime moved is re-read, so no stale body can be served —
//      including a file that grew past the size cap, which must still be
//      refused exactly as before;
//   3. the memo is bounded: a cache built with a small byte budget evicts, and
//      an evicted entry costs a re-read, never a wrong answer.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CachedTopicText, createTopicCache } from "../src/memory-cache.js";
import { encodePath } from "../src/resolver.js";
import { findMemoryTool, writeMemoryTool } from "../src/tools.js";
import { TOPIC_FILE_MAX_BYTES } from "../src/types.js";

/** Syscall log. Wrapping, never stubbing: every counted call still happens. */
const calls = vi.hoisted(() => ({
  enabled: false,
  reads: [] as string[],
  stats: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const record = (list: string[]) => (p: unknown) => {
    if (calls.enabled) list.push(String(p));
  };
  return {
    ...actual,
    readFileSync: (p: Parameters<typeof actual.readFileSync>[0], o?: unknown) => {
      record(calls.reads)(p);
      return (actual.readFileSync as (...args: unknown[]) => unknown)(p, o);
    },
    statSync: (p: Parameters<typeof actual.statSync>[0], o?: unknown) => {
      record(calls.stats)(p);
      return (actual.statSync as (...args: unknown[]) => unknown)(p, o);
    },
    lstatSync: (p: Parameters<typeof actual.lstatSync>[0], o?: unknown) => {
      record(calls.stats)(p);
      return (actual.lstatSync as (...args: unknown[]) => unknown)(p, o);
    },
  };
});

let tmpHome: string;
let origHome: string | undefined;

const makeCtx = (cwd: string) => ({ cwd }) as never;
const textOf = (res: { content: { type: string; text?: string }[] }) =>
  (res.content[0] as { type: string; text: string }).text;

/** Create the project store for a cwd and return its paths. */
function makeStore(cwd: string, index: string, files: Record<string, string> = {}) {
  const dir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), index);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { dir, indexPath: join(dir, "MEMORY.md") };
}

/** Run one search with the syscall log on, returning its text and cost. */
async function measured(cwd: string, query: string) {
  calls.reads = [];
  calls.stats = [];
  calls.enabled = true;
  try {
    const text = textOf(
      await findMemoryTool.execute(
        "t1",
        { query },
        undefined as never,
        undefined as never,
        makeCtx(cwd),
      ),
    );
    return { text, reads: [...calls.reads], stats: [...calls.stats] };
  } finally {
    calls.enabled = false;
  }
}

const isTopicPath = (p: string) => p.endsWith(".md") && !p.endsWith("MEMORY.md");

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "pcm-find-cache-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

const INDEX = [
  "# P",
  "- [Alpha Notes](alpha.md) — alphaword in the summary",
  "- [Beta Notes](beta.md) — betaword in the summary",
  "- [Gamma Notes](gamma.md) — gammaword in the summary",
].join("\n");
const FILES = {
  "alpha.md": "---\nname: alpha\n---\nalphabody one\n",
  "beta.md": "---\nname: beta\n---\nbetabody two\n",
  "gamma.md": "---\nname: gamma\n---\ngammabody three\n",
};

describe("find_memory does not re-read a body it already read", () => {
  it("issues no body reads on an identical repeat query", async () => {
    const cwd = join(tmpHome, "work", "repeat");
    makeStore(cwd, INDEX, FILES);

    const first = await measured(cwd, "betabody");
    expect(first.text).toContain("beta.md");
    // The first query must have read every body: that is what this fix
    // replaces, not something it makes optional.
    expect(first.reads.filter(isTopicPath)).toHaveLength(3);

    const second = await measured(cwd, "betabody");
    expect(second.text).toBe(first.text);
    expect(second.reads.filter(isTopicPath)).toEqual([]);
    // The index is memoised too, so a repeat query re-reads no file at all.
    expect(second.reads).toEqual([]);
  });

  it("costs at most one stat-class syscall per topic on a repeat query", async () => {
    const cwd = join(tmpHome, "work", "stats");
    makeStore(cwd, INDEX, FILES);
    await findMemoryTool.execute(
      "t1",
      { query: "betabody" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );

    const repeat = await measured(cwd, "betabody");
    // Resolution and the freshness check are the same lstat for a plain file,
    // so a repeat query is one syscall per topic — not the previous
    // lstat + stat pair.
    expect(repeat.stats.filter(isTopicPath).length).toBeLessThanOrEqual(3);
  });

  it("re-reads a body whose mtime moved, and returns the new content", async () => {
    const cwd = join(tmpHome, "work", "mtime");
    const store = makeStore(cwd, INDEX, FILES);

    expect((await measured(cwd, "zanzibarbody")).text).toContain("No entries match");
    const warm = await measured(cwd, "betabody");
    expect(warm.text).toContain("beta.md");

    // An external writer (Claude Code, or this process through a path that
    // does not notify the cache) bumps the mtime. Two seconds forward so the
    // assertion cannot depend on this filesystem's mtime resolution.
    const later = new Date(Date.now() + 2000);
    writeFileSync(join(store.dir, "beta.md"), "---\nname: beta\n---\nzanzibarbody now\n");
    utimesSync(join(store.dir, "beta.md"), later, later);

    const after = await measured(cwd, "zanzibarbody");
    expect(after.text).toContain("beta.md");
    expect(after.reads.filter((p) => p.endsWith("beta.md"))).toHaveLength(1);

    // And the stale body is gone, not merely shadowed by the new one.
    const stale = await measured(cwd, "betabody");
    expect(stale.text).not.toMatch(/beta\.md .*body\]/);
  });

  it("still refuses a body that grew past the size cap after being cached", async () => {
    const cwd = join(tmpHome, "work", "oversize-warm");
    const store = makeStore(cwd, INDEX, FILES);

    // Warm the entry with a readable body.
    expect((await measured(cwd, "betabody")).text).toContain("beta.md");

    const huge = `---\nname: beta\n---\n${"secretword ".repeat(TOPIC_FILE_MAX_BYTES / 10)}\n`;
    const later = new Date(Date.now() + 2000);
    writeFileSync(join(store.dir, "beta.md"), huge);
    utimesSync(join(store.dir, "beta.md"), later, later);

    const after = await measured(cwd, "secretword");
    // Refused on size, matched on metadata only — the same user-visible
    // behaviour as before the cache, and no read of the huge file.
    expect(after.text).toContain("could not be read");
    expect(after.reads.filter((p) => p.endsWith("beta.md"))).toEqual([]);
    // The cached body must not be served either.
    expect(after.text).not.toMatch(/beta\.md .*body\]/);
  });

  it("sees a body rewritten by this process's own write_memory", async () => {
    // Claude Code's writes are covered by the mtime test above. This is the
    // other writer: an overwrite that lands within the same millisecond as the
    // query that cached the old body, where mtime alone might not move.
    const cwd = join(tmpHome, "work", "own-write");
    makeStore(cwd, INDEX, FILES);
    expect((await measured(cwd, "betabody")).text).toContain("beta.md");

    await writeMemoryTool.execute(
      "tw",
      {
        name: "beta",
        description: "betaword in the summary",
        type: "reference" as const,
        body: "rewrittenbody text\n",
      },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );

    const after = await measured(cwd, "rewrittenbody");
    expect(after.text).toContain("beta.md");
    expect((await measured(cwd, "betabody")).text).not.toMatch(/beta\.md .*body\]/);
  });

  it("sees an index line appended by another writer", async () => {
    const cwd = join(tmpHome, "work", "index-change");
    const store = makeStore(cwd, INDEX, FILES);
    expect((await measured(cwd, "deltaword")).text).toContain("No entries match");

    const later = new Date(Date.now() + 2000);
    writeFileSync(join(store.dir, "delta.md"), "---\nname: delta\n---\ndeltabody four\n");
    utimesSync(join(store.dir, "delta.md"), later, later);
    writeFileSync(
      store.indexPath,
      `${INDEX}\n- [Delta Notes](delta.md) — deltaword in the summary\n`,
    );
    utimesSync(store.indexPath, later, later);

    expect((await measured(cwd, "deltaword")).text).toContain("delta.md");
  });
});

describe("the topic memo is bounded", () => {
  const text = (body: string): CachedTopicText => ({
    body,
    prepared: {
      lowered: body.toLowerCase(),
      tokens: body.toLowerCase().match(/[a-z0-9]+/g) ?? [],
    },
  });
  const stat = (mtimeMs: number, size: number, ino = 1) => ({ mtimeMs, size, ino });

  it("evicts oldest entries to stay within its byte budget", () => {
    // One entry ("word") estimates at 192 (ENTRY_BYTES) + 2*(4+4) + 15 = 223
    // bytes, so this holds two of the six.
    const cache = createTopicCache({ maxBytes: 500 });
    for (let i = 0; i < 6; i++) cache.set(`/store/t${i}.md`, stat(1000 + i, 4), text("word"), null);

    const retained = [...Array(6).keys()].filter(
      (i) => cache.get(`/store/t${i}.md`, stat(1000 + i, 4)) !== null,
    );
    expect(retained.length).toBeLessThan(6);
    // Whatever survives is the newest set, never an arbitrary hole in the middle.
    expect(retained).toEqual(retained.map((_r, i) => retained[0] + i));
    expect(cache.stats().bytes).toBeLessThanOrEqual(500);
  });

  it("bounds an entry that holds only a frontmatter type", () => {
    // The publish path records types, not bodies. Those entries retain no text,
    // so without the fixed per-entry charge they would sit under the byte budget
    // forever and the "bounded" claim would be about text only.
    const cache = createTopicCache({ maxBytes: 500 });
    for (let i = 0; i < 6; i++) cache.setType(`/store/p${i}.md`, stat(i, 5), "reference");
    expect(cache.stats().entries).toBeLessThan(6);
    expect(cache.stats().bytes).toBeLessThanOrEqual(500);
    // An evicted type is a miss, whose fallback is a real read, not a verdict.
    expect(cache.getType("/store/p0.md", stat(0, 5))).toBeNull();
    expect(cache.getType("/store/p5.md", stat(5, 5))?.type).toBe("reference");
  });

  it("serves an evicted entry on a miss, so results never depend on eviction", () => {
    const cache = createTopicCache({ maxBytes: 250 }); // exactly one 223-byte entry
    cache.set("/store/a.md", stat(1, 2), text("aa"), null);
    cache.set("/store/b.md", stat(2, 2), text("bb"), null);
    expect(cache.get("/store/a.md", stat(1, 2))).toBeNull(); // evicted
    cache.set("/store/a.md", stat(1, 2), text("aa"), null); // repopulated by a re-read
    expect(cache.get("/store/a.md", stat(1, 2))?.body).toBe("aa");
  });

  it("misses when the mtime, the size or the inode changes", () => {
    const cache = createTopicCache();
    cache.set("/store/x.md", stat(10, 5, 7), text("hello"), null);
    expect(cache.get("/store/x.md", stat(10, 5, 7))?.body).toBe("hello");
    expect(cache.get("/store/x.md", stat(11, 5, 7))).toBeNull();
    expect(cache.get("/store/x.md", stat(10, 6, 7))).toBeNull();
    expect(cache.get("/store/x.md", stat(10, 5, 8))).toBeNull();
  });

  it("drops an entry on demand, so a write from this process cannot be served stale", () => {
    const cache = createTopicCache();
    cache.set("/store/y.md", stat(10, 5), text("hello"), null);
    cache.invalidate("/store/y.md");
    expect(cache.get("/store/y.md", stat(10, 5))).toBeNull();
  });

  it("stores a prepared body that is exactly what the rank input would build", () => {
    // The cache exists to hand rankEntries an already-lowercased, already
    // tokenised body. If these ever diverge the search silently changes.
    const cache = createTopicCache();
    const raw = "Mixed CASE: 51820/udp — near-miss, 2 of them.\nSecond line.";
    cache.set("/store/z.md", stat(1, raw.length), text(raw), "reference");
    const got = cache.get("/store/z.md", stat(1, raw.length));
    expect(got?.prepared.lowered).toBe(raw.toLowerCase());
    expect(got?.prepared.tokens).toEqual(raw.toLowerCase().match(/[a-z0-9]+/g));
  });
});
