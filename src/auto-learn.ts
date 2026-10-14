// Auto-learning: periodic background review of the conversation to extract
// durable memories worth persisting across sessions.
//
// Uses completeSimple() for a single LLM call (no agent loop). The model returns
// a JSON array of memory candidates, which we validate and write via the same
// writeMemory() path the write_memory tool uses — so auto-learned memories are
// indistinguishable from Claude Code's own.
//
// Fire-and-forget: never blocks the user's turn. All errors are caught and
// recorded in the debug log.

import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api, Context, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findContentIssues, scanMemoryCandidate } from "./content-scan.js";
import { debugLog } from "./debug-log.js";
import { rankEntries } from "./find-rank.js";
import { parseMemoryFile } from "./frontmatter.js";
import { parseIndexFile } from "./index-parser.js";
import { resolveWriteTarget, slugify, writeMemory } from "./memory-writer.js";
import { createProjectMemoryDir, resolveMemoryDirs } from "./resolver.js";
import type { MemoryDir, ResolveResult } from "./types.js";

/** Configuration for auto-learning. */
export interface AutoLearnConfig {
  /** Review every N turns. */
  everyTurns: number;
  /** Pinned review model (provider/id, looked up in the model registry).
   * Unset means "use the session's current model", resolved at review time
   * because the user can switch models mid-session. */
  model?: { provider: string; id: string };
  /** Thinking level: "off" omits reasoning entirely (like pi-observational-memory). */
  thinking: "off" | "minimal" | "low" | "medium" | "high";
  /** Max output tokens for the review call. */
  maxOutputTokens: number;
  /** Max NEW topic files one review may create. Supersessions of an existing
   * entry do not count. Optional so existing callers keep the default. */
  maxNewPerReview?: number;
  /** Pass the store's demoteIndexOverflow setting through to writeMemory.
   * Optional so existing callers keep the writer's default (off). */
  demoteIndexOverflow?: boolean;
}

/** Default cap on new topic files per review. */
export const DEFAULT_MAX_NEW_PER_REVIEW = 3;

export const DEFAULT_AUTOLEARN_CONFIG: AutoLearnConfig = {
  everyTurns: 10,
  thinking: "off",
  maxOutputTokens: 2048,
  maxNewPerReview: DEFAULT_MAX_NEW_PER_REVIEW,
};

/** The reviewer's instructions, with the per-review cap stated.
 *
 * Pins and priority are no longer asked for. A pin exempts an index line from
 * demotion, and a no-thinking reviewer pinned liberally: in one hvac-control
 * session it pinned 41 entries, the live region's pins went from 24 to 53, and
 * the oldest unpinned feedback rules were demoted to make room for them. Pins
 * now come only from an explicit write_memory call.
 *
 * `supersedes` replaces the old overwrite flag as the field the model fills
 * in, so every candidate carries an explicit answer to "which existing entry
 * does this replace?". A store with hundreds of entries otherwise collects
 * one-fact siblings (95 new hp-78k0-* slugs in that session). */
export function buildSystemPrompt(maxNew: number): string {
  return `You are a memory extraction agent. Your job is to read a recent conversation chunk and extract durable facts worth remembering across sessions.

You return a JSON array of memory candidates, MOST DURABLE FIRST. Each candidate has:
- name: short slug (kebab-case, e.g. "prefer-jq-for-json")
- description: one-line summary
- type: one of "feedback" (behavioral rule), "reference" (lookup material), "project" (project-specific fact), "user" (user preference)
- body: markdown body, 1-10 lines
- supersedes: the slug of the existing entry this replaces or extends, or null for a genuinely new topic

At most ${maxNew} candidates may have supersedes: null. Superseding candidates do not count toward that limit.

What to extract:
- User preferences and conventions explicitly stated
- Project-specific facts that would save time in future sessions
- Verified solutions to recurring problems
- Corrections of earlier mistakes

What NOT to extract:
- Ephemeral state, TODOs, debugging steps, progress tallies
- Git history, commit hashes, MR/PR/issue numbers, or transient file paths
- Code patterns that are obvious from the code itself
- Anything already covered by existing memory entries

SUPERSESSION:
Prefer extending an existing entry over creating a sibling. If a candidate
corrects, updates, or adds detail to an existing entry in the same area, set
supersedes to that entry's slug and write a body that covers BOTH the old
content still true and the new detail: the body replaces the old one. Use the
identifier before the colon in the existing index (the existing file's
filename stem, e.g. "prefer-jq" — NOT the description).

If there is nothing worth extracting, return an empty array: []

Return ONLY the JSON array. No prose, no code fence.`;
}

