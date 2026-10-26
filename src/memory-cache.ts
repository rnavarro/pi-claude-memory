// Bounded memos for the read path behind find_memory.
//
// find_memory searched the WHOLE store on every call: read, parse, lowercase
// and tokenise 2,768 topic bodies (2.4 MiB) plus the 554 KB index. That measured
// 182-247 ms of synchronous main-thread work per call, and an identical repeat
// query cost exactly the same, because nothing in the stack remembered anything.
// pi runs this on the main thread, and the injected anchor points the model at
// find_memory whenever the index is truncated (which for a large store is
// always), so it was the largest per-call stall the extension produced.
//
// Two memos, both validated on every use by a single lstat of the file they
// describe:
//
//   topicTextCache     body text per topic file, already lowercased and
//                      tokenised the way rankEntries consumes it, so a repeat
//                      query re-reads and re-tokenises nothing. The same entry
//                      also holds the file's frontmatter `type` — see below.
//   cachedParseIndex   the parsed MEMORY.md, so a repeat query does not re-read
//                      554 KB and re-resolve 2,767 hrefs (one lstat each).
//
// The type facet exists for the WRITE path. Every publish asks the fit planner
// for `isRule()` once per distinct topic, and the writer answered each of those
// by reading and parsing the whole topic file to learn one frontmatter field.
// Three consecutive live stall reports put the busiest frame of a 336-456 ms
// event-loop delay inside exactly that chain (readFileUtf8 <- readFileSync <-
// topicIsRule <- isRule <- ruleOf <- clusterOfFile <- fitIndexToExcerpt <-
// publish), at 16-19% of the slice. Both facets come from one parse of one
// read, so they share an entry and a freshness key: whichever path reads a
// topic first fills in what it learned, and neither can be served for a version
// the other has seen expire. Measured on a copy of the live store: a second
// publish in the same process drops from 2,797 topic reads to 1 (the one topic
// it just wrote) while its stat count is unchanged, and from 99.3 ms to 57.7 ms
// wall (median of 5 runs, load average 3.4-4.4).
//
// What is retained, and what the ceiling is — this is a long-lived interactive
// process, and an unbounded per-store token cache would be a slower leak than
// the stall it fixes:
//
//   * per topic: the body string, its lowercased copy, and one array slot per
//     token. The token STRINGS are shared through an intern table, so a token
//     that occurs in 500 entries is stored once. Estimated cost per entry is
//     `2 * (body.length + lowered.length) + 15 * tokens.length` bytes — see
//     estimatedBytes for the coefficients and how they were measured — plus a
//     fixed ENTRY_BYTES for the entry itself. That fixed charge is what keeps
//     the budget meaningful for a frontmatter-only entry, which retains no body
//     at all: without it, a long-lived process that touched many topics would
//     hold one map slot per path under a byte budget it never filled.
//   * `maxBytes` (default 24 MiB estimated) caps the entries. Eviction is
//     insertion-ordered (FIFO) — no touch-on-read bookkeeping, so a hit costs
//     nothing. The live store (2,796 topics, 2.4 MiB of bodies) estimates at
//     11.5 MiB / 12.1 MB: 10.99 MiB of body text plus 0.51 MiB of the per-entry
//     charge (4,312 bytes per topic on average).
//   * the intern table is capped separately (200,000 distinct tokens). Past
//     that cap the whole memo is dropped: rare, correct, and only ever costs a
//     cold first query.
//
// Ceiling: the live store retains 12.4 MB measured (heapUsed after gc with the
// cache filled, minus the same after clearing it). Interning is what keeps it
// there — without it the same store retains 17.9 MB; bodies and lowered text
// alone account for 8.2 MB of that. The 24 MiB budget is ~2x the live store, so
// the ceiling is ~26 MB of retained heap for a store twice this size.
//
// Correctness does NOT depend on the bound. A miss is never "no body" — it is
// a real read through the same guards, so eviction can only make a query pay
// full price for the files it lost, never change which bodies are searchable
// or the order they rank in. That is why the FIFO order is allowed to be
// arbitrary.
//
// Freshness is mtime + size + inode, checked against a stat taken by the same
// lstat the read path already performs for containment. Any write — this
// process's (which also invalidates explicitly, covering same-millisecond
// rewrites) or Claude Code's — moves the mtime, and an atomic rename also
// changes the inode, so both invalidate naturally. The entry is keyed on the
// stat taken BEFORE the read: content read after a concurrent change is newer
// than its key, which can only cause a spurious re-read later, never a stale
// body served.
//
// Cost of filling it, measured on the live store: the FIRST query in a process
// costs ~110 ms more CPU than before the memo existed (210 -> 320 ms CPU,
// 140 -> 190 ms wall) because the tokens it retains are promoted out of the
// young generation instead of being collected with the query. Every query after
// that costs ~97 ms less (142 -> 45 ms CPU, 120 -> 37 ms wall), so the memo pays
// for itself on the second search of a session. A store that outgrows the
// budget degrades smoothly: evicted entries are simply re-read.

