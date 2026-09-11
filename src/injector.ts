// Injector: bimodal memory injection into Pi's system prompt
//
// Strategy:
// 1. Always inject the routing anchor (even when no memory exists yet)
// 2. Always inject MEMORY.md content (index entries + hand-authored sections)
// 3. Greedily inject full file bodies up to a token cap (default 5000)
// 4. Priority: pinned entries → feedback/user type → most recently modified
// 5. Large files get index-only with ⟨index-only⟩ marker (model can fetch via recall_memory)
// 6. Project tier injected first so it wins the shared budget (see buildMemoryInjection)

import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { debugLog } from "./debug-log.js";
import { parseMemoryContent } from "./frontmatter.js";
import { parseIndexFile, reconcileIndex } from "./index-parser.js";
import type { IndexEntry, IndexLine, MemoryDir, MemoryFile, MemoryType } from "./types.js";
import { TOPIC_FILE_MAX_BYTES } from "./types.js";

const DEFAULT_TOKEN_CAP = 5000;
const CHARS_PER_TOKEN = 4; // rough estimate
const SMALL_FILE_LINE_THRESHOLD = 60; // files with <= this many lines are candidates for full injection

/**
 * Routing anchor for when memory entries exist. Tells the model how to use
 * memory tools and how they coexist with ctx_search.
 *
 * Matches context-mode's terse, directive arrow-syntax.
 *
 * The reviewer sentence is generated per-session rather than hardcoded: with
 * autoLearn disabled the model is the ONLY writer, and telling it to withhold
 * routine memories in favour of a reviewer that never runs is a silent
 * memory-loss mode. The interval is likewise real config, not the literal 10.
 */
export const MEMORY_ROUTING_ANCHOR = `pi-claude-memory active. The memory below is already in context — never re-read a loaded entry.
Index entry marked ⟨index-only⟩ → recall_memory(name); unmarked entries are already in full.
Entry marked ⟨missing⟩ → its file is gone from disk; do not call recall_memory for it.
Entry marked ⟨unavailable⟩ → present on disk but not readable as a memory; do not call recall_memory for it.
An entry tagged [in global tier] lives in the global store, so pass that tier to recall_memory.
User correction, stated preference, or verified fix → write_memory this turn.{{REVIEWER}}
Memory that is now wrong → remove_memory (never leave it to rot).
Durable facts across sessions → the index below.
What happened in a prior session (errors, commands, prompts) → ctx_search.
Never store ephemeral state, TODOs, or commit hashes.`;

/**
 * Short anchor for when no memory entries exist yet (new project).
 * Just tells the model the system is active and what qualifies for write_memory.
 */
export const MEMORY_ROUTING_ANCHOR_EMPTY = `pi-claude-memory active. No memories yet for this project.
User correction, stated preference, or verified fix → write_memory.{{REVIEWER}}
Never store ephemeral state, TODOs, or commit hashes.`;

/** Describe the reviewer honestly for the current config. */
export function reviewerClause(autoLearn: boolean, reviewIntervalTurns: number): string {
  if (!autoLearn) {
    return " Nothing sweeps this conversation automatically — write_memory is the only way a fact survives.";
  }
  return ` A background reviewer sweeps the conversation every ${reviewIntervalTurns} turns for everything else — don't duplicate it.`;
}

/** Fill in the reviewer sentence for the resolved config. */
function withReviewer(template: string, autoLearn: boolean, reviewIntervalTurns: number): string {
  return template.replace("{{REVIEWER}}", reviewerClause(autoLearn, reviewIntervalTurns));
}

/** Result of building an injection block for a tier. */
export interface InjectionBlock {
  /** The formatted markdown to append to the system prompt. */
  text: string;
  /** Set of file paths loaded in full (for index marker rendering). */
  loadedPaths: Set<string>;
  /** Number of topic files loaded in full. */
  filesLoaded: number;
  /** Estimated token count for this block (full text only, excludes index). */
  tokens: number;
  /** Whether this tier has any index entries (even if none loaded in full). */
  hasEntries: boolean;
  /** Warnings (missing files, unindexed files, etc.) */
  warnings: string[];
}