export interface MemoryCandidate {
  name: string;
  description: string;
  type: "feedback" | "reference" | "project" | "user";
  body: string;
  /** Ignored on write: a reviewer never pins (see buildSystemPrompt). Still
   * accepted so a model that emits it is not rejected. */
  pinned?: boolean;
  /** Slug of the existing entry this candidate replaces, or null/absent for a
   * new topic. A non-empty value is folded into name + overwrite by
   * normalizeCandidate before writing. */
  supersedes?: string | null;
  /** If true, overwrite an existing entry with the same slug (supersession).
   * The LLM sets this when a candidate contradicts/replaces an existing entry. */
  overwrite?: boolean;
  /** Priority 1-5 (5=highest). Optional; defaults to type-derived value. */
  priority?: number;
}

/**
 * Run an auto-learning review over a conversation chunk.
 *
 * @param ctx Pi extension context (provides model registry + abort signal)
 * @param cfg Auto-learn config
 * @param cwd Current working directory (for tier resolution)
 * @param chunk Recent conversation text to review
 * @returns number of memories written, or -1 on failure
 */
export async function runAutoLearn(
  ctx: ExtensionContext,
  cfg: AutoLearnConfig,
  cwd: string,
  chunk: string,
  signal?: AbortSignal,
): Promise<number> {
  if (!chunk.trim()) return 0;

  const resolvedModel = resolveReviewModel(ctx, cfg);
  if (!resolvedModel) return -1;
  const { model, source } = resolvedModel;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    debugLog("auto_learn.no_api_key", { provider: model.provider, id: model.id, source });
    return -1;
  }

  // Build the reviewer's view of the store HERE — after auth, from a fresh
  // resolution — so the existing-index summary and the mtime snapshot agree
  // with each other and with the dirs the write loop will use. Callers
  // previously built the summary BEFORE auth (from the session's frozen,
  // fuzzy resolution): a user edit during the auth wait made the snapshot
  // newer than the summary the model reasoned from, and the overwrite guard
  // would then accept clobbering that edit. One fresh resolve closes it.
  // Auto-learn writes are mutations: exact project match only (no
  // basename-glob fallback) so a review never writes into another project's
  // store via a fuzzy match. For a new project this yields project=null and
  // the project tier is created on first write below.
  const resolved = resolveMemoryDirs(cwd);
  const existingIndex = buildExistingIndexSummary(resolved, chunk);
  // Snapshot existing file mtimes BEFORE the LLM call so overwrite candidates
  // can be skipped if a user/Claude edit lands during the (1-3s) call — avoids
  // silently clobbering a newer edit with a stale review decision.
  const mtimes = snapshotMtimes([resolved.project]);

  const userText = `EXISTING MEMORY INDEX (avoid duplicates):
${existingIndex || "(empty — no existing memories)"}

RECENT CONVERSATION CHUNK:
${chunk}

Extract durable memories worth persisting. Return ONLY a JSON array.`;

  const context: Context = {
    systemPrompt: buildSystemPrompt(cfg.maxNewPerReview ?? DEFAULT_MAX_NEW_PER_REVIEW),
    messages: [
      {
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text: userText }],
      },
    ],
  };

  // Follow pi-observational-memory's pattern: only pass reasoning if the
  // model supports it AND thinking is not "off". When thinking is "off",
  // omit the field entirely rather than passing a sentinel.
  const modelSupportsReasoning = Boolean((model as { reasoning?: unknown }).reasoning);
  const thinkingLevel = cfg.thinking;
  const reasoningOption =
    modelSupportsReasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {};

  debugLog("auto_learn.model_call", {
    provider: model.provider,
    id: model.id,
    source,
    thinking: cfg.thinking,
    modelSupportsReasoning,
    reasoningPassed: thinkingLevel !== "off" && modelSupportsReasoning,
    chunkChars: chunk.length,
    maxOutputTokens: cfg.maxOutputTokens,
  });

  let replyText: string;
  try {
    // Resolve the stream function from the model registry.
    // Since pi 0.81, the compat completeSimple only resolves builtin API IDs
    // (openai, anthropic, etc.). A provider-registered custom API is unknown
    // to it and throws "No API provider registered for
    // api: ...". Routing through the registry avoids that crash; see
    // resolveStreamFn for why the registry's own streamSimple comes first.
    // Falls back to compat completeSimple when the registry has neither path.
    const streamFn = resolveStreamFn(ctx, model);
    const doComplete = streamFn ?? completeSimple;
    const reply = await doComplete(model, context, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      ...reasoningOption,
      maxTokens: cfg.maxOutputTokens,
      temperature: 0,
      signal: signal ?? ctx.signal,
    });
    replyText = reply.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
  } catch (err) {
    debugLog("auto_learn.llm_error", { error: String(err) });
    return -1;
  }

  // Parse the JSON array — tolerate code fences and leading/trailing prose.
  const candidates = parseCandidates(replyText);

  debugLog("auto_learn.llm_response", {
    replyChars: replyText.length,
    // The preview is logged before candidates are scanned, so a reply that
    // carries a secret value is withheld whole rather than logged in clear.
    replyPreview: findContentIssues(replyText).some((f) => f.kind === "secret")
      ? "(withheld: reply contains a secret value)"
      : replyText.slice(0, 200),
    candidatesParsed: candidates.length,
  });

  if (candidates.length === 0) {
    return 0;
  }

  // A review aborted after its deadline (shutdown timeout, session
  // replacement) must not write: its decisions were computed against a
  // conversation snapshot that is no longer the live one, and writing would
  // race whoever triggered the abort. The LLM call itself is already
  // signal-bound; this closes the completion→write window.
  if (signal?.aborted) {
    debugLog("auto_learn.skip_writes_aborted", { candidates: candidates.length });
    return 0;
  }

  return writeCandidates(candidates, resolved, mtimes, cwd, signal, {
    maxNew: cfg.maxNewPerReview ?? DEFAULT_MAX_NEW_PER_REVIEW,
    demoteIndexOverflow: cfg.demoteIndexOverflow === true,
  });
}

