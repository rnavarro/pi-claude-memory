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
  SessionBeforeCompactEvent,
  SessionEntry,
  SessionMessageEntry,
  SessionShutdownEvent,
  ToolResultEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { type AutoLearnConfig, runAutoLearn } from "./auto-learn.js";
import { loadConfig, type PiClaudeMemoryConfig } from "./config.js";
import { debugLog, withDebugLogContext } from "./debug-log.js";
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

// Loaded config (debugLog, autoLearn, reviewIntervalTurns, etc.)
let config: PiClaudeMemoryConfig = loadConfig();

// Turn counter for auto-learning. Incremented on turn_end, checked on agent_settled.
let turnCount = 0;

// Single-flight tracking for auto-learn. The periodic (agent_settled) trigger
// is fire-and-forget, but session_shutdown must await any in-flight review
// before starting its own, to avoid two concurrent runs over overlapping
// branches. Null when no review is running.
let autoLearnInFlight: Promise<number> | null = null;

// Abort handle for the in-flight review when we own its signal (periodic and
// compact launches pass none of their own). Shutdown-timeout and
// session_start ABORT the review instead of abandoning it — an abandoned
// review keeps writing into the shared store and races the next review.
let autoLearnAbort: AbortController | null = null;

// Session generation, bumped on every session_start. Completion handlers of
// reviews launched under an older generation must not clear state or drain
// the compact queue into a newer session.
let autoLearnGeneration = 0;

// A compaction snapshot waiting for the in-flight review to finish, so the
// pre-compaction branch is not silently dropped when compact fires during a
// running review. Drained in launchAutoLearn's completion handler. Last
// compact wins (coalesce) if several queue while a review runs.
interface PendingCompact {
  ctx: ExtensionContext;
  cfg: AutoLearnConfig;
  cwd: string;
  chunk: string;
}
let pendingCompact: PendingCompact | null = null;

// Recent tool results captured for auto-learn context.
const TOOL_RESULT_MAX_CHARS = 8000;
let toolResultChunk = "";

// Session ID for debug log file naming.
let currentSessionId: string | undefined;

/** Extract session ID from extension context (best-effort). */
function getSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? currentSessionId;
  } catch {
    return currentSessionId;
  }
}

export default function piClaudeMemory(pi: ExtensionAPI): void {
  config = loadConfig();

  debugLog("extension.register", {
    debugLog: config.debugLog,
    autoLearn: config.autoLearn,
    reviewIntervalTurns: config.reviewIntervalTurns,
    injectTokenCap: config.injectTokenCap,
    reviewModel: `${config.reviewModel.provider}/${config.reviewModel.id}`,
    reviewThinking: config.reviewThinking,
    reviewOnShutdown: config.reviewOnShutdown,
    reviewOnCompact: config.reviewOnCompact,
  });

  // Phase 1: inject memory into the system prompt on every before_agent_start.
  pi.on("before_agent_start", handleBeforeAgentStart);

  // Phase 2: register memory tools.
  registerMemoryTools(pi);

  // Phase 3: auto-learning. Count turns and capture tool results, then fire
  // a background review every N turns after the agent settles.
  if (config.autoLearn) {
    pi.on("turn_end", handleTurnEnd);
    pi.on("tool_result", handleToolResult);
    pi.on("agent_settled", handleAgentSettled);

    // Fire auto-learn before compaction so pre-compaction conversation detail
    // is not permanently lost (after compaction getBranch() returns the
    // compaction summary, not raw messages).
    if (config.reviewOnCompact) {
      pi.on("session_before_compact", handleSessionBeforeCompact);
    }

    // Fire auto-learn on shutdown to catch short sessions that never reached
    // the turn threshold. Pi awaits shutdown handlers with no timeout of its
    // own, so we await and apply our own deadline.
    if (config.reviewOnShutdown) {
      pi.on("session_shutdown", handleSessionShutdown);
    }
  }

  // Reset caches on session lifecycle events
  pi.on("session_start", (_event, ctx) => {
    currentSessionId = getSessionId(ctx);
    frozenInjection = null;
    turnCount = 0;
    toolResultChunk = "";
    // A new session invalidates the previous generation: an in-flight review
    // belongs to the old session and must not write while the new one runs.
    // Abort it, bump the generation so its completion handler leaves the
    // new session's state alone, and clear the compact queue.
    autoLearnAbort?.abort();
    autoLearnAbort = null;
    autoLearnGeneration++;
    autoLearnInFlight = null;
    pendingCompact = null;
    withDebugLogContext(
      { enabled: config.debugLog, cwd: ctx.cwd, sessionId: getSessionId(ctx) },
      () => {
        debugLog("session.start", { cwd: ctx.cwd, sessionId: getSessionId(ctx) });
      },
    );
  });
}

