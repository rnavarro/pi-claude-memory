// Tests for auto-learn: JSON candidate parsing and index summary building.
// The LLM call itself is not tested here (requires a live model); the parsing
// and validation logic is the part that matters.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStemKeys,
  buildExistingIndexSummary,
  parseCandidates,
  snapshotMtimes,
} from "../src/auto-learn.js";
import { writeMemory } from "../src/memory-writer.js";
import { createProjectMemoryDir, encodePath, resolveMemoryDirs } from "../src/resolver.js";
import type { MemoryDir as MemoryDirType, ResolveResult } from "../src/types.js";

let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcm-autolearn-"));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  // Restore HOME exactly: when it was unset originally, it must end unset,
  // not silently re-pointed at the wiped temp dir.
  if (origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
});

describe("buildExistingIndexSummary", () => {
  it("lists the store's own entries", () => {
    // Create a fake claude memory dir
    const claudeDir = join(tmpDir, ".claude", "memory");
    const projectHash = "-home-user-workspace-test";
    const projectDir = join(tmpDir, ".claude", "projects", projectHash, "memory");

    // We can't easily test resolveMemoryDirs with a fake cwd. Instead,
    // build the summary from a hand-built ResolveResult. (With the resolver's
    // lazy homedir this test's process.env.HOME override works; the dir
    // layout here is hand-built rather than resolved.)

    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(claudeDir, "global_entry.md"), "# Global");
    writeFileSync(join(claudeDir, "MEMORY.md"), "# Global Memory\n");
    writeFileSync(join(projectDir, "project_entry.md"), "# Project");
    writeFileSync(join(projectDir, "MEMORY.md"), "# Project Memory\n");

    const resolved: ResolveResult = {
      project: {
        tier: "project",
        dir: projectDir,
        indexPath: join(projectDir, "MEMORY.md"),
        label: "test",
      },
      warnings: [],
    };

    // One store: the header is the store's own label, and only the entries that
    // live in it are listed.
    const summary = buildExistingIndexSummary(resolved);
    expect(summary).toContain("## test");
    expect(summary).toContain("project_entry");
  });

  it("returns nothing when this project has no store", () => {
    const resolved: ResolveResult = {
      project: null,
      warnings: [],
    };

    // Nothing to advertise. This used to emit a section for the global tier.
    const summary = buildExistingIndexSummary(resolved);
    expect(summary).toBe("");
  });

  it("emits slug: description from parsed MEMORY.md entries (not titles)", () => {
    const claudeDir = join(tmpDir, ".claude", "memory");

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "prefer-jq.md"), "---\nname: prefer-jq\n---\nbody");
    writeFileSync(
      join(claudeDir, "MEMORY.md"),
      "# Global Memory Index\n\n- [Prefer jq](prefer-jq.md) — Use jq for JSON processing\n",
    );

    const resolved: ResolveResult = {
      project: {
        tier: "project",
        dir: claudeDir,
        indexPath: join(claudeDir, "MEMORY.md"),
        label: "test",
      },
      warnings: [],
    };

    const summary = buildExistingIndexSummary(resolved);
    // Should contain the slug (stable identifier for supersession) and the
    // description, NOT the display title.
    expect(summary).toContain("prefer-jq:");
    expect(summary).toContain("Use jq for JSON processing");
    expect(summary).not.toContain("Prefer jq");
  });

  it("appends a new entry at the live tail and moves no identity line on a supersede", () => {
    // Prompt-cache stability: the identity block is re-sent on every review, so
    // its order may change only by appending. The writer replaces a superseded
    // entry's MEMORY.md line IN PLACE and splices a new one at the end of the
    // live region (just above `## Archive`), so file order is append-only for
    // both operations. Listing by topic-file mtime instead moved a superseded
    // entry to the tail and broke the prefix at its old slot.
    const dir = join(tmpDir, "store-with-archive");
    mkdirSync(dir, { recursive: true });
    const topics = ["live-one", "live-two", "archived-one", "archived-two"];
    topics.forEach((stem, i) => {
      const file = join(dir, `${stem}.md`);
      writeFileSync(file, `---\nname: ${stem}\n---\nbody`);
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      utimesSync(file, t, t);
    });
    writeFileSync(
      join(dir, "MEMORY.md"),
      [
        "- [Live one](live-one.md) — first live entry",
        "- [Live two](live-two.md) — second live entry",
        "",
        "## Archive",
        "",
        "- [Archived one](archived-one.md) — first archived entry",
        "- [Archived two](archived-two.md) — second archived entry",
        "",
      ].join("\n"),
    );
    const resolved: ResolveResult = {
      project: { tier: "project", dir, indexPath: join(dir, "MEMORY.md"), label: "test" },
      warnings: [],
    };

    const identity = (s: string) => s.split(/^SUMMARIES/m)[0];
    const before = buildExistingIndexSummary(resolved);
    const written = writeMemory(resolved.project as MemoryDirType, {
      name: "brand-new",
      description: "a new entry",
      type: "project",
      body: "body",
      pinned: false,
      allowOverwrite: false,
    });
    expect(written.ok).toBe(true);
    // The writer did put the line mid-file, above the Archive heading.
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(index.indexOf("brand-new.md")).toBeLessThan(index.indexOf("## Archive"));

    const after = buildExistingIndexSummary(resolved);
    const linesBefore = identity(before).split("\n");
    const linesAfter = identity(after).split("\n");
    // Exactly one insertion, at the live tail: every line before it is
    // byte-identical and every line after it keeps its order.
    expect(linesAfter).toEqual([
      ...linesBefore.slice(0, 3),
      "- brand-new",
      ...linesBefore.slice(3),
    ]);

    // A supersede rewrites the description in place, so the identity block must
    // not change at all — this is the operation the reviewer performs most.
    const superseded = writeMemory(resolved.project as MemoryDirType, {
      name: "live-one",
      description: "a rewritten description",
      type: "project",
      body: "new body",
      pinned: false,
      allowOverwrite: true,
    });
    expect(superseded.ok).toBe(true);
    expect(identity(buildExistingIndexSummary(resolved))).toBe(identity(after));
  });
});