/**
 * Pick the model a review runs on.
 *
 * A pinned cfg.model is looked up in the registry and nothing else: if it is
 * missing the review fails rather than silently running on a different (and
 * possibly far more expensive) model. Unset, the session's current model is
 * used, read from ctx at call time so a mid-session model switch is followed.
 * Failure is debug-logged only; a console line would land inside the TUI.
 */
function resolveReviewModel(
  ctx: ExtensionContext,
  cfg: AutoLearnConfig,
): { model: Model<Api>; source: "configured" | "session" } | undefined {
  if (cfg.model) {
    const found = ctx.modelRegistry.find(cfg.model.provider, cfg.model.id);
    if (!found) {
      debugLog("auto_learn.model_not_found", {
        provider: cfg.model.provider,
        id: cfg.model.id,
        source: "configured",
        reason: "configured reviewModel is not in the model registry",
      });
      return undefined;
    }
    return { model: found, source: "configured" };
  }
  const session = ctx.model as Model<Api> | undefined;
  if (!session) {
    debugLog("auto_learn.model_not_found", {
      source: "session",
      reason: "no reviewModel configured and the session has no model selected",
    });
    return undefined;
  }
  return { model: session, source: "session" };
}

/**
 * Write validated candidates, one at a time. Returns the number written.
 *
 * Every candidate is content-scanned FIRST, before anything that can touch
 * disk (store creation, overwrite backup to .trash, the write itself): an
 * auto-learned title and description become an index line injected into
 * every later turn, so a prompt injection or a secret value must never land.
 * Rejection is per entry — the rest of the batch still writes. The explicit
 * write_memory tool is scanned too, since the model authors those calls, but
 * for injection and invisible characters only (see scanWriteToolInput).
 */