import { lstatSync } from "node:fs";
import type { PreparedText } from "./find-rank.js";
import { parseIndexFile } from "./index-parser.js";
import type { MemoryDir, MemoryType, ParsedIndex } from "./types.js";
import { INDEX_MAX_BYTES } from "./types.js";

/** What a cached body must match to be served. `ino` catches a same-size,
 * same-millisecond replacement (atomic rename writes a new inode). */
export interface FileFacts {
  mtimeMs: number;
  size: number;
  ino: number;
}

/** A searchable body, as the scorer wants it. */
export interface CachedTopicText {
  /** Body after frontmatter, verbatim. */
  body: string;
  /** `body` lowercased and tokenised — what `prepareText(body)` produces. */
  prepared: PreparedText;
}

/** The one frontmatter field the write path needs, from the same parse that
 * produced a {@link CachedTopicText}. */
export interface CachedTopicType {
  /** `parseMemoryContent(...).type` — the declared type, or null when the file
   * declares none and its name does not imply one. */
  type: MemoryType;
}

export interface TopicCache {
  /** The cached text, or null when absent, describing a different version, or
   * cached by a caller that only recorded the frontmatter type. */
  get(filePath: string, facts: FileFacts): CachedTopicText | null;
  /** The cached frontmatter type, or null on the same conditions as {@link get}. */
  getType(filePath: string, facts: FileFacts): CachedTopicType | null;
  /** Retain one body under `facts`, plus the frontmatter type from the same
   * parse. The stored arrays are frozen, so a caller that keeps the reference
   * cannot mutate what a later reader sees. */
  set(filePath: string, facts: FileFacts, text: CachedTopicText, type: MemoryType): void;
  /** Retain just the frontmatter type under `facts` — what the write path's rule
   * check records, so a publish does not pay for a body no query asked for. */
  setType(filePath: string, facts: FileFacts, type: MemoryType): void;
  /** Drop one file: what a write from this process calls, so a rewrite cannot
   * be served from a body read before it. */
  invalidate(filePath: string): void;
  clear(): void;
  stats(): TopicCacheStats;
}

export interface TopicCacheStats {
  entries: number;
  /** Estimated retained bytes of the cached entries (see the header). */
  bytes: number;
  /** Distinct token strings held by the intern table. */
  interned: number;
}

/** Default ceiling on cached entries, in estimated bytes. */
export const TOPIC_CACHE_MAX_BYTES = 24 * 1024 * 1024;
/** Ceiling on distinct interned token strings. */
export const TOPIC_CACHE_MAX_INTERNED = 200_000;

/** Per-token retained bytes, measured: 289,611 interned tokens cost 4.4 MB
 * (12.4 MB retained with tokens, 8.2 MB with bodies and lowered text alone),
 * i.e. an 8-byte array slot plus a share of the shared string table. */
const TOKEN_BYTES = 15;
/** Retained bytes of an entry that are not its text: the map slot, the absolute
 * path key, the facts and the two facet objects. Charged to every entry so an
 * entry holding only a frontmatter type (a few bytes) is still bounded by the
 * byte budget rather than by the number of paths a process happens to touch. */
