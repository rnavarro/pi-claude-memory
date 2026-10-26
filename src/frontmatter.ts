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

/** Options for {@link parseMemoryContent}. A diagnostic seam, not behaviour:
 * production callers pass nothing. */
export interface ParseMemoryOptions {
  /** Skip the flat-scalar fast path and parse every frontmatter block with
   * YAML. This is exactly the pre-fast-path code path, so the equivalence test
   * and the benchmark can measure the two against each other. */
  yamlOnly?: boolean;
}

/** How many frontmatter blocks each parser has answered since the last reset.
 * Read by the tests that prove the fast path is taken; the counters carry no
 * correctness weight, so a lost update could only weaken a test assertion. */
let fastPathParses = 0;
let yamlPathParses = 0;

/** Snapshot of the parser counters (see {@link resetFrontmatterParserStats}). */
export function frontmatterParserStats(): { fastPath: number; yamlPath: number } {
  return { fastPath: fastPathParses, yamlPath: yamlPathParses };
}

/** Zero the parser counters. */
export function resetFrontmatterParserStats(): void {
  fastPathParses = 0;
  yamlPathParses = 0;
}

/** Parse memory content string (separated for testing). */
export function parseMemoryContent(
  content: string,
  filename: string,
  mtimeMs: number,
  options?: ParseMemoryOptions,
): ParsedFrontmatter {
  const { body, hasFrontmatter, raw: parsedRaw } = splitFrontmatter(content, options);

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
function splitFrontmatter(
  content: string,
  options?: ParseMemoryOptions,
): {
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
    const raw = parseFrontmatterBlock(frontmatter, options);
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

/** Parse a frontmatter block into a record. Returns null when the block is not
 * a YAML mapping.
 *
 * Tries the flat-scalar fast path first (see `parseFlatFrontmatter`) and falls
 * back to YAML for every block it declines. */
function parseFrontmatterBlock(
  block: string,
  options?: ParseMemoryOptions,
): Record<string, unknown> | null {
  if (!options?.yamlOnly) {
    const fast = parseFlatFrontmatter(block);
    if (fast !== null) {
      fastPathParses++;
      return fast;
    }
  }
  yamlPathParses++;
  return parseYamlFrontmatter(block);
}

// ---------------------------------------------------------------------------
// Flat-scalar fast path
//
// Building a YAML document is the most expensive thing this module does, and
// index maintenance does it once per topic file (the fit planner asks whether
// each topic is a standing rule, the writer asks whether the target is pinned).
// A profile of a 2.4s main-thread stall put ~25% of it in the YAML document
// machinery and in the garbage its allocations created. Every memory file this
// store holds is the same shape: flat `key: value` scalars, one level of
// nested mapping under `metadata:`, and values that wrap onto continuation
// lines. That shape is scanned directly here.
//
// The contract is EXACT equivalence with `parse()` for the shapes accepted, and
// `null` ("decline, let YAML do it") for everything else: lists, flow
// collections, block scalars, anchors, aliases, tags, two-level nesting,
// duplicate keys, comments, blank lines inside a value, quoted strings with
// escapes, and any scalar whose YAML type is not a plain string. Declining is
// always safe; accepting wrongly is not, so every doubtful line declines.
// `test/frontmatter-fast-path.test.ts` proves both halves: deep equality with
// the YAML path over every real memory file on this machine, and
// instrumentation showing the fast path is the one that answered.

/** A scanned mapping block: its entries, the index of the first line after it,
 * and whether it held any entry at all (an empty block is a null document). */
interface FlatBlock {
  entries: Record<string, unknown>;
  next: number;
  sawEntry: boolean;
}

/** Keys that would rewrite the prototype of the object being built instead of
 * becoming an own property. Left to YAML, which handles them its own way. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Characters that mean something other than text when they START a value:
 * `- ` a list item, `[`/`{` a flow collection, `|`/`>` a block scalar, `&`/`*`
 * an anchor or alias, `!` a tag, `%` a directive, quotes, and the reserved
 * `@` and backtick. */
const VALUE_INDICATORS = new Set([
  "-",
  "?",
  ":",
  ",",
  "[",
  "]",
  "{",
  "}",
  "#",
  "&",
  "*",
  "!",
  "|",
  ">",
  "'",
  '"',
  "%",
  "@",
  "`",
]);

/** A key this scanner accepts: a bare word, no quoting, no flow punctuation,
 * no `?` complex-key marker. Every key in the store matches. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// yaml's default schema is `core`. Its non-string scalar tags are the only way
// a plain scalar stops being a string, so the patterns and the resolution below
// are copied from the library itself (dist/schema/core/int.js, float.js,
// bool.js and dist/schema/common/null.js). A scalar that matches one of them
// resolves to the same value YAML would produce; everything else stays a
// string. The corpus test pins every spelling, including the ones YAML leaves
// as strings (`yes`, `1_000`, `2026-08-11T01:17:02.742Z`).
const YAML_INT = /^[-+]?[0-9]+$/;
const YAML_INT_OCT = /^0o[0-7]+$/;
const YAML_INT_HEX = /^0x[0-9a-fA-F]+$/;
const YAML_FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/;
const YAML_FLOAT_EXP = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/;
const YAML_FLOAT_NAN = /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/;
const YAML_BOOL = /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/;
const YAML_NULL = /^(?:~|[Nn]ull|NULL)?$/;

/** Resolve a plain scalar exactly as yaml's core schema would. */
function resolvePlainScalar(value: string): unknown {
  if (YAML_INT.test(value)) return Number.parseInt(value, 10);
  if (YAML_INT_OCT.test(value)) return Number.parseInt(value.substring(2), 8);
  if (YAML_INT_HEX.test(value)) return Number.parseInt(value.substring(2), 16);
  if (YAML_FLOAT.test(value)) return Number.parseFloat(value);
  if (YAML_FLOAT_EXP.test(value)) return Number.parseFloat(value);
  if (YAML_FLOAT_NAN.test(value)) {
    return value.slice(-3).toLowerCase() === "nan"
      ? Number.NaN
      : value[0] === "-"
        ? Number.NEGATIVE_INFINITY
        : Number.POSITIVE_INFINITY;
  }
  if (YAML_BOOL.test(value)) return value[0] === "t" || value[0] === "T";
  if (YAML_NULL.test(value)) return null;
  return value;
}

/** Number of leading spaces on a line, or null when the line is indented with a
 * tab. YAML forbids a tab as block indentation, so such a line is left to YAML
 * rather than trimmed into something YAML would reject. */
function lineIndent(line: string): number | null {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  if (line[n] === "\t") return null;
  return n;
}

/** Index of the next line holding content, skipping blank and comment lines, or
 * -1 at the end of the block. */
function nextContentLine(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    return i;
  }
  return -1;
}

/** Scan a frontmatter block as flat scalars. Returns null when the block is not
 * something this scanner can reproduce exactly. */
function parseFlatFrontmatter(text: string): Record<string, unknown> | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.endsWith("\r")) {
      // A CR at the end of the block is CONTENT, not a line break: the
      // delimiter scan joins the block with "\n", so a CRLF document leaves
      // that CR attached to the last line and YAML keeps it in the value
      // (`raw` reports `"windows\r"`). Stripping it would be a different
      // value, so a block like that goes to YAML.
      if (i === lines.length - 1) return null;
      line = line.slice(0, -1);
    }
    if (line.includes("\r")) return null;
    // A whitespace-only line holding a tab is not blank to YAML: after an empty
    // value it is a tab-indentation error (which reads as "no frontmatter"),
    // after a scalar it is ignored. Not modelled, so decline the block.
    if (line.includes("\t") && line.trim() === "") return null;
    lines[i] = line;
  }
  const block = parseFlatBlock(lines, 0, 0, 0);
  if (block === null || !block.sawEntry) return null;
  return block.entries;
}

