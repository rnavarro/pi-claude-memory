// Tests for auto-learn: JSON candidate parsing and index summary building.
// The LLM call itself is not tested here (requires a live model); the parsing
// and validation logic is the part that matters.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExistingIndexSummary, parseCandidates, snapshotMtimes } from "../src/auto-learn.js";
import { withDebugLogContext } from "../src/debug-log.js";
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

describe("createProjectMemoryDir split-brain notice", () => {
  it("records a candidate-store notice in the debug log (not the TUI) and still creates", () => {
    // An existing store for a *different* cwd sharing the basename "app":
    // the exact store for cwdB does not exist, but a basename glob would
    // match the customer-a store. Mutations resolve exact-only, so creating
    // here shadows those memories — record it for the operator.
    //
    // This is advisory and fires per candidate, so it goes to the debug log
    // rather than the console: a console line would land inside the rendered
    // conversation. See the no-console-ui-noise memory.
    const otherEncoded = `-${encodePath(join(tmpDir, "work", "customer-a", "app")).slice(1)}`;
    const projectsRoot = join(tmpDir, ".claude", "projects");
    mkdirSync(join(projectsRoot, otherEncoded), { recursive: true });
    writeFileSync(join(projectsRoot, otherEncoded, "MEMORY.md"), "# Customer A\n- [x](x.md) — x\n");

    const logDir = join(tmpDir, ".pi", "agent", "pi-claude-memory", "debug");
    const sid = `split-${Date.now()}`;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    let created: MemoryDirType | null = null;
    try {
      created = withDebugLogContext({ enabled: true, cwd: tmpDir, sessionId: sid }, () => {
        const cwdB = join(tmpDir, "work", "customer-b", "app");
        return createProjectMemoryDir(cwdB);
      });
    } finally {
      consoleErr.mockRestore();
    }
    if (!created) throw new Error("expected createProjectMemoryDir to return a dir");

    // The new exact store dir was created (MEMORY.md appears on first write).
    expect(existsSync(created.dir)).toBe(true);

    // No console noise went to the TUI.
    expect(consoleErr).not.toHaveBeenCalled();

    // The notice is recorded in the debug log, naming the sibling store.
    const logFile = join(logDir, `${sid}.ndjson`);
    expect(existsSync(logFile)).toBe(true);
    const logged = readFileSync(logFile, "utf8");
    expect(logged).toContain("split_brain_shadows_existing_store");
    expect(logged).toContain(otherEncoded);
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

describe("buildExistingIndexSummary tier attribution", () => {
  it("marks an entry linked by another tier's index with its OWNING tier", () => {
    // A project index may link to a global topic via an absolute href. The
    // summary must not present that entry as a project slug: the write loop
    // picks its directory from the candidate's tier, so a mis-attributed
    // entry lets the model overwrite an unrelated same-named project file
    // using contents it only ever saw in global.
    const proj = join(tmpDir, "work", "proj");
    const glob = join(tmpDir, ".claude", "memory");
    mkdirSync(proj, { recursive: true });
    mkdirSync(glob, { recursive: true });
    // Global owns shared-slug.md …
    writeFileSync(
      join(glob, "shared-slug.md"),
      "---\ndescription: GLOBAL OWNER\ntype: reference\n---\ng\n",
    );
    // … and the project index links to it cross-tier.
    writeFileSync(
      join(proj, "MEMORY.md"),
      `# P\n- [Shared](/${glob}/shared-slug.md) — global-owned entry\n`,
    );
    const resolved = {
      project: {
        tier: "project" as const,
        dir: proj,
        indexPath: join(proj, "MEMORY.md"),
        label: "project",
      },
      global: {
        tier: "global" as const,
        dir: glob,
        indexPath: join(glob, "MEMORY.md"),
        label: "global",
      },
      warnings: [],
    };
    const summary = buildExistingIndexSummary(resolved as never);
    // The entry is attributed to global, not silently to project.
    expect(summary).toContain("[owner: global]");
  });
});

describe("tier attribution survives a symlinked store root", () => {
  it("still attributes cross-tier entries to the owning tier", () => {
    // entry.filePath is realpath'd by resolveHref, while MemoryDir.dir was
    // built lexically from homedir(). With any store component behind a
    // symlink (a dotfiles-managed ~/.claude), a lexical prefix test fails for
    // EVERY entry and ownerOf silently falls back to the linking tier —
    // reintroducing the misattribution the round-5 fix removed.
    const realGlobal = join(tmpDir, "real-claude", "memory");
    mkdirSync(realGlobal, { recursive: true });
    writeFileSync(
      join(realGlobal, "shared-slug.md"),
      "---\ndescription: GLOBAL OWNER\ntype: reference\n---\ng\n",
    );
    // The store is reached through a symlink, which is how dir would look if
    // ~/.claude itself were a symlink.
    const linkGlobal = join(tmpDir, "link-claude-memory");
    symlinkSync(realGlobal, linkGlobal);

    const proj = join(tmpDir, "work", "proj");
    mkdirSync(proj, { recursive: true });
    // The project index links the CANONICAL path (as resolveHref produces).
    writeFileSync(
      join(proj, "MEMORY.md"),
      `# P\n- [Shared](${join(realGlobal, "shared-slug.md")}) — global-owned entry\n`,
    );

    const resolved = {
      project: {
        tier: "project" as const,
        dir: proj,
        indexPath: join(proj, "MEMORY.md"),
        label: "project",
      },
      global: {
        tier: "global" as const,
        dir: linkGlobal, // lexical path through the symlink
        indexPath: join(linkGlobal, "MEMORY.md"),
        label: "global",
      },
      warnings: [],
    };
    const summary = buildExistingIndexSummary(resolved as never);
    expect(summary).toContain("[owner: global]");
  });
});
