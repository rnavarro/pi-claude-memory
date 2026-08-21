// pi-claude-memory — shared Claude Code memory store for Pi
//
// Reads and writes the same memory files Claude Code uses:
//   ~/.claude/projects/<path-hash>/memory/  (project tier)
//   ~/.claude/memory/                        (global tier)
//
// Phase 1: read-only harness — injection only, no writes.
// Phase 2: tools — recall_memory, write_memory, remove_memory.

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildMemoryInjection } from "./injector.js";
import { resolveMemoryDirs } from "./resolver.js";
import { registerMemoryTools } from "./tools.js";
import type { ResolveResult } from "./types.js";

// Cache the resolved memory dirs for the session.
// Resolution involves glob probes which are expensive to repeat every turn.
let cachedResolve: { cwd: string; result: ResolveResult } | null = null;

export default function piClaudeMemory(pi: ExtensionAPI): void {
  // Phase 1: inject memory into the system prompt on every before_agent_start.
  // Pi rebuilds the system prompt from scratch each turn, so we must inject
  // every turn — skipping means the memory is entirely absent from that turn.
  pi.on("before_agent_start", handleBeforeAgentStart);

  // Phase 2: register memory tools.
  registerMemoryTools(pi);

  // Reset the resolver cache on session lifecycle events (cwd may change)
  pi.on("session_start", () => {
    cachedResolve = null;
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

  // Resolve (or use cached) memory directories
  const resolved = getCachedResolve(cwd);
  if (!resolved.project && !resolved.global) {
    return; // no memory for this cwd — nothing to inject
  }

  // Build the injection text
  const { text, warnings } = buildMemoryInjection(resolved.project, resolved.global);

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

/** Get cached or fresh resolve result for a cwd. */
function getCachedResolve(cwd: string): ResolveResult {
  if (cachedResolve && cachedResolve.cwd === cwd) {
    return cachedResolve.result;
  }

  const result = resolveMemoryDirs(cwd);
  cachedResolve = { cwd, result };
  return result;
}
