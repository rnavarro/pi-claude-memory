// Auto-learning: periodic background review of the conversation to extract
// durable memories worth persisting across sessions.
//
// Uses completeSimple() for a single LLM call (no agent loop). The model returns
// a JSON array of memory candidates, which we validate and write via the same
// writeMemory() path the write_memory tool uses — so auto-learned memories are
// indistinguishable from Claude Code's own.
//
// Fire-and-forget: never blocks the user's turn. All errors are caught and
// logged to stderr.

import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./debug-log.js";
import { parseIndexFile } from "./index-parser.js";
import { resolveWriteTarget, slugify, writeMemory } from "./memory-writer.js";
import { createGlobalMemoryDir, createProjectMemoryDir, resolveMemoryDirs } from "./resolver.js";
import type { MemoryDir, ResolveResult } from "./types.js";

/** Configuration for auto-learning. */
export interface AutoLearnConfig {
  /** Review every N turns. */
  everyTurns: number;
  /** Model provider/id. */
  model: { provider: string; id: string };
  /** Thinking level: "off" omits reasoning entirely (like pi-observational-memory). */
  thinking: "off" | "minimal" | "low" | "medium" | "high";
  /** Max output tokens for the review call. */
  maxOutputTokens: number;
}

export const DEFAULT_AUTOLEARN_CONFIG: AutoLearnConfig = {
  everyTurns: 10,
  model: { provider: "neuralwatt", id: "deepseek-v4-flash" },
  thinking: "off",
  maxOutputTokens: 2048,
};

const SYSTEM_PROMPT = `You are a memory extraction agent. Your job is to read a recent conversation chunk and extract durable facts worth remembering across sessions.

You return a JSON array of memory candidates. Each candidate has:
- name: short slug (kebab-case, e.g. "prefer-jq-for-json") — match existing entry name for supersession
- description: one-line summary
- type: one of "feedback" (behavioral rule), "reference" (lookup material), "project" (project-specific fact), "user" (user preference)
- body: markdown body, 1-10 lines
- tier: "project" or "global"
- pinned: boolean (true only for critical behavioral rules)
- overwrite: boolean (true if this supersedes/replaces an existing entry — see SUPERSESSION below)
- priority: optional integer 1-5 (5=highest). Omit to use type default (feedback=5, user=4, project=3, reference=2)

What to extract:
- User preferences and conventions explicitly stated
- Project-specific facts that would save time in future sessions
- Verified solutions to recurring problems
- Corrections of earlier mistakes

What NOT to extract:
- Ephemeral state, TODOs, debugging steps
- Git history, commit hashes, or transient file paths
- Code patterns that are obvious from the code itself
- Anything already covered by existing memory entries

SUPERSESSION:
If a candidate contradicts or supersedes an existing entry (e.g. a bug fix that
resolves an earlier "unproven" note, or a corrected fact), return it with the
SAME slug as the existing entry so it replaces the old content. Do NOT create a
new entry under a different slug — that creates duplicates. Match the existing
entry's slug exactly: use the identifier before the colon in the existing index
(that is the existing file's filename stem, e.g. "prefer-jq" — NOT the
description).

If there is nothing worth extracting, return an empty array: []

Return ONLY the JSON array. No prose, no code fence.`;

interface MemoryCandidate {
  name: string;
  description: string;
  type: "feedback" | "reference" | "project" | "user";
  body: string;
  tier: "project" | "global";
  pinned: boolean;
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

