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
import { INDEX_MAX_BYTES, INDEX_STARTUP_MAX_BYTES, INDEX_STARTUP_MAX_LINES } from "./types.js";

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

/** True when the index line's href resolves to ANY path in `identities`.
 *
 * Unlike `lineTargetsFile` this carries no basename fast path, because the
 * caller may be an index belonging to a DIFFERENT store than the topic. A line
 * whose href is literally `(notes.md)` in another tier's index links that
 * tier's OWN `notes.md`, not the topic being removed. The real corpus holds
 * `user_location.md` in both the global store and the other-project project
 * store, each linked by a bare basename in its own index, so a basename-based
 * cross-tier match stripped a live, unrelated entry's line and reported it as a
 * cleanup. Resolving the href is the only rule that is both
 * spelling-independent and tier-correct.
 *
 * `identities` holds every spelling the topic is known by (its lexical path and
 * its canonical path, both captured BEFORE the move). Resolving the HREF stays
 * lexical, so this keeps matching after the leaf is gone and realpath can no
 * longer resolve it. */
export function lineTargetsAnyIdentity(
  line: string,
  baseDir: string,
  identities: ReadonlySet<string>,
): boolean {
  const parsed = parseLinkLine(line);
  if (!parsed) return false;
  const lexical = isAbsolute(parsed.href) ? resolve(parsed.href) : resolve(baseDir, parsed.href);
  if (identities.has(lexical)) return true;
  try {
    return identities.has(realpathSync(lexical));
  } catch {
    return false;
  }
}

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

/** Why a store's MEMORY.md was refused. An absent index is NOT a rejection —
 *  that is a store which has none yet. */
export type IndexRejection = "symlink" | "not-regular-file" | "oversize" | "unreadable";

/** The bounded startup excerpt of a store's MEMORY.md, or why it was refused. */
export type BoundedIndex =
  | {
      ok: true;
      /** Verbatim leading lines, within both startup limits. */
      content: string;
      /** Lines in the whole file, so a truncation notice can say what was cut. */
      totalLines: number;
      truncated: boolean;
      /** Which limit bound, or null when the whole file fit. */
      limitedBy: "lines" | "bytes" | null;
    }
  | { ok: false; reason: IndexRejection };

/** Read the startup excerpt of a store's MEMORY.md: its first
 *  INDEX_STARTUP_MAX_LINES lines, subject to INDEX_STARTUP_MAX_BYTES.
 *
 * This is the INJECTION view, and it is deliberately not the parser's
 * contract. parseIndexFile must see every entry — the reviewer's
 * existing-entry summary and the writer's replace/remove matching both depend
 * on the whole index, and reporting a topic below the cut as "unindexed" would
 * be false. Bounding the parse instead of the view would hide entries from
 * deduplication and supersession.
 *
 * Excerpt semantics follow Claude Code: the limits apply to the SOURCE file, so
 * headings, prose, and blank lines all consume them, and surviving lines keep
 * source order. A pin below the cut is therefore not promoted — promoting it
 * would mean reordering the file the model is shown.
 *
 * Returns null when no index file exists. Guard failures (symlinked,
 * non-regular, past INDEX_MAX_BYTES, unreadable) are reported as ok:false so
 * the caller can warn rather than silently inject nothing. */
export function readBoundedIndex(dir: MemoryDir): BoundedIndex | null {
  let st: import("node:fs").Stats;
  try {
    st = lstatSync(dir.indexPath);
  } catch {
    return null; // absent — a store with no index yet
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!st.isFile()) return { ok: false, reason: "not-regular-file" };
  if (st.size > INDEX_MAX_BYTES) return { ok: false, reason: "oversize" };
  let raw: string;
  try {
    raw = readFileSync(dir.indexPath, "utf8");
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const all = raw.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  let limitedBy: "lines" | "bytes" | null = null;
  for (const line of all) {
    if (kept.length >= INDEX_STARTUP_MAX_LINES) {
      limitedBy = "lines";
      break;
    }
    // Byte counting is UTF-8 and includes the newline joining this line to the
    // previous one, so the excerpt measures the same on disk and in the prompt.
    // Whole lines are kept, so a multi-byte character is never split.
    const lineBytes = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > INDEX_STARTUP_MAX_BYTES) {
      limitedBy = "bytes";
      break;
    }
    bytes += lineBytes;
    kept.push(line);
  }
  return {
    ok: true,
    content: kept.join("\n"),
    totalLines: all.length,
    truncated: limitedBy !== null,
    limitedBy,
  };
}

/** Describe an index that has grown past the injected excerpt limit, or return
 *  null while it still fits.
 *
 * This exists because writes APPEND: once MEMORY.md is past the cutoff, every
 * new entry is added BELOW the injected excerpt, so the newest memories are
 * exactly the ones the model never sees — the opposite of what the writer of
 * that entry expects. The startup limit is the reader's contract, so the only
 * place to make it actionable is the write that crosses it. */
export function startupLimitWarning(dir: MemoryDir): string | null {
  let raw: string;
  try {
    raw = readFileSync(dir.indexPath, "utf8");
  } catch {
    return null; // no index yet — the caller is about to create one
  }
  const lines = raw.split("\n").length;
  const bytes = Buffer.byteLength(raw, "utf8");
  if (lines <= INDEX_STARTUP_MAX_LINES && bytes <= INDEX_STARTUP_MAX_BYTES) return null;
  const over: string[] = [];
  if (lines > INDEX_STARTUP_MAX_LINES) {
    over.push(`${lines} lines (limit ${INDEX_STARTUP_MAX_LINES})`);
  }
  if (bytes > INDEX_STARTUP_MAX_BYTES) {
    over.push(`${bytes} bytes (limit ${INDEX_STARTUP_MAX_BYTES})`);
  }
  return (
    `MEMORY.md is past the injected excerpt limit: ${over.join(", ")}. ` +
    "Entries below the cutoff are not injected, and appends go to the end, so " +
    "the newest entries are the ones being dropped. Read through the file with " +
    "recall_memory, or consolidate the index."
  );
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
 * `/./` in it reaches the injector as a different STRING than the canonical
 * path, and cross-tier ownership then compares two spellings of one file.
 *
 * When the target exists we canonicalize through realpathSync, because
 * owningTierOf compares against realpath'd store roots: if any component of
 * the store is itself a symlink (a dotfiles-managed ~/.claude), a lexical
 * path and the real path differ and the entry would be attributed to no store
 * at all. reconcileIndex resolves the same way, so its missing/unindexed
 * report agrees. Missing files keep the lexical path — they cannot be
 * realpath'd, and reconcileIndex reports them as missing. */
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