describe("buildExistingIndexSummary spends the summary budget on relevance", () => {
  /** 120 entries with ~100-char summaries, oldest first by mtime, so the
   *  6000-char budget describes only the oldest ~60 without a chunk. The last
   *  one is about the topic the chunk discusses. */
  function bigStore(): ResolveResult {
    const dir = join(tmpDir, "store");
    mkdirSync(dir, { recursive: true });
    const lines = ["# Index"];
    const base = Date.now() / 1000 - 10_000;
    for (let i = 0; i < 120; i++) {
      const stem = i === 119 ? "flmd0-hold-low-on-power-cycle" : `filler-${i}`;
      const summary =
        i === 119
          ? `FLMD0 must be held low before a power cycle or the chip boots into the flash loader ${"z".repeat(20)}`
          : `ordinary unrelated fact number ${i} ${"y".repeat(70)}`;
      const file = join(dir, `${stem}.md`);
      writeFileSync(file, `---\nname: ${stem}\n---\nbody`);
      utimesSync(file, base + i, base + i);
      lines.push(`- [${stem}](${stem}.md) — ${summary}`);
    }
    writeFileSync(join(dir, "MEMORY.md"), `${lines.join("\n")}\n`);
    return {
      project: { tier: "project", dir, indexPath: join(dir, "MEMORY.md"), label: "test" },
      warnings: [],
    };
  }

  const describedStems = (summary: string) =>
    summary
      .split("\n")
      .filter((l) => /^- [^:]+: /.test(l))
      .map((l) => l.slice(2, l.indexOf(":")));

  it("without a chunk, the newest entry is a bare slug (oldest first)", () => {
    const summary = buildExistingIndexSummary(bigStore());
    expect(summary).toContain("- flmd0-hold-low-on-power-cycle\n");
    expect(describedStems(summary)).toContain("filler-0");
  });

  it("with a chunk about it, the newest entry is described", () => {
    const summary = buildExistingIndexSummary(
      bigStore(),
      "user: the board will not boot after the power cycle; is FLMD0 still held high?",
    );
    expect(describedStems(summary)).toContain("flmd0-hold-low-on-power-cycle");
    expect(summary).toContain("the ones shown are those most related to this conversation");
  });

  it("relevance changes which entries are described, never the identity block", () => {
    const identity = (s: string) => s.split(/^SUMMARIES/m)[0];
    const plain = buildExistingIndexSummary(bigStore());
    const ranked = buildExistingIndexSummary(bigStore(), "FLMD0 power cycle flash loader");
    // The cacheable prefix is identical under both rankings; only the trailing
    // summaries block differs.
    expect(identity(ranked)).toBe(identity(plain));
    expect(
      identity(ranked)
        .split("\n")
        .filter((l) => l.startsWith("- ")),
    ).toHaveLength(120);
    expect(describedStems(ranked)).not.toEqual(describedStems(plain));
  });

  it("an unmatched chunk falls back to oldest first", () => {
    const store = bigStore();
    const plain = buildExistingIndexSummary(store);
    const unmatched = buildExistingIndexSummary(store, "qqqq wwww");
    expect(describedStems(unmatched)).toEqual(describedStems(plain));
    expect(unmatched).toContain("the ones shown are those most related to this conversation");
    expect(unmatched.split(/^SUMMARIES/m)[0]).toBe(plain.split(/^SUMMARIES/m)[0]);
  });
});

