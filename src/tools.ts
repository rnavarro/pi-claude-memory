// Memory tools: recall_memory, write_memory, remove_memory.
//
// These tools let the agent read individual memory files by name (with
// [[wikilink]] resolution), write new Claude-format memory files, and remove
// stale ones. All writes go to the SAME files Claude Code uses, so the two
// agents share a single store and never diverge.

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./debug-log.js";
import { invalidateResolveCache, withToolLogContext } from "./index.js";
import type { MemoryOpResult } from "./memory-writer.js";
import { readMemory, removeMemory, writeMemory } from "./memory-writer.js";
import { createGlobalMemoryDir, createProjectMemoryDir, resolveMemoryDirs } from "./resolver.js";
import type { MemoryDir, ResolveResult } from "./types.js";

/** Pick a tier dir from a resolve result. */
function pickTier(resolved: ResolveResult, tier: "project" | "global") {
  return tier === "global" ? resolved.global : resolved.project;
}

const recallTool = defineTool({
  name: "recall_memory",
  label: "Recall Memory",
  description:
    "Read a specific Claude Code memory entry by name. " +
    "Resolves [[wikilinks]] inside the body to relative links. " +
    "Use for loading a memory file you saw in the injected index but need the full content of. " +
    "Shares the same store as Claude Code — writes here are visible to Claude Code and vice versa.",
  parameters: Type.Object({
    name: Type.String({
      description:
        "Memory entry name or filename. Matches the filename itself, or any spelling that slugifies to the same value as the file's stem. Give the FULL stem for underscore-named entries: 'feedback_never_push_master', not 'never-push-master'.",
    }),
    tier: Type.Optional(
      Type.Union([Type.Literal("project"), Type.Literal("global")], {
        description: "Memory tier. Default: project (falls back to global if not found).",
      }),
    ),
  }),
  promptSnippet:
    "recall_memory - Read a Claude Code memory entry by name with [[wikilink]] resolution.",
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    debugLog("tool.recall_memory", { name: params.name, tier: params.tier ?? "project" });
    const resolved = resolveMemoryDirs(ctx.cwd);
    const defaultTier = params.tier === undefined;
    const tier = params.tier ?? "project";
    const otherTier = tier === "project" ? "global" : "project";

    // Candidate order: the requested tier first, then the other tier ONLY
    // when the caller did not name one. An explicitly named tier is honored
    // strictly, so a same-slug entry in the other store is never substituted.
    //
    // The other tier must be a candidate even when the requested tier has NO
    // directory at all: with no project store for this cwd, a global entry
    // must still be reachable. Resolving the dir first and only falling back
    // after a failed READ dropped that case entirely, so recall_memory
    // answered "No memory directory available (tier=project)" while a global
    // store full of memories sat one call away.
    const ordered: Array<"project" | "global"> = defaultTier ? [tier, otherTier] : [tier];
    const candidates: MemoryDir[] = [];
    for (const t of ordered) {
      const d = pickTier(resolved, t);
      if (d && !candidates.includes(d)) candidates.push(d);
    }

    if (candidates.length === 0) {
      return {
        content: [{ type: "text", text: `No memory directory available (tier=${tier}).` }],
        details: undefined as unknown,
      };
    }

    let miss: string | null = null;
    // "not found" is the least informative failure there is. `miss ??=` kept the
    // FIRST one, so with an entry absent from the first tier but present and
    // unreadable (oversize, unreadable file) in the second, the caller was told
    // the memory does not exist — and a model told that may simply write it
    // again, creating a duplicate of a file that is sitting right there.
    const isNotFound = (m: string) => /not found/i.test(m);
    for (const dir of candidates) {
      const result = readMemory(dir, params.name);
      if (!result.ok) {
        if (miss === null || (isNotFound(miss) && !isNotFound(result.message))) {
          miss = result.message;
        }
        continue;
      }
      if (dir !== candidates[0]) {
        debugLog("tool.recall_memory.fallback", { name: params.name, tier: dir.tier });
      }
      const header = `**${dir.label} tier** \u2014 \u0060${result.filePath}\u0060\n\n`;
      return {
        content: [{ type: "text", text: header + result.content }],
        details: {
          tier: dir.tier,
          filePath: result.filePath,
          name: result.frontmatter.name,
        } as unknown,
      };
    }

    return {
      content: [{ type: "text", text: miss ?? `Memory not found: ${params.name}` }],
      details: undefined as unknown,
    };
  },
});