export function writeCandidates(
  rawCandidates: MemoryCandidate[],
  resolved: ResolveResult,
  mtimes: Map<string, number>,
  cwd: string,
  signal?: AbortSignal,
  options: { maxNew?: number; demoteIndexOverflow?: boolean } = {},
): number {
  const maxNew = options.maxNew ?? Number.POSITIVE_INFINITY;
  const candidates = rawCandidates.map(normalizeCandidate);
  let written = 0;
  let newWritten = 0;
  const capped: string[] = [];
  for (const c of candidates) {
    // Abort between candidates: a shutdown-timeout abort raised mid-loop
    // must stop the remaining fs writes as soon as possible.
    if (signal?.aborted) {
      debugLog("auto_learn.skip_writes_aborted", { remaining: candidates.length - written });
      break;
    }
    // Content scan before any disk change. Reasons carry masked snippets
    // only, so the debug log never holds the secret it refused to store.
    const scan = scanMemoryCandidate(c);
    if (!scan.ok) {
      // A secret in the title would leak through the logged name itself.
      debugLog("auto_learn.content_rejected", {
        name: logSafeName(c.name),
        reasons: scan.reasons,
      });
      continue;
    }
    // One store. A missing store is created on first write (a fresh install
    // has none); if that fails, skip this candidate rather than dropping the
    // rest of the batch.
    let dir: MemoryDir | null = resolved.project;
    if (!dir) dir = createProjectMemoryDir(cwd);
    if (!dir) {
      debugLog("auto_learn.no_store", { cwd });
      continue;
    }
    // Stale-overwrite guard: an overwrite candidate is only safe when the
    // target file existed at snapshot time and is unchanged since. Anything
    // else (created mid-review, edited mid-review, deleted mid-review) is a
    // concurrent mutation the stale review must not clobber or resurrect.
    // The snapshot is keyed by `${tier}:${slug}`, matching snapshotMtimes.
    if (c.overwrite === true) {
      // Resolve the same target writeMemory is about to write: the EXISTING
      // file for this name, whatever its stem. Keying on slugify(c.name) alone
      // left a non-slug-normal stem ("Foo Bar.md") unresolvable — the snapshot
      // lookup hit through the raw-stem alias, then the stat of the slug path
      // threw ENOENT and the candidate was skipped as "deleted", so
      // supersession silently no-opped and the log blamed a deletion that
      // never happened.
      const target = resolveWriteTarget(dir, c.name);
      const targetStem = target.replace(/\.md$/, "");
      const snapKey = `${dir.tier}:${targetStem}`;
      const snapMtime = mtimes.get(snapKey);
      if (snapMtime === undefined) {
        // Not present when the review started: created mid-review (or the
        // model guessed a slug that only materialized meanwhile). Never
        // overwrite what we did not see.
        debugLog("auto_learn.skip_unsnapshotted_overwrite", { target, tier: dir.tier });
        continue;
      }
      try {
        const curMtime = statSync(join(dir.dir, target)).mtimeMs;
        if (curMtime !== snapMtime) {
          debugLog("auto_learn.skip_stale_overwrite", { target, snapMtime, curMtime });
          continue;
        }
      } catch {
        // Vanished during the call — a user/Claude deliberate deletion.
        // Writing would resurrect it.
        debugLog("auto_learn.skip_deleted_overwrite", { target, tier: dir.tier });
        continue;
      }
    }
    // New-topic cap. Candidates arrive most durable first, so the ones past
    // the cap are the least durable. Supersessions are never capped: they
    // refine the store without growing it.
    if (c.overwrite !== true && newWritten >= maxNew) {
      capped.push(logSafeName(c.name));
      continue;
    }
    // Per-candidate try/catch: one bad candidate (fs error, portability
    // throw) must not drop the rest of the batch — a thrown error here
    // would otherwise reject runAutoLearn and lose all remaining writes.
    try {
      const result = writeMemory(
        dir,
        {
          name: c.name,
          description: c.description,
          type: c.type,
          body: c.body,
          // A reviewer never pins, but it must not unpin either: the writer
          // drops pinned:true on an overwrite that passes false, so a
          // supersession keeps whatever pin the target already carries.
          pinned: c.overwrite === true && existingPinned(dir, c.name),
          priority: c.priority ?? null,
          // Auto-learn overwrites only when the LLM signals supersession
          allowOverwrite: c.overwrite === true,
        },
        // Reviewer writes must demote like tool writes do. Before this they
        // passed nothing, so a store whose writes are mostly the reviewer's
        // (438 of 460 in one hvac-control session) never demoted on them and
        // the live index sat permanently past the injection cut.
        { demoteIndexOverflow: options.demoteIndexOverflow === true },
      );
      if (result.ok) {
        written++;
        if (c.overwrite !== true) newWritten++;
      }
    } catch (err) {
      debugLog("auto_learn.write_error", { name: c.name, tier: dir.tier, error: String(err) });
    }
  }

  if (capped.length > 0) {
    debugLog("auto_learn.candidates_capped", { maxNew, capped });
  }

  debugLog("auto_learn.complete", {
    candidates: candidates.length,
    written,
    skipped: candidates.length - written,
    capped: capped.length,
  });

  return written;
}

