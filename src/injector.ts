// Injector: bounded memory INDEX injection into Pi's system prompt
//
// Contract (deliberately the same shape as Claude Code's auto-memory):
// 1. Always inject the routing anchor (even when no memory exists yet)
// 2. Inject the project's MEMORY.md, bounded to its first 200 lines or 25KB,
//    whichever binds first — the same startup excerpt Claude Code sends
// 3. Topic bodies are NEVER loaded here. recall_memory reads on demand.
// 4. The global store is NOT injected; a signpost names it so the model can
//    read its index or recall from it explicitly.
//
// What this replaced, and why: the injector used to render EVERY index line
// and then greedily load topic bodies under a 5000-token budget. The budget was
// a rounding error next to the index it competed with — big-project's 1341-line
// index alone cost ~74k tokens per turn, and the global tier's 734 lines cost
// ~35k tokens in every session of every project. Bounding the index is the
// substance of the fix; dropping body preloading follows from it, because
// bodies are what the bounded index tells the model to fetch on demand.

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { debugLog } from "./debug-log.js";
import {
  countIndexEntries,
  parseIndexContent,
  parseIndexFile,
  readBoundedIndex,
  reconcileIndex,
} from "./index-parser.js";
import type { MemoryDir } from "./types.js";
import { INDEX_STARTUP_MAX_BYTES, INDEX_STARTUP_MAX_LINES } from "./types.js";

/**
 * Routing anchor for when memory entries exist. Tells the model how to use
 * memory tools and how they coexist with ctx_search.
 *
 * Matches context-mode's terse, directive arrow-syntax.
 *
 * The first two lines are load-bearing: with bodies no longer preloaded, an
 * unqualified index link looks like context the model already has, so it must
 * be told (a) to fetch by FILENAME, since a display title is not a name the
 * resolver accepts, and (b) that a link is not a guarantee the file is
 * readable — availability is no longer inspected at injection time, so the
 * model learns a dead link from recall_memory's failure rather than from a
 * ⟨missing⟩ marker.
 *
 * The reviewer sentence is generated per-session rather than hardcoded: with
 * autoLearn disabled the model is the ONLY writer, and telling it to withhold
 * routine memories in favour of a reviewer that never runs is a silent
 * memory-loss mode. The interval is likewise real config, not the literal 10.
 */
export const MEMORY_ROUTING_ANCHOR = `pi-claude-memory active. Only the bounded project index is below — topic bodies are NOT in context.
Read an entry with recall_memory, passing its FILENAME; a link does not guarantee its file is readable.
A link whose path is outside this project's store lives in the global store — pass tier: "global" for it.
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

/** Injection options. An object rather than positional arguments: the removed
 *  token cap used to sit in the middle of the list, so every call site had to
 *  pass a number that no longer means anything to reach the flags after it. */
export interface InjectionOptions {
  /** Whether ctx_search is registered. Gates the ctx_search clause in the
   *  anchor so it never names a tool the session does not have. */
  hasCtxSearch?: boolean;
  /** Whether the background reviewer runs. When false the anchor must not
   *  promise a reviewer that never runs. */
  autoLearn?: boolean;
  /** Interval stated in the anchor when autoLearn is on. */
  reviewIntervalTurns?: number;
}

/**
 * Build the full memory injection text.
 * Returns the combined text to append to event.systemPrompt.
 * Always returns the routing anchor even when no memory blocks exist,
 * so the model knows write_memory is available for new projects.
 */
export function buildMemoryInjection(
  project: MemoryDir | null,
  global: MemoryDir | null,
  options: InjectionOptions = {},
): { text: string; warnings: string[] } {
  const { hasCtxSearch = true, autoLearn = true, reviewIntervalTurns = 10 } = options;
  const warnings: string[] = [];
  const blocks: string[] = [];

  const projectBlock = project ? buildProjectIndexBlock(project, global, warnings) : null;
  if (projectBlock) blocks.push(projectBlock);

  const globalBlock = global ? globalSignpost(global) : null;
  if (globalBlock) blocks.push(globalBlock);

  const hasAnyEntries = blocks.length > 0;

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
    hasProject: project !== null,
    hasGlobal: global !== null,
    hasAnyEntries,
    hasCtxSearch,
    warningCount: warnings.length,
    textLength: `\n\n## Memory\n\n${finalAnchor}\n\n${blocks.join("\n\n")}`.trimEnd().length,
  });

  return {
    text: `\n\n## Memory\n\n${finalAnchor}\n\n${blocks.join("\n\n")}`.trimEnd(),
    warnings,
  };
}