/** Handle session_before_compact: fire auto-learn over the pre-compaction
 * branch before compaction destroys the raw messages.
 *
 * MUST NOT await the LLM call — session_before_compact is awaited by Pi and
 * can fire mid-turn; blocking here stalls the user's turn. Snapshot the
 * branch synchronously, void the run, return immediately. */
function handleSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): void {
  withDebugLogContext(
    { enabled: config.debugLog, cwd: ctx.cwd, sessionId: getSessionId(ctx) },
    () => {
      debugLog("session.before_compact", {
        turnCount,
        reason: event.reason,
        willRetry: event.willRetry,
        branchEntryCount: event.branchEntries?.length ?? 0,
      });

      // Snapshot the pre-compaction branch synchronously — after compaction
      // getBranch() returns the compaction summary, not these raw messages.
      const branchText = serializeEntries(event.branchEntries);
      const toolText = toolResultChunk;
      // Do NOT clear toolResultChunk here yet — the periodic trigger may still
      // want it. It gets cleared after the periodic trigger drains it.
      const chunk = toolText ? `${branchText}\n\n### Tool Results\n${toolText}` : branchText;

      if (chunk.trim().length < config.shutdownMinChunkChars) {
        debugLog("auto_learn.skip_compact", {
          chunkChars: chunk.length,
          threshold: config.shutdownMinChunkChars,
        });
        return;
      }

      // Truncate to configured max
      const truncated =
        chunk.length > config.reviewMaxChunkChars
          ? `${chunk.slice(0, config.reviewMaxChunkChars)}\n... [truncated]`
          : chunk;

      debugLog("auto_learn.trigger_compact", {
        chunkChars: truncated.length,
        branchChars: branchText.length,
        toolResultChars: toolText.length,
      });

      // runAutoLearn builds the existing-index summary itself, after auth,
      // from a fresh exact resolution — callers no longer pass a stale one.
      const autoLearnCfg: AutoLearnConfig = {
        everyTurns: config.reviewIntervalTurns,
        model: config.reviewModel,
        thinking: config.reviewThinking,
        maxOutputTokens: config.reviewMaxOutputTokens,
      };

      // Fire-and-forget: must not block compaction. Do not await. If a review
      // is already in flight, queue the snapshot to run when it finishes
      // (coalesce — last compact wins) instead of silently dropping the
      // pre-compaction branch.
      if (autoLearnInFlight) {
        debugLog("auto_learn.compact_queued", { chunkChars: truncated.length });
        pendingCompact = {
          ctx,
          cfg: autoLearnCfg,
          cwd: ctx.cwd,
          chunk: truncated,
        };
        return;
      }
      void launchAutoLearn(ctx, autoLearnCfg, ctx.cwd, truncated);
    },
  );
}

/** Handle session_shutdown: await any in-flight auto-learn, then fire one
 * final review for short sessions that never hit the turn threshold.
 *
 * Pi awaits shutdown handlers with no timeout of its own, so a hung LLM call
 * would hang /quit forever. We apply our own deadline via AbortSignal.timeout. */
