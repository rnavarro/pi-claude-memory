// Resolver: cwd → Claude Code memory directories
//
// Claude Code stores project memory at:
//   ~/.claude/projects/<encoded-project-root>/memory/MEMORY.md
// and global memory at:
//   ~/.claude/memory/MEMORY.md
//
// Encoding: replace "/" with "-" in the absolute path.
// e.g. /home/user/workspace/my-app → -home-user-workspace-my-app
//
// The path that gets encoded is not the cwd — it is the project IDENTITY ROOT
// (projectIdentityRoot below). Claude Code keys the store on the repository, so
// every subdirectory and every linked worktree of one repo shares a single
// store. Encoding the raw cwd instead sends a subdir or worktree launch to a
// different, usually empty store, so pi would read and write files Claude Code
// never touches for that project.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { debugLog } from "./debug-log.js";
import type { MemoryDir, ResolveResult } from "./types.js";

/** Claude Code's config tree (~/.claude), which CLAUDE_CONFIG_DIR relocates.
 * Computed lazily (not at module load) so tests that override process.env.HOME
 * after importing the resolver see the temp home instead of the real one. */
function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (override) return isAbsolute(override) ? override : resolve(override);
  return `${homedir()}/.claude`;
}

/** Root of Claude Code's per-project memory stores. */
function claudeProjectsDir(): string {
  return `${claudeConfigDir()}/projects`;
}

/** Claude Code's global (cross-project) memory store. Lazily computed — see
 * claudeConfigDir(). */
function claudeGlobalDir(): string {
  return `${claudeConfigDir()}/memory`;
}

/** Encode a path the way Claude Code does: "/" → "-". */
export function encodePath(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(path);
  return abs.replace(/\//g, "-");
}

/** Device names Claude Code refuses to use as a project directory name. */
const RESERVED_PROJECT_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** The encoded directory name for a project. CLAUDE_CODE_PROJECT_DIR_NAME
 * overrides it, but only when CLAUDE_CONFIG_DIR is set — that pairing is
 * Claude Code's own precondition, so honouring the name alone would invent a
 * store Claude Code never reads. */
function projectDirName(identityRoot: string): string {
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) {
    const raw = process.env.CLAUDE_CODE_PROJECT_DIR_NAME?.trim();
    if (
      raw &&
      /^[A-Za-z0-9_-]{1,64}$/.test(raw) &&
      !RESERVED_PROJECT_NAMES.has(raw.toLowerCase())
    ) {
      return raw;
    }
  }
  return encodePath(identityRoot);
}

/** Get the project directory for an encoded project name. */
function projectDir(encoded: string): string {
  return `${claudeProjectsDir()}/${encoded}`;
}

/**
 * Canonical project-identity root — the directory Claude Code keys a memory
 * store on.
 *
 * Inside a git repository this is the repository root, so every subdirectory
 * and every linked worktree of one repo resolves to the same store. Outside a
 * repository (including when the cwd does not exist) it is the cwd itself.
 */
export function projectIdentityRoot(cwd: string): string {
  const abs = isAbsolute(cwd) ? cwd : resolve(cwd);
  let dir = abs;
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let isDir = true;
      try {
        isDir = statSync(dotGit).isDirectory();
      } catch {
        // Unreadable .git entry: treat it as a repository root rather than
        // walking further up and adopting an unrelated parent repo.
      }
      if (isDir) return dir;
      return resolveLinkedWorktreeRoot(dir, dotGit) ?? dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return abs;
    dir = parent;
  }
}

/**
 * Follow a `.git` file (a linked-worktree or submodule pointer) to the main
 * repository root, or return null to fall back to the directory holding it.
 *
 * Two consistency checks mirror Claude Code's own: the linked gitdir must live
 * under <common>/worktrees/, and its backlink must point at this worktree's
 * .git. Without them a hand-edited or submodule `.git` file could claim an
 * unrelated repository's memory store.
 */
function resolveLinkedWorktreeRoot(worktreeDir: string, dotGitFile: string): string | null {
  try {
    const firstLine = readFileSync(dotGitFile, "utf8").split("\n")[0] ?? "";
    const match = /^gitdir:\s*(.+?)\s*$/.exec(firstLine);
    if (!match) return null;
    const gitdir = resolve(worktreeDir, match[1]);

    const commonRaw = readFileSync(join(gitdir, "commondir"), "utf8").trim();
    if (!commonRaw) return null;
    const common = resolve(gitdir, commonRaw);

    if (!gitdir.startsWith(`${common}/worktrees/`)) return null;

    const backRaw = readFileSync(join(gitdir, "gitdir"), "utf8").trim();
    if (!backRaw) return null;
    if (resolve(gitdir, backRaw) !== resolve(worktreeDir, ".git")) return null;

    return basename(common) === ".git" ? dirname(common) : common;
  } catch {
    return null;
  }
}

