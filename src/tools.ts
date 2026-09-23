// Memory tools: recall_memory, write_memory, remove_memory.
//
// These tools let the agent read individual memory files by name (with
// [[wikilink]] resolution), write new Claude-format memory files, and remove
// stale ones. All writes go to the SAME files Claude Code uses, so the two
// agents share a single store and never diverge.

import { basename } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./debug-log.js";
import { invalidateResolveCache, withToolLogContext } from "./index.js";
import { parseIndexFile, reconcileIndex } from "./index-parser.js";
import type { MemoryOpResult } from "./memory-writer.js";
import { readMemory, removeMemory, writeMemory } from "./memory-writer.js";
import { createProjectMemoryDir, resolveMemoryDirs } from "./resolver.js";
import type { MemoryDir } from "./types.js";

/** Refuse a request that still names a memory tier, and say why.
 *
 * The global tier is gone, so `tier: "global"` has no destination. Quietly
 * treating it as the project store would silently retarget a write or a
 * removal — worse than failing. A model can carry the habit for a while (the
 * injected anchor taught it this parameter for months), and an explanatory
 * refusal is how it learns otherwise.
 *
 * `tier: "project"` is accepted and ignored so a harmless echo keeps working. */
function tierRefusal(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const tier = (params as { tier?: unknown }).tier;
  if (tier === undefined || tier === "project") return null;
  return (
    `No "${String(tier)}" memory tier: pi-claude-memory is project-scoped, matching Claude Code, ` +
    `which has no cross-project memory store. Nothing was written or removed. Retry without the ` +
    `tier parameter; a rule that must apply in every project belongs in AGENTS.md or CLAUDE.md.`
  );
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
  }),
  promptSnippet:
    "recall_memory - Read a Claude Code memory entry by name with [[wikilink]] resolution.",
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const refusal = tierRefusal(params);
    if (refusal) {
      return { content: [{ type: "text", text: refusal }], details: undefined as unknown };
    }
    debugLog("tool.recall_memory", { name: params.name });
    const dir = resolveMemoryDirs(ctx.cwd).project;
    if (!dir) {
      return {
        content: [
          {
            type: "text",
            text: `No memory store for this project yet (${ctx.cwd}) — nothing has been written here.`,
          },
        ],
        details: undefined as unknown,
      };
    }

    // Resolution inside readMemory is exact, so a name that is not in this
    // store fails instead of being answered by a same-named entry elsewhere.
    const result = readMemory(dir, params.name);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: result.message }],
        details: undefined as unknown,
      };
    }
    const header = `**${dir.label}** \u2014 \u0060${result.filePath}\u0060\n\n`;
    return {
      content: [{ type: "text", text: header + result.content }],
      details: {
        tier: dir.tier,
        filePath: result.filePath,
        name: result.frontmatter.name,
      } as unknown,
    };
  },
});

/** Default and maximum result counts for find_memory.
 *
 * Bounded on purpose: the store is larger than the context window, which is the
 * whole problem. A search that returns a thousand lines has reproduced it. */
const FIND_DEFAULT_LIMIT = 25;
const FIND_MAX_LIMIT = 100;
/** Summary text kept per hit. The summary is a discovery aid, not the entry. */
const FIND_SUMMARY_CHARS = 140;

/** One search hit, rendered as a single line. */
interface FindHit {
  name: string;
  title: string;
  summary: string;
  /** Index line number, or null when no index line points at the file. */
  line: number | null;
}

/** Find a memory entry by keyword across the FULL store, not the injected prefix.
 *
 * The injected index stops at Claude Code's startup limit, so past that limit the
 * model cannot see most of its own memories — and cannot ask for one whose name
 * it does not know, which makes a memory it cannot see a memory it does not have.
 * This is the discovery half of that fix: the reader still shows the prefix, and
 * this searches everything.
 *
 * It writes nothing and reads only the index (guarded and size-capped) plus one
 * directory listing, so it cannot disturb the store or race the writer. */
