// Frontmatter parser: handles 3 generations of Claude Code memory format
//
// Gen 1 (flat top-level type):
//   ---
//   name: Prefer jq for JSON
//   description: Use jq for JSON processing
//   type: feedback
//   ---
//
// Gen 2 (nested metadata):
//   ---
//   name: never-push-to-the-default-branch
//   description: "The default branch..."
//   metadata:
//     node_type: memory
//     type: feedback
//     originSessionId: b203f5ed-...
//     modified: 2026-08-11T01:17:02.742Z
//   ---
//
// Gen 3 (no frontmatter at all):
//   # Config Audit — 2026-02-27
//   (plain markdown, no YAML block)

import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import type { MemoryType, ParsedFrontmatter } from "./types.js";

const FRONTMATTER_DELIM = "---";

/** Parse a memory topic file from disk. */
export function parseMemoryFile(filePath: string, filename: string): ParsedFrontmatter {
  const content = readFileSync(filePath, "utf8");
  const stats = statSync(filePath);
  return parseMemoryContent(content, filename, stats.mtimeMs);
}

/** Parse memory content string (separated for testing). */
export function parseMemoryContent(
  content: string,
  filename: string,
  mtimeMs: number,
): ParsedFrontmatter {
  const { body, hasFrontmatter, raw: parsedRaw } = splitFrontmatter(content);

  if (!hasFrontmatter) {
    // Gen 3: no usable frontmatter (absent, or a Markdown block that is not a
    // YAML mapping — splitFrontmatter preserves the original text in that case)
    return {
      name: filename.replace(/\.md$/, ""),
      description: extractFirstHeading(body) || filename.replace(/\.md$/, ""),
      type: inferTypeFromFilename(filename),
      priority: null,
      modified: new Date(mtimeMs).toISOString(),
      pinned: false,
      raw: {},
      hasFrontmatter: false,
      body,
    };
  }

  const raw = parsedRaw ?? {};
  const name = extractString(raw, "name") ?? filename.replace(/\.md$/, "");
  const description = extractString(raw, "description") ?? "";
  const type = extractType(raw, filename);
  const priority = extractPriority(raw);
  const modified = extractModified(raw, mtimeMs);
  const pinned = extractBoolean(raw, "pinned") ?? false;

  return {
    name,
    description,
    type,
    priority,
    modified,
    pinned,
    raw,
    hasFrontmatter: true,
    body,
  };
}

/** Split content into frontmatter and body. */
function splitFrontmatter(content: string): {
  frontmatter: string | null;
  body: string;
  hasFrontmatter: boolean;
  raw: Record<string, unknown> | null;
} {
  const none = { frontmatter: null, body: content, hasFrontmatter: false, raw: null };
  // The opening delimiter must be exactly `---` on its own first line. A
  // `----` line is a Markdown horizontal rule, not a frontmatter opener.
  const firstLine = content.split("\n", 1)[0].trim();
  if (firstLine !== FRONTMATTER_DELIM) {
    return none;
  }

  const lines = content.split("\n");
  // Find the closing ---
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() !== FRONTMATTER_DELIM) continue;
    const frontmatter = lines.slice(1, i).join("\n");
    const raw = parseYamlFrontmatter(frontmatter);
    // Only treat the block as frontmatter when it PARSES as a YAML mapping.
    // Otherwise it is Markdown that merely sits between two `---` rule lines
    // (a YAML scalar, or prose): stripping it deleted those bytes from the
    // body AND produced an empty metadata map, so the content vanished from
    // both injection and recall. Keep the original text intact instead.
    if (raw === null) {
      return none;
    }
    const body = lines
      .slice(i + 1)
      .join("\n")
      .replace(/^\n+/, ""); // strip leading blank lines
    return { frontmatter, body, hasFrontmatter: true, raw };
  }

  // No closing delimiter — treat as no frontmatter
  return none;
}

/** Parse YAML frontmatter string into a record. Returns null on parse error. */
function parseYamlFrontmatter(yaml: string): Record<string, unknown> | null {
  try {
    const doc = parse(yaml) as unknown;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      return null;
    }
    return doc as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract a string value from a key (top-level or nested in metadata). */
function extractString(raw: Record<string, unknown>, key: string): string | undefined {
  const top = raw[key];
  if (typeof top === "string" && top.trim()) return top.trim();

  const metadata = raw.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const nested = (metadata as Record<string, unknown>)[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }

  return undefined;
}

/** Extract the memory type from top-level type or metadata.type. Falls back to filename. */
function extractType(raw: Record<string, unknown>, filename: string): MemoryType {
  const topType = raw.type;
  if (typeof topType === "string") {
    const t = topType.trim() as MemoryType;
    if (t === "feedback" || t === "reference" || t === "project" || t === "user") return t;
  }

  const metadata = raw.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const nested = (metadata as Record<string, unknown>).type;
    if (typeof nested === "string") {
      const t = nested.trim() as MemoryType;
      if (t === "feedback" || t === "reference" || t === "project" || t === "user") return t;
    }
  }

  return inferTypeFromFilename(filename);
}

/** Infer type from filename prefix (feedback_, reference_, project_, user_). */
function inferTypeFromFilename(filename: string): MemoryType {
  const name = filename.replace(/\.md$/, "").toLowerCase();
  if (name.startsWith("feedback_")) return "feedback";
  if (name.startsWith("reference_")) return "reference";
  if (name.startsWith("project_")) return "project";
  if (name.startsWith("user_")) return "user";
  return null;
}

/** Extract modification timestamp from metadata.modified, metadata, or fall back to mtime. */
function extractModified(raw: Record<string, unknown>, mtimeMs: number): string {
  // Check metadata.modified (gen 2)
  const metadata = raw.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const nested = (metadata as Record<string, unknown>).modified;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }

  // Check top-level modified
  const top = raw.modified;
  if (typeof top === "string" && top.trim()) return top.trim();

  // Fall back to file mtime
  return new Date(mtimeMs).toISOString();
}

/** Extract a boolean from top-level or metadata. */
function extractBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const top = raw[key];
  if (typeof top === "boolean") return top;

  const metadata = raw.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const nested = (metadata as Record<string, unknown>)[key];
    if (typeof nested === "boolean") return nested;
  }

  return undefined;
}

/** Extract priority (1-5) from top-level or metadata. Returns null if absent or invalid. */
function extractPriority(raw: Record<string, unknown>): number | null {
  for (const source of [raw, raw.metadata as Record<string, unknown> | undefined]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const val = source.priority;
    if (typeof val === "number" && Number.isInteger(val) && val >= 1 && val <= 5) {
      return val;
    }
  }
  return null;
}

/** Extract the first markdown heading as a fallback description. */
function extractFirstHeading(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}