/**
 * Build the full memory injection text for both tiers.
 * Returns the combined text to append to event.systemPrompt.
 * Always returns the routing anchor even when no memory blocks exist,
 * so the model knows write_memory is available for new projects.
 *
 * @param project Project memory dir, or null
 * @param global Global memory dir, or null
 * @param tokenCap Total token budget shared across BOTH tiers (not per-tier)
 * @param hasCtxSearch Whether ctx_search tool is registered (gates the
 *        ctx_search clause in the anchor). When false, the clause is omitted
 *        so the anchor doesn't reference an unavailable tool.
 * @param autoLearn Whether the background reviewer is enabled. When false the
 *        anchor must NOT promise a reviewer that never runs, or the model
 *        withholds routine memories from a sweep that does not exist.
 * @param reviewIntervalTurns Interval stated in the anchor when autoLearn is
 *        on, so the prompt matches the configured cadence rather than a
 *        hardcoded value.
 */
export function buildMemoryInjection(
  project: MemoryDir | null,
  global: MemoryDir | null,
  tokenCap = DEFAULT_TOKEN_CAP,
  hasCtxSearch = true,
  autoLearn = true,
  reviewIntervalTurns = 10,
): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const blocks: string[] = [];

  // Shared mutable budget across both tiers. Project tier goes first so it
  // wins when competing for the same budget.
  const budget = { remaining: tokenCap, total: tokenCap };
  let hasAnyEntries = false;
  // Cumulative set of topic paths whose bodies are already in this prompt.
  // Shared across tiers so a topic reached by BOTH indexes — a project index
  // may link an absolute href into the global store, and the global index
  // lists the same file relatively — is injected once. Previously each tier
  // built its own set, so the file's body was emitted twice AND charged twice
  // against the shared budget. It is also the set the index renderer consults,
  // so the second tier marks the entry as already-present instead of
  // ⟨index-only⟩ when the body is in fact there.
  const alreadyLoaded = new Set<string>();

  // Prepare BOTH tiers (loading their full text and consuming the shared
  // budget) before rendering EITHER index. Rendering as we went meant the first
  // tier's index was written against a loadedPaths set that could not yet
  // include a body the second tier was about to inject: a cross-tier entry
  // could sit in the prompt in full AND still be advertised as ⟨index-only⟩,
  // inviting a recall_memory call for text already in context — the one thing
  // the anchor tells the model never to do.
  const prepared: PreparedTier[] = [];
  if (project) {
    prepared.push(
      prepareTier(project, project.label, budget, warnings, global?.dir, alreadyLoaded),
    );
  }
  if (global) {
    prepared.push(prepareTier(global, "Global", budget, warnings, project?.dir, alreadyLoaded));
  }

  const knownDirs: MemoryDir[] = [];
  if (project) knownDirs.push(project);
  if (global) knownDirs.push(global);
  for (const tier of prepared) {
    const text = renderTier(tier, alreadyLoaded, knownDirs, sep);
    if (text) blocks.push(text);
    if (tier.hasEntries) hasAnyEntries = true;
  }

  // Choose anchor variant based on whether any entries exist, and state the
  // reviewer situation truthfully for the resolved config.
  const anchor = withReviewer(
    hasAnyEntries ? MEMORY_ROUTING_ANCHOR : MEMORY_ROUTING_ANCHOR_EMPTY,
    autoLearn,
    reviewIntervalTurns,
  );

  // Gate the ctx_search clause when the tool isn't registered.
  //
  // That clause lives on its OWN line in the template. It used to share a line
  // with "Durable facts across sessions → the index below.", so this strip
  // deleted the sentence explaining what the injected index is FOR — the model
  // lost the index guidance as collateral damage from hiding a tool it has no
  // access to.
  const finalAnchor = hasCtxSearch ? anchor : anchor.replace(/\n.*ctx_search\..*$/m, "");

  debugLog("injector.build", {
    hasProject: !!project,
    hasGlobal: !!global,
    hasAnyEntries,
    hasCtxSearch,
    tokenCap,
    warningCount: warnings.length,
    textLength: `\n\n## Memory\n\n${finalAnchor}\n\n${blocks.join("\n\n")}`.trimEnd().length,
  });

  return {
    text: `\n\n## Memory\n\n${finalAnchor}\n\n${blocks.join("\n\n")}`.trimEnd(),
    warnings,
  };
}

