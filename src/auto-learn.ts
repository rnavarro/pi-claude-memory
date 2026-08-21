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

import { readdirSync } from "node:fs";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeMemory } from "./memory-writer.js";
import { createProjectMemoryDir, resolveMemoryDirs } from "./resolver.js";
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
  model: { provider: "neuralwatt", id: "glm-5.2-flex" },
  thinking: "off",
  maxOutputTokens: 2048,
};

const SYSTEM_PROMPT = `You are a memory extraction agent. Your job is to read a recent conversation chunk and extract durable facts worth remembering across sessions.

You return a JSON array of memory candidates. Each candidate has:
- name: short slug (kebab-case, e.g. "prefer-jq-for-json")
- description: one-line summary
- type: one of "feedback" (behavioral rule), "reference" (lookup material), "project" (project-specific fact), "user" (user preference)
- body: markdown body, 1-10 lines
- tier: "project" or "global"
- pinned: boolean (true only for critical behavioral rules)

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

If there is nothing worth extracting, return an empty array: []

Return ONLY the JSON array. No prose, no code fence.`;

interface MemoryCandidate {
  name: string;
  description: string;
  type: "feedback" | "reference" | "project" | "user";
  body: string;
  tier: "project" | "global";
  pinned: boolean;
}

/**
 * Run an auto-learning review over a conversation chunk.
 *
 * @param ctx Pi extension context (provides model registry + abort signal)
 * @param cfg Auto-learn config
 * @param cwd Current working directory (for tier resolution)
 * @param chunk Recent conversation text to review
 * @param existingIndex Summary of existing memory entries (to avoid duplicates)
 * @returns number of memories written, or -1 on failure
 */
export async function runAutoLearn(
  ctx: ExtensionContext,
  cfg: AutoLearnConfig,
  cwd: string,
  chunk: string,
  existingIndex: string,
): Promise<number> {
  if (!chunk.trim()) return 0;

  // Resolve the model
  const model = ctx.modelRegistry.find(cfg.model.provider, cfg.model.id) as Model<Api> | undefined;
  if (!model) {
    console.error(
      `[pi-claude-memory] auto-learn: model ${cfg.model.provider}/${cfg.model.id} not found`,
    );
    return -1;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    console.error(`[pi-claude-memory] auto-learn: no API key for ${cfg.model.provider}`);
    return -1;
  }

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

  let replyText: string;
  try {
    const reply = await completeSimple(model, context, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      ...reasoningOption,
      maxTokens: cfg.maxOutputTokens,
      temperature: 0,
      signal: ctx.signal,
    });
    replyText = reply.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
  } catch (err) {
    console.error(`[pi-claude-memory] auto-learn: LLM call failed: ${String(err)}`);
    return -1;
  }

  // Parse the JSON array — tolerate code fences and leading/trailing prose.
  const candidates = parseCandidates(replyText);
  if (candidates.length === 0) {
    return 0;
  }

  // Resolve memory dirs for the cwd
  const resolved = resolveMemoryDirs(cwd);

  // Write each candidate. Count successes.
  let written = 0;
  for (const c of candidates) {
    let dir: MemoryDir | null = c.tier === "global" ? resolved.global : resolved.project;
    if (!dir && c.tier === "project") {
      dir = createProjectMemoryDir(cwd);
    }
    if (!dir) {
      // Requested tier unavailable — skip silently. The model will learn from
      // the absence in the next cycle's index.
      continue;
    }
    const result = writeMemory(dir, {
      name: c.name,
      description: c.description,
      type: c.type,
      body: c.body,
      pinned: c.pinned,
      tier: c.tier,
      allowOverwrite: false, // auto-learn never clobbers existing memories
    });
    if (result.ok) written++;
  }
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
    return parsed.filter(isValidCandidate);
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
    typeof c.pinned === "boolean"
  );
}

/** Build a compact summary of the existing memory index for the LLM. */
export function buildExistingIndexSummary(resolved: ResolveResult): string {
  const lines: string[] = [];
  for (const dir of [resolved.global, resolved.project]) {
    if (!dir) continue;
    lines.push(`## ${dir.label} tier`);
    // We don't re-parse MEMORY.md here — the injector already does that work.
    // For the LLM summary, just list the file names in the dir.
    try {
      const files = readdirSync(dir.dir).filter(
        (f: string) => f.endsWith(".md") && f !== "MEMORY.md",
      );
      if (files.length === 0) {
        lines.push("(no entries)");
      } else {
        for (const f of files.slice(0, 50)) {
          lines.push(`- ${f}`);
        }
        if (files.length > 50) {
          lines.push(`... and ${files.length - 50} more`);
        }
      }
    } catch {
      lines.push("(unreadable)");
    }
  }
  return lines.join("\n");
}
