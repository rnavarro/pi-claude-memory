// Memory file writer.
//
// Writes Claude Code-format memory files: per-topic .md with YAML frontmatter
// + a link entry in MEMORY.md. Round-trip validates YAML before writing.
// All writes are add-only for v1: existing frontmatter is preserved, MEMORY.md
// link entries are appended (never rewritten) so hand-authored sections survive.

import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { debugLog } from "./debug-log.js";
import { parseMemoryContent } from "./frontmatter.js";
import { lineTargetsAnyIdentity, lineTargetsFile } from "./index-parser.js";
import type { MemoryDir, MemoryType, ParsedFrontmatter } from "./types.js";
import { INDEX_MAX_BYTES, TOPIC_FILE_MAX_BYTES } from "./types.js";

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
  /** Other stores whose indexes may also link this topic.
   *
   * A topic owned by one tier can be linked from the OTHER tier's index by an
   * absolute href — the my-app project index on this machine links two
   * global topics that way. Removing from the owning tier alone leaves the
   * other tier advertising a topic that no longer exists, so the caller passes
   * the other resolved store and its dangling line is stripped too. */
  alsoUnlink?: MemoryDir[];
}

/** Result of a write or remove operation. */
export interface MemoryOpResult {
  ok: boolean;
  message: string;
  /** Path to the written/moved file, if any. */
  filePath?: string;
  /** Machine-readable failure class, so a caller can tell "this tier does not
   * hold the entry" (safe to try the other tier) from "this tier refused" (an
   * answer about THIS tier, which must not be retried against another store).
   * Absent on success. */
  reason?: "not_found" | "refused" | "error";
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
/** Names a read/remove/write may never address: path separators and
 * traversal fragments would either escape the store or (after slugification)
 * silently alias a DIFFERENT topic than the caller named — e.g. "sub/nested"
 * slugified to "subnested.md", or "../outer" to "outer.md". Reject the
 * unsafe input BEFORE any slugification so no neutralized form is tried. */
export function isUnsafeMemoryName(name: string): boolean {
  return (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.includes("\n") ||
    name.includes("\r")
  );
}

/** Validate one candidate filename as a plain, contained, non-reserved child
 * of `base`, returning its absolute path or null. */
function containedChild(base: string, c: string): string | null {
  // Direct children only: a separator-bearing candidate is a nested path —
  // lexically contained here, but this store never writes nested topics,
  // and restricting it flattens a whole class of containment tricks.
  if (c.includes("/") || c.includes("\\") || c.includes("..")) return null;
  const p = resolve(base, c);
  // Containment: must be within the base dir (defense in depth on top of
  // the direct-children rule).
  if (p !== base && !p.startsWith(`${base}${sep}`)) return null;
  // Reserved: never touch the index file.
  if (basename(p).toLowerCase() === "memory.md") return null;
  let st: import("node:fs").Stats;
  try {
    st = lstatSync(p);
  } catch {
    return null;
  }
  // Only plain regular files: a symlinked "topic" could point outside the
  // store (read would leak, removal semantics get murky).
  if (st.isSymbolicLink() || !st.isFile()) return null;
  return p;
}

function resolveTopicFile(dir: MemoryDir, name: string): string | null {
  // Unsafe names are rejected outright — never slugified. Slugify would
  // neutralize the separator and silently resolve a different topic than
  // the caller named.
  if (isUnsafeMemoryName(name)) return null;
  const slug = slugify(name);
  const rawCandidate = name.endsWith(".md") ? name : `${name}.md`;
  const base = resolve(dir.dir);
  // Explicit filename first: when the caller names "alpha.md" and BOTH
  // alpha.md and alpha.md.md exist (slug "alpha.md" + .md append), the
  // caller meant alpha.md. The slug candidate stays as a fallback for
  // hand-authored titles ("Alpha Beta" → alpha-beta.md).
  for (const c of name.endsWith(".md")
    ? [rawCandidate, `${slug}.md`]
    : [`${slug}.md`, rawCandidate]) {
    const p = containedChild(base, c);
    if (p) return p;
  }

  // Slug scan: a topic whose stem is not slug-normal ("Foo Bar.md", or
  // uppercase) is unreachable by the candidates above — its slug differs from
  // its stem, so `foo-bar.md` does not exist. Without this, supersession of
  // such a topic silently no-opped: the snapshot lookup hit, then the stat of
  // the slug path threw ENOENT and the candidate was skipped as "deleted".
  // Ambiguous matches (two files slugifying alike) resolve to nothing rather
  // than to an arbitrary one.
  if (!slug) return null;
  let found: string | null = null;
  const matchingNames: string[] = [];
  try {
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".md") || e.name === "MEMORY.md") continue;
      if (slugify(e.name.replace(/\.md$/, "")) !== slug) continue;
      matchingNames.push(e.name);
      found = containedChild(base, e.name);
    }
  } catch {
    return null;
  }
  if (matchingNames.length === 0) return null;
  if (matchingNames.length === 1) return found;
  // Refusing to guess between two files is right (picking arbitrarily could
  // read or trash the wrong one), but the caller reports plain "not found",
  // which is both wrong and impossible to diagnose from the message. Record the
  // candidates so the ambiguity is at least visible in the debug log.
  debugLog("writer.topic_ambiguous", {
    name,
    dir: dir.dir,
    matches: matchingNames.slice(0, 5),
  });
  return null;
}

