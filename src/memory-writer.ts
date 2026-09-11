// Memory file writer.
//
// Writes Claude Code-format memory files: per-topic .md with YAML frontmatter
// + a link entry in MEMORY.md. Round-trip validates YAML before writing.
// All writes are add-only for v1: existing frontmatter is preserved, MEMORY.md
// link entries are appended (never rewritten) so hand-authored sections survive.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { debugLog } from "./debug-log.js";
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
  /** Priority 1-5 (5=highest). Optional; null/undefined means derive from type. */
  priority?: number | null;
  /** Whether to overwrite an existing entry with the same slug.
   * The write_memory tool sets true (user explicitly asked).
   * Auto-learn sets false (skip + log on collision to avoid clobbering
   * Claude Code-authored memories). */
  allowOverwrite: boolean;
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

/** Resolve a topic name to a safe file path within the memory dir, or null if
 * not found or if the name would escape the dir / target the reserved index.
 *
 * Centralizes the slug-then-raw candidate lookup with two guards the previous
 * inline code lacked:
 * 1. Containment: the resolved path must stay inside dir. Rejects `..` and
 *    separator-bearing raw names — slugify would mangle them, but the raw
 *    fallback honored them and could escape the memory dir.
 * 2. Reserved: never resolve to MEMORY.md (the index itself), so a stray
 *    `remove_memory MEMORY.md` cannot trash the index. */
function resolveTopicFile(dir: MemoryDir, name: string): string | null {
  const slug = slugify(name);
  const rawCandidate = name.endsWith(".md") ? name : `${name}.md`;
  const base = resolve(dir.dir);
  for (const c of [`${slug}.md`, rawCandidate]) {
    // Direct children only: a separator-bearing candidate is a nested path —
    // lexically contained here, but this store never writes nested topics,
    // and restricting it flattens a whole class of containment tricks.
    if (c.includes("/") || c.includes("\\") || c.includes("..")) continue;
    const p = resolve(dir.dir, c);
    // Containment: must be within the base dir (defense in depth on top of
    // the direct-children rule).
    if (p !== base && !p.startsWith(`${base}${sep}`)) continue;
    // Reserved: never touch the index file.
    if (basename(p).toLowerCase() === "memory.md") continue;
    let st: import("node:fs").Stats;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    // Only plain regular files: a symlinked "topic" could point outside the
    // store (read would leak, removal semantics get murky).
    if (st.isSymbolicLink() || !st.isFile()) continue;
    return p;
  }
  return null;
}