  // Resolve the model
  const model = ctx.modelRegistry.find(cfg.model.provider, cfg.model.id) as Model<Api> | undefined;
  if (!model) {
    debugLog("auto_learn.model_not_found", { provider: cfg.model.provider, id: cfg.model.id });
    console.error(
      `[pi-claude-memory] auto-learn: model ${cfg.model.provider}/${cfg.model.id} not found`,
    );
    return -1;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    debugLog("auto_learn.no_api_key", { provider: cfg.model.provider });
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
  const resolved = resolveMemoryDirs(cwd, { exactOnly: true });
  const existingIndex = buildExistingIndexSummary(resolved);
  // Snapshot existing file mtimes BEFORE the LLM call so overwrite candidates
  // can be skipped if a user/Claude edit lands during the (1-3s) call — avoids
  // silently clobbering a newer edit with a stale review decision.
  const mtimes = snapshotMtimes([resolved.global, resolved.project]);

  const userText = `EXISTING MEMORY INDEX (avoid duplicates):
${existingIndex || "(empty — no existing memories)"}

RECENT CONVERSATION CHUNK:
${chunk}

Extract durable memories worth persisting. Return ONLY a JSON array.`;

  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
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
    provider: cfg.model.provider,
    id: cfg.model.id,
    thinking: cfg.thinking,
    modelSupportsReasoning,
    reasoningPassed: thinkingLevel !== "off" && modelSupportsReasoning,
    chunkChars: chunk.length,
    maxOutputTokens: cfg.maxOutputTokens,
  });

  let replyText: string;
  try {
    // Resolve the stream function from the model registry's provider.
    // Since pi 0.81, the compat completeSimple only resolves builtin API IDs
    // (openai, anthropic, etc.). A provider-registered custom API (e.g.
    // neuralwatt) is unknown to it and throws "No API provider registered for
    // api: ...". Routing through the registry's composed provider avoids that
    // crash. Falls back to compat completeSimple for builtin providers.
    // Pattern copied from pi-observational-memory's resolveStreamFn.
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
    replyPreview: replyText.slice(0, 200),
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

  // Write each candidate. Count successes.
  let written = 0;
  for (const c of candidates) {
    // Abort between candidates: a shutdown-timeout abort raised mid-loop
    // must stop the remaining fs writes as soon as possible.
    if (signal?.aborted) {
      debugLog("auto_learn.skip_writes_aborted", { remaining: candidates.length - written });
      break;
    }
    let dir: MemoryDir | null = c.tier === "global" ? resolved.global : resolved.project;
    if (!dir && c.tier === "project") {
      dir = createProjectMemoryDir(cwd);
    } else if (!dir && c.tier === "global") {
      dir = createGlobalMemoryDir();
    }
    if (!dir) {
      // Requested tier unavailable — skip silently. The model will learn from
      // the absence in the next cycle's index.
      continue;
    }
    // Stale-overwrite guard: an overwrite candidate is only safe when the
    // target file existed at snapshot time and is unchanged since. Anything
    // else (created mid-review, edited mid-review, deleted mid-review) is a
    // concurrent mutation the stale review must not clobber or resurrect.
    // The snapshot is keyed by `${tier}:${slug}` so a same-slug entry in the
    // other tier can never stand in for this target's mtime.
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
    // Per-candidate try/catch: one bad candidate (fs error, portability
    // throw) must not drop the rest of the batch — a thrown error here
    // would otherwise reject runAutoLearn and lose all remaining writes.
    try {
      const result = writeMemory(dir, {
        name: c.name,
        description: c.description,
        type: c.type,
        body: c.body,
        pinned: c.pinned,
        tier: c.tier,
        priority: c.priority ?? null,
        // Auto-learn overwrites only when the LLM signals supersession
        allowOverwrite: c.overwrite === true,
      });
      if (result.ok) written++;
    } catch (err) {
      debugLog("auto_learn.write_error", { name: c.name, tier: c.tier, error: String(err) });
    }
  }

  debugLog("auto_learn.complete", {
    candidates: candidates.length,
    written,
    skipped: candidates.length - written,
  });

  return written;
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
            return { name: String(o?.name ?? "?"), tier: String(o?.tier ?? "?") };
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
    (c.tier === "project" || c.tier === "global") &&
    typeof c.pinned === "boolean" &&
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

/** Snapshot mtimes of existing topic files, keyed by `${tier}:${slug}`, so
 * overwrite candidates can be skipped if the target changed during the LLM
 * call. Captured BEFORE the call; compared AFTER. Tier-keyed because a
 * same-slug file in the other tier must not stand in for the target's
 * mtime (project iterated after global would otherwise overwrite the
 * global key and phantom-mismatch every global overwrite). */
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

/** Build a compact summary of the existing memory index for the LLM.
 *
 * Parses MEMORY.md (not a raw readdir) so the LLM sees entry descriptions,
 * not just filenames. This is critical for dedup: without descriptions, the
 * LLM cannot tell what an existing entry covers and creates near-duplicate
 * slugs instead of recognizing the same topic.
 *
 * Falls back to readdir filenames only if MEMORY.md is unparseable. */
export function buildExistingIndexSummary(resolved: ResolveResult): string {
  const lines: string[] = [];
  // Each entry must be advertised under the tier that OWNS it, not under the
  // tier whose index happens to link it. A project index can link to a global
  // topic (cross-tier absolute hrefs are supported), and the summary used to
  // group such an entry under "project" while reducing the href to a bare
  // basename — so the model saw global contents described as a project slug
  // and could return a project-tier overwrite for a topic it had only ever
  // seen in global. The write loop picks its directory from the candidate's
  // tier, so that overwrite would land on an unrelated same-named project file.
  //
  // Both sides are canonicalized: entry.filePath comes from resolveHref, which
  // realpath's the target, while MemoryDir.dir is built lexically from
  // homedir(). If any component of the store is a symlink (a dotfiles-managed
  // ~/.claude), every canonical entry path fails a lexical prefix test and
  // attribution silently falls back to the LINKING tier — reintroducing the
  // exact misattribution this function exists to prevent. The injector
  // canonicalizes both sides for the same reason.
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
  const ownerOf = (filePath: string, fallback: MemoryDir): MemoryDir => {
    let canonicalPath = filePath;
    try {
      canonicalPath = realpathSync(filePath);
    } catch {
      // Missing target keeps the lexical path (resolveHref does the same).
    }
    for (const d of [resolved.project, resolved.global]) {
      if (!d) continue;
      const root = canonicalDir(d);
      if (canonicalPath === root || canonicalPath.startsWith(`${root}/`)) return d;
    }
    return fallback;
  };

  for (const dir of [resolved.global, resolved.project]) {
    if (!dir) continue;
    const headerIndex = lines.length;
    // Name the TIER in the header, not just the label. A project store's label
    // is the cwd basename ("## my-app tier"), while the candidate schema
    // accepts only "project" or "global", so a model echoing the header
    // produced an invalid tier that parseCandidates then dropped in silence.
    // The label stays for context; the valid token comes first.
    lines.push(`## ${dir.tier} tier (${dir.label})`);
    const before = lines.length;
    try {
      const parsed = parseIndexFile(dir);
      if (parsed && parsed.entries.length > 0) {
        // EVERY entry is listed by identity. The previous slice(0, 50) hid the
        // rest from the reviewer permanently: this machine's real global index
        // has 222 entries and writes append, so anything past the cutoff could
        // never be matched for supersession no matter how many reviews ran.
        // The advertised "match the existing identifier" mechanism simply did
        // not apply to them, and they accumulated as duplicates. Identities are
        // what supersession keys on, so they are never dropped; only the
        // SUMMARIES are budgeted, which bounds prompt size without losing
        // matchability.
        let summaryChars = 0;
        let trimmed = 0;
        for (const entry of parsed.entries) {
          // The stem is the stable identifier: the writer keys overwrite
          // targets on slugify(candidate.name), so the model must return THIS
          // slug to supersede. The owning tier is stated explicitly because a
          // slug alone is ambiguous across stores.
          const stem = entry.href.split("/").pop()?.replace(/\.md$/, "") ?? entry.title;
          const owner = ownerOf(entry.filePath, dir);
          const tierNote = owner.tier === dir.tier ? "" : ` [owner: ${owner.tier}]`;
          if (summaryChars + entry.summary.length <= SUMMARY_BUDGET_CHARS) {
            lines.push(`- ${stem}: ${entry.summary}${tierNote}`);
            summaryChars += entry.summary.length;
          } else {
            lines.push(`- ${stem}${tierNote}`);
            trimmed++;
          }
        }
        if (trimmed > 0) {
          lines.push(
            `(summaries omitted for ${trimmed} of ${parsed.entries.length} entries to bound size; ` +
              "every identifier is listed above, so supersede by matching one)",
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
          for (const f of files) {
            lines.push(`- ${f.replace(/\.md$/, "")}`);
          }
        }
      }
    } catch {
      lines.push("(unreadable)");
    }
    // Drop a section that carries a header but no entries we could attribute
    // to this tier, so the model is not handed a header implying ownership.
    if (lines.length === before && headerIndex < lines.length) {
      lines.length = headerIndex;
    }
  }
  return lines.join("\n");
}

/** Resolve a stream/complete function from the model registry's provider.
 *
 * Since pi 0.81, the compat completeSimple only resolves builtin API IDs.
 * A provider-registered custom API (e.g. neuralwatt) is unknown to it and
 * throws. Routing through the registry's composed provider avoids that.
 * Returns undefined if the provider has no streamSimple (caller falls back
 * to compat completeSimple).
 *
 * Pattern copied from pi-observational-memory's resolveStreamFn. */
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
    const provider =
      typeof ctx.modelRegistry.getProvider === "function"
        ? ctx.modelRegistry.getProvider(providerName)
        : undefined;
    const streamSimple = provider?.streamSimple;
    if (typeof streamSimple !== "function") return undefined;
    debugLog("auto_learn.stream_resolved", { providerName, source: "registry" });
    return (m, c, o) =>
      streamSimple(m as Model<Api>, c as Context, o as Record<string, unknown>).result();
  } catch (err) {
    debugLog("auto_learn.stream_resolve_failed", { providerName, error: String(err) });
    return undefined;
  }
}