describe("resolveMemoryDirs is exact for reads and mutations alike", () => {
  it("does not adopt a foreign same-basename store; it reports it as an orphan", () => {
    // Simulate cwd /work/customer-b/app whose exact project store does not
    // exist, while another project /work/customer-a/app does. The read path
    // used to glob-adopt the other store by basename suffix and inject a
    // foreign project's memories into this cwd's prompt (encodePath is lossy,
    // '/' → '-', so suffixes collide). Reads and mutations now share one
    // rule: only the exact encoded store resolves; a same-basename store is
    // reported for the user to adopt deliberately.
    const otherDir = join(tmpDir, ".claude", "projects", "-work-customer-a-app");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "MEMORY.md"), "# Customer A\n");

    const cwdB = join(tmpDir, "work", "customer-b", "app");
    const resolved = resolveMemoryDirs(cwdB);
    expect(resolved.project).toBeNull();
    expect(resolved.orphanStores?.length).toBe(1);
    expect(resolved.orphanStores?.[0]).toContain("customer-a");
  });

  it("still resolves an exact match, with nothing to report", () => {
    const cwdA = join(tmpDir, "work", "customer-a", "app");
    const exactDir = join(tmpDir, ".claude", "projects", encodePath(cwdA));
    const memorySub = join(exactDir, "memory");
    mkdirSync(memorySub, { recursive: true });
    writeFileSync(join(memorySub, "MEMORY.md"), "# Customer A\n");
    const got = resolveMemoryDirs(cwdA);
    expect(got.project?.dir).toContain("customer-a");
    expect(got.orphanStores?.length ?? 0).toBe(0);
  });
});