const ENTRY_BYTES = 192;
/** Characters are not bytes: the measured store keeps 3.56 M chars of body and
 * lowered text in 8.0 MB, so V8 held them as two-byte strings. Counting two
 * bytes per character keeps this an over-estimate rather than an under-estimate. */
const CHARS_TO_BYTES = 2;

function estimatedBytes(text: CachedTopicText): number {
  return (
    ENTRY_BYTES +
    CHARS_TO_BYTES * (text.body.length + text.prepared.lowered.length) +
    TOKEN_BYTES * text.prepared.tokens.length
  );
}

interface Entry {
  facts: FileFacts;
  /** Body facet, present once a search prepared this version. */
  text: CachedTopicText | null;
  /** Frontmatter facet, present once anything parsed this version. */
  frontmatter: CachedTopicType | null;
  bytes: number;
}

function sameFacts(a: FileFacts, b: FileFacts): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

/** Create a memo with its own budget, intern table and eviction order.
 *
 * A factory rather than a module constant so the bounds are testable: the
 * production instance ({@link topicTextCache}) takes the defaults, a test
 * builds one small enough to evict. */
export function createTopicCache(
  options: { maxBytes?: number; maxInterned?: number } = {},
): TopicCache {
  const maxBytes = options.maxBytes ?? TOPIC_CACHE_MAX_BYTES;
  const maxInterned = options.maxInterned ?? TOPIC_CACHE_MAX_INTERNED;
  // Insertion-ordered: the first key is the oldest, which is what eviction
  // takes. Touching a key does not reorder it (a hit is read-only work).
  const entries = new Map<string, Entry>();
  const vocab = new Map<string, string>();
  let bytes = 0;

  const drop = (filePath: string): void => {
    const entry = entries.get(filePath);
    if (!entry) return;
    entries.delete(filePath);
    bytes -= entry.bytes;
  };

  /** Share one string per distinct token, so the retained cost of a token is
   * its array slot rather than a fresh string per occurrence. */
  const intern = (tokens: readonly string[]): readonly string[] => {
    const out: string[] = new Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as string;
      const held = vocab.get(token);
      if (held === undefined) {
        if (vocab.size >= maxInterned) {
          // Turning over more distinct tokens than the table can hold means
          // the store itself has changed shape; start cold rather than grow.
          entries.clear();
          vocab.clear();
          bytes = 0;
          vocab.set(token, token);
          out[i] = token;
          continue;
        }
        vocab.set(token, token);
        out[i] = token;
      } else {
        out[i] = held;
      }
    }
    return Object.freeze(out);
  };

  /** The entry, or null when absent or holding a different version of the file
   * (which is dropped, so the caller's re-read is recorded cleanly). */
  const live = (filePath: string, facts: FileFacts): Entry | null => {
    const entry = entries.get(filePath);
    if (!entry) return null;
    if (!sameFacts(entry.facts, facts)) {
      // Changed on disk: hold the budget while the caller re-reads it.
      drop(filePath);
      return null;
    }
    return entry;
  };

  const evictToBudget = (): void => {
    for (const oldest of entries.keys()) {
      if (bytes <= maxBytes) break;
      drop(oldest);
    }
  };

  return {
    get(filePath, facts) {
      return live(filePath, facts)?.text ?? null;
    },
    getType(filePath, facts) {
      return live(filePath, facts)?.frontmatter ?? null;
    },
    set(filePath, facts, text, type) {
      const size = estimatedBytes(text);
      // Size is measured before interning so a file that will not be cached
      // cannot leave its tokens behind in the shared table.
      if (size > maxBytes) {
        drop(filePath); // never cache something that alone blows the budget
        return;
      }
      const frozenText: CachedTopicText = Object.freeze({
        body: text.body,
        prepared: Object.freeze({
          lowered: text.prepared.lowered,
          tokens: intern(text.prepared.tokens),
        }),
      });
      const frontmatter: CachedTopicType = Object.freeze({ type });
      // Read the entry AFTER interning: filling the intern table past its cap
      // clears every entry, so a reference taken before it can be stale.
      const sameVersion = live(filePath, facts);
      if (sameVersion) {
        // Same version, new facet: keep the FIFO slot rather than moving a busy
        // entry to the young end of the eviction order.
        bytes += size - sameVersion.bytes;
        sameVersion.text = frozenText;
        sameVersion.frontmatter = frontmatter;
        sameVersion.bytes = size;
      } else {
        entries.set(filePath, { facts, text: frozenText, frontmatter, bytes: size });
        bytes += size;
      }
      evictToBudget();
    },
    setType(filePath, facts, type) {
      const frontmatter: CachedTopicType = Object.freeze({ type });
      const sameVersion = live(filePath, facts);
      if (sameVersion) {
        // Same version: record the type and leave the body (and the FIFO slot)
        // alone. Neither facet can disagree with the other — both come from one
        // parse of the same bytes.
        sameVersion.frontmatter = frontmatter;
        return;
      }
      entries.set(filePath, { facts, text: null, frontmatter, bytes: ENTRY_BYTES });
      bytes += ENTRY_BYTES;
      evictToBudget();
    },
    invalidate(filePath) {
      drop(filePath);
    },
    clear() {
      entries.clear();
      vocab.clear();
      bytes = 0;
    },
    stats() {
      return { entries: entries.size, bytes, interned: vocab.size };
    },
  };
}