/** A tier whose full text has been loaded, awaiting index rendering.
 *
 * The index is rendered in a SECOND pass (see buildMemoryInjection) so it can
 * be written against the complete loadedPaths set, and can mark entries that
 * reconcileIndex found missing. */
interface PreparedTier {
  dir: MemoryDir;
  label: string;
  parsed: ReturnType<typeof parseIndexFile>;
  /** Canonical paths of index entries whose file is gone (from reconcileIndex). */
  missing: Set<string>;
  /** Canonical paths present on disk but NOT injectable, so a fetch would fail. */
  unfetchable: Set<string>;
  fullTextSection: string;
  loadedPaths: Set<string>;
  tokens: number;
  hasEntries: boolean;
}

/** Load a tier's topic files and consume budget. Mutates the shared budget.
 *
 * Rendering is deliberately NOT done here: it must wait until every tier has
 * loaded, so ⟨index-only⟩ reflects the finished prompt rather than a
 * half-built one. */
function prepareTier(
  dir: MemoryDir,
  label: string,
  budget: { remaining: number; total: number },
  warnings: string[],
  otherTierDir?: string | null,
  alreadyLoaded: Set<string> = new Set(),
): PreparedTier {
  const parsed = parseIndexFile(dir);
  if (!parsed) {
    return {
      dir,
      label,
      parsed: null,
      missing: new Set(),
      unfetchable: new Set(),
      fullTextSection: "",
      loadedPaths: new Set(),
      tokens: 0,
      hasEntries: false,
    };
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
  // otherTierDir approves cross-tier absolute hrefs (a project index linking
  // to a global topic) while rejecting everything outside the two stores.
  const { files, unfetchable } = loadTopicFiles(
    dir,
    parsed.entries.map((e) => e.filePath),
    otherTierDir,
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
  } = buildFullTextSection(files, parsed.entries, budget, warnings, alreadyLoaded);

  debugLog("injector.tier", {
    label,
    entryCount: parsed.entries.length,
    filesLoaded: loadedPaths.size,
    tokensUsed: tokens,
    budgetRemaining: budget.remaining,
    missingCount: recon.missing.length,
    unindexedCount: recon.unindexed.length,
  });

  return {
    dir,
    label,
    parsed,
    missing: new Set(recon.missing.map((e) => e.filePath)),
    unfetchable,
    fullTextSection,
    loadedPaths,
    tokens,
    hasEntries: parsed.entries.length > 0,
  };
}

/** Render one prepared tier: header, index, and full text.
 *
 * Runs after every tier has loaded, so the index is marked against the
 * COMPLETE set of bodies in this prompt.
 *
 * `knownDirs` is used to say which store actually OWNS an entry. A project
 * index can link a global topic by absolute href, and without the annotation
 * the entry renders under "Memory (<project>)" with nothing to say otherwise —
 * so a model that reads that heading and calls recall_memory with the project
 * tier gets "not found" for a file sitting one tier away. */
function renderTier(
  tier: PreparedTier,
  loadedPaths: Set<string>,
  knownDirs: MemoryDir[],
  separator: string,
): string {
  if (!tier.parsed) return "";

  const indexSection = renderIndexSection(
    tier.parsed,
    { loaded: loadedPaths, missing: tier.missing, unfetchable: tier.unfetchable },
    (filePath) => owningTierOf(filePath, knownDirs, tier.dir, separator),
  );

  const parts: string[] = [];
  parts.push(`### Memory (${tier.label})\n`);
  if (indexSection) {
    parts.push(`#### Index\n\n${indexSection}`);
  }
  if (tier.fullTextSection) {
    parts.push(`#### Full Text (always loaded)\n\n${tier.fullTextSection}`);
  }
  return parts.join("\n");
}

/** Canonicalize a path for containment comparison (realpath, lexical fallback). */
function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Which resolved store owns this topic, or null if it belongs to none of
 * them.
 *
 * Both sides are canonicalized: entry paths come from resolveHref, which
 * realpath's the target, while MemoryDir.dir is built lexically from homedir().
 * Comparing a canonical path against a lexical root silently fails whenever a
 * store component is a symlink, which would drop every annotation. */
function owningTierOf(
  filePath: string,
  knownDirs: MemoryDir[],
  linkingDir: MemoryDir,
  separator: string,
): MemoryDir | null {
  const target = canonicalizePath(filePath);
  let owner: MemoryDir | null = null;
  for (const d of knownDirs) {
    const root = canonicalizePath(d.dir);
    if (target === root || target.startsWith(`${root}${separator}`)) {
      owner = d;
      break;
    }
  }
  if (!owner) return null;
  // Only worth annotating when it is NOT the tier this index belongs to.
  return canonicalizePath(owner.dir) === canonicalizePath(linkingDir.dir) ? null : owner;
}

/** Load topic files from disk, keyed by filePath.
 *
 * Read-side containment: index hrefs resolve to arbitrary paths (including
 * absolute cross-tier links), so each file is validated against the
 * approved memory roots (its own tier's dir plus the other tier's dir),
 * must be a plain regular file, and must be under the size cap — all BEFORE
 * any bytes are read into what becomes the system prompt.
 *
 * Containment is checked on the CANONICAL path (realpathSync), not the
 * lexical one: `resolve()` is pure string math, so a symlinked DIRECTORY
 * inside the store (memory/bridge -> /) passes a lexical check and then
 * has its children injected. Both sides are canonicalized — the memory
 * roots themselves may live behind a symlink (a dotfiles-managed
 * ~/.claude, for instance), so canonicalizing only the candidate would
 * reject every legitimate file.
 *
 * The final read goes through an open file descriptor that is fstat'd, so
 * the regular-file and size checks and the bytes come from the SAME inode;
 * a pathname check followed by a pathname read is two lookups that a
 * concurrent swap can desynchronize. */
function loadTopicFiles(
  dir: MemoryDir,
  filePaths: string[],
  otherTierDir?: string | null,
): { files: Map<string, MemoryFile>; unfetchable: Set<string> } {
  // Canonicalize the approved roots once. A root that cannot be realpath'd
  // (does not exist yet) simply cannot contain anything.
  const allowedRoots: string[] = [];
  for (const root of [dir.dir, otherTierDir]) {
    if (!root) continue;
    try {
      allowedRoots.push(realpathSync(root));
    } catch {
      // root missing — contributes no allowed prefix
    }
  }
  const files = new Map<string, MemoryFile>();
  // Paths that ARE on disk but that we refuse to inject. They are not
  // "missing", and they are not fetchable either, so the index must not
  // advertise them the way it advertises an entry whose body simply did not fit.
  const unfetchable = new Set<string>();
  for (const filePath of filePaths) {
    try {
      // Canonical path: follows symlinks in EVERY component, and doubles as
      // the existence check (realpath throws ENOENT for a missing file).
      const realPath = realpathSync(filePath);
      // Containment against canonical roots. A path resolving outside every
      // store is skipped before any read — whether it got there via ../, an
      // absolute href, or a symlinked intermediate directory.
      const contained = allowedRoots.some(
        (r) => realPath === r || realPath.startsWith(`${r}${sep}`),
      );
      if (!contained) {
        debugLog("injector.topic_containment_reject", { filePath, realPath, tier: dir.tier });
        unfetchable.add(realPath);
        continue;
      }
      const filename = basename(realPath);
      // Skip MEMORY.md itself
      if (filename === "MEMORY.md") continue;
      // Open once, then validate and read the same inode.
      let fd: number;
      try {
        // O_NONBLOCK matters here. Opening a FIFO for read BLOCKS until some
        // writer opens the other end, so a FIFO named *.md and linked from the
        // index hung prompt construction forever — the regular-file check
        // below was never reached because the open never returned. With
        // O_NONBLOCK the open returns immediately and fstatSync rejects the
        // descriptor as non-regular. The descriptor-based check is kept
        // deliberately: it validates the very inode we then read.
        fd = openSync(realPath, constants.O_RDONLY | constants.O_NONBLOCK);
      } catch {
        // A failed open leaves the path known, so it can still be marked
        // unfetchable below rather than advertised as fetchable.
        unfetchable.add(realPath);
        continue;
      }
      let content: string;
      let mtime = 0;
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) {
          debugLog("injector.topic_not_regular_file", { filePath, realPath, tier: dir.tier });
          unfetchable.add(realPath);
          continue;
        }
        if (st.size > TOPIC_FILE_MAX_BYTES) {
          debugLog("injector.topic_oversize_skip", {
            filePath,
            size: st.size,
            cap: TOPIC_FILE_MAX_BYTES,
          });
          unfetchable.add(realPath);
          continue;
        }
        mtime = st.mtimeMs;
        content = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
      const frontmatter = parseMemoryContent(content, filename, mtime);
      files.set(realPath, {
        filename,
        filePath: realPath,
        frontmatter,
        size: content.length,
        mtime,
        lineCount: content.split("\n").length,
      });
    } catch {
      // Skip unreadable files. No unfetchable entry: realpathSync itself threw,
      // so there is no canonical key to mark, and reconcileIndex already reports
      // such an entry as missing.
    }
  }
  return { files, unfetchable };
}