const findTool = defineTool({
  name: "find_memory",
  label: "Search Memory",
  description:
    "Find memory entry names by keyword across this project's WHOLE memory store. " +
    "The injected index is cut at Claude Code's startup limit (200 lines or 25 KB), so entries " +
    "below that cut are invisible to the prompt even though they are present and recallable. " +
    "Search before concluding a memory does not exist. Returns names for recall_memory, not bodies.",
  parameters: Type.Object({
    query: Type.String({
      description:
        "Case-insensitive keywords. Every word must appear in the entry's title, summary, or filename.",
    }),
    limit: Type.Optional(
      Type.Number({
        description: `Maximum entries to return (default ${FIND_DEFAULT_LIMIT}, max ${FIND_MAX_LIMIT}).`,
      }),
    ),
  }),
  promptSnippet:
    "find_memory - Find a memory entry's name by keyword when the injected index is truncated.",
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const refusal = tierRefusal(params);
    if (refusal) {
      return { content: [{ type: "text", text: refusal }], details: undefined as unknown };
    }
    debugLog("tool.find_memory", { query: params.query });
    const dir = resolveMemoryDirs(ctx.cwd).project;
    if (!dir) {
      return {
        content: [
          {
            type: "text",
            text: `No memory store for this project yet (${ctx.cwd}) — nothing has been written here.`,
          },
        ],
        details: undefined as unknown,
      };
    }

    const terms = params.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (terms.length === 0) {
      return {
        content: [{ type: "text", text: "find_memory needs at least one keyword." }],
        details: undefined as unknown,
      };
    }
    const requested =
      typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.floor(params.limit)
        : FIND_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(FIND_MAX_LIMIT, requested));
    const matches = (haystack: string) => terms.every((t) => haystack.includes(t));

    const parsed = parseIndexFile(dir);
    const hits: FindHit[] = [];
    const claimed = new Set<string>();

    // Indexed entries, newest first. The index is append-ordered, so the line
    // number is the only recency signal the index itself carries — priority and
    // modified live in the topic frontmatter, and reading a thousand of those to
    // rank a keyword search costs more than it returns. Newest-first also puts
    // the entries most likely to be missing from the injected prefix on top,
    // which is the case this tool exists for.
    for (const entry of parsed?.entries ?? []) {
      const name = basename(entry.href);
      const key = name.toLowerCase();
      if (claimed.has(key)) continue;
      if (!matches(`${entry.title}\n${entry.summary}\n${entry.href}`.toLowerCase())) continue;
      claimed.add(key);
      hits.push({ name, title: entry.title, summary: entry.summary, line: entry.lineNumber });
    }
    hits.sort((a, b) => (b.line ?? 0) - (a.line ?? 0));

    // A topic file no index line points at is still recallable by name, and it is
    // exactly the silent-invisibility case a search should surface rather than
    // conceal. Its title lives in frontmatter, which this does not read, so it
    // matches on filename alone.
    const recon = reconcileIndex(parsed ?? { lines: [], entries: [] }, dir.dir);
    const unindexed: FindHit[] = [];
    for (const filename of recon.unindexed) {
      const key = filename.toLowerCase();
      if (claimed.has(key)) continue;
      const stem = filename.replace(/\.md$/, "");
      if (!matches(`${stem}\n${filename}`.toLowerCase())) continue;
      claimed.add(key);
      unindexed.push({ name: filename, title: stem, summary: "", line: null });
    }
    unindexed.sort((a, b) => a.name.localeCompare(b.name));
    hits.push(...unindexed);

    const searched = (parsed?.entries.length ?? 0) + recon.unindexed.length;
    const shown = hits.slice(0, limit);
    const body = shown.map((hit) => {
      const summary =
        hit.summary.length > FIND_SUMMARY_CHARS
          ? `${hit.summary.slice(0, FIND_SUMMARY_CHARS)}…`
          : hit.summary;
      const detail = summary.length > 0 ? ` — ${summary}` : "";
      const where = hit.line === null ? "no index line" : `index line ${hit.line}`;
      return `- ${hit.name} — ${hit.title}${detail}  [${where}]`;
    });

    const header =
      hits.length === 0
        ? `No entries match ${JSON.stringify(params.query)} in this project's memory store (${searched} entries searched).`
        : `${hits.length} of ${searched} entries match ${JSON.stringify(params.query)}, newest first. Pass an exact name to recall_memory.`;
    const notes: string[] = [];
    if (hits.length > shown.length) {
      notes.push(`Showing the first ${shown.length}; narrow the query or raise limit.`);
    }
    if (!parsed) {
      notes.push(
        "The index could not be read (absent, symlinked, or oversize), so this covered files on disk only.",
      );
    }

    return {
      content: [{ type: "text", text: [header, ...body, ...notes].join("\n") }],
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
    pinned: Type.Optional(
      Type.Boolean({
        description:
          "Pin marker written into the MEMORY.md line as ⛔ and kept in frontmatter. The LINE is what makes a pin visible: no reader parses a topic's frontmatter, so setting that field alone changes nothing about what gets injected. A pin bypasses no size limit (nothing is injected in full now) and does not escape the 200-line/25KB index cutoff. An overwrite that omits this clears an existing pin; the field defaults to false.",
      }),
    ),
    priority: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 5,
        description:
          "Priority 1-5 (5=highest). Metadata only under the bounded-index contract: with no preloaded bodies there is no injection order left to control. Defaults to type: feedback=5, user=4, project=3, reference=2.",
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
    "Pick the right type: feedback=behavioral rule (highest priority), reference=lookup material (on-demand), project=project-specific fact, user=user preference.",
    "Keep descriptions to one line — they appear in the MEMORY.md index that is injected every turn, bounded to its first 200 lines or 25KB.",
    "The project store is the only store: a rule that must apply in every project belongs in AGENTS.md or CLAUDE.md, not in memory. Use memory for facts needed while working in this project.",
  ],
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const refusal = tierRefusal(params);
    if (refusal) {
      return { content: [{ type: "text", text: refusal }], details: undefined as unknown };
    }
    debugLog("tool.write_memory", {
      name: params.name,
      type: params.type,
      pinned: params.pinned ?? false,
      priority: params.priority ?? null,
      bodyChars: params.body.length,
    });
    // Resolution is exact for every operation; a same-basename store is never
    // adopted implicitly, so a write cannot land in another project's store.
    let dir: MemoryDir | null = resolveMemoryDirs(ctx.cwd).project;
    // Create the store if it doesn't exist yet (fresh installations have none —
    // reads stay side-effect-free, writes create on demand).
    if (!dir) dir = createProjectMemoryDir(ctx.cwd);
    if (!dir) {
      return {
        content: [{ type: "text", text: `Could not create a memory store for cwd ${ctx.cwd}.` }],
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
        priority: params.priority ?? null,
        allowOverwrite: true, // tool is user-initiated, overwrite is expected
      });
    } catch (err) {
      debugLog("tool.write_memory_error", { name: params.name, error: String(err) });
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
  }),
  promptSnippet:
    "remove_memory - Move a memory entry to .trash/ and remove its MEMORY.md link. Recoverable, never hard-deletes.",
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const refusal = tierRefusal(params);
    if (refusal) {
      return { content: [{ type: "text", text: refusal }], details: undefined as unknown };
    }
    debugLog("tool.remove_memory", { name: params.name });
    const dir = resolveMemoryDirs(ctx.cwd).project;
    if (!dir) {
      return {
        content: [{ type: "text", text: `No memory store for this project yet (${ctx.cwd}).` }],
        details: undefined as unknown,
      };
    }

    let result: MemoryOpResult;
    try {
      result = removeMemory(dir, { name: params.name });
    } catch (err) {
      debugLog("tool.remove_memory_error", { name: params.name, error: String(err) });
      result = { ok: false, message: `Failed to remove memory ${params.name}: ${String(err)}` };
    } finally {
      // Invalidate the resolver cache so the next before_agent_start reflects
      // the removed entry in the index.
      invalidateResolveCache();
    }

    return {
      content: [{ type: "text", text: result.message }],
      details: { ok: result.ok, tier: dir.tier, trashPath: result.filePath } as unknown,
    };
  },
});

export const recallMemoryTool = recallTool;
export const findMemoryTool = findTool;
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
  pi.registerTool(withLogging(findTool));
  pi.registerTool(withLogging(writeTool));
  pi.registerTool(withLogging(removeTool));
}