/** Scan one mapping block whose keys all start at `blockIndent`. `depth` counts
 * nesting levels: the root mapping is 0 and `metadata:` may open one nested
 * mapping at depth 1. Anything deeper declines. */
function parseFlatBlock(
  lines: string[],
  start: number,
  blockIndent: number,
  depth: number,
): FlatBlock | null {
  const entries: Record<string, unknown> = {};
  let sawEntry = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    if (trimmed.startsWith("#")) {
      i++;
      continue;
    }
    // `---` / `...` inside the block would start a new document.
    if (trimmed === "---" || trimmed === "...") return null;
    const indent = lineIndent(line);
    if (indent === null) return null;
    if (indent < blockIndent) break;
    // A key that is indented deeper than its block belongs to a nested
    // structure this scanner does not model (a deeper map, a sequence, or a
    // value that wrapped where a key was expected).
    if (indent > blockIndent) return null;
    const colon = line.indexOf(":", indent);
    if (colon < 0) return null;
    const key = line.slice(indent, colon);
    if (!PLAIN_KEY.test(key)) return null;
    if (RESERVED_KEYS.has(key)) return null;
    // YAML's default is unique keys: a duplicate makes the whole block throw,
    // which this module reads as "no frontmatter". Let YAML produce that.
    if (Object.hasOwn(entries, key)) return null;
    const rest = line.slice(colon + 1);
    // `a:b` is a bare scalar key, not `a: b`.
    if (rest !== "" && rest[0] !== " ") return null;
    if (rest.includes("\t")) return null;
    const first = rest.trim();
    sawEntry = true;

    if (first === "") {
      const next = nextContentLine(lines, i + 1);
      if (next < 0) {
        entries[key] = null;
        break;
      }
      const nextIndent = lineIndent(lines[next]);
      if (nextIndent === null) return null;
      if (nextIndent > indent) {
        if (depth !== 0) return null;
        const sub = parseFlatBlock(lines, next, nextIndent, depth + 1);
        if (sub === null) return null;
        entries[key] = sub.entries;
        i = sub.next;
        continue;
      }
      entries[key] = null;
      i++;
      continue;
    }

    if (first[0] === '"' || first[0] === "'") {
      const quote = first[0];
      const close = first.indexOf(quote, 1);
      if (close === first.length - 1) {
        // One-line quoted scalar: no escapes and no inner quote, so the text
        // between the quotes is the value verbatim.
        const inner = first.slice(1, -1);
        if (inner.includes("\\") || inner.includes(quote)) return null;
        entries[key] = inner;
        i++;
        continue;
      }
      if (close !== -1) return null; // closing quote followed by more text
      // A quoted scalar that wraps: YAML folds each line break (plus the
      // following indentation) into a single space.
      if (first.length < 2 || first.includes("\\")) return null;
      const pieces = [first.slice(1)];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const cont = lines[j];
        if (cont.trim() === "") return null; // a blank line folds to "\n"
        const contIndent = lineIndent(cont);
        if (contIndent === null) return null;
        if (contIndent <= indent) return null; // never terminated at this level
        if (cont.trim().startsWith("#")) return null;
        const contText = cont.trim();
        if (contText.includes("\\")) return null;
        if (contText.endsWith(quote)) {
          const body = contText.slice(0, -1);
          if (body === "" || body.includes(quote)) return null;
          pieces.push(body);
          closed = true;
          j++;
          break;
        }
        if (contText.includes(quote)) return null;
        pieces.push(contText);
        j++;
      }
      if (!closed) return null;
      entries[key] = pieces.join(" ");
      i = j;
      continue;
    }

    if (VALUE_INDICATORS.has(first[0])) return null;
    // ` #` starts a comment even after a value, and YAML then ends the scalar
    // there; comment stripping is not modelled here.
    if (first.includes(" #")) return null;
    // A plain scalar cannot contain `: `, and one that ends in `:` is read as a
    // mapping marker (YAML rejects the block).
    if (first.includes(": ") || first.endsWith(":")) return null;
    const pieces = [first];
    let j = i + 1;
    while (j < lines.length) {
      const cont = lines[j];
      if (cont.trim() === "") break; // ends this scalar; YAML may fold a blank
      const contIndent = lineIndent(cont);
      if (contIndent === null) return null;
      if (contIndent <= indent) break;
      const contText = cont.trim();
      if (contText.startsWith("#")) return null; // YAML rejects a comment here
      if (contText.includes(" #")) return null;
      // A continuation that reads as a mapping entry (or an empty key) nests a
      // mapping inside the scalar, which YAML rejects.
      if (contText.includes(": ") || contText.endsWith(":") || contText.startsWith(":")) {
        return null;
      }
      pieces.push(contText);
      j++;
    }
    entries[key] = resolvePlainScalar(pieces.join(" "));
    i = j;
  }
  return { entries, next: i, sawEntry };
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
