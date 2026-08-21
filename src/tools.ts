// Memory tools: recall_memory, write_memory, remove_memory.
//
// These tools let the agent read individual memory files by name (with
// [[wikilink]] resolution), write new Claude-format memory files, and remove
// stale ones. All writes go to the SAME files Claude Code uses, so the two
// agents share a single store and never diverge.

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readMemory, removeMemory, writeMemory } from "./memory-writer.js";
import { createProjectMemoryDir, resolveMemoryDirs } from "./resolver.js";
import type { ResolveResult } from "./types.js";

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
        "Memory entry name (slug) or filename. Matches the filename stem (e.g. 'never-push-master' for feedback_never_push_master.md).",
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
    const tier = params.tier ?? "project";
    const resolved = resolveMemoryDirs(ctx.cwd);

    // Try the requested tier first, fall back to the other.
    const dir =
      pickTier(resolved, tier) ?? pickTier(resolved, tier === "project" ? "global" : "project");
    if (!dir) {
      return {
        content: [{ type: "text", text: `No memory directory available (tier=${tier}).` }],
        details: undefined as unknown,
      };
    }

    const result = readMemory(dir, params.name);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: result.message }],
        details: undefined as unknown,
      };
    }

    const header = `**${dir.label} tier** — \`${result.filePath}\`\n\n`;
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

const writeTool = defineTool({
  name: "write_memory",
  label: "Write Memory",
  description:
    "Write a Claude Code-format memory entry (YAML frontmatter + markdown body) and append a link to MEMORY.md. " +
    "Round-trip validates YAML before writing. " +
    "Writes to the SAME files Claude Code uses — the shared store stays in sync. " +
    "Add-only for v1: existing entries with the same name are overwritten at the file level, but hand-authored MEMORY.md sections are preserved.",
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
  }),
  promptSnippet:
    "write_memory - Write a Claude Code memory entry (auto-learned fact or reference). Shares store with Claude Code.",
  promptGuidelines: [
    "Use write_memory proactively only for explicit signals: user corrections, stated preferences, or verified fixes. A background reviewer sweeps every 10 turns for routine learning — don't duplicate it.",
    "Do NOT write memories for ephemeral state, TODOs, or debugging steps — those belong in session notes, not durable memory.",
    "Pick the right type: feedback=behavioral rule (always inject), reference=lookup material (on-demand), project=project-specific fact, user=user preference.",
    "Keep descriptions to one line — they appear in the MEMORY.md index that is injected every turn.",
    "Prefer the global tier for cross-project facts (user preferences, tool conventions). Use project tier for project-specific facts.",
  ],
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const tier = params.tier ?? "project";
    const resolved = resolveMemoryDirs(ctx.cwd);
    let dir = pickTier(resolved, tier);
    // For project-tier writes, create the dir if it doesn't exist yet.
    if (!dir && tier === "project") {
      dir = createProjectMemoryDir(ctx.cwd);
    }
    if (!dir) {
      return {
        content: [
          { type: "text", text: `No ${tier} memory directory available for cwd ${ctx.cwd}.` },
        ],
        details: undefined as unknown,
      };
    }

    const result = writeMemory(dir, {
      name: params.name,
      description: params.description,
      type: params.type,
      body: params.body,
      pinned: params.pinned ?? false,
      tier,
    });
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
    const tier = params.tier ?? "project";
    const resolved = resolveMemoryDirs(ctx.cwd);
    const dir =
      pickTier(resolved, tier) ?? pickTier(resolved, tier === "project" ? "global" : "project");
    if (!dir) {
      return {
        content: [{ type: "text", text: `No ${tier} memory directory available.` }],
        details: undefined as unknown,
      };
    }

    const result = removeMemory(dir, { name: params.name, tier });
    return {
      content: [{ type: "text", text: result.message }],
      details: { ok: result.ok, tier: dir.tier, trashPath: result.filePath } as unknown,
    };
  },
});

/** Register all memory tools. */
export function registerMemoryTools(pi: ExtensionAPI): void {
  pi.registerTool(recallTool);
  pi.registerTool(writeTool);
  pi.registerTool(removeTool);
}