async function handleSessionShutdown(
  event: SessionShutdownEvent,
  ctx: ExtensionContext,
): Promise<void> {
  debugLog("index.shutdown_fired", { reason: event.reason, turnCount });
  await withDebugLogContext(
    { enabled: config.debugLog, cwd: ctx.cwd, sessionId: getSessionId(ctx) },
    async () => {
      debugLog("session.shutdown", { reason: event.reason, turnCount });

      // Single shared absolute deadline: the in-flight wait and the final
      // review COMBINED must not exceed shutdownTimeoutMs (Pi provides no
      // timeout of its own). Previously the two phases could each consume
      // the full budget, doubling the worst case.
      const shutdownDeadline = Date.now() + config.shutdownTimeoutMs;
      const remainingMs = () => Math.max(0, shutdownDeadline - Date.now());

      // If a periodic or compact-triggered review is still running, await it
      // under the shared deadline so a hung provider cannot block shutdown.
      if (autoLearnInFlight) {
        debugLog("auto_learn.shutdown_await_inflight", {});
        let inflightSettled = true;
        try {
          await raceTimeout(autoLearnInFlight, remainingMs());
        } catch (err) {
          // Distinguish a hung review (our raceTimeout rejected) from a
          // review that errored and is done. A hung review is still running
          // — abort it below; either way do not start a second writer on
          // top of it.
          //
          // Matched on the sentinel CLASS, not the message: a provider or
          // network error whose text happens to contain "timed out" would
          // otherwise be misread as "still running", causing us to abort and
          // skip the final review for a review that had already settled.
          inflightSettled = !(err instanceof AutoLearnAwaitTimeout);
        }
        if (!inflightSettled) {
          // On timeout the in-flight review is STILL RUNNING (periodic and
          // compact launches own an abort controller precisely for this).
          // Abort it and skip the final review: launching a competitor
          // writer would race it into the same store (duplicate entries,
          // lost index updates).
          autoLearnAbort?.abort();
          autoLearnAbort = null;
          autoLearnInFlight = null;
          pendingCompact = null;
          debugLog("auto_learn.shutdown_timeout_abort", {});
          console.error(
            "[pi-claude-memory] auto-learn: in-flight review exceeded shutdown deadline; aborted, final review skipped",
          );
          return;
        }
        // The review settled (wrote, errored, or aborted elsewhere). Its
        // .finally clears the flag, but it may not have run yet (our await
        // continuation can resume before the chained .finally in the same
        // microtask wave). Clear explicitly so the final launchAutoLearn
        // below does not bail on the stale non-null flag.
        // INVARIANT: nothing between here and the launchAutoLearn call may
        // await — an await would let the settled review's .finally
        // interleave, drain pendingCompact, and double-launch.
        autoLearnInFlight = null;
        // NOTE: a queued compact snapshot is NOT cleared here — its material
        // (pre-compaction) is merged into the final chunk below instead of
        // being dropped. Only the timeout branch above may discard it, since
        // that path skips the final review entirely to avoid a double writer.
      }

      // Now build a final chunk from whatever conversation we have. At
      // shutdown the agent is not streaming, so ctx.signal is undefined —
      // we supply our own abort signal with a deadline.
      const branchText = serializeBranch(ctx);
      const toolText = toolResultChunk;
      const liveChunk = toolText ? `${branchText}\n\n### Tool Results\n${toolText}` : branchText;

      // A queued pre-compaction snapshot must NOT be discarded (compaction
      // already destroyed the raw messages it captured) and it must not
      // swamp the live branch either. It arrives here ALREADY truncated to
      // reviewMaxChunkChars when it was queued, so a naive prepend followed
      // by a tail-truncation spends the entire budget on it and drops 100%
      // of the post-compaction material. Budget the two explicitly instead.
      const snapshotChunk = pendingCompact?.chunk ?? null;
      pendingCompact = null;
      const chunk = composeShutdownChunk(snapshotChunk, liveChunk, config.reviewMaxChunkChars);

      if (chunk.trim().length < config.shutdownMinChunkChars) {
        debugLog("auto_learn.skip_shutdown", {
          chunkChars: chunk.length,
          threshold: config.shutdownMinChunkChars,
        });
        return;
      }

      // composeShutdownChunk already applied the cap; no further truncation.
      const truncated = chunk;

      debugLog("auto_learn.trigger_shutdown", {
        chunkChars: truncated.length,
        branchChars: branchText.length,
        toolResultChars: toolText.length,
        snapshotChars: snapshotChunk?.length ?? 0,
      });

      const autoLearnCfg: AutoLearnConfig = {
        everyTurns: config.reviewIntervalTurns,
        model: config.reviewModel,
        thinking: config.reviewThinking,
        maxOutputTokens: config.reviewMaxOutputTokens,
      };

      // Final review. Own an AbortController (not just a timed signal) so
      // this launch is reachable via autoLearnAbort — otherwise session_start
      // of a replacement session cannot abort a shutdown review still
      // writing — and race the await so a provider that ignores the signal
      // cannot hang shutdown.
      const shutdownController = new AbortController();
      const shutdownTimer = setTimeout(
        () => shutdownController.abort(),
        Math.max(remainingMs(), 1),
      );
      shutdownTimer.unref?.();
      try {
        await raceTimeout(
          launchAutoLearn(ctx, autoLearnCfg, ctx.cwd, truncated, shutdownController),
          remainingMs(),
        );
      } catch (err) {
        // Deadline hit or the review errored: abort either way — a provider
        // that ignored the signal may still be mid-write, and the write loop
        // checks signal.aborted between candidates.
        shutdownController.abort();
        debugLog("auto_learn.shutdown_error", { error: String(err) });
        // Swallow — never block shutdown on an LLM error.
      } finally {
        clearTimeout(shutdownTimer);
      }
    },
  );
}

