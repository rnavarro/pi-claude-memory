// Tests for auto-learn: JSON candidate parsing and index summary building.
// The LLM call itself is not tested here (requires a live model); the parsing
// and validation logic is the part that matters.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExistingIndexSummary, parseCandidates } from "../src/auto-learn.js";
import { createProjectMemoryDir, encodePath, resolveMemoryDirs } from "../src/resolver.js";
import type { ResolveResult } from "../src/types.js";

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
  it("lists memory files in the resolved dirs", () => {
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
      global: {
        tier: "global",
        dir: claudeDir,
        indexPath: join(claudeDir, "MEMORY.md"),
        label: "Global",
      },
      project: {
        tier: "project",
        dir: projectDir,
        indexPath: join(projectDir, "MEMORY.md"),
        label: "test",
      },
      warnings: [],
    };

    const summary = buildExistingIndexSummary(resolved);
    expect(summary).toContain("Global tier");
    expect(summary).toContain("global_entry");
    expect(summary).toContain("test tier");
    expect(summary).toContain("project_entry");
  });

  it("handles empty dirs gracefully", () => {
    const claudeDir = join(tmpDir, "empty-global");

    mkdirSync(claudeDir, { recursive: true });

    const resolved: ResolveResult = {
      global: {
        tier: "global",
        dir: claudeDir,
        indexPath: join(claudeDir, "MEMORY.md"),
        label: "Global",
      },
      project: null,
      warnings: [],
    };

    const summary = buildExistingIndexSummary(resolved);
    expect(summary).toContain("(no entries)");
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
      global: {
        tier: "global",
        dir: claudeDir,
        indexPath: join(claudeDir, "MEMORY.md"),
        label: "Global",
      },
      project: null,
      warnings: [],
    };

    const summary = buildExistingIndexSummary(resolved);
    // Should contain the slug (stable identifier for supersession) and the
    // description, NOT the display title.
    expect(summary).toContain("prefer-jq:");
    expect(summary).toContain("Use jq for JSON processing");
    expect(summary).not.toContain("Prefer jq");
  });
});

describe("resolveMemoryDirs exactOnly", () => {
  it("falls back to basename-glob match without exactOnly (read behavior)", () => {
    // Simulate cwd /work/customer-b/app whose exact project store does not
    // exist, while another project /work/customer-a/app does. The fuzzy
    // (read) path still glob-matches the other store by basename — that is
    // pre-existing read behavior.
    const otherDir = join(tmpDir, ".claude", "projects", "-work-customer-a-app");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "MEMORY.md"), "# Customer A\n");

    const cwdB = join(tmpDir, "work", "customer-b", "app");
    const fuzzy = resolveMemoryDirs(cwdB);
    expect(fuzzy.project?.dir).toContain("customer-a");
  });

  it("returns null project with exactOnly:true instead of matching another project", () => {
    const otherDir = join(tmpDir, ".claude", "projects", "-work-customer-a-app");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "MEMORY.md"), "# Customer A\n");

    const cwdB = join(tmpDir, "work", "customer-b", "app");
    const exact = resolveMemoryDirs(cwdB, { exactOnly: true });
    expect(exact.project).toBeNull();
  });

  it("still resolves an exact match with exactOnly:true", () => {
    const cwdA = join(tmpDir, "work", "customer-a", "app");
    const exactDir = join(tmpDir, ".claude", "projects", encodePath(cwdA));
    const memorySub = join(exactDir, "memory");
    mkdirSync(memorySub, { recursive: true });
    writeFileSync(join(memorySub, "MEMORY.md"), "# Customer A\n");
    const got = resolveMemoryDirs(cwdA, { exactOnly: true });
    expect(got.project?.dir).toContain("customer-a");
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
      '```json\n[{"name":"x","description":"d","type":"reference","body":"b","tier":"global","pinned":false}]\n```';
    const cands = parseCandidates(reply);
    expect(cands).toHaveLength(1);
    expect(cands[0].tier).toBe("global");
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

describe("createProjectMemoryDir split-brain warning", () => {
  it("warns loudly (and still creates) when a basename-matched store already exists", () => {
    // An existing store for a *different* cwd sharing the basename "app":
    // the exact store for cwdB does not exist, but a basename glob would
    // match the customer-a store. Mutations resolve exact-only, so creating
    // here shadows those memories — the operator must see that.
    const otherEncoded = `-${encodePath(join(tmpDir, "work", "customer-a", "app")).slice(1)}`;
    const projectsRoot = join(tmpDir, ".claude", "projects");
    mkdirSync(join(projectsRoot, otherEncoded), { recursive: true });
    writeFileSync(join(projectsRoot, otherEncoded, "MEMORY.md"), "# Customer A\n- [x](x.md) — x\n");

    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cwdB = join(tmpDir, "work", "customer-b", "app");
      const created = createProjectMemoryDir(cwdB);
      if (!created) throw new Error("expected createProjectMemoryDir to return a dir");
      // Warning fired: names the shadowed store and the adopt-by-rename hint
      const errCalls = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
      expect(
        errCalls.some((m) => m.includes("NEW project store") && m.includes(otherEncoded)),
      ).toBe(true);
      expect(errCalls.some((m) => m.includes("shadow"))).toBe(true);
      // The new exact store dir was created anyway (writes must succeed;
      // MEMORY.md itself appears on first write).
      expect(existsSync(created.dir)).toBe(true);
    } finally {
      vi.mocked(console.error).mockRestore();
    }
  });
});
