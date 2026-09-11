// Resolver: cwd → Claude Code memory directories
//
// Claude Code stores project memory at:
//   ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md
// and global memory at:
//   ~/.claude/memory/MEMORY.md
//
// Encoding: replace "/" with "-" in the absolute path.
// e.g. /home/user/workspace/my-app → -home-user-workspace-my-app

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { debugLog } from "./debug-log.js";
import type { MemoryDir, ResolveResult } from "./types.js";

/** Root of Claude Code's per-project memory stores. Computed lazily (not at
 * module load) so tests that override process.env.HOME after importing the
 * resolver see the temp home instead of the real one. */
function claudeProjectsDir(): string {
  return `${homedir()}/.claude/projects`;
}

/** Claude Code's global (cross-project) memory store. Lazily computed — see
 * claudeProjectsDir(). */
function claudeGlobalDir(): string {
  return `${homedir()}/.claude/memory`;
}

/** Encode a path the way Claude Code does: "/" → "-". */
export function encodePath(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(path);
  return abs.replace(/\//g, "-");
}

/** Get the project directory for an encoded cwd. */
function projectDir(encoded: string): string {
  return `${claudeProjectsDir()}/${encoded}`;
}

/**
 * Resolve memory directories for the given working directory.
 *
 * Checks for two layouts:
 * 1. Standard: <project>/memory/MEMORY.md + <project>/memory/*.md
 * 2. Root-level: <project>/MEMORY.md + <project>/memory/*.md (other-project anomaly)
 *
 * If the exact encoded dir doesn't exist, globs for candidates whose basename
 * matches the cwd basename (handles rename split-brain like pool_cover vs pool-cover).
 */
export function resolveMemoryDirs(cwd: string, opts?: { exactOnly?: boolean }): ResolveResult {
  const warnings: string[] = [];
  const absCwd = isAbsolute(cwd) ? cwd : resolve(cwd);
  const encoded = encodePath(absCwd);

  // Resolve project tier
  let project: MemoryDir | null = null;

  // Try exact encoded dir first
  const exactDir = projectDir(encoded);
  if (existsSync(exactDir)) {
    project = resolveProjectMemory(exactDir, absCwd, warnings);
  }

  // If exact match not found, try basename glob (rename split-brain handling).
  // Skipped for mutations (opts.exactOnly) so a write/remove never lands in
  // another project's store via a fuzzy basename match.
  if (!project && !opts?.exactOnly) {
    const cwdBasename = absCwd.split(sep).pop() ?? absCwd;
    if (cwdBasename) {
      const candidates = findProjectCandidates(cwdBasename);
      if (candidates.length === 1) {
        project = resolveProjectMemory(candidates[0], absCwd, warnings);
      } else if (candidates.length > 1) {
        warnings.push(
          `Ambiguous project match: ${candidates.length} dirs for basename "${cwdBasename}". ` +
            `Using most recently modified: ${candidates[0]}`,
        );
        // Sort by mtime desc, already done in findProjectCandidates
        project = resolveProjectMemory(candidates[0], absCwd, warnings);
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
    encoded,
    projectDir: project?.dir ?? null,
    projectLabel: project?.label ?? null,
    globalDir: global?.dir ?? null,
    warningCount: warnings.length,
    warnings,
  });

  return { project, global, warnings };
}

/**
 * Create the project memory directory structure for a cwd that has no existing
 * memory. Creates ~/.claude/projects/<encoded-cwd>/memory/ and returns the
 * resolved MemoryDir. Used by write_memory when the project tier is null.
 */
export function createProjectMemoryDir(cwd: string): MemoryDir | null {
  const absCwd = isAbsolute(cwd) ? cwd : resolve(cwd);
  const encoded = encodePath(absCwd);
  const projectDir = `${claudeProjectsDir()}/${encoded}`;
  const memorySubdir = `${projectDir}/memory`;

  // Split-brain warning: if a basename-matched store already exists (rename
  // split-brain), the fresh exact dir we create will shadow it — resolution
  // prefers the exact dir from now on, making prior memories invisible to
  // reads. Mutations resolve exact-only (they must never land in another
  // project's store), so this write cannot adopt the existing store; note it
  // in the debug log rather than in the TUI.
  const siblings = findProjectCandidates(absCwd.split(sep).pop() ?? absCwd);
  if (siblings.length > 0) {
    // Suffix matching is heuristic: "/home/x/my-<basename>" also ends with
    // "-<basename>", so candidates can be unrelated stores. This is advisory
    // only, and it fires once per candidate while the write loop runs — it
    // belongs in the debug log, not in the middle of the rendered
    // conversation. Set debugLog:true in settings.json to see it.
    //
    // The information is not lost: the resolved store is still created, and
    // the debug entry records every candidate for later inspection.
    debugLog("resolver.split_brain_shadows_existing_store", {
      cwd: absCwd,
      encoded,
      siblings,
      note: `new project store created for ${absCwd}; ${siblings.length} same-basename store(s) exist (${siblings.join(", ")}) — if one is a renamed cwd of this project, rename it to ${encoded} to adopt its memories`,
    });
  }

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
