// MEMORY.md parser: link entries + hand-authored sections
//
// Claude Code's MEMORY.md is a mix of:
// - Link entries:  "- [title](file.md) — summary text"
// - Pin markers:   "- ⛔ [title](file.md) — summary"
// - Cross-tier:    "- [title](/home/user/.claude/memory/file.md) — summary"
// - Hand-authored sections: "## Key Architecture Patterns" followed by prose
// - Emoji markers: ⛔, ⭐, ⚡ inline in summaries
//
// The parser preserves all non-link lines as-is for display. Only link entries
// are structured for programmatic use (injection, patching, reconciliation).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { IndexEntry, IndexLine, MemoryDir, ParsedIndex } from "./types.js";

// Match: - [title](href) — summary  (with optional emoji markers like ⛔ before [)
// Also allows the dash to be a regular hyphen with spaces.
const LINK_PATTERN = /^-\s+(?:[^[]+\s+)?\[([^\]]+)\]\(([^)]+)\)\s*[—-]\s*(.+)$/;

/** Parse a MEMORY.md file from disk. */
export function parseIndexFile(dir: MemoryDir): ParsedIndex | null {
  if (!existsSync(dir.indexPath)) return null;
  const content = readFileSync(dir.indexPath, "utf8");
  return parseIndexContent(content, dir.dir);
}

/** Parse MEMORY.md content string (separated for testing). */
export function parseIndexContent(content: string, baseDir: string): ParsedIndex {
  const lines: (IndexEntry | IndexLine)[] = [];
  const entries: IndexEntry[] = [];

  const rawLines = content.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const match = line.match(LINK_PATTERN);

    if (match) {
      const [, title, href, summary] = match;
      const filePath = resolveHref(href, baseDir);
      const pinned = isPinnedLine(line, summary);
      const entry: IndexEntry = {
        title: title.trim(),
        href,
        filePath,
        summary: summary.trim(),
        pinned,
        lineNumber: i + 1,
      };
      lines.push(entry);
      entries.push(entry);
    } else {
      lines.push({ text: line, lineNumber: i + 1 });
    }
  }

  return { lines, entries };
}

/** Resolve a href from MEMORY.md to an absolute file path. */
function resolveHref(href: string, baseDir: string): string {
  // Absolute path (cross-tier reference like /home/user/.claude/memory/file.md)
  if (isAbsolute(href)) {
    return href;
  }

  // Relative to the memory directory
  return resolve(baseDir, href);
}

/** Detect pin markers in a line: ⛔ prefix or [pin] in the title/summary. */
function isPinnedLine(line: string, summary: string): boolean {
  return line.includes("⛔") || summary.includes("[pin]");
}

/**
 * Reconcile index entries with files on disk.
 * Returns entries for files that exist on disk but are not in the index,
 * and flags index entries pointing at missing files.
 */
export interface ReconcileResult {
  /** Files on disk but not in the index. */
  unindexed: string[];
  /** Index entries pointing at files that don't exist. */
  missing: IndexEntry[];
}

/** Compare index entries against actual files on disk. */
export function reconcileIndex(parsed: ParsedIndex, dir: string): ReconcileResult {
  const diskFiles = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md") {
      diskFiles.add(entry.name);
    }
  }

  const indexedFiles = new Set<string>();
  const missing: IndexEntry[] = [];

  for (const entry of parsed.entries) {
    // Extract just the filename from the href (may be relative or absolute)
    const filename = entry.href.split("/").pop() ?? entry.href;
    indexedFiles.add(filename);

    // Check if the file exists
    // For absolute paths (cross-tier), check existence separately
    if (isAbsolute(entry.href)) {
      if (!existsSync(entry.filePath)) {
        missing.push(entry);
      }
    } else {
      if (!diskFiles.has(filename)) {
        missing.push(entry);
      }
    }
  }

  // Files on disk but not in index
  const unindexed = [...diskFiles].filter((f) => !indexedFiles.has(f));

  return { unindexed, missing };
}