/**
 * Resolve memory directories for the given working directory.
 *
 * Checks for two layouts:
 * 1. Standard: <project>/memory/MEMORY.md + <project>/memory/*.md
 * 2. Root-level: <project>/MEMORY.md + <project>/memory/*.md (other-project anomaly)
 *
 * Resolution is EXACT for every operation — reads, writes, and removals all
 * share one rule. The basename-glob fallback that reads used to apply was
 * removed: suffix matching on the encoded name cannot tell "this project at
 * an old path" from "an unrelated project whose basename ends the same way"
 * (encodePath is lossy, '/' → '-', so /x/my-app and /y/control encode
 * to names sharing the -control suffix), and a wrong guess injects another
 * project's memories into this one's prompt. Renames are reported in
 * orphanStores as a signpost for the user to act on instead.
 */
export function resolveMemoryDirs(cwd: string): ResolveResult {
  const warnings: string[] = [];
  const absCwd = isAbsolute(cwd) ? cwd : resolve(cwd);
  const identityRoot = projectIdentityRoot(absCwd);
  const encoded = projectDirName(identityRoot);

  // Resolve project tier
  let project: MemoryDir | null = null;

  // Try exact encoded dir first
  const exactDir = projectDir(encoded);
  if (existsSync(exactDir)) {
    project = resolveProjectMemory(exactDir, absCwd, warnings);
  }

  // No exact store. Same-basename stores become a REPORT, not a match:
  // findProjectCandidates' suffix test cannot distinguish a renamed cwd from
  // an unrelated project (a cwd named "control" matches every store ending
  // "-control"), so adoption must be a deliberate user action.
  let orphanStores: string[] = [];
  if (!project) {
    const cwdBasename = identityRoot.split(sep).pop() ?? identityRoot;
    if (cwdBasename) {
      orphanStores = findProjectCandidates(cwdBasename);
      if (orphanStores.length > 0) {
        warnings.push(
          `No memory store for ${absCwd}, but ${orphanStores.length} same-basename store(s) exist: ` +
            `${orphanStores.join(", ")}. If one is this project at an old path, rename it to ` +
            `${encoded} to adopt its memories.`,
        );
      }
    }
  }

  // Resolve global tier
  let global: MemoryDir | null = null;
  const globalDir = claudeGlobalDir();
  if (existsSync(globalDir)) {
    const globalIndexPath = `${globalDir}/MEMORY.md`;
    // Return the global dir even if MEMORY.md doesn't exist yet —
    // write_memory needs the dir to create it on first write.
    global = {
      tier: "global",
      dir: globalDir,
      indexPath: globalIndexPath,
      label: "Global",
    };
  }

  debugLog("resolver.resolve", {
    cwd: absCwd,
    identityRoot,
    encoded,
    projectDir: project?.dir ?? null,
    projectLabel: project?.label ?? null,
    globalDir: global?.dir ?? null,
    warningCount: warnings.length,
    warnings,
  });

  return { project, global, warnings, orphanStores };
}

/**
 * Create the project memory directory structure for a cwd that has no existing
 * memory. Creates ~/.claude/projects/<encoded-cwd>/memory/ and returns the
 * resolved MemoryDir. Used by write_memory when the project tier is null.
 */
export function createProjectMemoryDir(cwd: string): MemoryDir | null {
  const absCwd = isAbsolute(cwd) ? cwd : resolve(cwd);
  const encoded = projectDirName(projectIdentityRoot(absCwd));
  const projectDir = `${claudeProjectsDir()}/${encoded}`;
  const memorySubdir = `${projectDir}/memory`;

  // No same-basename scan here: resolution is exact everywhere, so there is
  // nothing to "shadow". A same-basename store is already reported by
  // resolveMemoryDirs (orphanStores) before any write, and the injected
  // signpost tells the user how to adopt it.
  try {
    mkdirSync(memorySubdir, { recursive: true });
    debugLog("resolver.create_project_dir", { cwd: absCwd, encoded, memorySubdir });
    return {
      tier: "project",
      dir: memorySubdir,
      indexPath: `${memorySubdir}/MEMORY.md`,
      label: absCwd.split(sep).pop() ?? absCwd,
    };
  } catch (err) {
    const errorMsg = String(err);
    debugLog("resolver.create_project_dir_error", { cwd: absCwd, encoded, error: errorMsg });
    console.error(`[pi-claude-memory] failed to create project memory dir: ${errorMsg}`);
    return null;
  }
}

