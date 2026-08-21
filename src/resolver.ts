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
import type { MemoryDir, ResolveResult } from "./types.js";

const CLAUDE_PROJECTS_DIR = `${homedir()}/.claude/projects`;
const CLAUDE_GLOBAL_DIR = `${homedir()}/.claude/memory`;

/** Encode a path the way Claude Code does: "/" → "-". */
export function encodePath(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(path);
  return abs.replace(/\//g, "-");
}

/** Get the project directory for an encoded cwd. */
function projectDir(encoded: string): string {
  return `${CLAUDE_PROJECTS_DIR}/${encoded}`;
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
export function resolveMemoryDirs(cwd: string): ResolveResult {
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

  // If exact match not found, try basename glob (rename split-brain handling)
  if (!project) {
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
  if (existsSync(CLAUDE_GLOBAL_DIR)) {
    const globalIndexPath = `${CLAUDE_GLOBAL_DIR}/MEMORY.md`;
    // Return the global dir even if MEMORY.md doesn't exist yet —
    // write_memory needs the dir to create it on first write.
    global = {
      tier: "global",
      dir: CLAUDE_GLOBAL_DIR,
      indexPath: globalIndexPath,
      label: "Global",
    };
  }

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
  const projectDir = `${CLAUDE_PROJECTS_DIR}/${encoded}`;
  const memorySubdir = `${projectDir}/memory`;

  try {
    mkdirSync(memorySubdir, { recursive: true });
    return {
      tier: "project",
      dir: memorySubdir,
      indexPath: `${memorySubdir}/MEMORY.md`,
      label: absCwd.split(sep).pop() ?? absCwd,
    };
  } catch (err) {
    console.error(`[pi-claude-memory] failed to create project memory dir: ${String(err)}`);
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
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const encodedBasename = `-${cwdBasename}`;
  const candidates: { dir: string; mtime: number }[] = [];

  for (const entry of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Match by suffix: encoded dir ends with -<basename>
    if (entry.name.endsWith(encodedBasename)) {
      const dir = `${CLAUDE_PROJECTS_DIR}/${entry.name}`;
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