/** Render the MEMORY.md index section (all lines, preserving structure).
 *  Entries whose bodies are NOT loaded in full are marked ⟨index-only⟩. */
/** The fetch marker for one index entry.
 *
 * A file reconcileIndex found missing is NOT fetchable, so it must not be
 * marked ⟨index-only⟩ (what it used to get, since a missing file is never in
 * loadedPaths) — that told the model to call recall_memory every turn for
 * something guaranteed to fail. */
/** The fetchability sets an index line is judged against. Bundled because
 *  they are always consulted together, and three parallel sets in a signature
 *  is a standing invitation to pass them in the wrong order. */
interface FetchState {
  loaded: Set<string>;
  missing: Set<string>;
  unfetchable: Set<string>;
}

function markerFor(filePath: string, fetch: FetchState): string {
  if (fetch.missing.has(filePath)) return " ⟨missing⟩";
  if (fetch.loaded.has(filePath)) return "";
  // Present on disk but not injectable: a non-regular file, a file over the
  // size cap, or one resolving outside both stores. recall_memory refuses these
  // for the same reasons, so ⟨index-only⟩ would send the model to a tool call
  // that cannot succeed — the class ⟨missing⟩ already fixed, one branch short.
  if (fetch.unfetchable.has(filePath)) return " ⟨unavailable⟩";
  return " ⟨index-only⟩";
}