describe("parseCandidates", () => {
  it("parses a clean JSON array", () => {
    const reply = JSON.stringify([
      {
        name: "a",
        description: "desc",
        type: "feedback",
        body: "b",
        tier: "project",
        pinned: false,
      },
    ]);
    const cands = parseCandidates(reply);
    expect(cands).toHaveLength(1);
    expect(cands[0].name).toBe("a");
  });

  it("strips code fences", () => {
    const reply =
      '```json\n[{"name":"x","description":"d","type":"reference","body":"b","pinned":false}]\n```';
    const cands = parseCandidates(reply);
    expect(cands).toHaveLength(1);
    expect(cands[0].name).toBe("x");
  });

  it("rejects a candidate that still names a tier the schema does not accept", () => {
    // The reviewer no longer chooses a store. A candidate carrying "global" is
    // rejected rather than quietly re-homed into the project store: a silent
    // relocation would file a fact somewhere the model did not choose.
    const reply = JSON.stringify([
      { name: "g", description: "d", type: "reference", body: "b", tier: "global", pinned: false },
    ]);
    expect(parseCandidates(reply)).toEqual([]);
  });

  it("tolerates leading prose before the array", () => {
    const reply = "Here are the memories:\n[]";
    const cands = parseCandidates(reply);
    expect(cands).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseCandidates("not json")).toEqual([]);
    expect(parseCandidates("[{invalid")).toEqual([]);
  });

  it("filters out invalid candidate shapes", () => {
    const reply = JSON.stringify([
      {
        name: "good",
        description: "d",
        type: "feedback",
        body: "b",
        tier: "project",
        pinned: false,
      },
      { name: 123, description: "bad-type" },
      {
        name: "bad-tier",
        description: "d",
        type: "feedback",
        body: "b",
        tier: "mars",
        pinned: false,
      },
      {
        name: "no-type",
        description: "d",
        type: "unknown",
        body: "b",
        tier: "project",
        pinned: false,
      },
    ]);
    const cands = parseCandidates(reply);
    expect(cands).toHaveLength(1);
    expect(cands[0].name).toBe("good");
  });

  it("parses overwrite and priority optional fields", () => {
    const reply = JSON.stringify([
      {
        name: "supersede-old",
        description: "Corrected fact",
        type: "feedback",
        body: "new body",
        tier: "project",
        pinned: false,
        overwrite: true,
        priority: 5,
      },
    ]);
    const cands = parseCandidates(reply);
    expect(cands).toHaveLength(1);
    expect(cands[0].overwrite).toBe(true);
    expect(cands[0].priority).toBe(5);
  });

  it("rejects fractional priority (must be integer to match read-side validation)", () => {
    const reply = JSON.stringify([
      {
        name: "bad-prio",
        description: "Fractional priority",
        type: "feedback",
        body: "b",
        tier: "project",
        pinned: false,
        priority: 4.5,
      },
    ]);
    const cands = parseCandidates(reply);
    expect(cands).toEqual([]);
  });

  it("returns empty array for empty array input", () => {
    expect(parseCandidates("[]")).toEqual([]);
  });

  it("returns empty array when no brackets found", () => {
    expect(parseCandidates("nothing here")).toEqual([]);
  });
});

describe("createProjectMemoryDir", () => {
  it("creates a project memory dir for a new cwd", () => {
    const cwd = "/home/user/workspace/brand-new-project";
    const result = createProjectMemoryDir(cwd);
    expect(result).not.toBeNull();
    expect(result?.tier).toBe("project");
    expect(existsSync(result?.dir ?? "")).toBe(true);
    expect(result?.dir).toContain("brand-new-project");
    expect(result?.label).toBe("brand-new-project");
  });

  it("resolveMemoryDirs finds the dir after createProjectMemoryDir", () => {
    const cwd = "/home/user/workspace/another-new-project";
    // Before: resolver returns null project
    let resolved = resolveMemoryDirs(cwd);
    expect(resolved.project).toBeNull();

    // Create the dir
    const created = createProjectMemoryDir(cwd);
    expect(created).not.toBeNull();

    // After: resolver still returns null because MEMORY.md doesn't exist yet.
    // This is expected — the resolver requires MEMORY.md. The write path
    // uses createProjectMemoryDir directly, not the resolver.
    resolved = resolveMemoryDirs(cwd);
    expect(resolved.project).toBeNull(); // no MEMORY.md yet
  });
});