/** The process-wide topic memo. One instance for every store this process
 * searches; entries are keyed by absolute path, so stores cannot collide.
 *
 * One budget serves every store, deliberately: a session that alternates
 * between two large stores competes for the same 24 MiB, and the loser's
 * entries are re-read. Correctness is unaffected — a miss is always a real
 * read — so the worst case is slower queries, not different answers. */
export const topicTextCache = createTopicCache();

/** Facts from a stat/lstat result, in the shape the memo validates on. */
export function factsOf(st: { mtimeMs: number; size: number; ino: number }): FileFacts {
  return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
}

/** Parsed MEMORY.md memos, one per index path. */
interface IndexMemo {
  facts: FileFacts;
  parsed: ParsedIndex;
}
const indexMemos = new Map<string, IndexMemo>();
/** Bounds the index memo. A process resolves one store per project; the cap
 * only stops a pathological multi-store caller from growing it. */
const INDEX_MEMO_MAX = 8;

/** `parseIndexFile`, memoised on (path, mtime, size, inode).
 *
 * Same guards, same rejections as parseIndexFile: a symlink, a non-regular
 * file, or an oversize index is refused exactly as before (and the memo is
 * dropped, so the next query re-reads). Returns a COPY of the two arrays, so a
 * caller can never mutate the parse a later query is served from; the entries
 * inside are treated as immutable value objects throughout this codebase. */
export function cachedParseIndex(dir: MemoryDir): ParsedIndex | null {
  let st: import("node:fs").Stats;
  try {
    st = lstatSync(dir.indexPath);
  } catch {
    indexMemos.delete(dir.indexPath);
    return null;
  }
  const refused = st.isSymbolicLink() || !st.isFile() || st.size > INDEX_MAX_BYTES;
  const facts = factsOf(st);
  const memo = indexMemos.get(dir.indexPath);
  if (!refused && memo && sameFacts(memo.facts, facts)) {
    return { lines: [...memo.parsed.lines], entries: [...memo.parsed.entries] };
  }
  const parsed = parseIndexFile(dir);
  if (parsed === null) {
    indexMemos.delete(dir.indexPath);
    return null;
  }
  indexMemos.delete(dir.indexPath);
  indexMemos.set(dir.indexPath, { facts, parsed });
  while (indexMemos.size > INDEX_MEMO_MAX) {
    const oldest = indexMemos.keys().next().value;
    if (oldest === undefined) break;
    indexMemos.delete(oldest);
  }
  return { lines: [...parsed.lines], entries: [...parsed.entries] };
}

/** Drop the memo for one index path. Exported for tests and for a caller that
 * knows it just rewrote the index. */
export function invalidateCachedIndex(indexPath: string): void {
  indexMemos.delete(indexPath);
}
