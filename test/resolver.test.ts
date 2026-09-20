// Hermetic tests for the project-identity derivation.
//
// Claude Code keys a memory store on the REPOSITORY, not on the cwd, so a
// launch from a subdirectory or a linked worktree must resolve to the same
// store as a launch from the repository root. These fixtures build the `.git`
// layouts by hand (a `.git` directory for a normal repo, and the `.git` file +
// worktrees/<name>/{commondir,gitdir} trio for a linked worktree) so the tests
// need neither git nor the real memory corpus.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodePath, projectIdentityRoot, resolveMemoryDirs } from "../src/resolver.js";

let tmpDir: string;
let origHome: string | undefined;
let origConfigDir: string | undefined;
let origProjectDirName: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcm-resolver-"));
  origHome = process.env.HOME;
  origConfigDir = process.env.CLAUDE_CONFIG_DIR;
  origProjectDirName = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  process.env.HOME = tmpDir;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  // Restore exactly: a var that was unset originally must end unset, not
  // silently re-pointed at the wiped temp dir.
  for (const [key, value] of [
    ["HOME", origHome],
    ["CLAUDE_CONFIG_DIR", origConfigDir],
    ["CLAUDE_CODE_PROJECT_DIR_NAME", origProjectDirName],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/** Build a normal repository: <root>/.git as a directory. */
function makeRepo(root: string): string {
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

/** Build a linked worktree pointing at `repo`, with a consistent backlink. */
function makeWorktree(repo: string, worktree: string, name = "wt"): void {
  const gitdir = join(repo, ".git", "worktrees", name);
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  writeFileSync(join(gitdir, "gitdir"), `${join(worktree, ".git")}\n`);
}

describe("projectIdentityRoot", () => {
  it("returns the repository root for a subdirectory", () => {
    const repo = makeRepo(join(tmpDir, "repo"));
    const sub = join(repo, "packages", "app");
    mkdirSync(sub, { recursive: true });
    expect(projectIdentityRoot(sub)).toBe(repo);
    expect(projectIdentityRoot(repo)).toBe(repo);
  });

  it("returns the main repository root for a linked worktree", () => {
    const repo = makeRepo(join(tmpDir, "main-repo"));
    const worktree = join(tmpDir, "some-worktree");
    makeWorktree(repo, worktree);
    expect(projectIdentityRoot(worktree)).toBe(repo);
  });

  it("falls back to the worktree dir when the linkage is inconsistent", () => {
    const repo = makeRepo(join(tmpDir, "main-repo"));
    const worktree = join(tmpDir, "odd-worktree");
    makeWorktree(repo, worktree, "odd");
    // Point commondir somewhere the linked gitdir does not live, which is the
    // condition Claude Code rejects rather than following.
    writeFileSync(join(repo, ".git", "worktrees", "odd", "commondir"), "../../elsewhere\n");
    expect(projectIdentityRoot(worktree)).toBe(worktree);
  });

  it("returns the cwd itself outside a repository", () => {
    const plain = join(tmpDir, "plain", "nested");
    mkdirSync(plain, { recursive: true });
    expect(projectIdentityRoot(plain)).toBe(plain);
  });

  it("returns the cwd for a path that does not exist", () => {
    const ghost = join(tmpDir, "does-not-exist");
    expect(projectIdentityRoot(ghost)).toBe(ghost);
  });
});

describe("resolveMemoryDirs project identity", () => {
  it("resolves a subdirectory launch to the repository's store", () => {
    const repo = makeRepo(join(tmpDir, "repo"));
    const sub = join(repo, "packages", "app");
    mkdirSync(sub, { recursive: true });
    const memoryDir = join(tmpDir, ".claude", "projects", encodePath(repo), "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");

    const launchedFromSubdir = resolveMemoryDirs(sub);
    const launchedFromRoot = resolveMemoryDirs(repo);
    expect(launchedFromSubdir.project?.dir).toBe(memoryDir);
    expect(launchedFromRoot.project?.dir).toBe(memoryDir);
  });

  it("resolves a linked worktree launch to the main repository's store", () => {
    const repo = makeRepo(join(tmpDir, "main-repo"));
    const worktree = join(tmpDir, "wt");
    makeWorktree(repo, worktree);
    const memoryDir = join(tmpDir, ".claude", "projects", encodePath(repo), "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");

    expect(resolveMemoryDirs(worktree).project?.dir).toBe(memoryDir);
  });
});

describe("Claude Code config overrides", () => {
  it("honours CLAUDE_CONFIG_DIR for the projects and global roots", () => {
    const cfg = join(tmpDir, "cfg");
    mkdirSync(join(cfg, "memory"), { recursive: true });
    const repo = makeRepo(join(tmpDir, "repo"));
    const memoryDir = join(cfg, "projects", encodePath(repo), "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
    process.env.CLAUDE_CONFIG_DIR = cfg;

    const resolved = resolveMemoryDirs(repo);
    expect(resolved.project?.dir).toBe(memoryDir);
    expect(resolved.global?.dir).toBe(join(cfg, "memory"));
    expect(existsSync(join(tmpDir, ".claude"))).toBe(false);
  });

  it("honours CLAUDE_CODE_PROJECT_DIR_NAME only alongside CLAUDE_CONFIG_DIR", () => {
    const cfg = join(tmpDir, "cfg");
    const named = "my-project";
    const memoryDir = join(cfg, "projects", named, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
    const repo = makeRepo(join(tmpDir, "repo"));

    // Without CLAUDE_CONFIG_DIR the name is ignored, exactly as Claude Code
    // ignores it, and the encoded path is used instead.
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = named;
    expect(resolveMemoryDirs(repo).project).toBeNull();

    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(resolveMemoryDirs(repo).project?.dir).toBe(memoryDir);
  });

  it("rejects names Claude Code would refuse and falls back to the encoded path", () => {
    const cfg = join(tmpDir, "cfg");
    mkdirSync(cfg, { recursive: true });
    const repo = makeRepo(join(tmpDir, "repo"));
    const fallbackDir = join(cfg, "projects", encodePath(repo), "memory");
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(join(fallbackDir, "MEMORY.md"), "# Memory\n");
    process.env.CLAUDE_CONFIG_DIR = cfg;

    for (const bad of ["con", "COM1", "has space", "has/slash", "a".repeat(65)]) {
      process.env.CLAUDE_CODE_PROJECT_DIR_NAME = bad;
      const resolved = resolveMemoryDirs(repo);
      expect(resolved.project?.dir).toBe(fallbackDir);
    }
  });
});
