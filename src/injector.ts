// Injector: bimodal memory injection into Pi's system prompt
//
// Strategy:
// 1. Always inject MEMORY.md content (index entries + hand-authored sections)
// 2. Greedily inject full file bodies up to a token cap (default 5000)
// 3. Priority: pinned entries → feedback/user type → most recently modified
// 4. Large files get index-only (model can fetch via recall_memory tool)
// 5. Global tier injected first, then project tier

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parseMemoryFile } from "./frontmatter.js";
import { parseIndexFile, reconcileIndex } from "./index-parser.js";
import type { IndexEntry, IndexLine, MemoryDir, MemoryFile, MemoryType } from "./types.js";

const DEFAULT_TOKEN_CAP = 5000;
const CHARS_PER_TOKEN = 4; // rough estimate
const SMALL_FILE_LINE_THRESHOLD = 60; // files with <= this many lines are candidates for full injection

/** Result of building an injection block for a tier. */
export interface InjectionBlock {
  /** The formatted markdown to append to the system prompt. */
  text: string;
  /** Number of topic files loaded in full. */
  filesLoaded: number;
  /** Estimated token count for this block. */
  tokens: number;
  /** Warnings (missing files, unindexed files, etc.) */
  warnings: string[];
}

/**
 * Build the full memory injection text for both tiers.
 * Returns the combined text to append to event.systemPrompt.
 */
export function buildMemoryInjection(
  project: MemoryDir | null,
  global: MemoryDir | null,
  tokenCap = DEFAULT_TOKEN_CAP,
): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const blocks: string[] = [];

  if (global) {
    const block = buildTierInjection(global, "Global", tokenCap, warnings);
    if (block.text) {
      blocks.push(block.text);
    }
  }

  if (project) {
    const block = buildTierInjection(project, project.label, tokenCap, warnings);
    if (block.text) {
      blocks.push(block.text);
    }
  }

  if (blocks.length === 0) {
    return { text: "", warnings };
  }

  return {
    text: `\n\n## Memory\n\n${blocks.join("\n\n")}`,
    warnings,
  };
}

/** Build injection text for a single tier. */
function buildTierInjection(
  dir: MemoryDir,
  label: string,
  tokenCap: number,
  warnings: string[],
): InjectionBlock {
  const parsed = parseIndexFile(dir);
  if (!parsed) {
    return { text: "", filesLoaded: 0, tokens: 0, warnings };
  }

  // Reconcile index with disk
  const recon = reconcileIndex(parsed, dir.dir);
  if (recon.missing.length > 0) {
    warnings.push(
      `[${label}] ${recon.missing.length} index entries point at missing files: ` +
        recon.missing.map((e) => e.href).join(", "),
    );
  }

  // Load all topic files
  const files = loadTopicFiles(
    dir,
    parsed.entries.map((e) => e.filePath),
  );
  if (recon.unindexed.length > 0) {
    warnings.push(
      `[${label}] ${recon.unindexed.length} files on disk but not in index: ` +
        recon.unindexed.join(", "),
    );
  }

  // Build the index section (always injected — it's cheap and information-dense)
  const indexSection = renderIndexSection(parsed);

  // Build the full-text section (greedy, budget-limited)
  const {
    text: fullTextSection,
    filesLoaded,
    tokens,
  } = buildFullTextSection(files, parsed.entries, tokenCap);

  const parts: string[] = [];
  parts.push(`### Memory (${label})\n`);
  parts.push(
    `The following is your persistent ${label === "Global" ? "global" : "project"} memory, ` +
      "shared with Claude Code. Topic files listed in the index can be read on-demand " +
      "via the `recall_memory` tool.\n",
  );

  if (indexSection) {
    parts.push(`#### Index\n\n${indexSection}`);
  }

  if (fullTextSection) {
    parts.push(`#### Full Text (always loaded)\n\n${fullTextSection}`);
  }

  return {
    text: parts.join("\n"),
    filesLoaded,
    tokens,
    warnings,
  };
}

