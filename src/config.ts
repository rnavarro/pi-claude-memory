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
  /** Minimum chunk chars to trigger shutdown auto-learn. */
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

/** Load config from Pi's settings.json, merged with defaults. */
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
      ...(typeof n.reviewIntervalTurns === "number"
        ? { reviewIntervalTurns: n.reviewIntervalTurns }
        : {}),
      ...(typeof n.injectTokenCap === "number" ? { injectTokenCap: n.injectTokenCap } : {}),
      ...(isModelObj(n.reviewModel) ? { reviewModel: n.reviewModel } : {}),
      ...(isThinkingLevel(n.reviewThinking) ? { reviewThinking: n.reviewThinking } : {}),
      ...(typeof n.reviewMaxOutputTokens === "number"
        ? { reviewMaxOutputTokens: n.reviewMaxOutputTokens }
        : {}),
      ...(typeof n.reviewMaxChunkChars === "number"
        ? { reviewMaxChunkChars: n.reviewMaxChunkChars }
        : {}),
      ...(typeof n.reviewOnShutdown === "boolean" ? { reviewOnShutdown: n.reviewOnShutdown } : {}),
      ...(typeof n.shutdownMinChunkChars === "number"
        ? { shutdownMinChunkChars: n.shutdownMinChunkChars }
        : {}),
      ...(typeof n.shutdownTimeoutMs === "number"
        ? { shutdownTimeoutMs: n.shutdownTimeoutMs }
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
  return typeof o.provider === "string" && typeof o.id === "string";
}

function isThinkingLevel(v: unknown): v is "off" | "minimal" | "low" | "medium" | "high" {
  return v === "off" || v === "minimal" || v === "low" || v === "medium" || v === "high";
}