const writeTool = defineTool({
  name: "write_memory",
  label: "Write Memory",
  description:
    "Write a Claude Code-format memory entry (YAML frontmatter + markdown body) and append a link to MEMORY.md. " +
    "Round-trip validates YAML before writing. " +
    "Writes to the SAME files Claude Code uses — the shared store stays in sync. " +
    "An entry with the same name is overwritten at the file level; hand-authored MEMORY.md sections are preserved.",
  parameters: Type.Object({
    name: Type.String({
      description:
        "Entry name (slug). Will be slugified to a safe filename, e.g. 'prefer-jq-for-json'.",
    }),
    description: Type.String({
      description: "One-line summary shown in the MEMORY.md index link entry.",
    }),
    type: Type.Union(
      [
        Type.Literal("feedback"),
        Type.Literal("reference"),
        Type.Literal("project"),
        Type.Literal("user"),
      ],
      {
        description:
          "Memory type. feedback=behavioral rule, reference=lookup material, project=project fact, user=user preference.",
      },
    ),
    body: Type.String({ description: "Markdown body of the memory entry." }),
    tier: Type.Optional(
      Type.Union([Type.Literal("project"), Type.Literal("global")], {
        description: "Memory tier. Default: project.",
      }),
    ),
    pinned: Type.Optional(
      Type.Boolean({
        description: "If true, always injected in full regardless of size. Default: false.",
      }),
    ),
    priority: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 5,
        description:
          "Priority 1-5 (5=highest). Controls injection order when budget is tight. Defaults to type: feedback=5, user=4, project=3, reference=2.",
      }),
    ),
  }),
  promptSnippet:
    "write_memory - Write a Claude Code memory entry (auto-learned fact or reference). Shares store with Claude Code.",
  promptGuidelines: [
    // No reviewer clause here. This guideline used to hardcode "A background
    // reviewer sweeps every 10 turns", which contradicted the injected anchor
    // whenever autoLearn was off or the interval differed — and this is the
    // text the model reads right before deciding whether to call write_memory,
    // so with autoLearn off it told the model to withhold routine memories
    // from a sweep that never runs. The anchor is injected every turn and now
    // states the reviewer honestly for the current config; keeping one source
    // of truth is the fix, not a second copy that can drift again.
    "Use write_memory proactively only for explicit signals: user corrections, stated preferences, or verified fixes. Whether routine observations are captured automatically depends on configuration — follow the memory anchor in your context.",
    "Do NOT write memories for ephemeral state, TODOs, or debugging steps — those belong in session notes, not durable memory.",
    "Pick the right type: feedback=behavioral rule (always inject), reference=lookup material (on-demand), project=project-specific fact, user=user preference.",
    "Keep descriptions to one line — they appear in the MEMORY.md index that is injected every turn.",
    "Prefer the global tier for cross-project facts (user preferences, tool conventions). Use project tier for project-specific facts.",
  ],
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    debugLog("tool.write_memory", {
      name: params.name,
      type: params.type,
      tier: params.tier ?? "project",
      pinned: params.pinned ?? false,
      priority: params.priority ?? null,
      bodyChars: params.body.length,
    });
    const tier = params.tier ?? "project";
    // Resolution is exact for every operation; a same-basename store is never
    // adopted implicitly, so a write cannot land in another project's store.
    const resolved = resolveMemoryDirs(ctx.cwd);
    let dir = pickTier(resolved, tier);
    // Create the dir if it doesn't exist yet (fresh installations have no
    // store — reads stay side-effect-free, writes create on demand).
    if (!dir && tier === "project") {
      dir = createProjectMemoryDir(ctx.cwd);
    } else if (!dir && tier === "global") {
      dir = createGlobalMemoryDir();
    }
    if (!dir) {
      return {
        content: [
          { type: "text", text: `No ${tier} memory directory available for cwd ${ctx.cwd}.` },
        ],
        details: undefined as unknown,
      };
    }

    // The writer touches the filesystem in several places (mkdir, temp write
    // + rename, index patch). A failure there must surface as ok:false rather
    // than reject the tool call, and invalidation must still run: the topic
    // file may well have landed before the failure, so the frozen injection
    // is stale either way.
    let result: MemoryOpResult;
    try {
      result = writeMemory(dir, {
        name: params.name,
        description: params.description,
        type: params.type,
        body: params.body,
        pinned: params.pinned ?? false,
        tier,
        priority: params.priority ?? null,
        allowOverwrite: true, // tool is user-initiated, overwrite is expected
      });
    } catch (err) {
      debugLog("tool.write_memory_error", { name: params.name, tier, error: String(err) });
      result = { ok: false, message: `Failed to write memory ${params.name}: ${String(err)}` };
    } finally {
      // Invalidate the resolver cache so the next before_agent_start picks up
      // any newly created project dir or index changes. This causes a one-time
      // cache miss on the next turn (user explicitly wrote, one miss is fine).
      invalidateResolveCache();
    }
    return {
      content: [
        { type: "text", text: result.message + (result.filePath ? ` (${result.filePath})` : "") },
      ],
      details: { ok: result.ok, filePath: result.filePath, tier: dir.tier } as unknown,
    };
  },
});

