// Configuration: loads from Pi's settings.json under the "pi-claude-memory" key.
//
// Example settings.json:
//   "pi-claude-memory": {
//     "debugLog": true,
//     "autoLearn": true,
//     "reviewIntervalTurns": 10,
//     "injectTokenCap": 5000
//   }

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface PiClaudeMemoryConfig {
  /** Enable NDJSON debug logging to ~/.pi/agent/pi-claude-memory/debug/. */
  debugLog: boolean;
  /** Enable background auto-learning. */
  autoLearn: boolean;
  /** Run auto-learn review every N turns. */
  reviewIntervalTurns: number;
  /** Token budget for full-text file body injection (shared across tiers). */
  injectTokenCap: number;
  /** Auto-learn model. */
  reviewModel: { provider: string; id: string };
  /** Thinking level for auto-learn. "off" omits reasoning entirely. */
  reviewThinking: "off" | "minimal" | "low" | "medium" | "high";
  /** Max output tokens for auto-learn LLM call. */
  reviewMaxOutputTokens: number;
  /** Max chars of conversation to send to auto-learn. */
  reviewMaxChunkChars: number;
  /** Fire auto-learn on session shutdown (catches short sessions). */
  reviewOnShutdown: boolean;
  /** Minimum chunk chars to trigger a review from the COMPACT and SHUTDOWN
   * paths. Both use this one threshold: they fire at the same kind of moment
   * (the conversation is being restructured or is ending) and there is no
   * reason for them to differ. Named for shutdown only because that was the
   * first caller — see handleSessionBeforeCompact in index.ts. */
  shutdownMinChunkChars: number;
  /** Timeout (ms) for shutdown auto-learn LLM call. */
  shutdownTimeoutMs: number;
  /** Fire auto-learn on session_before_compact (catches pre-compaction loss). */
  reviewOnCompact: boolean;
}

export const DEFAULT_CONFIG: PiClaudeMemoryConfig = {
  debugLog: true,
  autoLearn: true,
  reviewIntervalTurns: 10,
  injectTokenCap: 5000,
  reviewModel: { provider: "neuralwatt", id: "deepseek-v4-flash" },
  reviewThinking: "off",
  reviewMaxOutputTokens: 2048,
  reviewMaxChunkChars: 50000,
  reviewOnShutdown: true,
  shutdownMinChunkChars: 1000,
  shutdownTimeoutMs: 5000,
  reviewOnCompact: true,
};

const SETTINGS_KEY = "pi-claude-memory";

/** Validate a numeric config field: must be a finite integer within [min,max].
 * Non-numeric, fractional, non-finite, or out-of-range values fall back to the
 * default with a loud warning — a fractional shutdownTimeoutMs would
 * previously reach AbortSignal.timeout and throw, a negative interval made
 * every settle qualify, and JSON can carry non-finite values past typeof
 * checks (Infinity, 1e999 parses to Infinity). */
export function num(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    // Deliberately console.error, and deliberately one line: a malformed
    // settings.json value is a user-actionable fault, not background chatter.
    // This does NOT fire during normal operation (it requires a bad config),
    // so it cannot land mid-conversation the way auto-learn progress used to.
    console.error(
      `[pi-claude-memory] invalid value for ${field}: ${JSON.stringify(value)} ` +
        `(must be an integer in [${min}, ${max}]) — using default ${fallback}`,
    );
    return fallback;
  }
  return value;
}

export function loadConfig(): PiClaudeMemoryConfig {
  const globalPath = join(getAgentDir(), "settings.json");
  if (!existsSync(globalPath)) return { ...DEFAULT_CONFIG };

  try {
    const raw = JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
    const nested = raw[SETTINGS_KEY];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      return { ...DEFAULT_CONFIG };
    }
    const n = nested as Record<string, unknown>;
    return {
      ...DEFAULT_CONFIG,
      ...(typeof n.debugLog === "boolean" ? { debugLog: n.debugLog } : {}),
      ...(typeof n.autoLearn === "boolean" ? { autoLearn: n.autoLearn } : {}),
      ...(n.reviewIntervalTurns !== undefined
        ? {
            reviewIntervalTurns: num(
              n.reviewIntervalTurns,
              "reviewIntervalTurns",
              DEFAULT_CONFIG.reviewIntervalTurns,
              1,
              1000,
            ),
          }
        : {}),
      ...(n.injectTokenCap !== undefined
        ? {
            injectTokenCap: num(
              n.injectTokenCap,
              "injectTokenCap",
              DEFAULT_CONFIG.injectTokenCap,
              0,
              1000000,
            ),
          }
        : {}),
      ...(isModelObj(n.reviewModel) ? { reviewModel: n.reviewModel } : {}),
      ...(isThinkingLevel(n.reviewThinking) ? { reviewThinking: n.reviewThinking } : {}),
      ...(n.reviewMaxOutputTokens !== undefined
        ? {
            reviewMaxOutputTokens: num(
              n.reviewMaxOutputTokens,
              "reviewMaxOutputTokens",
              DEFAULT_CONFIG.reviewMaxOutputTokens,
              1,
              200000,
            ),
          }
        : {}),
      ...(n.reviewMaxChunkChars !== undefined
        ? {
            reviewMaxChunkChars: num(
              n.reviewMaxChunkChars,
              "reviewMaxChunkChars",
              DEFAULT_CONFIG.reviewMaxChunkChars,
              1,
              10000000,
            ),
          }
        : {}),
      ...(typeof n.reviewOnShutdown === "boolean" ? { reviewOnShutdown: n.reviewOnShutdown } : {}),
      ...(n.shutdownMinChunkChars !== undefined
        ? {
            shutdownMinChunkChars: num(
              n.shutdownMinChunkChars,
              "shutdownMinChunkChars",
              DEFAULT_CONFIG.shutdownMinChunkChars,
              0,
              10000000,
            ),
          }
        : {}),
      ...(n.shutdownTimeoutMs !== undefined
        ? {
            shutdownTimeoutMs: num(
              n.shutdownTimeoutMs,
              "shutdownTimeoutMs",
              DEFAULT_CONFIG.shutdownTimeoutMs,
              100,
              600000,
            ),
          }
        : {}),
      ...(typeof n.reviewOnCompact === "boolean" ? { reviewOnCompact: n.reviewOnCompact } : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function isModelObj(v: unknown): v is { provider: string; id: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  // Non-empty: {provider: "", id: ""} passes a bare typeof check and then
  // fails much later as a confusing "model / not found". Reject it here so
  // the default model is used instead.
  return (
    typeof o.provider === "string" &&
    o.provider.length > 0 &&
    typeof o.id === "string" &&
    o.id.length > 0
  );
}

function isThinkingLevel(v: unknown): v is "off" | "minimal" | "low" | "medium" | "high" {
  return v === "off" || v === "minimal" || v === "low" || v === "medium" || v === "high";
}
