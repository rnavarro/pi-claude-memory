// The reviewer's write policy, enforced in code rather than asked of the
// model: a reviewer never pins (and never unpins a supersession target), new
// topics per review are capped, and `supersedes` routes a candidate onto the
// existing entry it replaces.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  type MemoryCandidate,
  parseCandidates,
  snapshotMtimes,
  writeCandidates,
} from "../src/auto-learn.js";
import { writeMemory } from "../src/memory-writer.js";
import type { MemoryDir, ResolveResult } from "../src/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcm-policy-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkStore(): { dir: MemoryDir; resolved: ResolveResult } {
  const root = join(tmpDir, "store");
  mkdirSync(root, { recursive: true });
  const dir: MemoryDir = {
    tier: "project",
    dir: root,
    indexPath: join(root, "MEMORY.md"),
    label: "Project",
  };
  return { dir, resolved: { project: dir, warnings: [] } };
}

const cand = (patch: Partial<MemoryCandidate>): MemoryCandidate => ({
  name: "fact",
  description: "a fact",
  type: "project",
  body: "body",
  ...patch,
});

const indexLine = (dir: MemoryDir, stem: string): string =>
  readFileSync(dir.indexPath, "utf8")
    .split("\n")
    .find((l) => l.includes(`(${stem}.md)`)) ?? "";

describe("a reviewer never pins", () => {
  it("writes a candidate that asks for a pin unpinned, in the topic and the index", () => {
    const { dir, resolved } = mkStore();
    expect(
      writeCandidates(
        [cand({ name: "rule", type: "feedback", pinned: true })],
        resolved,
        new Map(),
        tmpDir,
      ),
    ).toBe(1);
    expect(readFileSync(join(dir.dir, "rule.md"), "utf8")).not.toContain("pinned: true");
    expect(indexLine(dir, "rule")).not.toContain("⛔");
  });

  it("a supersession keeps the pin the target already carries", () => {
    const { dir, resolved } = mkStore();
    const seeded = writeMemory(dir, {
      name: "kept-rule",
      description: "pinned by the user",
      type: "feedback",
      body: "original",
      pinned: true,
      allowOverwrite: false,
    });
    expect(seeded.ok).toBe(true);
    const mtimes = snapshotMtimes([dir]);
    expect(
      writeCandidates(
        [cand({ name: "whatever", supersedes: "kept-rule", type: "feedback", body: "refined" })],
        resolved,
        mtimes,
        tmpDir,
      ),
    ).toBe(1);
    const topic = readFileSync(join(dir.dir, "kept-rule.md"), "utf8");
    expect(topic).toContain("refined");
    expect(topic).toContain("pinned: true");
    expect(indexLine(dir, "kept-rule")).toContain("⛔");
  });

  it("a supersession of an unpinned target does not pin it", () => {
    const { dir, resolved } = mkStore();
    writeCandidates([cand({ name: "plain", body: "v1" })], resolved, new Map(), tmpDir);
    const mtimes = snapshotMtimes([dir]);
    writeCandidates(
      [cand({ name: "plain", supersedes: "plain", pinned: true, body: "v2" })],
      resolved,
      mtimes,
      tmpDir,
    );
    const topic = readFileSync(join(dir.dir, "plain.md"), "utf8");
    expect(topic).toContain("v2");
    expect(topic).not.toContain("pinned: true");
  });
});

describe("supersedes", () => {
  it("routes the candidate onto the existing entry instead of minting a sibling", () => {
    const { dir, resolved } = mkStore();
    writeCandidates([cand({ name: "target", body: "old" })], resolved, new Map(), tmpDir);
    const mtimes = snapshotMtimes([dir]);
    expect(
      writeCandidates(
        [cand({ name: "target-sibling", supersedes: "target", body: "old plus new" })],
        resolved,
        mtimes,
        tmpDir,
      ),
    ).toBe(1);
    expect(readFileSync(join(dir.dir, "target.md"), "utf8")).toContain("old plus new");
    expect(existsSync(join(dir.dir, "target-sibling.md"))).toBe(false);
  });

  it("null and empty supersedes leave a new topic as proposed", () => {
    const { dir, resolved } = mkStore();
    writeCandidates(
      [cand({ name: "fresh-a", supersedes: null }), cand({ name: "fresh-b", supersedes: "  " })],
      resolved,
      new Map(),
      tmpDir,
    );
    expect(existsSync(join(dir.dir, "fresh-a.md"))).toBe(true);
    expect(existsSync(join(dir.dir, "fresh-b.md"))).toBe(true);
  });
});

describe("new topics per review are capped", () => {
  it("keeps the first N new topics (most durable first) and drops the rest", () => {
    const { dir, resolved } = mkStore();
    const names = ["n1", "n2", "n3", "n4", "n5"];
    expect(
      writeCandidates(
        names.map((name) => cand({ name })),
        resolved,
        new Map(),
        tmpDir,
        undefined,
        3,
      ),
    ).toBe(3);
    expect(names.map((n) => existsSync(join(dir.dir, `${n}.md`)))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("supersessions are not counted against the cap", () => {
    const { dir, resolved } = mkStore();
    writeCandidates(
      [cand({ name: "old-a" }), cand({ name: "old-b" })],
      resolved,
      new Map(),
      tmpDir,
    );
    const mtimes = snapshotMtimes([dir]);
    expect(
      writeCandidates(
        [
          cand({ name: "new-1" }),
          cand({ name: "x", supersedes: "old-a", body: "a2" }),
          cand({ name: "new-2" }),
          cand({ name: "y", supersedes: "old-b", body: "b2" }),
        ],
        resolved,
        mtimes,
        tmpDir,
        undefined,
        1,
      ),
    ).toBe(3);
    expect(existsSync(join(dir.dir, "new-1.md"))).toBe(true);
    expect(existsSync(join(dir.dir, "new-2.md"))).toBe(false);
    expect(readFileSync(join(dir.dir, "old-a.md"), "utf8")).toContain("a2");
    expect(readFileSync(join(dir.dir, "old-b.md"), "utf8")).toContain("b2");
  });

  it("a cap of 0 lets a review only refine existing entries", () => {
    const { dir, resolved } = mkStore();
    expect(
      writeCandidates([cand({ name: "nope" })], resolved, new Map(), tmpDir, undefined, 0),
    ).toBe(0);
    expect(existsSync(join(dir.dir, "nope.md"))).toBe(false);
  });
});

describe("candidate schema", () => {
  it("accepts candidates without pinned and with supersedes null or a slug", () => {
    const parsed = parseCandidates(
      JSON.stringify([
        { name: "a", description: "d", type: "project", body: "b", supersedes: null },
        { name: "b", description: "d", type: "project", body: "b", supersedes: "a" },
        { name: "c", description: "d", type: "project", body: "b", pinned: true },
      ]),
    );
    expect(parsed.map((c) => c.name)).toEqual(["a", "b", "c"]);
  });

  it("rejects a non-string supersedes", () => {
    expect(
      parseCandidates(
        JSON.stringify([
          { name: "a", description: "d", type: "project", body: "b", supersedes: 5 },
        ]),
      ),
    ).toEqual([]);
  });

  it("the prompt states the cap and no longer asks for pins", () => {
    const prompt = buildSystemPrompt(2);
    expect(prompt).toContain("At most 2 candidates may have supersedes: null");
    expect(prompt).toContain("MOST DURABLE FIRST");
    expect(prompt).not.toMatch(/^- pinned:/m);
    expect(prompt).not.toMatch(/^- priority:/m);
  });
});