/** Build the project tier block: the bounded index excerpt plus the routing
 *  guidance that only makes sense for the entries actually shown. */
function buildProjectIndexBlock(
  project: MemoryDir,
  global: MemoryDir | null,
  warnings: string[],
): string | null {
  // Reconcile against the FULL index, never the bounded excerpt: a topic whose
  // link sits below the 200-line cut is still indexed, so reporting it as
  // unindexed would be a lie. This is also the only signal that a topic file
  // has no index line at all, which is the silent-invisibility condition the
  // writer's orphan guards exist to avoid.
  const parsed = parseIndexFile(project);
  if (!parsed) {
    debugLog("injector.index_absent", { label: project.label, indexPath: project.indexPath });
  } else {
    const recon = reconcileIndex(parsed, project.dir);
    if (recon.missing.length > 0) {
      warnings.push(
        `[${project.label}] ${recon.missing.length} index entries point at missing files: ` +
          recon.missing.map((e) => e.href).join(", "),
      );
    }
    if (recon.unindexed.length > 0) {
      warnings.push(
        `[${project.label}] ${recon.unindexed.length} files on disk but not in index: ` +
          recon.unindexed.join(", "),
      );
    }
    debugLog("injector.tier", {
      label: project.label,
      entryCount: parsed.entries.length,
      missingCount: recon.missing.length,
      unindexedCount: recon.unindexed.length,
    });
  }

  const bounded = readBoundedIndex(project);
  // No index file at all: not a warning, just a store without an index yet.
  if (!bounded) return null;
  if (!bounded.ok) {
    // A symlinked, non-regular, or oversize MEMORY.md is a real
    // misconfiguration: the store exists but contributes nothing to the prompt.
    warnings.push(
      `[${project.label}] MEMORY.md not injected (${bounded.reason}): ${project.indexPath}`,
    );
    debugLog("injector.index_rejected", {
      label: project.label,
      indexPath: project.indexPath,
      reason: bounded.reason,
    });
    return null;
  }

  const parts = [`### Memory (${project.label})`, "#### Index", bounded.content.trimEnd()];

  if (bounded.truncated) {
    const kept = bounded.content.split("\n").length;
    const bound =
      bounded.limitedBy === "bytes"
        ? `${INDEX_STARTUP_MAX_BYTES} bytes`
        : `${INDEX_STARTUP_MAX_LINES} lines`;
    parts.push(
      `Index truncated at ${bound} (${kept} of ${bounded.totalLines} lines shown). ` +
        `Entries below the cut are NOT listed and cannot be recalled by name — read ${project.indexPath} to see them.`,
    );
  }

  // Per-entry ownership tags are gone with the re-rendering they depended on,
  // but the ROUTING problem they solved did not: recall_memory tries the
  // project tier first, so an index link into the global store would silently
  // return a same-named project entry instead. State the rule once, for the
  // entries actually shown.
  if (global && bounded.content.trim()) {
    const entries = parseIndexContent(bounded.content, project.dir).entries;
    const knownDirs = [project, global];
    const owned = entries.filter(
      (e) => owningTierOf(e.filePath, knownDirs, project, sep) !== null,
    ).length;
    if (owned > 0) {
      parts.push(
        `${owned} link(s) above resolve into the global store — pass tier: "global" to recall_memory for those.`,
      );
    }
  }

  return parts.join("\n\n");
}

/** Name the global store without injecting any of it.
 *
 * The global tier is a pi invention: Claude Code has no cross-project
 * auto-memory, and its index is not injected here because rendering it cost
 * ~35k tokens in every session of every project. The files stay, recall_memory
 * with tier: "global" still reaches them, and the signpost is what makes them
 * discoverable — without it the store would be unreachable by name, since
 * nothing else tells the model which entries exist.
 *
 * Returns null when the store has no readable index, so a machine without a
 * global store gets no dangling pointer. */
function globalSignpost(global: MemoryDir): string | null {
  const count = countIndexEntries(global);
  if (count === null) return null;
  return [
    "### Cross-project memory (on demand)",
    `${count} cross-project ${count === 1 ? "entry is" : "entries are"} stored at ${global.dir} and deliberately NOT in context.`,
    `Read ${global.indexPath} when a task may have cross-project context, then recall_memory with tier: "global".`,
  ].join("\n");
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