/** Create the global memory dir on first global write (fresh installations
 * have no ~/.claude/memory). Reads stay side-effect-free — this is called
 * only from write paths when the global tier is null. */
export function createGlobalMemoryDir(): MemoryDir | null {
  const globalDir = claudeGlobalDir();
  try {
    mkdirSync(globalDir, { recursive: true });
    debugLog("resolver.create_global_dir", { globalDir });
    return {
      tier: "global",
      dir: globalDir,
      indexPath: `${globalDir}/MEMORY.md`,
      label: "global",
    };
  } catch (err) {
    const errorMsg = String(err);
    debugLog("resolver.create_global_dir_error", { globalDir, error: errorMsg });
    console.error(`[pi-claude-memory] failed to create global memory dir: ${errorMsg}`);
    return null;
  }
}

/** Check both memory layouts for a project directory. */
function resolveProjectMemory(
  projectDir: string,
  cwd: string,
  warnings: string[],
): MemoryDir | null {
  const memorySubdir = `${projectDir}/memory`;

  // Layout 1: <project>/memory/MEMORY.md (standard)
  const subMemoryPath = `${memorySubdir}/MEMORY.md`;
  if (existsSync(subMemoryPath)) {
    // Verify there's actually a memory dir with files
    if (existsSync(memorySubdir)) {
      return {
        tier: "project",
        dir: memorySubdir,
        indexPath: subMemoryPath,
        label: cwd.split(sep).pop() ?? cwd,
      };
    }
  }

  // Layout 2: <project>/MEMORY.md (root-level, other-project anomaly)
  const rootMemoryPath = `${projectDir}/MEMORY.md`;
  if (existsSync(rootMemoryPath)) {
    // The topic files may still be in a memory/ subdir
    const topicDir = existsSync(memorySubdir) ? memorySubdir : projectDir;
    return {
      tier: "project",
      dir: topicDir,
      indexPath: rootMemoryPath,
      label: cwd.split(sep).pop() ?? cwd,
    };
  }

  // MEMORY.md doesn't exist in either location
  warnings.push(`Project dir ${projectDir} exists but has no MEMORY.md`);
  return null;
}

/**
 * One-line adoption signpost for the injected prompt. Rendered at most once
 * per session (the injection block freezes at session start), naming the
 * stores that look like this project's old paths and the exact rename that
 * would adopt one. Pure so the rendered line is testable; the model may relay
 * it to the user but must not read from or write to those stores.
 */
export function orphanSignpost(cwd: string, orphans: string[]): string {
  const abs = isAbsolute(cwd) ? cwd : resolve(cwd);
  const encoded = projectDirName(projectIdentityRoot(abs));
  return (
    `[pi-claude-memory] No memory store exists for this project yet, but ${orphans.length} ` +
    `store(s) from same-basename paths exist: ${orphans.join(", ")}. If one belongs to this ` +
    `project (renamed or moved), the user can rename it to ${encoded} inside ~/.claude/projects ` +
    `to adopt its memories. Do not read from or write to those stores.`
  );
}

/**
 * Find project dirs whose basename matches the cwd basename.
 * Returns paths sorted by most recently modified first.
 */
function findProjectCandidates(cwdBasename: string): string[] {
  const projectsDir = claudeProjectsDir();
  if (!existsSync(projectsDir)) return [];

  const encodedBasename = `-${cwdBasename}`;
  const candidates: { dir: string; mtime: number }[] = [];

  // A filesystem failure here must never break the turn. This runs inside
  // before_agent_start (resolveMemoryDirs is called from computeInjection), so
  // an unguarded readdirSync throw would abort turn start — the same hazard
  // reconcileIndex guards against in index-parser.ts. The existsSync check above
  // does not cover it: it reports existence, not readability, and EACCES, EIO,
  // and ENOTDIR all come out of the readdir itself.
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Match by suffix: encoded dir ends with -<basename>
    if (entry.name.endsWith(encodedBasename)) {
      const dir = `${projectsDir}/${entry.name}`;
      // Only include if it has a MEMORY.md somewhere
      if (existsSync(`${dir}/memory/MEMORY.md`) || existsSync(`${dir}/MEMORY.md`)) {
        try {
          const s = statSync(dir);
          candidates.push({ dir, mtime: s.mtimeMs });
        } catch {
          // skip unreadable
        }
      }
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.map((c) => c.dir);
}