function renderIndexSection(
  parsed: { lines: (IndexEntry | IndexLine)[] },
  fetch: FetchState,
  ownerOf: (filePath: string) => MemoryDir | null,
): string {
  return parsed.lines
    .map((line) => {
      if ("title" in line) {
        // IndexEntry — reconstruct the link line
        const pin = line.pinned ? "⛔ " : "";
        // A file that is missing, or present but rejected by the same guards
        // recall_memory applies, is NOT fetchable. Marking either ⟨index-only⟩
        // (what they used to get, since neither is ever in loadedPaths) told the
        // model to call recall_memory for it every single turn, and that call
        // was guaranteed to fail.
        const marker = markerFor(line.filePath, fetch);
        const owner = ownerOf(line.filePath);
        const ownerNote = owner ? ` [in ${owner.tier} tier]` : "";
        return `- ${pin}[${line.title}](${line.href}) — ${line.summary}${ownerNote}${marker}`;
      }
      return line.text;
    })
    .join("\n");
}

/**
 * Build the full-text section by greedily injecting file bodies under the
 * shared budget. Priority: pinned → feedback/user → most recently modified.
 * Only small files (≤ line threshold) are candidates.
 *
 * Uses continue (not break) so a large low-priority file doesn't block a
 * smaller high-priority file later in the sort — this is greedy best-fit,
 * not a priority guarantee.
 */