/** Fold a non-empty `supersedes` into the name and overwrite flag the write
 *  loop keys on. An empty or null value leaves the candidate as proposed. */
export function normalizeCandidate(c: MemoryCandidate): MemoryCandidate {
  if (typeof c.supersedes === "string" && c.supersedes.trim() !== "") {
    return { ...c, name: c.supersedes.trim(), overwrite: true };
  }
  return c;
}

/** Whether the existing topic a supersession targets is pinned. A missing or
 *  unreadable file reads as unpinned; the write loop's own guards decide
 *  whether the write may proceed at all. */
function existingPinned(dir: MemoryDir, name: string): boolean {
  const target = resolveWriteTarget(dir, name);
  try {
    return parseMemoryFile(join(dir.dir, target), target).pinned;
  } catch {
    return false;
  }
}

/** A candidate name as it may appear in the debug log: withheld whole when
 *  it holds a secret value, since the name is logged verbatim. */
function logSafeName(name: string): string {
  return findContentIssues(name).some((f) => f.kind === "secret")
    ? "(withheld: name holds a secret)"
    : name;
}

/** Parse a JSON array of MemoryCandidate from the LLM reply, tolerating fences and prose. */
export function parseCandidates(reply: string): MemoryCandidate[] {
  // Strip code fences if present
  let body = reply.trim();
  const fenceMatch = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    body = fenceMatch[1].trim();
  }

  // Find the first [ and last ] to extract the JSON array
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }
  const jsonText = body.slice(start, end + 1);

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isValidCandidate);
    // Say what was dropped and why. A candidate whose tier the schema does not
    // accept (the summary header used to render the store LABEL, and a model
    // echoing it wrote "my-app") was filtered here in total silence,
    // which is indistinguishable from the model having proposed nothing.
    if (valid.length !== parsed.length) {
      debugLog("auto_learn.candidates_rejected", {
        proposed: parsed.length,
        accepted: valid.length,
        rejected: parsed
          .filter((c) => !isValidCandidate(c))
          .slice(0, 5)
          .map((c) => {
            const o = c as { name?: unknown; tier?: unknown };
            // Logged before any content scan, so a name holding a secret
            // value is withheld here too.
            return { name: logSafeName(String(o?.name ?? "?")), tier: String(o?.tier ?? "?") };
          }),
      });
    }
    return valid;
  } catch {
    return [];
  }
}

function isValidCandidate(v: unknown): v is MemoryCandidate {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.name === "string" &&
    typeof c.description === "string" &&
    (c.type === "feedback" ||
      c.type === "reference" ||
      c.type === "project" ||
      c.type === "user") &&
    typeof c.body === "string" &&
    // A tier is no longer accepted. The reviewer used to choose one; there is
    // now a single store, and a candidate that still carries "global" is
    // rejected rather than quietly re-homed into the project store — a silent
    // relocation would put a fact somewhere the model did not choose.
    (c.tier === undefined || c.tier === "project") &&
    // pinned is optional and ignored on write (a reviewer never pins)
    (c.pinned === undefined || typeof c.pinned === "boolean") &&
    // supersedes is optional: a slug, or null for a new topic
    (c.supersedes === undefined || c.supersedes === null || typeof c.supersedes === "string") &&
    // overwrite is optional (defaults to false)
    (c.overwrite === undefined || typeof c.overwrite === "boolean") &&
    // priority is optional (defaults to type-derived value); if present it
    // must be an integer 1-5 to match extractPriority's read-side validation
    // (a float would be written then silently ignored on read).
    (c.priority === undefined ||
      (typeof c.priority === "number" &&
        Number.isInteger(c.priority) &&
        c.priority >= 1 &&
        c.priority <= 5))
  );
}

