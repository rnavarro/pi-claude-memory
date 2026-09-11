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

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { IndexEntry, IndexLine, MemoryDir, ParsedIndex } from "./types.js";

// Match: - [title](href) — summary  (with optional emoji markers like ⛔ before [)
// Also allows the dash to be a regular hyphen with spaces.
const LINK_PATTERN = /^-\s+(?:[^[]+\s+)?\[([^\]]+)\]\(([^)]+)\)\s*[—-]\s*(.+)$/;

/** Cap on the index file we will read into the prompt. MEMORY.md is
 * injected every turn, so an unbounded index is an unbounded per-turn cost.
 * Generous relative to any plausible index (Claude Code's own index lines
 * run ~100 bytes, so this is ~10k entries). */
const INDEX_MAX_BYTES = 1_000_000;

/** Parse a MEMORY.md file from disk.
 *
 * The index is the one path that is NOT covered by the topic-file guards in
 * injector.ts, and it is read on every turn. Validate it like a topic:
 * must be a regular file (a FIFO named MEMORY.md would block the
 * synchronous read forever; a symlinked one could pull in an unrelated
 * file), and must be within the size cap. Unlike topics the index is
 * allowed to sit at the project root (the Layout-2 anomaly the resolver
 * supports), so it is deliberately not containment-checked. */
export function parseIndexFile(dir: MemoryDir): ParsedIndex | null {
  try {
    const st = lstatSync(dir.indexPath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > INDEX_MAX_BYTES) return null;
  } catch {
    // missing or unreadable — same as "no index"
    return null;
  }
  try {
    const content = readFileSync(dir.indexPath, "utf8");
    return parseIndexContent(content, dir.dir);
  } catch {
    return null;
  }
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

/** Resolve a href from MEMORY.md to an absolute file path.
 *
 * Both branches normalize through resolve(): an ABSOLUTE href used to be
 * returned verbatim, so `/home/x/.claude/memory//topic.md` or a path with
 * `/./` in it reached the injector as a different string than the
 * canonical path the loader keys its map on. The file was injected in full
 * while the index section still marked it ⟨index-only⟩ (inviting a wasted
 * recall_memory), and a pinned entry lost its large-file bypass.
 *
 * When the target exists we ALSO canonicalize through realpathSync, because
 * the loader stores real paths: if any component of the store is itself a
 * symlink (a dotfiles-managed ~/.claude), a lexical path and the loader's
 * real path differ and every index line would render ⟨index-only⟩ despite
 * its body being injected. Missing files keep the lexical path — they are
 * reported as unindexed/missing by reconcileIndex and never loaded. */
function resolveHref(href: string, baseDir: string): string {
  // Absolute path (cross-tier reference like /home/user/.claude/memory/file.md)
  const lexical = isAbsolute(href) ? resolve(href) : resolve(baseDir, href);
  try {
    return realpathSync(lexical);
  } catch {
    return lexical;
  }
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

/** Compare index entries against actual files on disk.
 *
 * Purely advisory (it only produces warnings), so a filesystem failure here
 * must never break the turn: this runs inside before_agent_start, and an
 * unguarded readdirSync throw would abort turn start over a cosmetic
 * reconciliation. */
export function reconcileIndex(parsed: ParsedIndex, dir: string): ReconcileResult {
  const diskFiles = new Set<string>();
  let dirEntries: import("node:fs").Dirent[];
  try {
    dirEntries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { unindexed: [], missing: [] };
  }
  for (const entry of dirEntries) {
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