/** Handle before_agent_start: inject frozen memory into the system prompt. */
async function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult | undefined> {
  const cwd = ctx.cwd;

  return withDebugLogContext(
    { enabled: config.debugLog, cwd, sessionId: getSessionId(ctx) },
    async () => {
      // Use frozen injection if available and cwd hasn't changed.
      let frozen = frozenInjection;
      if (!frozen || frozen.cwd !== cwd) {
        const hasCtxSearch =
          event.systemPromptOptions.selectedTools?.includes("ctx_search") ?? false;
        frozen = computeInjection(cwd, hasCtxSearch);
        frozenInjection = frozen;
        debugLog("injector.freeze", {
          cwd,
          textLength: frozen.text.length,
          hasProject: !!frozen.resolved.project,
          hasGlobal: !!frozen.resolved.global,
        });
      }

      if (!frozen.text) {
        return;
      }

      return {
        systemPrompt: event.systemPrompt + frozen.text,
      };
    },
  );
}

/** Compute and freeze the injection text for a cwd. */
function computeInjection(cwd: string, hasCtxSearch: boolean): FrozenInjection {
  const resolved = resolveMemoryDirs(cwd);

  const { text, warnings } = buildMemoryInjection(
    resolved.project,
    resolved.global,
    config.injectTokenCap,
    hasCtxSearch,
    config.autoLearn,
    config.reviewIntervalTurns,
  );

  if (warnings.length > 0) {
    for (const w of warnings) {
      debugLog("injector.warning", { warning: w });
    }
  }

  return { cwd, text, resolved };
}

/** Handle turn_end: increment counter. */
function handleTurnEnd(_event: TurnEndEvent, ctx: ExtensionContext): void {
  turnCount++;
  withDebugLogContext(
    { enabled: config.debugLog, cwd: ctx.cwd, sessionId: getSessionId(ctx) },
    () => debugLog("turn.end", { turnCount }),
  );
}

/** Handle tool_result: capture tool output text for auto-learn context. */
function handleToolResult(event: ToolResultEvent, ctx: ExtensionContext): void {
  const text = toolResultToText(event);
  if (text) {
    appendToToolResultChunk(text);
    withDebugLogContext(
      { enabled: config.debugLog, cwd: ctx.cwd, sessionId: getSessionId(ctx) },
      () => debugLog("tool_result.captured", { toolName: event.toolName, chars: text.length }),
    );
  }
}