/** Snapshot mtimes of existing topic files, keyed `${dir.tier}:${stem}`, so
 * overwrite candidates can be skipped if the target changed during the LLM
 * call. Captured BEFORE the call; compared AFTER. The write loop builds the
 * same key from `resolveWriteTarget`, so a non-slug-normal stem ("Foo Bar.md")
 * is matched through its raw-stem alias as well as through its slug. */
export function snapshotMtimes(dirs: (MemoryDir | null)[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const dir of dirs) {
    if (!dir || !existsSync(dir.dir)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const found: Array<{ stem: string; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue;
      try {
        found.push({
          stem: entry.name.replace(/\.md$/, ""),
          mtime: statSync(join(dir.dir, entry.name)).mtimeMs,
        });
      } catch {
        // skip unreadable
      }
    }
    applyStemKeys(map, dir.tier, found);
  }
  return map;
}

/** Key a tier's topic stems into the mtime map, real stems before aliases.
 *
 * Two passes, not one: keying each entry's stem and slug together made the
 * result depend on the order stems arrived in. With both "foo-bar.md" and a
 * slug-alike such as "foo-bar:.md" on disk, whichever came last owned the
 * "foo-bar" key, so an alias could overwrite a real stem's mtime. The
 * overwrite guard then compares the write target against the OTHER file's
 * mtime and logs skip_stale_overwrite — blaming a concurrent edit that never
 * happened, and silently dropping the supersession. Real stems are therefore
 * all written first, and an alias only fills a key no real stem claimed.
 *
 * Exported because the ordering invariant cannot be exercised through
 * snapshotMtimes: whether the bad order arises depends on readdir order, which
 * on this filesystem puts the ASCII-uppercase slug-alikes first. */
export function applyStemKeys(
  map: Map<string, number>,
  tier: string,
  found: Array<{ stem: string; mtime: number }>,
): void {
  // Real stems win their own key, always.
  for (const { stem, mtime } of found) {
    map.set(`${tier}:${stem}`, mtime);
  }
  // Slugs are a fallback key for stems that are not slug-normal: the overwrite
  // guard looks up slugify(candidate.name) while the summary advertises the raw
  // stem, so an uppercase or spaced stem would otherwise miss and silently
  // no-op the supersession.
  for (const { stem, mtime } of found) {
    const slug = slugify(stem);
    if (slug && slug !== stem && !map.has(`${tier}:${slug}`)) {
      map.set(`${tier}:${slug}`, mtime);
    }
  }
}

/** Character budget for entry SUMMARIES in the reviewer's index summary.
 *
 * Identities are never budgeted (every entry must stay matchable for
 * supersession); only the descriptions are, so a large store cannot inflate
 * the review prompt without bound. */
const SUMMARY_BUDGET_CHARS = 6000;

/** Pick which entries (by index into `owned`, oldest write first) get their
 * summary within SUMMARY_BUDGET_CHARS.
 *
 * With a chunk, entries are taken by relevance to it first (score descending,
 * ties to the older entry), then the unmatched remainder oldest first. Without
 * one, oldest first only, which is the stable order the review prompt had
 * before relevance selection. An entry whose summary does not fit is skipped
 * rather than ending the pass, so shorter ones later in the order still fit. */
function chooseDescribed(
  owned: ReadonlyArray<{ stem: string; summary: string; title: string }>,
  chunk: string | undefined,
): Set<number> {
  let order = owned.map((_, i) => i);
  if (chunk?.trim()) {
    const scores = rankEntries(
      chunk,
      owned.map((e) => ({ title: e.title, summary: e.summary, filename: e.stem, body: null })),
    ).map((r) => r.score);
    order = [...order].sort((a, b) => scores[b] - scores[a] || a - b);
  }
  const described = new Set<number>();
  let used = 0;
  for (const i of order) {
    const len = owned[i].summary.length;
    if (used + len <= SUMMARY_BUDGET_CHARS) {
      described.add(i);
      used += len;
    }
  }
  return described;
}

/** Order items oldest write first by the mtime of the file each names.
 * A missing or unreadable file sorts first; ties keep their input order. */
function byWriteTime<T>(items: readonly T[], pathOf: (item: T) => string): T[] {
  const writeTime = (item: T): number => {
    try {
      return statSync(pathOf(item)).mtimeMs;
    } catch {
      return Number.NEGATIVE_INFINITY;
    }
  };
  return items
    .map((item) => ({ item, time: writeTime(item) }))
    .sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? -1 : 1))
    .map(({ item }) => item);
}

