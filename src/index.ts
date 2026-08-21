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
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { buildExistingIndexSummary, DEFAULT_AUTOLEARN_CONFIG, runAutoLearn } from "./auto-learn.js";
import { buildMemoryInjection } from "./injector.js";
import { resolveMemoryDirs } from "./resolver.js";
import { registerMemoryTools } from "./tools.js";
import type { ResolveResult } from "./types.js";

// Cache the resolved memory dirs for the session.
// Resolution involves glob probes which are expensive to repeat every turn.
let cachedResolve: { cwd: string; result: ResolveResult } | null = null;

// Capture the ExtensionAPI at registration time so event handlers can call
// pi.getAllTools() to check if ctx_search is registered.
let api: ExtensionAPI | null = null;

// Turn counter for auto-learning. Incremented on turn_end, checked on agent_settled.
let turnCount = 0;

// Rolling buffer of recent conversation text for the next auto-learn cycle.
// Capped to keep memory bounded; the LLM only needs the recent window.
const CHUNK_MAX_CHARS = 12000;
let conversationChunk = "";

export default function piClaudeMemory(pi: ExtensionAPI): void {
  api = pi;
  // Phase 1: inject memory into the system prompt on every before_agent_start.
  // Pi rebuilds the system prompt from scratch each turn, so we must inject
  // every turn — skipping means the memory is entirely absent from that turn.
  pi.on("before_agent_start", handleBeforeAgentStart);

  // Phase 2: register memory tools.
  registerMemoryTools(pi);

  // Phase 3: auto-learning. Count turns and accumulate conversation text,
  // then fire a background review every N turns after the agent settles.
  pi.on("turn_end", handleTurnEnd);
  pi.on("agent_settled", handleAgentSettled);

  // Reset the resolver cache on session lifecycle events (cwd may change)
  pi.on("session_start", () => {
    cachedResolve = null;
    turnCount = 0;
    conversationChunk = "";
  });

  pi.on("session_before_compact", () => {
    // Reset cache — pi-observational-memory handles the actual compaction.
    // We only reset our cache in case cwd changed mid-session (unlikely).
    cachedResolve = null;
    // Return void — we don't interfere with compaction
  });
}

/** Handle before_agent_start: inject memory into the system prompt. */
async function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult | undefined> {
  const cwd = ctx.cwd;

  // Resolve (or use cached) memory directories.
  // Even when no memory dirs exist yet (new project), we still inject the
  // routing anchor so the model knows write_memory is available to create
  // the first memory in this project.
  const resolved = getCachedResolve(cwd);

  // Check if ctx_search is registered so the anchor only references it when available.
  // This is cache-safe: the tool set doesn't change mid-session, so the result
  // is deterministic across turns.
  const hasCtxSearch = api?.getAllTools().some((t) => t.name === "ctx_search") ?? false;

  // Build the injection text (always includes the routing anchor)
  const { text, warnings } = buildMemoryInjection(
    resolved.project,
    resolved.global,
    5000,
    hasCtxSearch,
  );

  // Log warnings to stderr for debugging (never block the turn)
  if (warnings.length > 0) {
    for (const w of warnings) {
      console.error(`[pi-claude-memory] ${w}`);
    }
  }

  if (!text) {
    return; // nothing to inject
  }

  // Append memory to the system prompt
  return {
    systemPrompt: event.systemPrompt + text,
  };
}

/** Handle turn_end: increment counter and append message text to the chunk buffer. */
function handleTurnEnd(event: TurnEndEvent, _ctx: ExtensionContext): void {
  turnCount++;
  const text = messageToText(event.message);
  if (text) {
    appendToChunk(text);
  }
}

/** Handle agent_settled: fire background auto-learn every N turns. */
function handleAgentSettled(_event: AgentSettledEvent, ctx: ExtensionContext): void {
  if (turnCount < DEFAULT_AUTOLEARN_CONFIG.everyTurns) {
    return;
  }
  // Reset the counter so we count the next N turns
  turnCount = 0;
  // Snapshot the chunk and reset the buffer
  const chunk = conversationChunk;
  conversationChunk = "";

  // Fire-and-forget: never block the user's next turn.
  // Errors are caught inside runAutoLearn and logged to stderr.
  const resolved = resolveMemoryDirs(ctx.cwd);
  const existingIndex = buildExistingIndexSummary(resolved);
  void runAutoLearn(ctx, DEFAULT_AUTOLEARN_CONFIG, ctx.cwd, chunk, existingIndex).then(
    (written) => {
      if (written > 0) {
        console.error(
          `[pi-claude-memory] auto-learn: wrote ${written} new memor${written === 1 ? "y" : "ies"}`,
        );
      } else if (written === 0) {
        // No-op — silent on the common case of nothing to learn
      }
    },
    (err) => {
      console.error(`[pi-claude-memory] auto-learn: unexpected error: ${String(err)}`);
    },
  );
}

/** Convert an AgentMessage to plain text for the conversation chunk. */
function messageToText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { role?: string; content?: unknown };
  const role = m.role ?? "unknown";
  const content = m.content;
  if (typeof content === "string") return `### ${role}\n${content}`;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => {
        if (!c || typeof c !== "object") return "";
        const part = c as { type?: string; text?: string };
        if (part.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean);
    if (parts.length === 0) return "";
    return `### ${role}\n${parts.join("\n")}`;
  }
  return "";
}

/** Append text to the rolling chunk buffer, capping total size. */
function appendToChunk(text: string): void {
  if (!text) return;
  if (conversationChunk.length + text.length > CHUNK_MAX_CHARS) {
    // Drop the oldest content: keep the tail of the existing buffer
    const overflow = conversationChunk.length + text.length - CHUNK_MAX_CHARS;
    conversationChunk = conversationChunk.slice(overflow + 1);
  }
  conversationChunk += `${conversationChunk ? "\n\n" : ""}${text}`;
}

/** Get cached or fresh resolve result for a cwd. */
function getCachedResolve(cwd: string): ResolveResult {
  if (cachedResolve && cachedResolve.cwd === cwd) {
    return cachedResolve.result;
  }

  const result = resolveMemoryDirs(cwd);
  cachedResolve = { cwd, result };
  return result;
}

/** Invalidate the resolver cache.
 *
 * Called after write_memory/remove_memory modifies the memory dir structure
 * (e.g., creates a new project dir). The next before_agent_start will re-resolve
 * from disk and pick up the new dir.
 *
 * This is a one-time cache miss on the next turn (system prompt changes because
 * new memory content appears). That's acceptable — the user explicitly wrote. */
export function invalidateResolveCache(): void {
  cachedResolve = null;
}