/** Load topic files from disk, keyed by filePath. */
function loadTopicFiles(_dir: MemoryDir, filePaths: string[]): Map<string, MemoryFile> {
  const files = new Map<string, MemoryFile>();
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue;
    try {
      const filename = basename(filePath);
      // Skip MEMORY.md itself
      if (filename === "MEMORY.md") continue;
      const frontmatter = parseMemoryFile(filePath, filename);
      const content = readFileSync(filePath, "utf8");
      const stats = { size: content.length, mtime: 0, lineCount: content.split("\n").length };
      files.set(filePath, {
        filename,
        filePath,
        frontmatter,
        size: stats.size,
        mtime: getFileMtime(filePath),
        lineCount: stats.lineCount,
      });
    } catch {
      // skip unreadable files
    }
  }
  return files;
}

/** Get file mtime safely. */
function getFileMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Render the MEMORY.md index section (all lines, preserving structure). */
function renderIndexSection(parsed: { lines: (IndexEntry | IndexLine)[] }): string {
  return parsed.lines
    .map((line) => {
      if ("title" in line) {
        // IndexEntry — reconstruct the link line
        const pin = line.pinned ? "⛔ " : "";
        return `- ${pin}[${line.title}](${line.href}) — ${line.summary}`;
      }
      return line.text;
    })
    .join("\n");
}

/**
 * Build the full-text section by greedily injecting file bodies under the token cap.
 * Priority: pinned → feedback/user → most recently modified.
 * Only small files (≤ line threshold) are candidates.
 */
function buildFullTextSection(
  files: Map<string, MemoryFile>,
  entries: IndexEntry[],
  tokenCap: number,
): { text: string; filesLoaded: number; tokens: number } {
  // Build a priority-ordered list of candidate files
  const candidates = prioritizeFiles(files, entries);

  let tokensUsed = 0;
  const parts: string[] = [];
  let filesLoaded = 0;

  for (const file of candidates) {
    if (file.lineCount > SMALL_FILE_LINE_THRESHOLD && !file.frontmatter.pinned) {
      continue; // large files get index-only unless pinned
    }

    const bodyTokens = estimateTokens(file.frontmatter.body);
    if (tokensUsed + bodyTokens > tokenCap) {
      continue; // would exceed budget
    }

    parts.push(formatFileBlock(file));
    tokensUsed += bodyTokens;
    filesLoaded++;
  }

  return {
    text: parts.join("\n\n"),
    filesLoaded,
    tokens: tokensUsed,
  };
}

/** Prioritize files: pinned first, then feedback/user type, then most recently modified. */
function prioritizeFiles(files: Map<string, MemoryFile>, entries: IndexEntry[]): MemoryFile[] {
  // Build a map of filePath → pinned status from index entries
  const pinnedMap = new Map<string, boolean>();
  for (const entry of entries) {
    pinnedMap.set(entry.filePath, entry.pinned);
  }

  return [...files.values()].sort((a, b) => {
    // Pinned entries first
    const aPinned = a.frontmatter.pinned || (pinnedMap.get(a.filePath) ?? false);
    const bPinned = b.frontmatter.pinned || (pinnedMap.get(b.filePath) ?? false);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;

    // Then feedback/user type
    const aPriority = typePriority(a.frontmatter.type);
    const bPriority = typePriority(b.frontmatter.type);
    if (aPriority !== bPriority) return bPriority - aPriority;

    // Then most recently modified
    return b.mtime - a.mtime;
  });
}

/** Priority score: feedback and user types get highest priority. */
function typePriority(type: MemoryType): number {
  switch (type) {
    case "feedback":
      return 3;
    case "user":
      return 2;
    case "project":
      return 1;
    case "reference":
      return 0;
    default:
      return 0;
  }
}

/** Format a single file's body for injection. */
function formatFileBlock(file: MemoryFile): string {
  const header = `**${file.frontmatter.name}**`;
  return `${header}\n\n${file.frontmatter.body.trim()}`;
}

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
