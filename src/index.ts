// pi-claude-memory — shared Claude Code memory store for Pi
//
// Reads and writes the same memory files Claude Code uses:
//   ~/.claude/projects/<path-hash>/memory/  (project tier)
//   ~/.claude/memory/                        (global tier)
//
// Phase 1: read-only harness — injection only, no writes.
// Phase 2: tools — recall_memory, write_memory, remove_memory.
// Phase 3: auto-learning — periodic background review via completeSimple.

import type {
  AgentSettledEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionMessageEntry,
  ToolResultEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { buildExistingIndexSummary, DEFAULT_AUTOLEARN_CONFIG, runAutoLearn } from "./auto-learn.js";
import { buildMemoryInjection } from "./injector.js";
import { resolveMemoryDirs } from "./resolver.js";
import { registerMemoryTools } from "./tools.js";
import type { ResolveResult } from "./types.js";

// ---------------------------------------------------------------------------
// Session-level caches
//
// Pi rebuilds the system prompt from scratch every turn. To keep the prompt
// cache prefix stable, we freeze the injection text at session start and reuse
// the exact same bytes every turn. Only explicit user actions
// (write_memory / remove_memory) invalidate the frozen text — a one-time cache
// miss that's acceptable because the user explicitly asked.
//
// Auto-learn writes do NOT invalidate: they take effect next session. The model
// already has the context from the conversation; the new memory is for future
// sessions, not the current one.
// ---------------------------------------------------------------------------

/** Frozen injection text + resolve result for the current session. */
interface FrozenInjection {
  /** The cwd this was computed for (recompute if cwd changes). */
  cwd: string;
  /** The injection text to append to the system prompt every turn. */
  text: string;
  /** The resolved memory dirs (for auto-learn). */
  resolved: ResolveResult;
}

let frozenInjection: FrozenInjection | null = null;

// Capture the ExtensionAPI at registration time so event handlers can call
// pi.getAllTools() to check if ctx_search is registered.
let api: ExtensionAPI | null = null;

// Turn counter for auto-learning. Incremented on turn_end, checked on agent_settled.
let turnCount = 0;

// Recent tool results captured for auto-learn context.
// The session branch (from ctx.sessionManager.getBranch()) gives us user +
// assistant messages, but tool results are truncated. This supplements them.
const TOOL_RESULT_MAX_CHARS = 8000;
let toolResultChunk = "";

export default function piClaudeMemory(pi: ExtensionAPI): void {
  api = pi;

  // Phase 1: inject memory into the system prompt on every before_agent_start.
  // Pi rebuilds the system prompt from scratch each turn, so we must inject
  // every turn — but the text is frozen at session start so the prompt cache
  // prefix stays byte-identical across turns.
  pi.on("before_agent_start", handleBeforeAgentStart);

  // Phase 2: register memory tools.
  registerMemoryTools(pi);

  // Phase 3: auto-learning. Count turns and capture tool results, then fire
  // a background review every N turns after the agent settles.
  pi.on("turn_end", handleTurnEnd);
  pi.on("tool_result", handleToolResult);
  pi.on("agent_settled", handleAgentSettled);

  // Reset caches on session lifecycle events
  pi.on("session_start", () => {
    frozenInjection = null;
    turnCount = 0;
    toolResultChunk = "";
  });

  pi.on("session_before_compact", () => {
    // Freeze is still valid post-compaction — memory files haven't changed.
    // Just reset the tool result buffer to avoid feeding stale context to
    // the next auto-learn cycle.
    toolResultChunk = "";
  });
}

/** Handle before_agent_start: inject frozen memory into the system prompt. */
async function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult | undefined> {
  const cwd = ctx.cwd;

  // Use frozen injection if available and cwd hasn't changed.
  // This keeps the system prompt byte-identical across turns → prompt cache hit.
  let frozen = frozenInjection;
  if (!frozen || frozen.cwd !== cwd) {
    frozen = computeInjection(cwd);
    frozenInjection = frozen;
  }

  if (!frozen.text) {
    return; // nothing to inject
  }

  // Log warnings to stderr for debugging (never block the turn)
  // (warnings are only logged on first compute, not every turn)

  // Append memory to the system prompt
  return {
    systemPrompt: event.systemPrompt + frozen.text,
  };
}

/** Compute and freeze the injection text for a cwd. */
function computeInjection(cwd: string): FrozenInjection {
  const resolved = resolveMemoryDirs(cwd);

  // Check if ctx_search is registered so the anchor only references it when available.
  const hasCtxSearch = api?.getAllTools().some((t) => t.name === "ctx_search") ?? false;

  const { text, warnings } = buildMemoryInjection(
    resolved.project,
    resolved.global,
    5000,
    hasCtxSearch,
  );

  if (warnings.length > 0) {
    for (const w of warnings) {
      console.error(`[pi-claude-memory] ${w}`);
    }
  }

  return { cwd, text, resolved };
}

/** Handle turn_end: increment counter. */
function handleTurnEnd(_event: TurnEndEvent, _ctx: ExtensionContext): void {
  turnCount++;
}

/** Handle tool_result: capture tool output text for auto-learn context. */
function handleToolResult(event: ToolResultEvent, _ctx: ExtensionContext): void {
  const text = toolResultToText(event);
  if (text) {
    appendToToolResultChunk(text);
  }
}

/** Handle agent_settled: fire background auto-learn every N turns. */
function handleAgentSettled(_event: AgentSettledEvent, ctx: ExtensionContext): void {
  if (turnCount < DEFAULT_AUTOLEARN_CONFIG.everyTurns) {
    return;
  }
  // Reset the counter so we count the next N turns
  turnCount = 0;

  // Build conversation text from the session branch — this gives us user
  // prompts, assistant text, and tool calls (tool results are truncated in
  // the branch, so we supplement with the toolResultChunk).
  const branchText = serializeBranch(ctx);
  const toolText = toolResultChunk;
  toolResultChunk = "";

  // Combine: branch has the conversation flow, toolText has the full tool outputs
  const chunk = toolText ? `${branchText}\n\n### Tool Results\n${toolText}` : branchText;

  if (!chunk.trim()) return;

  // Use the frozen resolve result if available (avoids re-resolving).
  // Fall back to fresh resolve if the freeze was somehow lost.
  const resolved = frozenInjection?.resolved ?? resolveMemoryDirs(ctx.cwd);
  const existingIndex = buildExistingIndexSummary(resolved);

  // Fire-and-forget: never block the user's next turn.
  void runAutoLearn(ctx, DEFAULT_AUTOLEARN_CONFIG, ctx.cwd, chunk, existingIndex).then(
    (written) => {
      if (written > 0) {
        console.error(
          `[pi-claude-memory] auto-learn: wrote ${written} new memor${written === 1 ? "y" : "ies"}`,
        );
      }
      // IMPORTANT: do NOT invalidate the frozen injection. Auto-learn writes
      // take effect next session — the model already has this context from
      // the conversation. Invalidating here would bust the prompt cache for
      // facts the model just saw.
    },
    (err) => {
      console.error(`[pi-claude-memory] auto-learn: unexpected error: ${String(err)}`);
    },
  );
}

/** Serialize the session branch to text for auto-learn input. */
function serializeBranch(ctx: ExtensionContext): string {
  let entries: SessionMessageEntry[];
  try {
    entries = ctx.sessionManager
      .getBranch()
      .filter((e): e is SessionMessageEntry => e.type === "message");
  } catch {
    return "";
  }

  // Take the last ~20 messages to stay within a reasonable size for the LLM.
  const recent = entries.slice(-20);
  const parts: string[] = [];

  for (const entry of recent) {
    const msg = entry.message as { role?: string; content?: unknown };
    const role = msg.role ?? "unknown";
    const content = msg.content;

    if (typeof content === "string") {
      parts.push(`### ${role}\n${content}`);
      continue;
    }

    if (Array.isArray(content)) {
      const textParts = content
        .map((c) => {
          if (!c || typeof c !== "object") return "";
          const part = c as { type?: string; text?: string };
          if (part.type === "text" && typeof part.text === "string") return part.text;
          return "";
        })
        .filter(Boolean);
      if (textParts.length > 0) {
        parts.push(`### ${role}\n${textParts.join("\n")}`);
      }
    }
  }

  return parts.join("\n\n");
}

/** Convert a tool result event to text for the auto-learn chunk. */
function toolResultToText(event: ToolResultEvent): string {
  const toolName = "toolName" in event ? event.toolName : "unknown";
  const parts = event.content
    .map((c) => {
      if (c.type === "text" && typeof c.text === "string") return c.text;
      return "";
    })
    .filter(Boolean);
  if (parts.length === 0) return "";
  return `#### ${toolName}\n${parts.join("\n")}`;
}

/** Append text to the tool result chunk, capping total size. */
function appendToToolResultChunk(text: string): void {
  if (!text) return;
  if (toolResultChunk.length + text.length > TOOL_RESULT_MAX_CHARS) {
    // Drop the oldest content: keep the tail of the existing buffer
    const overflow = toolResultChunk.length + text.length - TOOL_RESULT_MAX_CHARS;
    toolResultChunk = toolResultChunk.slice(overflow + 1);
  }
  toolResultChunk += `${toolResultChunk ? "\n\n" : ""}${text}`;
}

/** Invalidate the frozen injection.
 *
 * Called after write_memory/remove_memory modifies the memory store. The next
 * before_agent_start will recompute from disk and pick up the changes.
 *
 * This is a one-time cache miss on the next turn (system prompt changes because
 * new memory content appears). That's acceptable — the user explicitly wrote.
 *
 * Auto-learn does NOT call this — its writes take effect next session to
 * preserve the prompt cache prefix. */
export function invalidateResolveCache(): void {
  frozenInjection = null;
}