/** Handle agent_settled: fire background auto-learn every N turns. */
function handleAgentSettled(_event: AgentSettledEvent, ctx: ExtensionContext): void {
  withDebugLogContext(
    { enabled: config.debugLog, cwd: ctx.cwd, sessionId: getSessionId(ctx) },
    () => {
      if (turnCount < config.reviewIntervalTurns) {
        debugLog("auto_learn.skip", { turnCount, threshold: config.reviewIntervalTurns });
        return;
      }
      // If a review is already running, do NOT reset the counter or drain the
      // tool-result chunk — preserve them so the next settle fires with the
      // accumulated context instead of starting from an empty window.
      if (autoLearnInFlight) {
        debugLog("auto_learn.skip_inflight", { turnCount });
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

      if (!chunk.trim()) {
        debugLog("auto_learn.skip_empty_chunk", {});
        return;
      }

      // Truncate chunk to configured max
      const truncated =
        chunk.length > config.reviewMaxChunkChars
          ? `${chunk.slice(0, config.reviewMaxChunkChars)}\n... [truncated]`
          : chunk;

      debugLog("auto_learn.trigger", {
        chunkChars: truncated.length,
        branchChars: branchText.length,
        toolResultChars: toolText.length,
      });

      const autoLearnCfg: AutoLearnConfig = {
        everyTurns: config.reviewIntervalTurns,
        model: config.reviewModel,
        thinking: config.reviewThinking,
        maxOutputTokens: config.reviewMaxOutputTokens,
      };

      // Fire-and-forget: never block the user's next turn.
      void launchAutoLearn(ctx, autoLearnCfg, ctx.cwd, truncated);
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
  return serializeMessageEntries(entries);
}

/** Serialize a list of session entries (from session_before_compact event) to
 * text. Filters to message entries, takes the last ~20. */
function serializeEntries(entries: SessionEntry[] | undefined): string {
  if (!entries || entries.length === 0) return "";
  const messages = entries.filter((e): e is SessionMessageEntry => e.type === "message");
  return serializeMessageEntries(messages);
}

/** Shared serializer for a list of message entries. */
function serializeMessageEntries(entries: SessionMessageEntry[]): string {
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
  const sep = toolResultChunk ? "\n\n" : "";
  let combined = toolResultChunk + sep + text;
  // Clamp to the cap by keeping the most recent content (tail). This also
  // bounds the buffer when a single result exceeds the cap (the previous
  // slice(overflow+1) math left the buffer at MAX+1 and could exceed it
  // entirely for an oversized single result).
  if (combined.length > TOOL_RESULT_MAX_CHARS) {
    combined = combined.slice(combined.length - TOOL_RESULT_MAX_CHARS);
  }
  toolResultChunk = combined;
}

/** Launch an auto-learn review with single-flight tracking.
 *
 * If a review is already in-flight, skip launching a new one to avoid two
 * concurrent runs over overlapping branches. The promise is stored in
 * autoLearnInFlight so the session_shutdown handler can await it before
 * starting its own final review. */
function launchAutoLearn(
  ctx: ExtensionContext,
  cfg: AutoLearnConfig,
  cwd: string,
  chunk: string,
  callerController?: AbortController,
): Promise<number> {
  if (autoLearnInFlight) {
    debugLog("auto_learn.skip_inflight", {});
    // Return a resolved promise so callers awaiting this (shutdown) proceed.
    return Promise.resolve(0);
  }

  // Reviews launched without a caller-supplied controller (periodic,
  // compact) get one we own, so shutdown-timeout and session_start can
  // cancel the review instead of abandoning it while it still writes. A
  // caller controller (shutdown) is registered the same way — autoLearnAbort
  // must point at the controller whose signal the review actually holds.
  const controller = callerController ?? new AbortController();
  const promise = runAutoLearn(ctx, cfg, cwd, chunk, controller.signal);
  const gen = autoLearnGeneration;
  autoLearnInFlight = promise;
  autoLearnAbort = controller;
  promise
    .then((written) => {
      // Progress goes to the debug log, NOT to the console: this fires
      // mid-conversation and a raw console line lands inside the rendered
      // TUI output, breaking up the response formatting. debugLog is
      // already gated by config.debugLog, which is where background-work
      // chatter belongs.
      debugLog("auto_learn.result", { written });
      // IMPORTANT: do NOT invalidate the frozen injection. Auto-learn writes
      // take effect next session — the model already has this context from
      // the conversation. Invalidating here would bust the prompt cache for
      // facts the model just saw.
      return written;
    })
    .catch((err) => {
      debugLog("auto_learn.error", { error: String(err) });
      console.error(`[pi-claude-memory] auto-learn: unexpected error: ${String(err)}`);
      return -1;
    })
    .finally(() => {
      // A review from a previous session (generation bumped by session_start
      // while this one was in flight) must not touch state or drain its
      // completion into the new session.
      if (gen !== autoLearnGeneration) return;
      // Clear the flag first, then drain a queued compaction snapshot. The
      // clear must happen here (not only in the shutdown await) so periodic
      // triggers see a clean slate.
      if (autoLearnInFlight === promise) autoLearnInFlight = null;
      if (autoLearnAbort === controller) autoLearnAbort = null;
      drainPendingCompact();
    });

  return promise;
}

/** Launch a queued compaction snapshot if one is waiting. Called from
 * launchAutoLearn's completion handler so a compact that arrived while a
 * review was running is not silently dropped. */
function drainPendingCompact(): void {
  // Check the slot is free BEFORE taking the snapshot — if another review is
  // somehow in flight, leave the snapshot queued for the next completion.
  if (!pendingCompact || autoLearnInFlight) return;
  const p = pendingCompact;
  pendingCompact = null;
  // runAutoLearn rebuilds the index summary itself from a fresh exact
  // resolution — the just-finished review's new memories are visible to
  // supersession.
  debugLog("auto_learn.compact_drain", { chunkChars: p.chunk.length });
  void launchAutoLearn(p.ctx, p.cfg, p.cwd, p.chunk);
}

/** Compose the shutdown review input from an optional queued pre-compaction
 * snapshot and the live post-compaction chunk, within a hard character cap.
 *
 * The snapshot arrives already truncated to the cap by the compaction path,
 * so simply prepending it and truncating the tail spends the whole budget on
 * pre-compaction material and drops the live branch entirely — the exact
 * material this shutdown review exists to capture. Instead the snapshot is
 * held to at most half the budget and the live chunk takes the remainder
 * (and is itself capped to whatever is left). Both halves get a truncation
 * marker so the reviewer can tell it is seeing a prefix. */
export function composeShutdownChunk(
  snapshot: string | null,
  live: string,
  maxChars: number,
): string {
  const cap = Math.max(0, maxChars);
  // The live branch keeps its TAIL: at shutdown the review wants the most
  // recent material, and keeping the head would retain the oldest turns of
  // the session while discarding the conversation that just ended. (The
  // pre-compaction snapshot keeps its head — it is a chronological prefix
  // of the same session, so its oldest turns are the ones the later branch
  // does not repeat.)
  let liveOut = live;
  if (live.length > cap) {
    liveOut = `... [truncated]\n${live.slice(-cap)}`;
  }

  if (!snapshot) return liveOut;

  // Reserve at least half the budget for the live branch. A snapshot shorter
  // than its share hands the leftover room to the live chunk.
  const snapshotShare = Math.floor(cap / 2);
  let snapshotOut = snapshot;
  if (snapshotOut.length > snapshotShare) {
    snapshotOut = `${snapshotOut.slice(0, snapshotShare)}\n... [truncated]`;
  }
  const liveBudget = Math.max(0, cap - snapshotOut.length);
  if (liveOut.length > liveBudget) {
    // Tail again: the newest turns are the ones worth reviewing.
    liveOut = `... [truncated]\n${liveOut.slice(-liveBudget)}`;
  }

  return `### Pre-compaction snapshot\n${snapshotOut}\n\n${liveOut}`;
}

/** Race a promise against a timeout. Resolves with the promise's value, or
 * rejects with a timeout Error after ms. Used so an in-flight review cannot
 * block shutdown indefinitely. The timer is unref'd so it never keeps the
 * process alive on its own. */
/** Thrown by raceTimeout when the awaited promise did not settle in time.
 *
 * A dedicated class rather than message matching: callers must be able to
 * tell "our deadline fired" from "the awaited work rejected", and an
 * arbitrary rejection may well mention timing out in its own text. */
export class AutoLearnAwaitTimeout extends Error {
  constructor() {
    super("auto-learn in-flight await timed out");
    this.name = "AutoLearnAwaitTimeout";
  }
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new AutoLearnAwaitTimeout()), ms);
      t.unref?.();
    }),
  ]);
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
