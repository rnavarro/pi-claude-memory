// Memory file writer.
//
// Writes Claude Code-format memory files: per-topic .md with YAML frontmatter
// + a link entry in MEMORY.md. Round-trip validates YAML before writing.
// All writes are add-only for v1: existing frontmatter is preserved, MEMORY.md
// link entries are appended (never rewritten) so hand-authored sections survive.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { parseMemoryContent } from "./frontmatter.js";
import type { MemoryDir, MemoryType, ParsedFrontmatter } from "./types.js";

/** A write-memory request. */
export interface WriteMemoryRequest {
  /** Entry name (slug). Used as filename: <name>.md */
  name: string;
  /** One-line description shown in MEMORY.md link entry. */
  description: string;
  /** Memory type. */
  type: Exclude<MemoryType, null>;
  /** Markdown body. */
  body: string;
  /** Whether to pin this entry. */
  pinned: boolean;
  /** Tier: "project" or "global". */
  tier: "project" | "global";
}

/** A remove-memory request. */
export interface RemoveMemoryRequest {
  /** Entry name or filename to remove. */
  name: string;
  /** Tier: "project" or "global". */
  tier: "project" | "global";
}

/** Result of a write or remove operation. */
export interface MemoryOpResult {
  ok: boolean;
  message: string;
  /** Path to the written/moved file, if any. */
  filePath?: string;
}

const TRASH_DIRNAME = ".trash";

/** Sanitize a name into a safe filename slug. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      // Collapse whitespace to single hyphens
      .replace(/\s+/g, "-")
      // Strip characters that are unsafe in filenames
      .replace(/[^a-z0-9._-]/g, "")
      // Collapse repeated hyphens
      .replace(/-+/g, "-")
      // Strip leading/trailing hyphens and dots
      .replace(/^[.-]+|[.-]+$/g, "")
  );
}

/** Build YAML frontmatter matching Claude Code gen-2 nested-metadata format. */
export function buildFrontmatterYaml(
  entry: Pick<WriteMemoryRequest, "name" | "description" | "type" | "pinned">,
  modified: string,
): string {
  // Use the yaml package so output is guaranteed valid (never string-template).
  const doc: Record<string, unknown> = {
    name: entry.name,
    description: entry.description,
    metadata: {
      node_type: "memory",
      type: entry.type,
      modified,
    },
  };
  if (entry.pinned) {
    (doc.metadata as Record<string, unknown>).pinned = true;
  }
  // stringify returns clean YAML with no trailing newline
  return `---\n${stringify(doc).trimEnd()}\n---\n`;
}

/** Round-trip validate: parse what we just emitted, confirm fields survive. */
function roundTripValidate(
  yamlText: string,
  expected: Pick<WriteMemoryRequest, "name" | "description" | "type">,
): boolean {
  const m = yamlText.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return false;
  try {
    const parsed = parse(m[1]) as Record<string, unknown>;
    if (parsed.name !== expected.name) return false;
    if (parsed.description !== expected.description) return false;
    const meta = parsed.metadata as Record<string, unknown> | undefined;
    if (!meta) return false;
    if (meta.type !== expected.type) return false;
    if (meta.node_type !== "memory") return false;
    return true;
  } catch {
    return false;
  }
}

/** Write a memory topic file + patch MEMORY.md index. Add-only for v1. */
export function writeMemory(dir: MemoryDir, req: WriteMemoryRequest): MemoryOpResult {
  const slug = slugify(req.name);
  if (!slug) {
    return { ok: false, message: `Invalid memory name: ${req.name}` };
  }
  const filename = `${slug}.md`;
  const filePath = join(dir.dir, filename);

  const modified = new Date().toISOString();
  const frontmatterYaml = buildFrontmatterYaml(req, modified);

  if (!roundTripValidate(frontmatterYaml, req)) {
    return { ok: false, message: `YAML round-trip validation failed for ${filename}` };
  }

  // Build the full file content
  const fullContent = `${frontmatterYaml}\n${req.body.trimStart()}\n`;

  // Ensure the directory exists
  mkdirSync(dir.dir, { recursive: true });

  // Write the topic file (overwrite if exists — user asked for a write)
  writeFileSync(filePath, fullContent, "utf8");

  // Patch MEMORY.md: append a link entry if not already present.
  patchIndexAppend(dir, {
    filename,
    title: deriveTitle(req.name, req.description),
    summary: req.description,
    pinned: req.pinned,
  });

  return {
    ok: true,
    message: `Wrote memory ${slug} to ${dir.label} tier`,
    filePath,
  };
}

