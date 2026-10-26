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

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { createPathCache, type PathCache } from "./path-cache.js";
import type { IndexEntry, IndexLine, MemoryDir, ParsedIndex } from "./types.js";
import {
  INDEX_MAX_BYTES,
  INDEX_PARSE_CAP_WARN_BYTES,
  INDEX_STARTUP_MAX_BYTES,
  INDEX_STARTUP_MAX_LINES,
} from "./types.js";

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
function sameTarget(path: string, target: string, cache: PathCache): boolean {
  if (path === target) return true;
  // Both sides go through resolvePath, which reaches for realpathSync only when
  // lstat shows a symlink; a plain path resolves to its canonical directory plus
  // its own name, which is the string realpathSync would have returned. Both
  // results are memoised, so a caller that walks every line of the index resolves
  // the entry being written once and each distinct href once, not once per line.
  //
  // A path that cannot be resolved keeps its lexical spelling here rather than
  // producing an error: the strings can only then be equal when they are
  // literally the same string, which returned true above — so the outcome matches
  // the old `try { realpathSync(a) === realpathSync(b) } catch { false }`.
  return cache.resolvePath(path) === cache.resolvePath(target);
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
export function lineTargetsFile(
  line: string,
  baseDir: string,
  targetPath: string,
  cache: PathCache = createPathCache(),
): boolean {
  const parsed = parseLinkLine(line);
  if (!parsed) return false;
  return sameTarget(resolveHref(parsed.href, baseDir, cache), targetPath, cache);
}

/** True when the index line's href resolves to ANY path in `identities`.
 *
 * Unlike `lineTargetsFile` this carries no basename fast path, because the
 * caller may be an index belonging to a DIFFERENT store than the topic. A line
 * whose href is literally `(notes.md)` in another tier's index links that
 * tier's OWN `notes.md`, not the topic being removed. The real corpus holds
 * `user_location.md` in both the global store and a project
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
  cache: PathCache = createPathCache(),
): boolean {
  const parsed = parseLinkLine(line);
  if (!parsed) return false;
  const lexical = isAbsolute(parsed.href) ? resolve(parsed.href) : resolve(baseDir, parsed.href);
  if (identities.has(lexical)) return true;
  // resolvePath, not realpathOf: the identities hold the topic's lexical AND
  // canonical spellings, and a non-symlink leaf canonicalizes to exactly what
  // realpathSync would return — so a store of 2,400 plain topics costs one
  // realpath (its directory) instead of 2,400. Falling back to the lexical
  // string when the path cannot be resolved is safe here: that string was
  // already tested above, so it cannot match now either.
  return identities.has(cache.resolvePath(lexical));
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
export function parseIndexFile(
  dir: MemoryDir,
  cache: PathCache = createPathCache(),
): ParsedIndex | null {
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
    return parseIndexContent(content, dir.dir, cache);
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
 * the caller can warn rather than silently inject nothing.
 *
 * maxBytes narrows the byte limit for a smaller view (a subagent's). It never
 * widens it: the startup limit is Claude Code's, and both harnesses must agree
 * on what the model is shown by default. */
export function readBoundedIndex(
  dir: MemoryDir,
  maxBytes: number = INDEX_STARTUP_MAX_BYTES,
): BoundedIndex | null {
  const byteLimit = Math.min(maxBytes, INDEX_STARTUP_MAX_BYTES);
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
    if (bytes + lineBytes > byteLimit) {
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
  // Measure the region that is actually injected: everything above the archive
  // heading. Parked entries below it are not part of the excerpt, so counting
  // them kept this warning firing on every write to a demoted store while telling
  // the operator the newest entries were the ones being dropped, which is the
  // exact failure demotion prevents. With no heading the live region is the whole
  // file, so a store that never demotes measures as it always did.
  const lines = raw.split("\n");
  const marker = lines.findIndex(isArchiveHeading);
  const live = marker === -1 ? lines : lines.slice(0, marker);
  if (fitsExcerpt(live)) return null;
  const lineCount = live.length;
  const bytes = excerptBytes(live);
  const over: string[] = [];
  if (lineCount > INDEX_STARTUP_MAX_LINES) {
    over.push(`${lineCount} lines (limit ${INDEX_STARTUP_MAX_LINES})`);
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

/** Warn while MEMORY.md is approaching the byte cap the parser refuses.
 *
 * Distinct from startupLimitWarning above. That one is about how much of the
 * index reaches a prompt; this one is about whether the index can be parsed at
 * all. Past INDEX_MAX_BYTES, parseIndexFile returns null: every entry in the
 * store disappears from injection and the writer refuses every index update.
 * Neither the archive nor the demotion planner shrinks the file — demotion moves
 * lines within it — so the only fix is deleting or merging entries.
 *
 * The write path is the right place for the approach warning because a write is
 * what makes the file grow, and it is also the LAST moment a warning is possible:
 * once the cap is crossed, writes are refused and only the injector can report it. */
export function indexParseCapWarning(dir: MemoryDir): string | null {
  let bytes: number;
  try {
    const st = lstatSync(dir.indexPath);
    // A symlinked or non-regular index is a different fault, and the injector
    // already reports it with the reason it measured.
    if (st.isSymbolicLink() || !st.isFile()) return null;
    bytes = st.size;
  } catch {
    return null; // no index yet — the caller is about to create one
  }
  if (bytes <= INDEX_PARSE_CAP_WARN_BYTES) return null;
  const measured = `MEMORY.md is ${bytes} bytes`;
  const advice =
    " The archive keeps demoted entries reachable but does not shrink the file, " +
    "so entries have to be deleted or merged to bring it back down.";
  if (bytes > INDEX_MAX_BYTES) {
    return (
      `${measured}, past the ${INDEX_MAX_BYTES}-byte cap: the parser refuses it, so ` +
      `no entry in this store is injected and index updates are refused until it shrinks.${advice}`
    );
  }
  return (
    `${measured}, approaching the ${INDEX_MAX_BYTES}-byte cap past which the parser ` +
    `refuses the whole index and every entry disappears from injection.${advice}`
  );
}

/** Parse MEMORY.md content string (separated for testing).
 *
 * `cache` is one operation's path cache: pass the caller's own so a parse and a
 * later ownership test over the same entries resolve each topic once between
 * them. Omitted, the parse makes and drops its own. */
export function parseIndexContent(
  content: string,
  baseDir: string,
  cache: PathCache = createPathCache(),
): ParsedIndex {
  const lines: (IndexEntry | IndexLine)[] = [];
  const entries: IndexEntry[] = [];

  const rawLines = content.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const link = parseLinkLine(line);

    if (link) {
      const filePath = resolveHref(link.href, baseDir, cache);
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
 * When the target exists we canonicalize, because owningTierOf compares against
 * realpath'd store roots: if any component of the store is itself a symlink (a
 * dotfiles-managed ~/.claude), a lexical path and the real path differ and the
 * entry would be attributed to no store at all. reconcileIndex resolves the
 * same way, so its missing/unindexed report agrees. Missing files keep the
 * lexical path — they cannot be canonicalized, and reconcileIndex reports them
 * as missing.
 *
 * The canonicalization is the cache's (one per operation), and it only reaches
 * for realpathSync when lstat shows the leaf is a symlink. Doing it per line
 * here was the storm: an append to a 100-line index resolved the same topic 100
 * times, and to a 2,400-line index, 2,400 times, all of it main-thread. */
function resolveHref(href: string, baseDir: string, cache: PathCache): string {
  // Absolute path (cross-tier reference like /home/user/.claude/memory/file.md)
  const lexical = isAbsolute(href) ? resolve(href) : resolve(baseDir, href);
  return cache.resolvePath(lexical);
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

/** The heading that separates the live index from demoted entries.
 *
 * A heading rather than a comment because this file stays a human-readable
 * MEMORY.md: someone who opens it should find a section that explains itself,
 * and the parser already preserves headings as prose, so no other reader needs
 * to learn a new syntax. */
export const ARCHIVE_HEADING = "## Archive";

/** True for the archive divider, and only for it.
 *
 * Anchored to a bare heading so a link whose title merely contains the word
 * "Archive" is not mistaken for the divider. */
export function isArchiveHeading(line: string): boolean {
  return /^#{1,6}\s+archive$/i.test(line.trim());
}

/** True when an index line carries a pin marker.
 *
 * Exported so the fit planner ranks pins with the parser's own rule (`⛔`
 * anywhere in the line, or `[pin]` in the summary) instead of keeping a second
 * copy of the marker syntax that can drift away from this one. */
export function isPinnedIndexLine(line: string): boolean {
  const link = parseLinkLine(line);
  return link !== null && isPinnedLine(line, link.summary);
}

/** True when a line is a link the fit planner may move below the archive
 *  heading. Prose, headings, blank lines and pinned links are never moved. */
function isDemotableLinkLine(line: string): boolean {
  return parseLinkLine(line) !== null && !isPinnedIndexLine(line);
}

/** Bytes a run of lines occupies under the excerpt reader's arithmetic: UTF-8
 *  bytes plus one byte for each newline joining them.
 *
 * Deliberately the same rule as readBoundedIndex, so a region this function
 * calls fitting is a region that reader actually keeps whole. */
export function excerptBytes(lines: readonly string[]): number {
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    bytes += Buffer.byteLength(lines[i] ?? "", "utf8") + (i > 0 ? 1 : 0);
  }
  return bytes;
}

/** True when a run of lines is entirely inside the startup excerpt. */
export function fitsExcerpt(
  lines: readonly string[],
  maxLines: number = INDEX_STARTUP_MAX_LINES,
  maxBytes: number = INDEX_STARTUP_MAX_BYTES,
): boolean {
  return lines.length <= maxLines && excerptBytes(lines) <= maxBytes;
}

export interface IndexFitOptions {
  /** Line bound for the live region. Defaults to the startup excerpt limit. */
  maxLines?: number;
  /** UTF-8 byte bound for the live region, using the excerpt reader's rule. */
  maxBytes?: number;
  /**
   * Recency of a topic file, epoch ms, or 0 when unknown. The planner asks for
   * this only when an archive heading already exists, which is the point at
   * which file position stops being a faithful rank.
   */
  recencyAt?: (filename: string) => number;
  /**
   * Whether a topic is a standing rule (feedback or user type). Rules are
   * demoted last while they fit within RULE_SHARE of the byte bound. Defaults
   * to the slug convention when the caller cannot read frontmatter.
   */
  isRule?: (filename: string) => boolean;
  /** Members a slug-prefix cluster needs to be demoted first (default 5). */
  clusterMin?: number;
}

export interface IndexFitResult {
  /** The whole index: live region first, archive region last. */
  lines: string[];
  /** Filenames NEWLY demoted by this call, in the order they moved. A link that
   *  was already archived and gets re-demoted is not news and is not listed. */
  demoted: string[];
  /** True when the live region is still past the bound because only prose,
   *  headings, or pinned entries remain to move. Nothing is evicted to force a
   *  fit. */
  cannotFit: boolean;
}

/** Move non-pinned link lines below an `## Archive` heading until the live
 * region fits inside Claude Code's startup excerpt.
 *
 * Order, oldest first within each step: members of a big slug-prefix cluster
 * (CLUSTER_MIN_MEMBERS or more, standing rules excluded), then ordinary
 * entries, then standing rules (feedback or user type) while they fill at most
 * RULE_SHARE of the byte bound. A cluster with archived members keeps one
 * generated prose signpost in the live region, so its topic stays findable.
 * Recency alone evicted standing rules to make room for a single cluster: one
 * hvac-control session minted 95 hp-78k0-* entries, and the rules that apply
 * in every session were the ones demoted.
 *
 * Why this is not destruction: the topic file is never touched, recall_memory
 * resolves names against the directory rather than the index, and the parser
 * (which the reconciler and the auto-learn reviewer both use) reads link lines
 * wherever they sit — so a demoted line still suppresses a false "unindexed"
 * warning and still tells the reviewer that the topic exists. Moving the line
 * back is the undo.
 *
 * Why it is pure: no reads, no clock, no ranking metadata. The index is
 * append-ordered, so the earliest surviving link line is the oldest entry and
 * position is a sufficient rank; reading a thousand topic frontmatters for a
 * better one would make the writer's retry closure impure and slow on every
 * attempt. */
/** Fit the live region of an index into Claude Code's startup excerpt.
 *
 * Promotion is why this can be recomputed from scratch on every write. Position
 * stops encoding recency the moment a heading exists, because the newest entries
 * sit above it and the oldest below it; Claude Code appends new entries at the
 * END OF THE FILE, which is below the heading, so position alone can never tell
 * that such a line is the newest one there. Promoting archived links back into
 * the live region before refitting is what keeps an external writer's append
 * visible.
 *
 * Promotion therefore requires a recency signal. Without one, an archived line's
 * position is YOUNGER than the live lines that survived (they are above it), so
 * promoting would invert the rank and demote the wrong entries. In that mode
 * archived lines stay archived and only the live region is re-ranked by position,
 * which is a faithful rank while no archive exists. The writer always supplies a
 * signal; this degraded mode exists for callers that cannot.
 *
 * Pure: no reads of its own, no clock. Any I/O is the caller's `recencyAt`. */
export function fitIndexToExcerpt(
  input: readonly string[],
  options: IndexFitOptions = {},
): IndexFitResult {
  const maxLines = options.maxLines ?? INDEX_STARTUP_MAX_LINES;
  const maxBytes = options.maxBytes ?? INDEX_STARTUP_MAX_BYTES;
  const recencyAt = options.recencyAt;
  const isRule = options.isRule ?? isRuleBySlug;
  const clusterMin = options.clusterMin ?? CLUSTER_MIN_MEMBERS;
  const promote = recencyAt !== undefined;

  // Signposts are derived, never authored: strip every one up front and
  // regenerate them at the end, so a pass is a pure function of the links.
  const lines = input.filter((line) => !isClusterSignpost(line));
  // A trailing empty element is the file's final newline, not a line. Hold it
  // aside so rebuilding cannot consume it or double it.
  const trailing = lines.at(-1) === "" ? lines.pop() : undefined;

  const markerIdx = lines.findIndex(isArchiveHeading);
  const hadMarker = markerIdx >= 0;
  const livePre = markerIdx >= 0 ? lines.slice(0, markerIdx) : [...lines];
  const archived = markerIdx >= 0 ? lines.slice(markerIdx + 1) : [];

  // Only link lines are ever demoted, so only link lines are promoted back.
  // Prose authored below the heading stays below it.
  const parked = archived.filter((line) => parseLinkLine(line) === null);
  const alreadyArchived = archived.filter((line) => parseLinkLine(line) !== null);
  let live = promote ? [...livePre, ...alreadyArchived] : [...livePre];
  const archivedLinks: string[] = promote ? [] : [...alreadyArchived];
  const demoted: string[] = [];

  const fileOf = (line: string): string | null => {
    const link = parseLinkLine(line);
    return link ? basename(link.href) : null;
  };
  const ruleCache = new Map<string, boolean>();
  const ruleOf = (file: string): boolean => {
    let known = ruleCache.get(file);
    if (known === undefined) {
      known = isRule(file);
      ruleCache.set(file, known);
    }
    return known;
  };
  /** The cluster a line belongs to, or null for a rule, a pin, a singleton
   *  prefix, or prose. Rules are never clustered: a run of feedback slugs
   *  sharing two words ("feedback-dont-*") is a set of distinct rules, not a
   *  topic one pointer can stand in for. */
  const clusterOfFile = (file: string): string | null => {
    if (ruleOf(file)) return null;
    return clusterKey(file);
  };

  // Cluster sizes over the WHOLE index, so a cluster mostly archived already
  // still counts as one.
  const clusterSize = new Map<string, number>();
  for (const line of [...live, ...archivedLinks]) {
    const file = fileOf(line);
    const key = file ? clusterOfFile(file) : null;
    if (key) clusterSize.set(key, (clusterSize.get(key) ?? 0) + 1);
  }
  const bigClusters = [...clusterSize]
    .filter(([, n]) => n >= clusterMin)
    .map(([key]) => key)
    .sort();
  const big = new Set(bigClusters);

  // Room for the signposts is reserved before fitting, at their largest
  // possible size, so adding them afterwards can never push the live region
  // back over the bound.
  const reserveLines = bigClusters.length;
  const reserveBytes = bigClusters.reduce(
    (sum, key) =>
      sum + Buffer.byteLength(clusterSignpost(key, clusterSize.get(key) ?? 0), "utf8") + 1,
    0,
  );
  const fitLines = Math.max(0, maxLines - reserveLines);
  const fitBytes = Math.max(0, maxBytes - reserveBytes);

  const assemble = (): IndexFitResult => {
    const archivedCount = new Map<string, number>();
    for (const line of archivedLinks) {
      const file = fileOf(line);
      const key = file ? clusterOfFile(file) : null;
      if (key && big.has(key)) archivedCount.set(key, (archivedCount.get(key) ?? 0) + 1);
    }
    const signposts = bigClusters
      .filter((key) => (archivedCount.get(key) ?? 0) > 0)
      .map((key) => clusterSignpost(key, archivedCount.get(key) ?? 0));
    const liveOut = [...live, ...signposts];
    const out = [...liveOut];
    if (hadMarker || archivedLinks.length > 0 || parked.length > 0) {
      out.push(ARCHIVE_HEADING, ...parked, ...archivedLinks);
    }
    if (trailing !== undefined) out.push(trailing);
    return { lines: out, demoted, cannotFit: !fitsExcerpt(liveOut, maxLines, maxBytes) };
  };

  if (fitsExcerpt(live, fitLines, fitBytes)) return assemble();

  // A link that was already archived and gets re-demoted is not news: the steady
  // state re-demotes the same lines on every write, and reporting them would
  // make every write look like it changed something.
  const previouslyArchived = new Set(
    alreadyArchived.flatMap((line) => {
      const file = fileOf(line);
      return file ? [file.toLowerCase()] : [];
    }),
  );
  // Every line's file, byte cost and demotion tier is computed once. The old
  // loop recomputed them for each victim, which is quadratic: a promoted store
  // of ~2,400 archived links spent 5 s of main-thread time per write scanning
  // 2,500 lines and re-running a link regex for each of ~2,400 removals.
  const fileByIndex: (string | null)[] = new Array(live.length);
  const bytesByIndex: number[] = new Array(live.length);
  const linkByIndex: boolean[] = new Array(live.length);
  const ruleLineByIndex: boolean[] = new Array(live.length);
  const clusterTierByIndex: number[] = new Array(live.length);
  for (let at = 0; at < live.length; at++) {
    const line = live[at] ?? "";
    const file = fileOf(line);
    fileByIndex[at] = file;
    bytesByIndex[at] = Buffer.byteLength(line, "utf8") + 1;
    linkByIndex[at] = isDemotableLinkLine(line);
    const rule = file !== null && ruleOf(file);
    ruleLineByIndex[at] = rule;
    const key = rule || file === null ? null : clusterOfFile(file);
    clusterTierByIndex[at] = key !== null && big.has(key) ? 0 : 1;
  }
  // Ages are computed once against the pre-splice positions, so the positional
  // fallback does not drift as lines leave.
  let ages = live.map((_line, at) => {
    const file = fileByIndex[at] ?? null;
    // Prose and headings are never victims, so their age never decides anything.
    if (file === null) return Number.POSITIVE_INFINITY;
    const known = recencyAt ? recencyAt(file) : 0;
    return known > 0 ? known : at;
  });

  // Standing rules are held back only while they fill at most RULE_SHARE of the
  // byte bound. Past that, the oldest of them compete with ordinary entries, so
  // a flood of reviewer-minted rules cannot push everything else out.
  const ruleBudget = maxBytes * RULE_SHARE;
  let ruleBytes = 0;
  for (let at = 0; at < live.length; at++) {
    if (linkByIndex[at] && ruleLineByIndex[at]) ruleBytes += bytesByIndex[at] ?? 0;
  }

  let ruleOverBudget = ruleBytes > ruleBudget;
  /** Demotion order: 0 = member of a big cluster (its signpost stands in for
   *  it), 1 = ordinary entry, 2 = standing rule while rules are within budget. */
  const tierOf = (at: number): number => {
    if (ruleLineByIndex[at]) return ruleOverBudget ? 1 : 2;
    return clusterTierByIndex[at] ?? 1;
  };
  const order = (left: number, right: number): number => {
    const tierDelta = tierOf(left) - tierOf(right);
    if (tierDelta !== 0) return tierDelta;
    const leftAge = ages[left] ?? Number.POSITIVE_INFINITY;
    const rightAge = ages[right] ?? Number.POSITIVE_INFINITY;
    if (leftAge !== rightAge) return leftAge - rightAge;
    return left - right;
  };

  // The same victim sequence the repeated-minimum scan produced, but sorted
  // once: tier, then age, then position.
  const candidates: number[] = [];
  for (let at = 0; at < live.length; at++) if (linkByIndex[at]) candidates.push(at);
  candidates.sort(order);
  const removed = new Set<number>();
  let liveCount = live.length;
  let liveBytes = excerptBytes(live);
  let cursor = 0;
  while (liveCount > fitLines || liveBytes > fitBytes) {
    let victimIdx = -1;
    while (cursor < candidates.length) {
      const candidate = candidates[cursor] ?? 0;
      cursor++;
      if (!removed.has(candidate)) {
        victimIdx = candidate;
        break;
      }
    }
    if (victimIdx < 0) {
      // Only prose, headings, or pins are left. Refuse to evict a pin: a pin is a
      // claim that the line must stay visible, and quietly dropping one is the
      // failure this mechanism exists to prevent. Report instead.
      break;
    }
    const moved = live[victimIdx] ?? "";
    removed.add(victimIdx);
    liveCount--;
    liveBytes -= bytesByIndex[victimIdx] ?? 0;
    const name = fileByIndex[victimIdx] ?? moved;
    if (ruleLineByIndex[victimIdx]) {
      ruleBytes -= bytesByIndex[victimIdx] ?? 0;
      // Rules only leave, so the budget flip happens at most once; re-sort the
      // survivors when it does.
      if (ruleOverBudget && ruleBytes <= ruleBudget) {
        ruleOverBudget = false;
        candidates.length = 0;
        for (let at = 0; at < live.length; at++)
          if (linkByIndex[at] && !removed.has(at)) candidates.push(at);
        candidates.sort(order);
        cursor = 0;
      }
    }
    if (!previouslyArchived.has(name.toLowerCase())) demoted.push(name);
    archivedLinks.push(moved);
  }
  if (removed.size > 0) {
    const survivorsLines: string[] = [];
    const survivorsAges: number[] = [];
    for (let at = 0; at < live.length; at++) {
      if (removed.has(at)) continue;
      survivorsLines.push(live[at] ?? "");
      survivorsAges.push(ages[at] ?? Number.POSITIVE_INFINITY);
    }
    live = survivorsLines;
    ages = survivorsAges;
  }

  return assemble();
}

/** Members a slug-prefix cluster needs before its lines are demoted first. */
export const CLUSTER_MIN_MEMBERS = 5;

/** Share of the byte bound standing rules may hold before they compete with
 *  ordinary entries for the live region. */
export const RULE_SHARE = 0.5;

/** A topic's cluster: the first two words of its stem ("hp-78k0" for
 *  "hp-78k0-flmd0-hold.md"), or null for a one-word stem. */
export function clusterKey(file: string): string | null {
  const words = file
    .replace(/\.md$/i, "")
    .toLowerCase()
    .split(/[-_]+/)
    .filter((w) => w.length > 0);
  return words.length >= 2 ? `${words[0]}-${words[1]}` : null;
}

/** Fallback rule test when the caller cannot read frontmatter: the store's
 *  slug conventions ("feedback-…", "feedback_…", "user-…"). */
function isRuleBySlug(file: string): boolean {
  return /^(feedback|user)[-_]/i.test(file);
}

/** The generated line that stands in for a cluster's archived members. Prose,
 *  not a link, so the parser never counts it as an entry and demotion never
 *  moves it. Tool-neutral up front because Claude Code reads this file too. */
export function clusterSignpost(key: string, archivedCount: number): string {
  const noun = archivedCount === 1 ? "entry" : "entries";
  return `- ${key}-* — ${archivedCount} more ${noun} listed below the Archive heading (find_memory "${key}")`;
}

/** True for a line clusterSignpost generated. */
export function isClusterSignpost(line: string): boolean {
  return /^- [a-z0-9]+-[a-z0-9]+-\* — \d+ more entr(?:y|ies) listed below the Archive heading \(find_memory "[a-z0-9]+-[a-z0-9]+"\)$/.test(
    line,
  );
}