/** The filename a write of `name` should target: the EXISTING on-disk topic
 * for that name (whatever its stem), else the slug-derived name.
 *
 * Exported because the auto-learn stale-overwrite guard must stat exactly the
 * file writeMemory is about to write. Previously the guard stat'd the slug
 * path while writeMemory also wrote the slug path: for a non-slug-normal stem
 * both were wrong together, so the guard failed closed (a safe but silent
 * no-op) and a write that DID proceed created a duplicate rather than
 * superseding. Resolving the existing file aligns the guard, the write, and
 * the advertised stem. */
export function resolveWriteTarget(dir: MemoryDir, name: string): string {
  const existing = resolveTopicFile(dir, name);
  return existing ? basename(existing) : `${slugify(name)}.md`;
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
  // Name policy is shared with read/remove: separator/traversal/newline
  // bearing names are invalid AT ENTRY — slugifying them would silently
  // target a different topic than the caller named ("../outer" → outer.md).
  if (isUnsafeMemoryName(req.name)) {
    return {
      ok: false,
      message: `Invalid memory name: ${JSON.stringify(req.name)} — path separators, traversal fragments, and newlines are not allowed`,
    };
  }
  const slug = slugify(req.name);
  if (!slug) {
    return { ok: false, message: `Invalid memory name: ${req.name}` };
  }
  // Description policy: it becomes the index-line summary after the dash.
  // Empty descriptions emit unmatchable index lines ("- [T](x.md) — " fails
  // every link regex, so rewrites append duplicates and removal can't strip
  // the line), and multiline descriptions could smuggle a second entry into
  // the index.
  if (!req.description.trim() || req.description.includes("\n") || req.description.includes("\r")) {
    return {
      ok: false,
      message: `Invalid description for ${slug}: must be a non-empty single line`,
    };
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
  // Target the EXISTING file when one already exists for this name, so an
  // overwrite supersedes that topic in place instead of creating a
  // slug-named duplicate beside a non-slug-normal stem ("Foo Bar.md" +
  // "foo-bar.md"). Resolution is NOT gated on allowOverwrite: the collision
  // check below must also see that the name resolves to a file, otherwise a
  // plain write of "Foo Bar" would not notice "Foo Bar.md" exists and would
  // quietly create the same duplicate. The auto-learn stale-overwrite guard
  // resolves identically, so it stats exactly the file this writes.
  const filename = resolveWriteTarget(dir, req.name);
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
  // lstat before reading: the read/remove paths reject a symlinked topic
  // (resolveTopicFile), but this preserve-read would follow one and lift the
  // TARGET's metadata into the new memory — which is then injected every turn.
  // A symlink here means the name is not a topic we own, so skip preservation
  // and write fresh; the publish below replaces the link rather than following
  // it either way.
  let existingIsPlainFile = false;
  try {
    const st = lstatSync(filePath);
    existingIsPlainFile = st.isFile() && !st.isSymbolicLink();
  } catch {
    existingIsPlainFile = false;
  }
  if (existingIsPlainFile) {
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

  // Refuse a topic the read paths would reject. Both readers cap at
  // TOPIC_FILE_MAX_BYTES (the injector silently drops an oversize file from
  // the prompt; recall_memory refuses it), so publishing past the cap produced
  // an entry that reported success, got an index line, and could never be read
  // through any interface this extension offers. Byte length, not string
  // length: the cap is applied to bytes on the read side.
  const contentBytes = Buffer.byteLength(fullContent, "utf8");
  if (contentBytes > TOPIC_FILE_MAX_BYTES) {
    debugLog("writer.write_oversize", {
      slug,
      filename,
      tier: dir.tier,
      bytes: contentBytes,
      cap: TOPIC_FILE_MAX_BYTES,
    });
    return {
      ok: false,
      message:
        `Memory ${filename} is too large to write (${contentBytes} bytes, cap ${TOPIC_FILE_MAX_BYTES}). ` +
        `It would be unreadable by recall_memory and dropped from injection.`,
    };
  }

  // Ensure the directory exists
  mkdirSync(dir.dir, { recursive: true });

  // Write the topic file. Auto-learn (allowOverwrite=false) publishes
  // no-clobber: another writer creating the same slug between the collision
  // check above and now would be silently destroyed by temp+rename; link()
  // fails EEXIST atomically instead.
  if (req.allowOverwrite) {
    atomicWriteFile(filePath, fullContent);
  } else if (!atomicWriteFileNoClobber(filePath, fullContent)) {
    debugLog("writer.write_lost_create_race", { slug, filename, tier: dir.tier, label: dir.label });
    return {
      ok: false,
      message: `Memory ${filename} appeared in ${dir.label} tier concurrently (auto-learn skipped to avoid clobbering)`,
    };
  }

  // Patch MEMORY.md: append a link entry if not already present. Never let
  // a failure here escape: the topic file is already on disk, and throwing
  // would (a) in auto-learn be swallowed by the per-candidate catch, leaving
  // a topic with NO index line — invisible to every injection, the exact
  // state withIndexRetry exists to prevent — and (b) in the write_memory
  // tool skip invalidateResolveCache, leaving a stale frozen injection.
  let indexError: string | null = null;
  try {
    patchIndexAppend(dir, {
      filename,
      // Derive the display title from the RESOLVED FILENAME STEM, not from the
      // slug. Two reasons:
      //
      // 1. The index line interpolates the title inside [..]. A raw name
      //    containing ']' (e.g. "a]b" -> ab.md) produced `- [A]b](ab.md) — ...`,
      //    which no index regex can ever match, so every later write appended a
      //    duplicate and removal could not strip the line. A filename stem has
      //    already been through slugify OR was already a legal name on disk, so
      //    it is safe here either way.
      // 2. Deriving from the SLUG mangled titles for the many real entries whose
      //    stems contain an underscore: slugify strips '_', so a supersession of
      //    the real `feedback_prefer_jq.md` rewrote its line to
      //    `- [Feedbackpreferjq](feedback_prefer_jq.md)`. Title and filename
      //    disagreed — the opposite of what the previous comment here claimed.
      //    The stem also keeps the title in agreement with the href by
      //    construction, which is what the comment was reaching for.
      title: deriveTitle(filename.replace(/\.md$/, "")),
      summary: req.description,
      pinned: req.pinned,
    });
  } catch (err) {
    indexError = String(err);
    debugLog("writer.index_patch_failed", {
      slug,
      filename,
      tier: dir.tier,
      label: dir.label,
      error: indexError,
    });
    // Deliberately not rewritten by unrelated later writes. `patchIndexAppend`
    // only ever touches the entry being written, so this topic stays unindexed
    // (and therefore uninjected) until something rewrites THIS entry. The
    // message must not imply otherwise.
    console.error(
      `[pi-claude-memory] wrote ${filename} but failed to update ${dir.indexPath}: ${indexError}. ` +
        `The topic file exists but has no index line, so it will not be injected until this entry is written again.`,
    );
  }

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
    message: indexError
      ? `Wrote memory ${slug} to ${dir.label} tier, but the index update failed (${indexError}); the entry is not linked yet`
      : `Wrote memory ${slug} to ${dir.label} tier`,
    filePath,
  };
}

/** Derive a human-readable title from the entry's FILENAME STEM.
 *
 * The title is the bracket display text in MEMORY.md; the summary after the
 * dash carries the description. Prettifying keeps the two halves from being
 * identical — duplicated text both wastes injected tokens every turn and
 * breaks supersession identity (the auto-learn prompt tells the LLM to match
 * the existing entry's identifier, which must be the slug, not the
 * description).
 *
 * Splits on BOTH '-' and '_': the store is full of Claude Code entries whose
 * stems use underscores (`feedback_prefer_jq`, `user_location`), and splitting
 * only on hyphens left those as a single unsplit word. */
function deriveTitle(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Append a link entry to MEMORY.md without destroying hand-authored content.
 *
 * Publishes via withIndexRetry (atomic writes + lost-update merge retry) so
 * a concurrent Claude Code index edit is rebased onto and merged with, not
 * overwritten. */
function patchIndexAppend(
  dir: MemoryDir,
  entry: { filename: string; title: string; summary: string; pinned: boolean },
): void {
  const indexPath = dir.indexPath;

  const pin = entry.pinned ? "⛔ " : "";
  const newLine = `- ${pin}[${entry.title}](${entry.filename}) — ${entry.summary}`;
  // Match by RESOLVED TARGET, not by the literal `(filename.md)` spelling.
  // An index line reached through an absolute href (a shape the parser
  // supports and Claude Code writes) is the same file, but a spelling-based
  // regex misses it: the append branch then adds a SECOND line for a topic
  // that is already listed, and every future write keeps missing it too, so
  // the duplicate is permanent. The target path is the same one the parser
  // and the containment guard use.
  const targetPath = join(dir.dir, entry.filename);
  const linkRegex = new RegExp(
    // Summary optional: hand-authored lines like "- [Foo](foo.md)" (no dash
    // + summary) must still be replaceable — a mandatory-summary regex would
    // append a duplicate line instead. The write path now rejects empty
    // descriptions, so WE never emit dash-less lines; this covers existing
    // ones from Claude Code or hand edits.
    `^-\\s+(?:[^\\[]+\\s+)?\\[[^\\]]+\\]\\(${escapeRegex(entry.filename)}\\)(?:\\s*[—-]\\s*.+)?$`,
  );

  // If MEMORY.md doesn't exist, create it with the entry — no-clobber so
  // losing a creation race falls through to merge into the winner's index.
  if (!existsSync(indexPath)) {
    if (atomicWriteFileNoClobber(indexPath, `${newLine}\n`)) return;
  }

  withIndexRetry(
    indexPath,
    (content) => {
      // Check if an entry for this target already exists — if so, replace its
      // line. `linkRegex` is the cheap literal fast path; the target check
      // catches differently-spelled hrefs for the same file.
      const lines = content.split("\n");
      const existingIdx = lines.findIndex(
        (l) => linkRegex.test(l) || lineTargetsFile(l, dir.dir, targetPath),
      );

      if (existingIdx >= 0) {
        // Replace the existing line in place
        lines[existingIdx] = newLine;
        return lines.join("\n");
      }

      // Append at end. Preserve trailing newline state — and treat EMPTY
      // content as needing no separator: `"".endsWith("\n")` is false, so an
      // empty-but-existing MEMORY.md would otherwise gain a stray leading
      // blank line, which parseIndexContent keeps as an IndexLine and
      // renderIndexSection re-emits into the prompt on every turn.
      const ending = content === "" || content.endsWith("\n") ? "" : "\n";
      return `${content}${ending}${newLine}\n`;
    },
    () => existsSync(join(dir.dir, entry.filename)),
  );
}

/** Remove a memory: move file to .trash/ and remove its MEMORY.md entry. */
export function removeMemory(dir: MemoryDir, req: RemoveMemoryRequest): MemoryOpResult {
  const filePath = resolveTopicFile(dir, req.name);
  if (!filePath) {
    debugLog("writer.remove_not_found", { name: req.name, tier: dir.tier, label: dir.label });
    return {
      ok: false,
      reason: "not_found",
      message: `Memory not found: ${req.name} in ${dir.label} tier`,
    };
  }

  // Move to .trash/ (never delete — user can recover)
  const trashDir = join(dir.dir, TRASH_DIRNAME);
  const filename = basename(filePath);
  // Unique per-removal destination. `${filename}.${Date.now()}.bak` collided
  // when the same topic was removed twice within one millisecond (or across
  // processes sharing a timestamp), and renameSync overwrites silently — so
  // the second removal would destroy the first backup, contradicting the
  // recoverability promise. mkdtempSync reserves a fresh directory instead.
  //
  // The .trash dir is also checked for symlink-ness: moving files through an
  // attacker-controlled symlink would relocate them outside the store. The
  // check runs BEFORE creating anything, so an existing symlink is rejected
  // rather than followed by mkdirSync.
  try {
    const st = lstatSync(trashDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      debugLog("writer.trash_not_directory", { trashDir, tier: dir.tier });
      return {
        ok: false,
        reason: "refused",
        message: `.trash in ${dir.label} tier is not a plain directory`,
      };
    }
  } catch {
    // Absent — create it below.
    mkdirSync(trashDir, { recursive: true });
  }
  const destDir = mkdtempSync(join(trashDir, `${filename}.`));
  const trashPath = join(destDir, filename);
  // Pin every spelling of this topic's identity BEFORE the move. Index lines
  // pointing at it — in this store or the other tier — are matched against this
  // set: after renameSync the leaf is gone, so a matcher that canonicalizes both
  // sides can no longer resolve the topic and would miss a cross-tier absolute
  // href entirely.
  const identities = topicIdentities(filePath);
  renameSync(filePath, trashPath);

  // Remove the link entry from MEMORY.md. Report honestly when no line was
  // removed: the topic is already in .trash/, so saying "and removed its
  // MEMORY.md link" while the link survives leaves a dangling index entry the
  // user believes is gone.
  // The file is already in .trash/ by this point, so a refusal to touch the
  // index must not throw past this frame: the caller would otherwise report a
  // generic failure and lose the fact that the move succeeded. Report both
  // facts instead — the topic is gone, and its link could not be updated.
  let linkRemoved = false;
  let indexError: string | null = null;
  try {
    linkRemoved = removeFromIndex(dir, identities);
  } catch (err) {
    indexError = String(err);
    debugLog("writer.remove_index_failed", {
      filename,
      tier: dir.tier,
      label: dir.label,
      trashPath,
      error: indexError,
    });
  }

  // Strip links to the same topic from the other tier's index.
  //
  // A topic owned here can be linked from the other store by an absolute href,
  // which is how the real my-app project index references two global
  // topics. Removing the owning copy alone left that store advertising advice
  // that no longer exists, so the caller (which already resolves both tiers)
  // passes the other store in and the dangling line goes too. Matching uses the
  // identity set captured above (lexical and canonical), so a bare or absolute
  // href, an alias spelling, and a symlinked store root all still match — while
  // a same-basename entry OWNED by the other tier correctly does not.
  const crossUnlinked: string[] = [];
  const crossFailed: string[] = [];
  for (const other of req.alsoUnlink ?? []) {
    if (other.indexPath === dir.indexPath || other.dir === dir.dir) continue;
    try {
      if (removeFromIndex(other, identities)) crossUnlinked.push(other.label);
    } catch (err) {
      crossFailed.push(other.label);
      debugLog("writer.remove_cross_unlink_failed", {
        filename,
        fromTier: dir.tier,
        otherTier: other.tier,
        otherIndex: other.indexPath,
        error: String(err),
      });
    }
  }

  debugLog("writer.remove_ok", {
    filename,
    tier: dir.tier,
    label: dir.label,
    trashPath,
    linkRemoved,
    indexError,
    crossUnlinked,
    crossFailed,
  });

  const crossNote =
    crossUnlinked.length > 0
      ? ` Removed its cross-tier link from ${crossUnlinked.join(", ")} tier.`
      : "";
  const crossFailNote =
    crossFailed.length > 0
      ? ` Could not update the cross-tier index in ${crossFailed.join(", ")} tier; it may still link this topic.`
      : "";

  if (indexError) {
    return {
      ok: true,
      message:
        `Moved memory ${filename} to .trash/ in ${dir.label} tier, but could not update ` +
        `${dir.indexPath}: ${indexError}. Its index line, if any, still points at the trashed file.` +
        crossFailNote,
      filePath: trashPath,
    };
  }

  return {
    ok: true,
    message: linkRemoved
      ? `Moved memory ${filename} to .trash/ in ${dir.label} tier.${crossNote}${crossFailNote}`
      : `Moved memory ${filename} to .trash/ in ${dir.label} tier, but no matching MEMORY.md line was found to remove.${crossNote}${crossFailNote}`,
    filePath: trashPath,
  };
}

/** Canonical identity of a topic path, for matching index lines.
 *
 * Captured BEFORE the file is moved to .trash/. After a move the leaf is gone,
 * so realpathSync fails on both sides and a lexical comparison against a
 * symlinked store root (`/alias/topic.md` vs the `/real/store/topic.md` an
 * absolute href holds) no longer matches — the index line would survive with
 * nothing left to match against. Resolving while the file still exists pins the
 * identity. Falls back to the lexical path when the file is unreadable. */
export function canonicalTopicTarget(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Every spelling that identifies a topic file: its lexical path and its
 * canonical (realpath) path.
 *
 * Both are captured BEFORE any move, because after renameSync the leaf is gone
 * and realpath can no longer resolve it. A matcher that canonicalizes both
 * sides therefore silently stops recognising the topic, which is how a
 * cross-tier absolute href survived removal. Recording both spellings keeps
 * matching working with the leaf missing, and covers an index href written
 * either through the store's lexical path or through a resolved one. */
export function topicIdentities(p: string): Set<string> {
  return new Set<string>([resolve(p), canonicalTopicTarget(p)]);
}

/** Remove a link entry from MEMORY.md by resolved identity. Publishes via
 * withIndexRetry (atomic writes + lost-update merge retry).
 *
 * Returns whether any line was actually removed. Callers report success to
 * the user, and a removal that silently no-ops leaves an index line pointing
 * at a file already moved to .trash/ — the caller needs to know so it does
 * not claim the link was removed. */
function removeFromIndex(dir: MemoryDir, identities: ReadonlySet<string>): boolean {
  const indexPath = dir.indexPath;
  if (!existsSync(indexPath)) return false;

  // Match by RESOLVED IDENTITY, never by the literal `(basename)` spelling.
  //
  // The basename fast path this used to carry is sound only for the topic's OWN
  // store (same dir + same basename ⇒ same file). This function is also called
  // against the OTHER tier's index, where a bare `(notes.md)` href links that
  // tier's own file — so the shortcut stripped a live, unrelated entry's line
  // and reported it as a cross-tier cleanup. Both stores really do hold a
  // `user_location.md` on this machine, each linked by a bare basename in its
  // own index. Resolving the href is the only rule that is both
  // spelling-independent and tier-correct.
  let removed = false;
  withIndexRetry(indexPath, (content) => {
    const lines = content.split("\n");
    const filtered = lines.filter((l) => !lineTargetsAnyIdentity(l, dir.dir, identities));
    if (filtered.length === lines.length) return null; // nothing to remove
    removed = true;
    return filtered.join("\n");
  });
  return removed;
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

  // Size cap shared with the injector. Without it recall_memory is an
  // uncapped read of any file in the store, and the routing anchor actively
  // tells the model to call it for ⟨index-only⟩ entries — exactly the entries
  // the injector declined to read in full.
  try {
    const st = statSync(filePath);
    if (st.size > TOPIC_FILE_MAX_BYTES) {
      debugLog("writer.read_oversize", {
        name,
        tier: dir.tier,
        size: st.size,
        cap: TOPIC_FILE_MAX_BYTES,
      });
      return {
        ok: false,
        message: `Memory ${name} is too large to read (${st.size} bytes, cap ${TOPIC_FILE_MAX_BYTES})`,
      };
    }
  } catch (err) {
    debugLog("writer.read_stat_error", { name, tier: dir.tier, error: String(err) });
    return { ok: false, message: `Memory not readable: ${name} in ${dir.label} tier` };
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
/** Create an exclusively-owned temp file beside `filePath`, returning its path.
 *
 * The temp name is predictable (PID + timestamp), so a preexisting SYMLINK at
 * that pathname used to be followed by `writeFileSync(tmpPath, ...)`, truncating
 * whatever it pointed at — and the subsequent rename then published the symlink
 * itself as the topic. A write could therefore modify a file outside the store,
 * report success, and leave an entry that recall and containment both reject.
 *
 * `flag: "wx"` (O_CREAT|O_EXCL) refuses to open an existing path at all, so we
 * only ever write a file this call created. A collision picks a fresh name, and
 * the attempt counter keeps the name unique without depending on the clock.
 *
 * Internal — exported for tests. */
export function createTempFile(dir: string, filePath: string, content: string): string {
  const base = basename(filePath);
  for (let attempt = 0; attempt < 32; attempt++) {
    const tmpPath = join(dir, `.${base}.${process.pid}.${Date.now()}.${attempt}.tmp`);
    try {
      writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx" });
      return tmpPath;
    } catch (err) {
      // Name already taken (possibly by a planted symlink). Try another.
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not create a unique temp file for ${filePath}`);
}

/** Write via temp file + rename. Internal — exported for tests. */
export function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpPath = createTempFile(dir, filePath, content);
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Don't leave the temp file behind on a failed publish. It is invisible
    // to the .md scans (both require .endsWith(".md")), but it accumulates
    // in a directory the user browses. Mirrors atomicWriteFileNoClobber's
    // cleanup, which already did this.
    try {
      unlinkSync(tmpPath);
    } catch {
      // Already gone, or not ours to remove — nothing useful to do.
    }
    throw err;
  }
}

/** Publish a new file WITHOUT clobbering an existing one. link() is atomic
 * and fails with EEXIST when the target exists, closing the
 * check-then-create gap that write-then-rename leaves open (another writer
 * could create the target between our check and our rename, and rename
 * would silently destroy their bytes). Returns false when the target came
 * into existence concurrently. Internal — exported for tests. */
export function atomicWriteFileNoClobber(filePath: string, content: string): boolean {
  const dir = dirname(filePath);
  const tmpPath = createTempFile(dir, filePath, content);
  try {
    linkSync(tmpPath, filePath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return false;
    // Hardlinks are unavailable on exFAT/FAT, many FUSE mounts, and some
    // network shares. Fall back to O_CREAT|O_EXCL ("wx") — also an atomic
    // no-clobber create, no hardlink support needed. wx EEXIST means the
    // target came into existence concurrently: same no-clobber contract.
    if (
      code === "EPERM" ||
      code === "ENOSYS" ||
      code === "ENOTSUP" ||
      code === "EOPNOTSUPP" ||
      code === "EMLINK" ||
      code === "EXDEV"
    ) {
      try {
        writeFileSync(filePath, content, { flag: "wx" });
        return true;
      } catch (fallbackErr) {
        if ((fallbackErr as NodeJS.ErrnoException)?.code === "EEXIST") return false;
        throw fallbackErr;
      }
    }
    throw err;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // nothing to clean up
    }
  }
}

/** Number of read-check-merge attempts before withIndexRetry publishes
 * rebased-on-freshest-read anyway. */
const INDEX_MERGE_ATTEMPTS = 3;

/** Read-modify-write MEMORY.md with lost-update mitigation: after computing
 * the mutated content, re-read the index; if it changed since our read,
 * another writer landed first — recompute from THEIR content and retry.
 * Each attempt still publishes via atomic temp+rename.
 *
 * This narrows but does not close the lost-update window: no cross-process
 * lock exists (Claude Code is an independent writer), so a write can still
 * land in the gap between the final re-read and the rename. On retries
 * exhausted, publish the mutation rebased on the freshest read rather than
 * dropping it — a topic file with no index line is invisible to every
 * injector.
 *
 * fn maps current index content to updated content, or null for "nothing
 * to do". Internal — exported for tests. */
/** Refuse to read an index we may not publish back over.
 *
 * A symlinked or otherwise non-regular MEMORY.md is not an index. Reading it
 * pulls an unrelated file's bytes into the store — the subsequent rename
 * replaces the LINK with a regular file containing them, laundering outside
 * content past the read-side guards and into every future prompt. A FIFO would
 * block this synchronous read forever. An oversize index is refused for the
 * same reason the parser refuses it: appending to one that no longer parses
 * poisons every entry in the tier.
 *
 * Throws rather than returning, so callers surface a degraded result instead
 * of reporting success for a write that never reached the index. An ABSENT
 * index is not an error — callers create one. */
function assertIndexReadable(indexPath: string): void {
  let st: import("node:fs").Stats;
  try {
    st = lstatSync(indexPath);
  } catch {
    return; // absent — the caller creates it
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`MEMORY.md is not a regular file: ${indexPath}`);
  }
  if (st.size > INDEX_MAX_BYTES) {
    throw new Error(`MEMORY.md exceeds the ${INDEX_MAX_BYTES}-byte cap: ${indexPath}`);
  }
}

export function withIndexRetry(
  indexPath: string,
  fn: (content: string) => string | null,
  verifyGuard?: () => boolean,
): void {
  for (let attempt = 1; ; attempt++) {
    assertIndexReadable(indexPath);
    if (!existsSync(indexPath)) return;
    const before = readFileSync(indexPath, "utf8");
    const next = fn(before);
    if (next === null || next === before) return;
    if (attempt < INDEX_MERGE_ATTEMPTS) {
      const after = readFileSync(indexPath, "utf8");
      if (after !== before) {
        debugLog("writer.index_retry", { attempt, indexPath });
        continue;
      }
    } else {
      debugLog("writer.index_retry_exhausted", { attempt, indexPath });
    }
    // Guard EVERY publication, not just the post-write re-apply. The retry
    // `continue` above is a second way to reach a publish: when contention is
    // detected, the loop re-reads and re-runs `fn` on the concurrent writer's
    // content — and an append closure re-adds a missing line there too. If the
    // concurrent writer was a remover, that content has no line for us and the
    // topic is already in .trash/, so without this check the retry publishes a
    // link to a trashed file. This window is strictly wider than the
    // rename->verify one (it needs only a concurrent index change between our
    // two reads), and it was the more reachable of the two.
    //
    // On the ordinary path the topic was just written, so this is one
    // existsSync that always passes.
    if (verifyGuard && !verifyGuard()) {
      debugLog("writer.index_publish_vetoed", { indexPath, attempt });
      return;
    }
    // Refuse to publish an index past the cap the parser enforces.
    // parseIndexFile returns null for an oversize index, which hides EVERY
    // entry in that tier — so appending a long description that crosses the
    // threshold silently unindexes the whole store. Throwing surfaces it as a
    // degraded write instead, and leaves the existing index untouched.
    const indexBytes = Buffer.byteLength(next, "utf8");
    if (indexBytes > INDEX_MAX_BYTES) {
      throw new Error(
        `index update would exceed the ${INDEX_MAX_BYTES}-byte cap (${indexBytes} bytes): ${indexPath}`,
      );
    }
    atomicWriteFile(indexPath, next);
    verifyIndexPublish(indexPath, next, fn, verifyGuard);
    return;
  }
}

/** Post-publish verification, with a guarded one-shot re-apply.
 *
 * Exported for tests. The race it handles is CROSS-PROCESS — a writer landing
 * between our rename and this read — so a single-threaded test cannot
 * interleave it and should pre-clobber the index and call this directly
 * instead.
 *
 * Why the re-apply exists at all: a topic file with no index line is invisible
 * to every injection (silent memory loss), whereas a stale link is a cosmetic
 * dangling href that reconcileIndex already reports. When a concurrent writer
 * replaced the index after our publish, re-running the mutation on THEIR
 * content merges our entry back in rather than dropping it.
 *
 * Why it is guarded: an append closure cannot tell "my line was removed" from
 * "my line was never added". Re-applying unconditionally re-links a topic that
 * a concurrent remove_memory deliberately trashed. verifyGuard resolves the
 * ambiguity at the filesystem level — and it is sound rather than racy because
 * removeMemory trashes the topic BEFORE it strips the index line, so by the
 * time the remover's index write lands the topic is already gone. */
export function verifyIndexPublish(
  indexPath: string,
  next: string,
  fn: (content: string) => string | null,
  verifyGuard?: () => boolean,
): void {
  let landed: string;
  try {
    // Guard the CORRECTIVE read too. This path ran unguarded, so a symlink
    // swapped in during the rename-to-verify window was read through here even
    // though the main path refuses one, and that content was then re-published
    // as the index.
    assertIndexReadable(indexPath);
    landed = readFileSync(indexPath, "utf8");
  } catch {
    // Index vanished post-write (concurrent removal) — nothing sane to do.
    // Narrowed to the read: failures of the corrective write below must
    // surface rather than masquerade as a missing index.
    return;
  }
  if (landed === next) return; // our publish landed cleanly; nothing to do
  // A writer replaced the index in the rename->verify gap. Re-run the mutation
  // on THEIR content so our entry merges instead of being lost.
  if (verifyGuard && !verifyGuard()) {
    debugLog("writer.index_reapply_vetoed", { indexPath });
    return;
  }
  const reapplied = fn(landed);
  if (reapplied !== null && reapplied !== landed) {
    // Same size cap the main path enforces. Two individually-valid versions can
    // merge into an index past the cap here, and parseIndexFile returns null
    // above it — which hides EVERY entry in that tier, not just the merged one.
    const bytes = Buffer.byteLength(reapplied, "utf8");
    if (bytes > INDEX_MAX_BYTES) {
      debugLog("writer.index_reapply_oversize", { indexPath, bytes, cap: INDEX_MAX_BYTES });
      return;
    }
    atomicWriteFile(indexPath, reapplied);
    debugLog("writer.index_postwrite_reapply", { indexPath });
  }
}

/** Escape a string for safe embedding in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