const removeTool = defineTool({
  name: "remove_memory",
  label: "Remove Memory",
  description:
    "Remove a memory entry by moving the file to .trash/ (recoverable) and removing its link from MEMORY.md. " +
    "Never hard-deletes. Use to retire stale or incorrect memories.",
  parameters: Type.Object({
    name: Type.String({ description: "Entry name (slug) or filename to remove." }),
    tier: Type.Optional(
      Type.Union([Type.Literal("project"), Type.Literal("global")], {
        description: "Memory tier. Default: project.",
      }),
    ),
  }),
  promptSnippet:
    "remove_memory - Move a memory entry to .trash/ and remove its MEMORY.md link. Recoverable, never hard-deletes.",
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    debugLog("tool.remove_memory", { name: params.name, tier: params.tier ?? "project" });
    const explicitTier = params.tier !== undefined;
    const tier = params.tier ?? "project";
    const otherTier = tier === "project" ? "global" : "project";
    // Resolution is exact for every operation (see write_memory), so a
    // removal can only name an entry in this project's own store — or the
    // global tier, which is one fixed directory.
    const resolved = resolveMemoryDirs(ctx.cwd);

    // Candidate order mirrors recall_memory: the requested tier first, then the
    // other tier ONLY when the caller did not name one. An explicitly named tier
    // is honored strictly, so a same-named entry in another store is never
    // removed by accident.
    //
    // The fallback has to be ENTRY-level, not directory-level. Falling back only
    // when the requested tier had no directory at all meant that with a project
    // store present, `remove_memory feedback_prefer_jq` (a real global entry)
    // resolved the project dir, answered "not found", and never consulted
    // global — while recall_memory, which the anchor tells the model to use
    // when a memory is wrong, found the same entry without trouble.
    const ordered: Array<"project" | "global"> = explicitTier ? [tier] : [tier, otherTier];
    const candidates: MemoryDir[] = [];
    for (const t of ordered) {
      const d = pickTier(resolved, t);
      if (d && !candidates.some((c) => c.dir === d.dir)) candidates.push(d);
    }

    // Indexes that may hold a reference to the removed topic, INDEPENDENT of
    // `explicitTier`. Naming a tier constrains which store the entry is removed
    // FROM; it must not constrain which indexes get their dangling reference
    // cleaned. Deriving this from `candidates` made it empty on the explicit
    // path, so `remove_memory({name, tier: "global"})` trashed the global topic
    // and left the project index advertising it — the exact dangling link this
    // argument exists to prevent, on the invocation the injected anchor teaches
    // the model to use when it tags an entry "[in global tier]".
    const allDirs: MemoryDir[] = [];
    for (const t of ["project", "global"] as const) {
      const d = pickTier(resolved, t);
      if (d && !allDirs.some((c) => c.dir === d.dir)) allDirs.push(d);
    }

    if (candidates.length === 0) {
      return {
        content: [{ type: "text", text: `No ${tier} memory directory available.` }],
        details: undefined as unknown,
      };
    }

    // Try each candidate until one actually holds the entry. A "not found" in
    // the first tier is not an answer while another tier is untried. Any OTHER
    // failure IS an answer about that tier, so it is reported instead of being
    // retried against a store the caller did not name.
    let result: MemoryOpResult | null = null;
    let dir: MemoryDir = candidates[0];
    let firstMiss: string | null = null;
    const isNotFound = (m: string) => /not found/i.test(m);
    try {
      for (const candidate of candidates) {
        const attempt = removeMemory(candidate, {
          name: params.name,
          tier: candidate.tier,
          // Every resolved store, so the other one's dangling cross-tier
          // reference is stripped in the same operation.
          alsoUnlink: allDirs.filter((c) => c.dir !== candidate.dir),
        });
        if (!attempt.ok) {
          if (attempt.reason === "not_found") {
            // Keep the most specific absence, mirroring recall_memory: the first
            // tier answering "not found" must not mask a second tier's "too
            // large to read", which tells the caller the memory does exist.
            if (firstMiss === null || (isNotFound(firstMiss) && !isNotFound(attempt.message))) {
              firstMiss = attempt.message;
            }
            continue;
          }
          // A refusal — a safety check declining, or an I/O failure — is an
          // ANSWER about this tier, not an invitation to try the other store.
          // Falling through here trashed an entry the caller never named: with
          // `.trash` in the project tier present as a plain file, remove_memory
          // refused the project removal and then deleted the GLOBAL copy while
          // reporting success.
          result = attempt;
          dir = candidate;
          break;
        }
        result = attempt;
        dir = candidate;
        break;
      }
    } catch (err) {
      debugLog("tool.remove_memory_error", { name: params.name, tier, error: String(err) });
      result = { ok: false, message: `Failed to remove memory ${params.name}: ${String(err)}` };
    } finally {
      // Invalidate the resolver cache so the next before_agent_start reflects
      // the removed entry in the index.
      invalidateResolveCache();
    }

    const finalResult: MemoryOpResult = result ?? {
      ok: false,
      message: firstMiss ?? `Memory not found: ${params.name}`,
    };
    return {
      content: [{ type: "text", text: finalResult.message }],
      details: { ok: finalResult.ok, tier: dir.tier, trashPath: finalResult.filePath } as unknown,
    };
  },
});