/** Build a compact summary of the existing memory index for the LLM.
 *
 * Parses MEMORY.md (not a raw readdir) so the LLM sees entry descriptions,
 * not just filenames. This is critical for dedup: without descriptions, the
 * LLM cannot tell what an existing entry covers and creates near-duplicate
 * slugs instead of recognizing the same topic.
 *
 * Falls back to readdir filenames only if MEMORY.md is unparseable.
 *
 * Only this store's own topics are listed. An index line whose href resolves
 * outside the store names another store's topic: it is not addressable by name
 * here, so advertising it would invite overwriting an unrelated local file whose
 * stem happens to match.
 *
 * Entries are listed oldest write first (topic file mtime), not in MEMORY.md
 * order. The writer inserts a new line just above `## Archive`, so file order
 * put each new entry mid-list in a store with an Archive section, changing the
 * extraction prompt from that point on and missing the provider prompt cache.
 * By write time a new topic always lands last, and demotion to the archive
 * moves only the index line, never the topic file, so it reorders nothing.
 *
 * Which entries carry a SUMMARY is a separate choice from the listing order.
 * Without a chunk the budget is spent oldest first, so a new entry never takes
 * a summary away from an earlier one. With a chunk it is spent on the entries
 * most related to that chunk (BM25F over title, summary and filename, the
 * ranker find_memory uses), and only then oldest first. Oldest-first alone
 * described ~91 of 832 entries in a real store and left every recent cluster
 * as bare slugs (all 120 hp-78k0-* entries), and those are exactly the topics
 * the conversation under review re-derives; the reviewer could not see what
 * they covered and minted siblings instead of superseding. This gives up a
 * stable review prompt, which bought little: the user message already changes
 * with every chunk. */
export function buildExistingIndexSummary(resolved: ResolveResult, chunk?: string): string {
  const lines: string[] = [];
  // Both sides of the ownership test are canonicalized: entry.filePath comes
  // from resolveHref, which realpath's the target, while MemoryDir.dir is built
  // lexically from homedir(). With a symlinked store component (a
  // dotfiles-managed ~/.claude) a lexical prefix test fails on every entry and
  // every external entry would look local — the opposite of the intent.
  const canonicalRoots = new Map<MemoryDir, string>();
  const canonicalDir = (dir: MemoryDir): string => {
    const cached = canonicalRoots.get(dir);
    if (cached !== undefined) return cached;
    let root: string;
    try {
      root = realpathSync(dir.dir);
    } catch {
      root = dir.dir; // missing store — the lexical path is all we have
    }
    canonicalRoots.set(dir, root);
    return root;
  };
  /** Is this entry's target a topic in THIS store?
   *
   * An href that resolves outside it names another store's topic. Such an entry
   * is not addressable by name here, so it is skipped rather than advertised as
   * a supersession target: the write loop resolves a candidate's name inside
   * this store, so advertising an external stem would invite overwriting an
   * unrelated local file whose stem matches. */
  const isOwnedBy = (filePath: string, dir: MemoryDir): boolean => {
    let canonicalPath = filePath;
    try {
      canonicalPath = realpathSync(filePath);
    } catch {
      // Missing target keeps the lexical path (resolveHref does the same).
    }
    const root = canonicalDir(dir);
    return canonicalPath === root || canonicalPath.startsWith(`${root}/`);
  };

  const dir = resolved.project;
  if (dir) {
    const headerIndex = lines.length;
    // The header is the store's label (the project basename), stated for
    // context only; the candidate schema carries no tier token any more.
    lines.push(`## ${dir.label}`);
    const before = lines.length;
    try {
      const parsed = parseIndexFile(dir);
      if (parsed && parsed.entries.length > 0) {
        // EVERY local entry is listed by identity. The previous slice(0, 50)
        // hid the rest from the reviewer permanently on a large store (this
        // machine's cross-project index had 222 entries) and writes append, so
        // anything past the cutoff could never be matched for supersession no
        // matter how many reviews ran. The advertised "match the existing
        // identifier" mechanism simply did not apply to them, and they
        // accumulated as duplicates. Identities are what supersession keys on,
        // so they are never dropped; only the SUMMARIES are budgeted, which
        // bounds prompt size without losing matchability.
        let external = 0;
        const owned: Array<{ stem: string; summary: string; title: string }> = [];
        for (const entry of byWriteTime(parsed.entries, (e) => e.filePath)) {
          if (!isOwnedBy(entry.filePath, dir)) {
            external++;
            continue;
          }
          // The stem is the stable identifier: the writer keys overwrite
          // targets on slugify(candidate.name), so the model must return THIS
          // slug to supersede.
          const stem = entry.href.split("/").pop()?.replace(/\.md$/, "") ?? entry.title;
          owned.push({ stem, summary: entry.summary, title: entry.title });
        }
        const described = chooseDescribed(owned, chunk);
        let trimmed = 0;
        for (const [i, e] of owned.entries()) {
          if (described.has(i)) {
            lines.push(`- ${e.stem}: ${e.summary}`);
          } else {
            lines.push(`- ${e.stem}`);
            trimmed++;
          }
        }
        if (external > 0) {
          lines.push(
            `(${external} index entr${external === 1 ? "y" : "ies"} point outside this store and are ` +
              "not listed: they are not addressable by name here)",
          );
        }
        if (trimmed > 0) {
          lines.push(
            `(summaries omitted for ${trimmed} of ${parsed.entries.length} entries to bound size` +
              (chunk?.trim()
                ? "; the ones shown are those most related to this conversation"
                : "") +
              "; every identifier is listed above, so supersede by matching one)",
          );
        }
      } else {
        // Fallback: no parseable index, list filename stems if any files exist
        const files = existsSync(dir.dir)
          ? readdirSync(dir.dir).filter((f: string) => f.endsWith(".md") && f !== "MEMORY.md")
          : [];
        if (files.length === 0) {
          lines.push("(no entries)");
        } else {
          // No parseable index: list every file stem, so identities stay
          // complete. (This too was capped at 50, hiding files outright.)
          for (const f of byWriteTime(files, (name) => join(dir.dir, name))) {
            lines.push(`- ${f.replace(/\.md$/, "")}`);
          }
        }
      }
    } catch {
      lines.push("(unreadable)");
    }
    // Drop a header with no entries under it, so the model is not handed a
    // section implying ownership of something we could not list.
    if (lines.length === before && headerIndex < lines.length) {
      lines.length = headerIndex;
    }
  }
  return lines.join("\n");
}