/** Sanitize a name into a safe filename slug. */
export function slugify(name: string): string {
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

/** Build YAML frontmatter matching Claude Code gen-2 nested-metadata format.
 *
 * If preservedMetadata contains fields from an existing file (originSessionId,
 * etc.), they are merged into the new metadata block so provenance survives
 * across overwrites.
 */
export function buildFrontmatterYaml(
  entry: Pick<WriteMemoryRequest, "name" | "description" | "type" | "pinned" | "priority">,
  modified: string,
  preservedMetadata: Record<string, unknown> = {},
): string {
  // Use the yaml package so output is guaranteed valid (never string-template).
  // Spread preserved first, then our values override fields we own. We
  // explicitly manage the fields we own (node_type, type, modified, pinned,
  // priority) so a preserved value never survives an overwrite that intends to
  // clear it — e.g. pinned:false must delete a preserved pinned:true, and an
  // absent/invalid priority must delete a preserved one.
  const metadata: Record<string, unknown> = {
    ...preservedMetadata,
    node_type: "memory",
    type: entry.type,
    modified,
  };
  // pinned is owned: set when true, delete when false so a preserved
  // pinned:true does not survive an overwrite that clears it.
  if (entry.pinned) {
    metadata.pinned = true;
  } else {
    delete metadata.pinned;
  }
  // priority is owned: emit only a valid integer 1-5. Anything else clears it
  // so a stale preserved priority cannot survive a write that omits it.
  if (
    typeof entry.priority === "number" &&
    Number.isInteger(entry.priority) &&
    entry.priority >= 1 &&
    entry.priority <= 5
  ) {
    metadata.priority = entry.priority;
  } else {
    delete metadata.priority;
  }
  const doc: Record<string, unknown> = {
    name: entry.name,
    description: entry.description,
    metadata,
  };
  // stringify returns clean YAML with no trailing newline
  return `---\n${stringify(doc).trimEnd()}\n---\n`;
}

/** Round-trip validate: parse what we just emitted, confirm fields survive. */
function roundTripValidate(
  yamlText: string,
  expected: Pick<WriteMemoryRequest, "name" | "description" | "type" | "pinned" | "priority">,
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
    // pinned must round-trip: present+true when expected, absent when not.
    if (expected.pinned && meta.pinned !== true) return false;
    if (!expected.pinned && meta.pinned !== undefined) return false;
    // priority must round-trip when a valid integer was provided.
    if (
      typeof expected.priority === "number" &&
      Number.isInteger(expected.priority) &&
      expected.priority >= 1 &&
      expected.priority <= 5
    ) {
      if (meta.priority !== expected.priority) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Write a memory topic file + patch MEMORY.md index.
 *
 * Collision behavior controlled by req.allowOverwrite:
 * - false (auto-learn): if the file exists, skip and return ok=false.
 *   This prevents clobbering Claude Code-authored memories on slug collision.
 * - true (write_memory tool): if the file exists, overwrite it but preserve
 *   originSessionId (and other unknown metadata fields) from the existing
 *   file's raw frontmatter, so Claude Code's provenance metadata survives.
 *   The modified timestamp is always refreshed to now (recency sort wants the
 *   latest write time, not the original).
 */
export function writeMemory(dir: MemoryDir, req: WriteMemoryRequest): MemoryOpResult {
  const slug = slugify(req.name);
  if (!slug) {
    return { ok: false, message: `Invalid memory name: ${req.name}` };
  }
  // Reserved-name guard (write side): the read/remove path reserves
  // memory.md for the index, so writing a topic with that slug would create
  // an orphan no tool can ever recall or remove — and on case-insensitive
  // filesystems it could shadow MEMORY.md itself.
  if (/^memory$/i.test(slug)) {
    return {
      ok: false,
      message: `Reserved memory name: ${req.name} — the slug "memory" collides with the reserved index filename`,
    };
  }
  const filename = `${slug}.md`;
  const filePath = join(dir.dir, filename);

  const wasExisting = existsSync(filePath);
  // Collision guard: if the file exists and caller didn't allow overwrite, skip.
  if (wasExisting && !req.allowOverwrite) {
    debugLog("writer.write_skip_collision", { slug, filename, tier: dir.tier, label: dir.label });
    return {
      ok: false,
      message: `Memory ${filename} already exists in ${dir.label} tier (auto-learn skipped to avoid clobbering)`,
    };
  }

  const modified = new Date().toISOString();

  // If overwriting, preserve originSessionId from the existing file's raw frontmatter.
  // This is critical for the shared store: Claude Code's provenance metadata
  // must survive a Pi-initiated overwrite.
  let preservedMetadata: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const existing = readFileSync(filePath, "utf8");
      const parsed = parseMemoryContent(existing, filename, Date.now());
      if (parsed.hasFrontmatter && parsed.raw?.metadata) {
        preservedMetadata = parsed.raw.metadata as Record<string, unknown>;
      }
    } catch {
      // If we can't read the existing file, proceed with a fresh write
    }
  }

  const frontmatterYaml = buildFrontmatterYaml(req, modified, preservedMetadata);

  if (!roundTripValidate(frontmatterYaml, req)) {
    debugLog("writer.write_validation_failed", { slug, filename, tier: dir.tier });
    return { ok: false, message: `YAML round-trip validation failed for ${filename}` };
  }

  // Build the full file content
  const fullContent = `${frontmatterYaml}\n${req.body.trimStart()}\n`;

  // Ensure the directory exists
  mkdirSync(dir.dir, { recursive: true });

  // Write the topic file (atomic: write to temp, then rename)
  atomicWriteFile(filePath, fullContent);

  // Patch MEMORY.md: append a link entry if not already present.
  patchIndexAppend(dir, {
    filename,
    title: deriveTitle(req.name),
    summary: req.description,
    pinned: req.pinned,
  });

  debugLog("writer.write_ok", {
    slug,
    filename,
    type: req.type,
    tier: dir.tier,
    label: dir.label,
    pinned: req.pinned,
    // Overwrite defined by the write itself (target existed + allowOverwrite),
    // not by whether metadata survived — a frontmatter-less Gen 3 target
    // overwrites with nothing to preserve.
    overwrote: wasExisting && req.allowOverwrite,
    filePath,
  });

  return {
    ok: true,
    message: `Wrote memory ${slug} to ${dir.label} tier`,
    filePath,
  };
}

/** Derive a human-readable title from the entry slug.
 *
 * The title is the bracket display text in MEMORY.md; the summary after the
 * dash carries the description. Always prettify the slug so the two halves
 * are not identical — duplicated text both wastes injected tokens every turn
 * and breaks supersession identity (the auto-learn prompt tells the LLM to
 * match the existing entry's identifier, which must be the slug, not the
 * description). */
function deriveTitle(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Append a link entry to MEMORY.md without destroying hand-authored content.
 *
 * Uses atomic write (temp-file + rename) so a concurrent Claude Code reader
 * never observes a truncated MEMORY.md. */
function patchIndexAppend(
  dir: MemoryDir,
  entry: { filename: string; title: string; summary: string; pinned: boolean },
): void {
  const indexPath = dir.indexPath;

  // If MEMORY.md doesn't exist, create it with the entry
  if (!existsSync(indexPath)) {
    const pin = entry.pinned ? "⛔ " : "";
    const line = `- ${pin}[${entry.title}](${entry.filename}) — ${entry.summary}\n`;
    atomicWriteFile(indexPath, line);
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
    atomicWriteFile(indexPath, lines.join("\n"));
    return;
  }

  // Append at end. Preserve trailing newline state.
  const ending = content.endsWith("\n") ? "" : "\n";
  atomicWriteFile(indexPath, `${content}${ending}${newLine}\n`);
}

/** Remove a memory: move file to .trash/ and remove its MEMORY.md entry. */
export function removeMemory(dir: MemoryDir, req: RemoveMemoryRequest): MemoryOpResult {
  const filePath = resolveTopicFile(dir, req.name);
  if (!filePath) {
    debugLog("writer.remove_not_found", { name: req.name, tier: dir.tier, label: dir.label });
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

  debugLog("writer.remove_ok", { filename, tier: dir.tier, label: dir.label, trashPath });

  return {
    ok: true,
    message: `Moved memory ${filename} to .trash/ in ${dir.label} tier`,
    filePath: trashPath,
  };
}

/** Remove a link entry from MEMORY.md by filename.
 * Uses atomic write (temp-file + rename). */
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
    atomicWriteFile(indexPath, filtered.join("\n"));
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
  const filePath = resolveTopicFile(dir, name);
  if (!filePath) {
    debugLog("writer.read_not_found", { name, tier: dir.tier, label: dir.label });
    return { ok: false, message: `Memory not found: ${name} in ${dir.label} tier` };
  }

  const content = readFileSync(filePath, "utf8");
  const filename = basename(filePath);
  const frontmatter = parseMemoryContent(content, filename, Date.now());
  const { text, resolved, unresolved } = resolveWikilinks(frontmatter.body, dir);

  debugLog("writer.read_ok", {
    filename,
    tier: dir.tier,
    label: dir.label,
    contentLength: content.length,
    wikilinksResolved: resolved.length,
    wikilinksUnresolved: unresolved.length,
  });

  return {
    ok: true,
    content: `# ${frontmatter.name}\n\n${text}`,
    filePath,
    frontmatter,
  };
}

/** Write a file atomically: write to a temp file in the same directory, then rename.
 *
 * rename is atomic on POSIX when source and destination are on the same
 * filesystem (same directory). This prevents a concurrent reader (Claude
 * Code) from observing a truncated file. */
function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpName = `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`;
  const tmpPath = join(dir, tmpName);
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
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