export const recallMemoryTool = recallTool;
export const writeMemoryTool = writeTool;
export const removeMemoryTool = removeTool;

/** Wrap a tool so its execute body runs inside the debug-log context for the
 * call.
 *
 * Tool calls arrive outside the lifecycle handlers, so without this no
 * AsyncLocalStorage context is active and every debugLog in the read/write/
 * remove path is discarded. The diagnostics existed and could never be emitted
 * in production; a test that established the context by hand (as the ambiguity
 * test did) hid exactly that gap.
 *
 * Wrapped at registration rather than inside each body: the context needs the
 * CALL's cwd, and the definitions stay untouched because they are exported and
 * used directly by tests. The extension context is the last argument. */
function withLogging<T extends object>(tool: T): T {
  const inner = (tool as { execute: (...a: unknown[]) => Promise<unknown> }).execute;
  return {
    ...tool,
    execute: (...args: unknown[]) => {
      const ctx = args.at(-1) as { cwd?: string } | undefined;
      return withToolLogContext(ctx?.cwd ?? process.cwd(), () => inner(...args));
    },
  } as T;
}

/** Register all memory tools. */
export function registerMemoryTools(pi: ExtensionAPI): void {
  pi.registerTool(withLogging(recallTool));
  pi.registerTool(withLogging(writeTool));
  pi.registerTool(withLogging(removeTool));
}
