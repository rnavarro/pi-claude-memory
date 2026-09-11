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

// Match: - [title](href) — summary
// The summary is OPTIONAL. Hand-authored and emoji-marked index lines
// ("- ⛔ [Critical rule](rule.md)") carry no summary, and requiring one made
// them invisible to injection: they fell through as raw prose, so their body
// was never loaded and their pin was ignored — while the writer's replace and
// remove regexes (which make the summary optional) happily treated them as
// index lines. One grammar for both sides.
const LINK_PATTERN = /^-\s+(?:[^[]+\s+)?\[([^\]]+)\]\(([^)]+)\)\s*(?:[—-]\s*(.*))?$/;

/** A parsed index link line. `summary` is "" when the line omits it. */
export interface ParsedLinkLine {
  title: string;
  href: string;
  summary: string;
}

/** Parse a single index link line, ignoring pin markers. Returns null for
 * prose lines. Shared by the parser and by the writer's replace/remove
 * matching so the two can never disagree about what is a link line. */
export function parseLinkLine(line: string): ParsedLinkLine | null {
  const match = line.match(LINK_PATTERN);
  if (!match) return null;
  const [, title, href, summary] = match;
  return { title: title.trim(), href, summary: (summary ?? "").trim() };
}

/** True when `path` and `target` name the same file.
 *
 * Compares canonical paths when both exist: an index href may reach a topic
 * through a symlinked store component, and `resolveHref` already canonicalizes
 * the read side, so lexical comparison alone would report a false negative and
 * reintroduce the duplicate-line bug this guards against. */
function sameTarget(path: string, target: string): boolean {
  if (path === target) return true;
  try {
    return realpathSync(path) === realpathSync(target);
  } catch {
    return false;
  }
}

/** True when the index line links to `targetPath`, regardless of how the href
 * is SPELLED.
 *
 * Replace/remove used to match the literal `(filename.md)` spelling, so a line
 * using an absolute href — a shape the parser explicitly supports and Claude
 * Code writes — was neither replaced (a duplicate line was appended instead)
 * nor removed (the link kept pointing at a file already moved to .trash/,
 * while the tool reported success). Matching on the resolved target collapses
 * absolute, `./`-prefixed, and `dir/../` spellings onto the same file. */
export function lineTargetsFile(line: string, baseDir: string, targetPath: string): boolean {
  const parsed = parseLinkLine(line);
  if (!parsed) return false;
  return sameTarget(resolveHref(parsed.href, baseDir), targetPath);
}

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
    const link = parseLinkLine(line);

    if (link) {
      const filePath = resolveHref(link.href, baseDir);
      const pinned = isPinnedLine(line, link.summary);
      const entry: IndexEntry = {
        title: link.title,
        href: link.href,
        filePath,
        summary: link.summary,
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