/** Resolve a stream/complete function from the model registry.
 *
 * Since pi 0.81, the compat completeSimple only resolves builtin API IDs.
 * A provider-registered custom API is unknown to it and throws. Routing
 * through the registry avoids that.
 *
 * Since pi 0.86, providers take a normalized TranscriptContext and read the
 * system prompt from context.messages, so a plain Context handed straight to
 * provider.streamSimple loses its systemPrompt field without any error. The
 * registry's own streamSimple (added in 0.86) normalizes the Context first,
 * so it is preferred. The getProvider path remains for hosts older than 0.86,
 * whose providers still take a plain Context.
 *
 * Returns undefined if neither path is available (caller falls back to compat
 * completeSimple). */
function resolveStreamFn(
  ctx: ExtensionContext,
  model: unknown,
):
  | ((
      model: unknown,
      context: Context,
      options: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>)
  | undefined {
  const providerName = (model as { provider?: string }).provider;
  if (!providerName) return undefined;
  try {
    const registry = ctx.modelRegistry;
    if (typeof registry.streamSimple === "function") {
      debugLog("auto_learn.stream_resolved", { providerName, source: "registry_stream" });
      return (m, c, o) =>
        registry.streamSimple(m as Model<Api>, c, o as Record<string, unknown>).result();
    }
    const provider =
      typeof ctx.modelRegistry.getProvider === "function"
        ? ctx.modelRegistry.getProvider(providerName)
        : undefined;
    const streamSimple = provider?.streamSimple;
    if (typeof streamSimple !== "function") return undefined;
    debugLog("auto_learn.stream_resolved", { providerName, source: "registry_provider" });
    // Pre-0.86 hosts only: their providers take a plain Context, which the
    // current TranscriptContext type cannot express.
    return (m, c, o) =>
      streamSimple(
        m as Model<Api>,
        c as unknown as TranscriptContext,
        o as Record<string, unknown>,
      ).result();
  } catch (err) {
    debugLog("auto_learn.stream_resolve_failed", { providerName, error: String(err) });
    return undefined;
  }
}