/** Derive a human-readable title from the name + description. */
function deriveTitle(name: string, description: string): string {
  // If description is short, use it as title; else prettify the name.
  if (description && description.length <= 60) return description;
  return name
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Append a link entry to MEMORY.md without destroying hand-authored content. */
function patchIndexAppend(
  dir: MemoryDir,
  entry: { filename: string; title: string; summary: string; pinned: boolean },
): void {
  const indexPath = dir.indexPath;

  // If MEMORY.md doesn't exist, create it with the entry
  if (!existsSync(indexPath)) {
    const pin = entry.pinned ? "⛔ " : "";
    const line = `- ${pin}[${entry.title}](${entry.filename}) — ${entry.summary}\n`;
    writeFileSync(indexPath, line, "utf8");
    return;
  }

  const content = readFileSync(indexPath, "utf8");

  // Check if an entry for this filename already exists — if so, replace its line.
  const lines = content.split("\n");
  const linkRegex = new RegExp(
    `^-\\s+(?:[^\\[]+\\s+)?\\[[^\\]]+\\]\\(${escapeRegex(entry.filename)}\\)\\s*[—-]\\s*.+$`,
  );
  const existingIdx = lines.findIndex((l) => linkRegex.test(l));

  const pin = entry.pinned ? "⛔ " : "";
  const newLine = `- ${pin}[${entry.title}](${entry.filename}) — ${entry.summary}`;

  if (existingIdx >= 0) {
    // Replace the existing line in place
    lines[existingIdx] = newLine;
    writeFileSync(indexPath, lines.join("\n"), "utf8");
    return;
  }

  // Append at end. Preserve trailing newline state.
  const ending = content.endsWith("\n") ? "" : "\n";
  writeFileSync(indexPath, `${content}${ending}${newLine}\n`, "utf8");
}

/** Remove a memory: move file to .trash/ and remove its MEMORY.md entry. */
export function removeMemory(dir: MemoryDir, req: RemoveMemoryRequest): MemoryOpResult {
  const slug = slugify(req.name);
  // Allow direct filename match if slug doesn't match a real file
  const candidates = [`${slug}.md`, req.name.endsWith(".md") ? req.name : `${req.name}.md`];
  let filePath = "";
  for (const c of candidates) {
    const p = join(dir.dir, c);
    if (existsSync(p)) {
      filePath = p;
      break;
    }
  }

  if (!filePath || !existsSync(filePath)) {
    return { ok: false, message: `Memory not found: ${req.name} in ${dir.label} tier` };
  }

  // Move to .trash/ (never delete — user can recover)
  const trashDir = join(dir.dir, TRASH_DIRNAME);
  mkdirSync(trashDir, { recursive: true });
  const filename = basename(filePath);
  const trashPath = join(trashDir, `${filename}.${Date.now()}.bak`);
  renameSync(filePath, trashPath);

  // Remove the link entry from MEMORY.md
  removeFromIndex(dir, filename);

  return {
    ok: true,
    message: `Moved memory ${filename} to .trash/ in ${dir.label} tier`,
    filePath: trashPath,
  };
}

/** Remove a link entry from MEMORY.md by filename. */
function removeFromIndex(dir: MemoryDir, filename: string): void {
  const indexPath = dir.indexPath;
  if (!existsSync(indexPath)) return;

  const content = readFileSync(indexPath, "utf8");
  const lines = content.split("\n");
  const linkRegex = new RegExp(
    `^-\\s+(?:[^\\[]+\\s+)?\\[[^\\]]+\\]\\(${escapeRegex(filename)}\\)\\s*[—-]\\s*.+$`,
  );
  const filtered = lines.filter((l) => !linkRegex.test(l));
  if (filtered.length !== lines.length) {
    writeFileSync(indexPath, filtered.join("\n"), "utf8");
  }
}

/** Resolve [[wikilinks]] inside a markdown body to paths relative to the memory dir. */
export function resolveWikilinks(
  body: string,
  dir: MemoryDir,
): { text: string; resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  // [[name]] or [[name|display]]
  const wikilinkRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const text = body.replace(wikilinkRe, (_match, target: string, display?: string) => {
    const slug = slugify(target);
    const candidate = `${slug}.md`;
    const path = join(dir.dir, candidate);
    if (existsSync(path)) {
      resolved.push(candidate);
      const label = display ?? target;
      return `[${label}](${candidate})`;
    }
    unresolved.push(target);
    return display ?? target; // leave as plain text if unresolvable
  });
  return { text, resolved, unresolved };
}

/** Read a memory file by name, returning full content with resolved wikilinks. */
export function readMemory(
  dir: MemoryDir,
  name: string,
):
  | { ok: true; content: string; filePath: string; frontmatter: ParsedFrontmatter }
  | { ok: false; message: string } {
  const slug = slugify(name);
  const candidates = [`${slug}.md`, name.endsWith(".md") ? name : `${name}.md`];
  let filePath = "";
  for (const c of candidates) {
    const p = join(dir.dir, c);
    if (existsSync(p)) {
      filePath = p;
      break;
    }
  }
  if (!filePath || !existsSync(filePath)) {
    return { ok: false, message: `Memory not found: ${name} in ${dir.label} tier` };
  }

  const content = readFileSync(filePath, "utf8");
  const filename = basename(filePath);
  const frontmatter = parseMemoryContent(content, filename, Date.now());
  const { text } = resolveWikilinks(frontmatter.body, dir);

  return {
    ok: true,
    content: `# ${frontmatter.name}\n\n${text}`,
    filePath,
    frontmatter,
  };
}

/** Escape a string for safe embedding in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve a relative href from MEMORY.md against the memory dir. */
export function resolveHrefSafe(href: string, baseDir: string): string {
  // Cross-tier absolute hrefs (e.g. /home/user/.claude/memory/...)
  if (href.startsWith("/")) return resolve(href);
  // Relative hrefs resolve against the dir of MEMORY.md
  return resolve(dirname(baseDir), href);
}