function buildFullTextSection(
  files: Map<string, MemoryFile>,
  entries: IndexEntry[],
  budget: { remaining: number; total: number },
  warnings: string[],
  alreadyLoaded: Set<string>,
): { text: string; loadedPaths: Set<string>; filesLoaded: number; tokens: number } {
  // Build a priority-ordered list of candidate files
  const candidates = prioritizeFiles(files, entries);

  // Index-pinned status (⛔ marker or [pin] in MEMORY.md) — an entry counted
  // as pinned for sorting must also bypass the large-file filter, otherwise
  // "always inject" silently fails for big pinned files.
  const indexPinned = new Set(entries.filter((e) => e.pinned).map((e) => e.filePath));

  let tokensUsed = 0;
  const parts: string[] = [];
  const loadedPaths = new Set<string>();
  let filesLoaded = 0;

  for (const file of candidates) {
    // Already injected by the other tier: record it as present (so the index
    // renderer clears its ⟨index-only⟩ marker) but do not emit the body twice
    // or charge its tokens to the budget a second time.
    if (alreadyLoaded.has(file.filePath)) {
      loadedPaths.add(file.filePath);
      continue;
    }
    const effectivePinned = Boolean(file.frontmatter.pinned) || indexPinned.has(file.filePath);
    if (file.lineCount > SMALL_FILE_LINE_THRESHOLD && !effectivePinned) {
      continue; // large files get index-only unless pinned
    }

    const bodyTokens = estimateTokens(file.frontmatter.body);
    if (bodyTokens > budget.remaining) {
      // A pinned entry is documented as "always injected in full regardless
      // of size", but the shared budget still bounds it: a single pinned body
      // larger than the cap, or several pinned bodies exhausting it, gets
      // demoted to ⟨index-only⟩. That is the right outcome (overdrawing the
      // budget would blow the context window). The demotion is recorded in the
      // debug log rather than the console: this runs at prompt-build time on
      // EVERY turn the entry is over budget, so a console line would repeat
      // once per turn for as long as the condition holds.
      if (effectivePinned) {
        warnings.push(
          `pinned entry ${file.filename} is index-only this turn: ${bodyTokens} tokens exceeds the ${budget.remaining} remaining of the ${budget.total}-token budget`,
        );
      }
      continue; // would exceed shared budget
    }

    parts.push(formatFileBlock(file));
    tokensUsed += bodyTokens;
    budget.remaining -= bodyTokens;
    filesLoaded++;
    loadedPaths.add(file.filePath);
    alreadyLoaded.add(file.filePath);
  }

  return {
    text: parts.join("\n\n"),
    loadedPaths,
    filesLoaded,
    tokens: tokensUsed,
  };
}

/** Prioritize files: pinned first, then effective priority (explicit priority
 * or type-derived default), then most recently modified.
 *
 * Per consult (GPT-5.6): priority replaces type as the admission-order signal,
 * not merely a tie-breaker within type. A priority-5 project fact can outrank
 * an old feedback entry. Type supplies the default when no explicit priority
 * is set: feedback=5, user=4, project=3, reference=2. */
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

    // Then effective priority (explicit frontmatter priority, or type default)
    const aPriority = a.frontmatter.priority ?? typeDefaultPriority(a.frontmatter.type);
    const bPriority = b.frontmatter.priority ?? typeDefaultPriority(b.frontmatter.type);
    if (aPriority !== bPriority) return bPriority - aPriority;

    // Then most recently modified
    return b.mtime - a.mtime;
  });
}

/** Default priority derived from memory type when no explicit priority is set.
 * feedback=5 (behavioral rules, highest), user=4, project=3, reference=2. */
function typeDefaultPriority(type: MemoryType): number {
  switch (type) {
    case "feedback":
      return 5;
    case "user":
      return 4;
    case "project":
      return 3;
    case "reference":
      return 2;
    default:
      return 2; // untyped defaults to reference level
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
