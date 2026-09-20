// Shared types for pi-claude-memory

/** Maximum bytes read from a single topic file.
 *
 * Enforced on BOTH read paths: the injector (before bytes enter the system
 * prompt) and readMemory (the recall_memory tool, which the routing anchor
 * explicitly directs the model to use for ⟨index-only⟩ entries). Keeping one
 * constant in a shared module is the point — the two paths drifting is how
 * the tool side ended up uncapped while the injector side was bounded.
 */
export const TOPIC_FILE_MAX_BYTES = 1_000_000;

/** Maximum bytes read from a MEMORY.md index.
 *
 * Shared by the parser (which refuses to parse an oversize index) and the
 * writer (which refuses to read-then-publish over one). An index that grows
 * past this cap poisons every entry in that tier, so it must fail loudly on
 * both sides rather than being appended to until it silently stops parsing.
 */
export const INDEX_MAX_BYTES = 1_000_000;

/** Claude Code's documented startup excerpt limit for MEMORY.md: the first 200
 * lines or the first 25KB, whichever binds first.
 *
 * Distinct from INDEX_MAX_BYTES above, and the distinction matters. That cap is
 * a write-side safety bound on the whole index; this one is how much of the
 * index reaches a prompt. Substituting one for the other in either direction
 * either truncates a store the writer considers perfectly healthy, or lets a
 * single oversized store flood the context window. */
export const INDEX_STARTUP_MAX_LINES = 200;
export const INDEX_STARTUP_MAX_BYTES = 25_000;

/** Memory tier: project-specific or global (cross-project). */
export type MemoryTier = "project" | "global";

/** The 3 known frontmatter type values. null = untyped/no frontmatter. */
export type MemoryType = "feedback" | "reference" | "project" | "user" | null;

/**
 * A resolved memory directory.
 * dir is the filesystem path containing MEMORY.md and topic .md files.
 * For the project tier, memoryFile is the path to MEMORY.md (may be at dir root
 * or under a memory/ subdirectory — Claude Code uses both layouts).
 */
export interface MemoryDir {
  tier: MemoryTier;
  /** Directory containing the topic .md files. */
  dir: string;
  /** Path to MEMORY.md index file. */
  indexPath: string;
  /** Human-readable label for this tier (project name or "Global"). */
  label: string;
}

/** Parsed frontmatter from a memory topic file. */
export interface ParsedFrontmatter {
  /** Entry name (slug). Falls back to filename without .md. */
  name: string;
  /** One-line description. May be empty. */
  description: string;
  /** Memory type. null if not present. */
  type: MemoryType;
  /** Priority 1-5 (5=highest). null if not set in frontmatter. */
  priority: number | null;
  /** ISO timestamp of last modification. Falls back to file mtime. */
  modified: string;
  /** Whether this entry carries a pin marker.
   *
   * METADATA ONLY under the bounded-index contract. Nothing is injected in
   * full any more, so a pin does not bypass a size limit, does not affect
   * admission order, and is not promoted out of the startup cutoff. Claude
   * Code ignores the flag entirely (it injects no pinned memories in the
   * observed configuration). It is preserved for round-trip fidelity and for
   * the ⛔ marker in MEMORY.md. */
  pinned: boolean;
  /** The raw frontmatter object for round-trip preservation. */
  raw: Record<string, unknown>;
  /** Whether any frontmatter was present at all. */
  hasFrontmatter: boolean;
  /** The markdown body (everything after frontmatter). */
  body: string;
}

/** A link entry parsed from MEMORY.md. */
export interface IndexEntry {
  /** Display text from the [brackets]. */
  title: string;
  /** Filename from the (parentheses). May be relative or absolute. */
  href: string;
  /** Resolved absolute path to the topic file. */
  filePath: string;
  /** Summary text after the dash. */
  summary: string;
  /** Whether this entry has a pin marker (⛔ or [pin]). */
  pinned: boolean;
  /** Line number in MEMORY.md (1-indexed). */
  lineNumber: number;
}

/** A non-link line from MEMORY.md (headers, prose, emoji markers). */
export interface IndexLine {
  text: string;
  lineNumber: number;
}

/** Parsed MEMORY.md content: interleaved link entries and raw lines. */
export interface ParsedIndex {
  /** All lines in order, typed as entry or line. */
  lines: (IndexEntry | IndexLine)[];
  /** Just the link entries. */
  entries: IndexEntry[];
}

/** A topic file loaded from disk. */
export interface MemoryFile {
  /** Filename relative to the memory dir. */
  filename: string;
  /** Absolute path. */
  filePath: string;
  /** Parsed frontmatter + body. */
  frontmatter: ParsedFrontmatter;
  /** File size in bytes. */
  size: number;
  /** File mtime in milliseconds. */
  mtime: number;
  /** Total line count. */
  lineCount: number;
}

/** Result of resolving memory dirs for a given cwd. */
export interface ResolveResult {
  /** Project memory dir, or null if no project memory exists. */
  project: MemoryDir | null;
  /** Global memory dir (always exists if ~/.claude/memory/ does). */
  global: MemoryDir | null;
  /** Warnings encountered during resolution. */
  warnings: string[];
  /**
   * Stores whose encoded name ends with this cwd's basename, reported ONLY
   * when no exact store resolved for this project. These look like this
   * project's old paths (a rename or move), but suffix matching cannot
   * distinguish that from an unrelated project whose basename ends the same
   * way, so they are surfaced for the user to adopt deliberately — never
   * matched implicitly, and never written to.
   */
  orphanStores?: string[];
}