describe("createProjectMemoryDir", () => {
  it("creates the exact store when a same-basename sibling exists, without console noise", () => {
    // The create path used to scan for sibling stores and debug-note that the
    // fresh exact dir would shadow them on fuzzy reads. Reads are exact now,
    // so there is nothing to shadow: resolution already reports the sibling
    // via orphanStores (rendered once per session as the adoption signpost),
    // and the orphan-signpost test above covers that path. Creating remains
    // unconditional, and putting the store in place stays console-silent.
    const otherEncoded = `-${encodePath(join(tmpDir, "work", "customer-a", "app")).slice(1)}`;
    const projectsRoot = join(tmpDir, ".claude", "projects");
    mkdirSync(join(projectsRoot, otherEncoded), { recursive: true });
    writeFileSync(join(projectsRoot, otherEncoded, "MEMORY.md"), "# Customer A\n- [x](x.md) — x\n");

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    let created: MemoryDirType | null = null;
    try {
      created = createProjectMemoryDir(join(tmpDir, "work", "customer-b", "app"));
    } finally {
      consoleErr.mockRestore();
    }
    if (!created) throw new Error("expected createProjectMemoryDir to return a dir");
    expect(existsSync(created.dir)).toBe(true);
    expect(consoleErr).not.toHaveBeenCalled();
  });
});

