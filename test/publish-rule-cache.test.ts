// F7: the publish path's rule check must not re-read a store it already knows.
//
// fitIndexToExcerpt asks `isRule()` once per DISTINCT topic while it plans the
// demotion tiers, and the writer answered every one of those by reading and
// parsing the whole topic file (topicIsRule, src/memory-writer.ts). Three
// consecutive live stall reports put the busiest frame of a 336-456 ms
// event-loop delay inside that chain:
//
//   readFileUtf8 <- readFileSync <- topicIsRule <- isRule <- ruleOf
//     <- clusterOfFile <- fitIndexToExcerpt <- publish
//
// The topic memo in memory-cache.ts already holds parsed topic state keyed on
// (mtime, size, inode) and is invalidated by this process's own writes. These
// tests pin that the rule check is served from it — which turns "one read per
// topic per publish" into "one read per topic per PROCESS, then one stat".
//
// Syscalls are counted through wrapping mocks (every call still happens), so a
// slow machine can make no difference to the result.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { factsOf, topicTextCache } from "../src/memory-cache.js";
import {
  RULE_TYPE_MAX_BYTES,
  topicIsRule,
  topicIsRuleScan,
  writeMemory,
} from "../src/memory-writer.js";
import { createPathCache, type PathCache } from "../src/path-cache.js";
import type { MemoryDir } from "../src/types.js";

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

/** A topic file: the store has one per index line, and the publish path asks
 * about each of them once per write. */
const TOPICS = 8;

let tmpRoot: string;
let dir: MemoryDir;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pcm-f7-"));
  const store = join(tmpRoot, "memory");
  mkdirSync(store, { recursive: true });
  const lines = ["# Store"];
  for (let i = 0; i < TOPICS; i++) {
    const name = `topic-${i}.md`;
    writeFileSync(
      join(store, name),
      `---\nname: topic-${i}\ntype: ${i % 3 === 0 ? "feedback" : "reference"}\n---\nbody ${i}\n`,
    );
    lines.push(`- [Topic ${i}](${name}) — summary ${i}`);
  }
  writeFileSync(join(store, "MEMORY.md"), `${lines.join("\n")}\n`);
  dir = { tier: "project", dir: store, indexPath: join(store, "MEMORY.md"), label: "f7" };
  // One process-wide memo, so a test must not inherit another test's entries.
  topicTextCache.clear();
});

