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
import { basename, isAbsolute, resolve } from "node:path";
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

/** Move the oldest non-pinned link lines below an `## Archive` heading until the
 * live region fits inside Claude Code's startup excerpt.
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
  const promote = recencyAt !== undefined;

  const lines = [...input];
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
  const live = promote ? [...livePre, ...alreadyArchived] : [...livePre];
  const archivedLinks: string[] = promote ? [] : [...alreadyArchived];
  const demoted: string[] = [];

  const assemble = (fits: boolean): IndexFitResult => {
    const out = [...live];
    if (hadMarker || archivedLinks.length > 0 || parked.length > 0) {
      out.push(ARCHIVE_HEADING, ...parked, ...archivedLinks);
    }
    if (trailing !== undefined) out.push(trailing);
    return { lines: out, demoted, cannotFit: !fits };
  };

  if (fitsExcerpt(live, maxLines, maxBytes)) return assemble(true);

  // A link that was already archived and gets re-demoted is not news: the steady
  // state re-demotes the same lines on every write, and reporting them would
  // make every write look like it changed something.
  const previouslyArchived = new Set(
    alreadyArchived.flatMap((line) => {
      const link = parseLinkLine(line);
      return link ? [basename(link.href).toLowerCase()] : [];
    }),
  );
  // Ages are computed once against the pre-splice positions and spliced in step
  // with `live`, so the positional fallback does not drift as lines leave.
  const ages = live.map((line, at) => {
    const link = parseLinkLine(line);
    // Prose and headings are never victims, so their age never decides anything.
    if (link === null) return Number.POSITIVE_INFINITY;
    const known = recencyAt ? recencyAt(basename(link.href)) : 0;
    return known > 0 ? known : at;
  });

  while (!fitsExcerpt(live, maxLines, maxBytes)) {
    let victimIdx = -1;
    let victimAge = Number.POSITIVE_INFINITY;
    for (let i = 0; i < live.length; i++) {
      const line = live[i];
      if (line === undefined || !isDemotableLinkLine(line)) continue;
      const age = ages[i] ?? Number.POSITIVE_INFINITY;
      if (age < victimAge) {
        victimAge = age;
        victimIdx = i;
      }
    }
    if (victimIdx < 0) {
      // Only prose, headings, or pins are left. Refuse to evict a pin: a pin is a
      // claim that the line must stay visible, and quietly dropping one is the
      // failure this mechanism exists to prevent. Report instead.
      break;
    }
    const moved = live.splice(victimIdx, 1)[0];
    ages.splice(victimIdx, 1);
    if (moved === undefined) continue;
    const link = parseLinkLine(moved);
    const name = link ? basename(link.href) : moved;
    if (!previouslyArchived.has(name.toLowerCase())) demoted.push(name);
    archivedLinks.push(moved);
  }

  return assemble(fitsExcerpt(live, maxLines, maxBytes));
}