describe("snapshotMtimes keys", () => {
  it("keys a non-slug-normal stem by BOTH the raw stem and its slug", () => {
    const root = mkdtempSync(join(tmpdir(), "pcm-snap-"));
    writeFileSync(join(root, "Foo Bar.md"), "---\ndescription: d\ntype: project\n---\nbody\n");
    const dir = {
      tier: "project" as const,
      dir: root,
      indexPath: join(root, "MEMORY.md"),
      label: "Project",
    };
    const mtimes = snapshotMtimes([dir]);
    // The summary advertises the raw stem; the overwrite guard looks up the
    // slug. Both must resolve, or supersession of such an entry no-ops.
    expect(mtimes.has("project:Foo Bar")).toBe(true);
    expect(mtimes.has("project:foo-bar")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("reviewer index summary is complete", () => {
  it("lists every entry identity, not just the first fifty", () => {
    // A slice(0, 50) hid the rest of the index from the reviewer permanently on
    // a large store (this machine's cross-project index had 222 entries), and
    // writes append, so anything past the cutoff could never be matched for
    // supersession. Identities are never dropped; only summaries are budgeted.
    const proj = join(tmpDir, "work", "proj");
    mkdirSync(proj, { recursive: true });
    const idx = ["# P"];
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(proj, `e${i}.md`), "---\ndescription: d\ntype: reference\n---\nx\n");
      idx.push(`- [E${i}](e${i}.md) — ${"boilerplate advice repeated here. ".repeat(6)}`);
    }
    writeFileSync(join(proj, "MEMORY.md"), `${idx.join("\n")}\n`);

    const summary = buildExistingIndexSummary({
      project: { tier: "project", dir: proj, indexPath: join(proj, "MEMORY.md"), label: "proj" },
      warnings: [],
    } as never);
    expect(summary).toContain("## proj");
    expect(summary).toContain("e0");
    expect(summary).toContain("e59"); // beyond the old cutoff
  });

  it("does not offer an entry that points outside the store", () => {
    // An index line with an absolute href into another store names a topic this
    // store cannot address by name. Advertising it would invite the reviewer to
    // supersede it, and the write loop would then overwrite an unrelated local
    // file whose stem matches.
    const proj = join(tmpDir, "work", "proj2");
    const other = join(tmpDir, ".claude", "memory");
    mkdirSync(proj, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "shared-slug.md"),
      "---\ndescription: other\ntype: reference\n---\nx\n",
    );
    writeFileSync(join(proj, "local.md"), "---\ndescription: local\ntype: project\n---\nx\n");
    writeFileSync(
      join(proj, "MEMORY.md"),
      `# P\n- [Local](local.md) — local entry\n- [Shared](/${other}/shared-slug.md) — other store\n`,
    );

    const summary = buildExistingIndexSummary({
      project: { tier: "project", dir: proj, indexPath: join(proj, "MEMORY.md"), label: "proj" },
      warnings: [],
    } as never);
    expect(summary).toContain("local");
    expect(summary).not.toContain("shared-slug");
    expect(summary).toContain("point outside this store");
  });
});
describe("snapshotMtimes alias keys never shadow a real stem", () => {
  it("a real stem beats a slug alias in EITHER arrival order", () => {
    // Whether the clobbering order arises depends on readdir order, which on
    // this filesystem puts ASCII-uppercase slug-alikes first — so a directory
    // fixture cannot exercise it. Drive the keying directly instead: the slug
    // alias for "Foo Bar" is "foo-bar", the same key the real stem "foo-bar"
    // owns. Under the old single-pass keying the winner was whoever arrived
    // last, so the real stem's mtime was lost whenever it came first — and the
    // overwrite guard then compared against the other file's mtime and logged
    // skip_stale_overwrite, blaming a concurrent edit that never happened.
    const realFirst = new Map<string, number>();
    applyStemKeys(realFirst, "project", [
      { stem: "foo-bar", mtime: 100 },
      { stem: "Foo Bar", mtime: 200 },
    ]);
    expect(realFirst.get("project:foo-bar")).toBe(100); // the REAL stem's mtime
    expect(realFirst.get("project:Foo Bar")).toBe(200);

    const aliasFirst = new Map<string, number>();
    applyStemKeys(aliasFirst, "project", [
      { stem: "Foo Bar", mtime: 200 },
      { stem: "foo-bar", mtime: 100 },
    ]);
    expect(aliasFirst.get("project:foo-bar")).toBe(100);
    expect(aliasFirst.get("project:Foo Bar")).toBe(200);
  });

  it("still fills a slug alias when no real stem claims that key", () => {
    // The fallback exists so a spaced/uppercase stem is reachable by slug.
    const map = new Map<string, number>();
    applyStemKeys(map, "project", [{ stem: "Foo Bar", mtime: 200 }]);
    expect(map.get("project:Foo Bar")).toBe(200);
    expect(map.get("project:foo-bar")).toBe(200);
  });

  it("keys a real directory into the map", () => {
    const d = join(tmpDir, "store");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "topic.md"), "x");
    writeFileSync(join(d, "MEMORY.md"), "# M\n");
    const map = snapshotMtimes([
      { tier: "project", dir: d, indexPath: join(d, "MEMORY.md"), label: "p" },
    ]);
    expect(map.has("project:topic")).toBe(true);
    expect(map.has("project:MEMORY")).toBe(false); // never the index itself
  });
});

describe("resolution survives an unreadable projects directory", () => {
  it("does not abort the turn when the projects dir cannot be listed", () => {
    // findProjectCandidates runs inside before_agent_start (resolveMemoryDirs is
    // reached from computeInjection), so an unguarded readdirSync throw aborts
    // turn start — the same hazard reconcileIndex guards against in
    // index-parser.ts. existsSync only reports existence, not readability:
    // EACCES, EIO, and ENOTDIR all come out of the readdir itself. A FILE where
    // the projects directory belongs is the portable way to force ENOTDIR.
    const cwd = join(tmpDir, "work", "proj");
    const claude = join(tmpDir, ".claude");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, "projects"), "not a directory\n");

    let resolved: ResolveResult | undefined;
    expect(() => {
      resolved = resolveMemoryDirs(cwd);
    }).not.toThrow();
    expect(resolved?.project).toBeNull();
  });
});