afterEach(() => {
  calls.enabled = false;
  calls.reads = [];
  calls.stats = [];
  topicTextCache.clear();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const isTopicPath = (p: string) => p.endsWith(".md") && !p.endsWith("MEMORY.md");

/** One publish, with the syscall log on. `demoteIndexOverflow` is what turns
 * the rule check on (the fit planner is only consulted when it is set). */
function publish(name: string) {
  calls.reads = [];
  calls.stats = [];
  calls.enabled = true;
  try {
    const res = writeMemory(
      dir,
      {
        name,
        description: `entry ${name}`,
        type: "reference",
        body: `body of ${name}\n`,
        pinned: false,
        allowOverwrite: true,
      },
      { demoteIndexOverflow: true },
    );
    expect(res.ok).toBe(true);
    return { reads: [...calls.reads], stats: [...calls.stats] };
  } finally {
    calls.enabled = false;
  }
}

describe("a publish re-reads no topic it has already classified", () => {
  it("issues no topic reads on a second publish in the same process", () => {
    const first = publish("alpha");
    // The first publish in a process has to read the store: it is the read this
    // fix memoises, not one it makes optional.
    expect(first.reads.filter(isTopicPath)).toHaveLength(TOPICS + 1);

    const second = publish("beta");
    // The only topic a second publish may read is the one it just created: our
    // own write invalidates that entry, and a stale one is not an option. Every
    // topic it already classified is answered from the memo.
    expect(second.reads.filter(isTopicPath)).toEqual([join(dir.dir, "beta.md")]);
    // Which means a publish is stat-class work per topic, not a read per topic.
    expect(second.stats.filter(isTopicPath).length).toBeGreaterThan(0);

    // And the second publish still produced a correct index.
    const index = readFileSync(dir.indexPath, "utf8");
    expect(index).toContain("(alpha.md)");
    expect(index).toContain("(beta.md)");
  });
});

describe("the cached type is as fresh as a read", () => {
  /** Write a topic and return its path. */
  const topic = (name: string, content: string) => {
    const p = join(dir.dir, name);
    writeFileSync(p, content);
    return p;
  };
  /** One call through the publish path's rule check, with its own operation
   * cache (a new publish builds a new PathCache) and the syscall log on. */
  const verdict = (name: string) => {
    calls.reads = [];
    calls.stats = [];
    calls.enabled = true;
    try {
      const cache: PathCache = createPathCache();
      return { rule: topicIsRule(dir, name, cache), reads: [...calls.reads] };
    } finally {
      calls.enabled = false;
    }
  };

  it("re-reads and reclassifies when the type changed on disk", () => {
    topic("note.md", "---\ntype: feedback\n---\nbody\n");
    expect(verdict("note.md").rule).toBe(true);
    expect(verdict("note.md").rule).toBe(true); // memoised, no read

    // Claude Code, or this process through a path that did not invalidate,
    // rewrites it. Two seconds forward so the assertion cannot depend on this
    // filesystem's mtime resolution.
    writeFileSync(join(dir.dir, "note.md"), "---\ntype: reference\n---\nbody\n");
    const later = new Date(Date.now() + 2000);
    utimesSync(join(dir.dir, "note.md"), later, later);

    const after = verdict("note.md");
    expect(after.rule).toBe(false);
    expect(after.reads).toEqual([join(dir.dir, "note.md")]);
  });

  it("sees a same-size, same-mtime replacement, because the inode moved", () => {
    const p = topic("note.md", "---\ntype: feedback\n---\nbody_\n");
    // A pinned mtime, so utimes' millisecond truncation applies to both files
    // identically and the replacement really is mtime-identical.
    const pinned = new Date(Date.now() - 5000);
    utimesSync(p, pinned, pinned);
    expect(verdict("note.md").rule).toBe(true);
    const before = lstatSync(p);

    // An atomic rename over the topic: identical size, identical mtime, new
    // inode. Only the inode can reveal this, which is why the memo keys on it.
    const tmp = join(dir.dir, "note.tmp.md");
    writeFileSync(tmp, "---\ntype: reference\n---\nbody\n");
    utimesSync(tmp, pinned, pinned);
    renameSync(tmp, p);
    const after = lstatSync(p);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);

    expect(verdict("note.md").rule).toBe(false);
  });

  it("does not serve a file the size guard refuses", () => {
    const p = topic("note.md", "---\ntype: feedback\n---\nbody\n");
    expect(verdict("note.md").rule).toBe(true);
    // Past the cap the rule check refuses to read the file at all, so its
    // verdict is the slug convention — and it must NOT be the type that is
    // still sitting in the memo for this path.
    writeFileSync(p, `---\ntype: feedback\n---\n${"x".repeat(RULE_TYPE_MAX_BYTES)}\n`);
    const later = new Date(Date.now() + 2000);
    utimesSync(p, later, later);

    const after = verdict("note.md");
    expect(after.rule).toBe(false); // plain name, no rule slug, refused on size
    expect(after.reads).toEqual([]);
    // And nothing was recorded for the refused version.
    expect(topicTextCache.getType(p, factsOf(lstatSync(p)))).toBeNull();
  });
});

describe("the cached path answers exactly what the read path answers", () => {
  /** Both paths for one filename, with the memo cleared first so the cached
   * path is genuinely cold, then asked again for the warm answer. */
  function both(name: string) {
    const cache: PathCache = createPathCache();
    topicTextCache.clear();
    const cold = topicIsRule(dir, name, cache);
    const warm = topicIsRule(dir, name, cache);
    const scanned = topicIsRuleScan(dir, name, createPathCache());
    return { cold, warm, scanned };
  }

  const CASES: { why: string; name: string; content?: string; make?: () => void }[] = [
    { why: "no frontmatter", name: "plain-note.md", content: "# Just a note\n" },
    {
      why: "no frontmatter on a rule slug",
      name: "feedback-no-frontmatter.md",
      content: "body only\n",
    },
    { why: "flat feedback type", name: "flat-rule.md", content: "---\ntype: feedback\n---\nb\n" },
    { why: "flat user type", name: "user-flat.md", content: "---\ntype: user\n---\nb\n" },
    {
      why: "nested metadata type",
      name: "nested-rule.md",
      content: "---\nname: n\nmetadata:\n  node_type: memory\n  type: user\n---\nb\n",
    },
    {
      why: "nested non-rule type",
      name: "nested-plain.md",
      content: "---\nmetadata:\n  type: reference\n---\nb\n",
    },
    { why: "project type", name: "proj.md", content: "---\ntype: project\n---\nb\n" },
    {
      why: "rule slug with a non-rule type (the type wins)",
      name: "feedback-but-reference.md",
      content: "---\ntype: reference\n---\nb\n",
    },
    {
      why: "rule slug with an unrecognised type",
      name: "feedback-unknown-type.md",
      content: "---\ntype: memo\n---\nb\n",
    },
    {
      why: "misplaced type (a list, not a string)",
      name: "misplaced.md",
      content: "---\ntype:\n  - feedback\nmetadata: not-a-mapping\n---\nb\n",
    },
    {
      why: "type in the body, not the frontmatter",
      name: "body-type.md",
      content: "# t\n\ntype: feedback\n",
    },
    { why: "empty file", name: "empty.md", content: "" },
    {
      why: "unicode content",
      name: "unicode.md",
      content: "---\nname: ünïcode\ntype: user\n---\nnaïve — ok\n",
    },
    { why: "unicode filename, no frontmatter", name: "ünïcode-α.md", content: "naïve\n" },
    { why: "frontmatter only", name: "fm-only.md", content: "---\ntype: feedback\n---\n" },
    {
      why: "CRLF frontmatter",
      name: "crlf.md",
      content: "---\r\ntype: user\r\n---\r\nbody\r\n",
    },
    {
      why: "padded type value",
      name: "padded.md",
      content: '---\ntype: " feedback "\n---\nb\n',
    },
    {
      why: "two frontmatter blocks (the first wins)",
      name: "twoblocks.md",
      content: "---\ntype: reference\n---\n---\ntype: feedback\n---\nb\n",
    },
    { why: "empty type value", name: "empty-type.md", content: "---\ntype:\n---\nb\n" },
    {
      why: "uppercase rule slug",
      name: "FEEDBACK-upper.md",
      content: "---\nname: u\n---\nb\n",
    },
    { why: "underscore rule slug", name: "feedback_underscore.md", content: "no fm\n" },
    { why: "missing file", name: "missing.md" },
    {
      why: "oversize file",
      name: "oversize.md",
      content: `---\ntype: feedback\n---\n${"y".repeat(RULE_TYPE_MAX_BYTES)}\n`,
    },
    {
      why: "directory named like a topic",
      name: "dir.md",
      make: () => mkdirSync(join(dir.dir, "dir.md")),
    },
    {
      why: "symlink to a rule inside the store",
      name: "link-to-rule.md",
      make: () => symlinkSync(join(dir.dir, "flat-rule.md"), join(dir.dir, "link-to-rule.md")),
    },
    {
      why: "symlink pointing outside the store",
      name: "link-out.md",
      make: () => {
        const outside = join(tmpRoot, "outside.md");
        writeFileSync(outside, "---\ntype: feedback\n---\nsecret\n");
        symlinkSync(outside, join(dir.dir, "link-out.md"));
      },
    },
    {
      why: "unreadable file",
      name: "unreadable.md",
      make: () => {
        writeFileSync(join(dir.dir, "unreadable.md"), "---\ntype: feedback\n---\nb\n", {
          mode: 0o000,
        });
      },
    },
  ];

  it("matches the scan for every synthetic shape", () => {
    for (const c of CASES) {
      if (c.content !== undefined) writeFileSync(join(dir.dir, c.name), c.content);
      c.make?.();
    }
    // A file opened by a root process ignores its mode, so the unreadable case
    // is only a real EACCES for a non-root reader.
    const unreadableIsReadable = process.getuid?.() === 0;

    const mismatches: string[] = [];
    for (const c of CASES) {
      if (c.name === "unreadable.md" && unreadableIsReadable) continue;
      const { cold, warm, scanned } = both(c.name);
      if (cold !== scanned || warm !== scanned) {
        mismatches.push(`${c.name} (${c.why}): scanned=${scanned} cold=${cold} warm=${warm}`);
      }
    }
    expect(mismatches).toEqual([]);
    // Guard against a corpus that silently stopped testing anything.
    expect(CASES.length).toBeGreaterThan(20);
  });

  it("matches the scan for every topic of a real store", () => {
    // The store is not part of the repo. Set PCM_EQUIV_STORE to any store
    // directory (a copy of a live one is the point), or let it default to this
    // machine's live store, which is read-only here. Skipped when neither
    // exists, so the suite stays hermetic elsewhere.
    const store =
      process.env.PCM_EQUIV_STORE ??
      join(homedir(), ".claude", "projects", "-home-rnavarro-workspace-pi", "memory");
    if (!existsSync(store)) {
      console.warn("[f7] no equivalence store; set PCM_EQUIV_STORE to run this");
      return;
    }
    const real: MemoryDir = {
      tier: "project",
      dir: store,
      indexPath: join(store, "MEMORY.md"),
      label: "real",
    };
    const names = readdirSync(store).filter((n) => n.endsWith(".md") && n !== "MEMORY.md");
    expect(names.length).toBeGreaterThan(0);

    const mismatches: string[] = [];
    let unstable = 0;
    for (const name of names) {
      const cache: PathCache = createPathCache();
      topicTextCache.clear();
      const cold = topicIsRule(real, name, cache);
      const warm = topicIsRule(real, name, cache);
      const scanned = topicIsRuleScan(real, name, createPathCache());
      if (cold !== scanned || warm !== scanned) {
        // A live session may be rewriting this file as the test reads it. Ask
        // the reference again: if the two reads of the FILE disagree, the file
        // moved under us and the entry is not evidence either way.
        const again = topicIsRuleScan(real, name, createPathCache());
        if (again !== scanned) {
          unstable++;
          continue;
        }
        mismatches.push(`${name}: scanned=${scanned} cold=${cold} warm=${warm}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(unstable).toBeLessThan(names.length / 100);
    // Printed so a run records how much real input the equivalence covered.
    console.warn(
      `[f7] equivalence over ${names.length} real topics in ${store} (${unstable} unstable)`,
    );
  });
});
