// Injector: bimodal memory injection into Pi's system prompt
//
// Strategy:
// 1. Always inject the routing anchor (even when no memory exists yet)
// 2. Always inject MEMORY.md content (index entries + hand-authored sections)
// 3. Greedily inject full file bodies up to a token cap (default 5000)
// 4. Priority: pinned entries → feedback/user type → most recently modified
// 5. Large files get index-only with ⟨index-only⟩ marker (model can fetch via recall_memory)
// 6. Global tier injected first, then project tier

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parseMemoryFile } from "./frontmatter.js";
import { parseIndexFile, reconcileIndex } from "./index-parser.js";
import type { IndexEntry, IndexLine, MemoryDir, MemoryFile, MemoryType } from "./types.js";

const DEFAULT_TOKEN_CAP = 5000;
const CHARS_PER_TOKEN = 4; // rough estimate
const SMALL_FILE_LINE_THRESHOLD = 60; // files with <= this many lines are candidates for full injection

/**
 * Routing anchor — emitted every turn, even when no memory exists yet.
 * Tells the model how to use memory tools and how they coexist with ctx_search.
 * Matches context-mode's terse, directive arrow-syntax.
 */
export const MEMORY_ROUTING_ANCHOR = `pi-claude-memory active. The memory below is already in context — never re-read a loaded entry.
Index entry marked ⟨index-only⟩ → recall_memory(name); unmarked entries are already in full.
User correction, stated preference, or verified fix → write_memory this turn. A background reviewer sweeps the conversation every 10 turns for everything else — don't duplicate it.
Memory that is now wrong → remove_memory (never leave it to rot).
Durable facts across sessions → the index below. What happened in a prior session (errors, commands, prompts) → ctx_search.
Never store ephemeral state, TODOs, or commit hashes.`;

/** Result of building an injection block for a tier. */
export interface InjectionBlock {
  /** The formatted markdown to append to the system prompt. */
  text: string;
  /** Set of file paths loaded in full (for index marker rendering). */
  loadedPaths: Set<string>;
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
 * Always returns the routing anchor even when no memory blocks exist,
 * so the model knows write_memory is available for new projects.
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

  return {
    text: `\n\n## Memory\n\n${MEMORY_ROUTING_ANCHOR}\n\n${blocks.join("\n\n")}`.trimEnd(),
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
    return { text: "", loadedPaths: new Set(), filesLoaded: 0, tokens: 0, warnings };
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

  // Build the full-text section FIRST (greedy, budget-limited) so we know
  // which files are loaded in full — the index renderer marks the rest.
  const {
    text: fullTextSection,
    loadedPaths,
    tokens,
  } = buildFullTextSection(files, parsed.entries, tokenCap);

  // Build the index section (always injected — it's cheap and information-dense)
  // Mark entries whose bodies are NOT loaded with ⟨index-only⟩ so the model
  // knows which entries to recall_memory vs which are already in full text.
  const indexSection = renderIndexSection(parsed, loadedPaths);

  const parts: string[] = [];
  parts.push(`### Memory (${label})\n`);

  if (indexSection) {
    parts.push(`#### Index\n\n${indexSection}`);
  }

  if (fullTextSection) {
    parts.push(`#### Full Text (always loaded)\n\n${fullTextSection}`);
  }

  return {
    text: parts.join("\n"),
    loadedPaths,
    filesLoaded: loadedPaths.size,
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

/** Render the MEMORY.md index section (all lines, preserving structure).
 *  Entries whose bodies are NOT loaded in full are marked ⟨index-only⟩. */
function renderIndexSection(
  parsed: { lines: (IndexEntry | IndexLine)[] },
  loadedPaths: Set<string>,
): string {
  return parsed.lines
    .map((line) => {
      if ("title" in line) {
        // IndexEntry — reconstruct the link line
        const pin = line.pinned ? "⛔ " : "";
        const marker = loadedPaths.has(line.filePath) ? "" : " ⟨index-only⟩";
        return `- ${pin}[${line.title}](${line.href}) — ${line.summary}${marker}`;
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
): { text: string; loadedPaths: Set<string>; filesLoaded: number; tokens: number } {
  // Build a priority-ordered list of candidate files
  const candidates = prioritizeFiles(files, entries);

  let tokensUsed = 0;
  const parts: string[] = [];
  const loadedPaths = new Set<string>();
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
    loadedPaths.add(file.filePath);
  }

  return {
    text: parts.join("\n\n"),
    loadedPaths,
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
