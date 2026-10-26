// Tests for the flat-scalar frontmatter fast path.
//
// The fast path exists to keep a full YAML document from being built for every
// topic file during index maintenance (a measured main-thread stall). Its
// contract is exact equivalence with `yaml.parse` for the shapes it accepts,
// and a fallback to `yaml.parse` for everything else. These tests are the
// proof, in three parts:
//
//   1. Equivalence against the YAML parser over EVERY real memory file on this
//      machine (~/.claude/projects/*/memory/*.md, read-only). `parseMemoryContent`
//      is run twice per file: once through the production path (fast path or
//      YAML) and once with `{ yamlOnly: true }`, which is the pre-fast-path
//      code path. The whole ParsedFrontmatter object must be deep-equal.
//   2. Instrumentation: the fast path must actually be taken, otherwise (1)
//      passes while the store still pays the YAML cost.
//   3. Edge cases the store does not necessarily contain, so the fallback
//      boundary is pinned rather than inferred from today's data.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  frontmatterParserStats,
  parseMemoryContent,
  resetFrontmatterParserStats,
} from "../src/frontmatter.js";
import type { ParsedFrontmatter } from "../src/types.js";

// Fixed mtime so both sides format the same ISO fallback.
const MTIME = 1_700_000_000_000;

/** Parse through the production path. */
function parseNew(content: string, filename = "topic.md"): ParsedFrontmatter {
  return parseMemoryContent(content, filename, MTIME);
}

/** Parse through the pre-fast-path path: `yaml.parse` for every block. */
function parseOld(content: string, filename = "topic.md"): ParsedFrontmatter {
  return parseMemoryContent(content, filename, MTIME, { yamlOnly: true });
}

/** Which parser answered for one parse. */
function pathTaken(content: string, filename = "topic.md"): "fast" | "yaml" | "none" {
  resetFrontmatterParserStats();
  parseMemoryContent(content, filename, MTIME);
  const { fastPath, yamlPath } = frontmatterParserStats();
  expect(fastPath + yamlPath).toBeLessThanOrEqual(1);
  if (fastPath === 1) return "fast";
  if (yamlPath === 1) return "yaml";
  return "none"; // no frontmatter block was parsed at all
}

/** Assert the production path and the YAML path agree, and return the result. */
function expectEquivalent(content: string, filename = "topic.md"): ParsedFrontmatter {
  const next = parseNew(content, filename);
  const old = parseOld(content, filename);
  expect(next).toEqual(old);
  return next;
}

// ---------------------------------------------------------------------------
// 1. Equivalence over the live store
// ---------------------------------------------------------------------------

/** The operator's real Claude Code store, resolved without $HOME (the test
 *  setup replaces HOME with a temp dir). userInfo() reads the passwd entry. */
const REAL_STORE_ROOT = join(userInfo().homedir, ".claude", "projects");

function realMemoryFiles(): string[] {
  let projects: string[];
  try {
    projects = readdirSync(REAL_STORE_ROOT);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const project of projects) {
    const dir = join(REAL_STORE_ROOT, project, "memory");
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".md")) files.push(join(dir, name));
    }
  }
  return files;
}

const storeFiles = realMemoryFiles();

describe.skipIf(storeFiles.length === 0)("equivalence over the live memory store", () => {
  it("parses every real memory file identically through both paths", { timeout: 120_000 }, () => {
    const mismatches: string[] = [];
    const counts = { fast: 0, yaml: 0, none: 0 };
    for (const file of storeFiles) {
      const content = readFileSync(file, "utf8");
      const name = basename(file);
      const next = parseMemoryContent(content, name, statSync(file).mtimeMs);
      const old = parseMemoryContent(content, name, statSync(file).mtimeMs, { yamlOnly: true });
      try {
        expect(next).toEqual(old);
      } catch {
        mismatches.push(file);
      }
      resetFrontmatterParserStats();
      parseMemoryContent(content, name, MTIME);
      const stats = frontmatterParserStats();
      if (stats.fastPath === 1) counts.fast++;
      else if (stats.yamlPath === 1) counts.yaml++;
      else counts.none++;
    }
    expect(mismatches).toEqual([]);
    expect(counts.fast + counts.yaml + counts.none).toBe(storeFiles.length);
    // The store must exercise both paths: this test is the evidence that the
    // fast path agrees with YAML on real data, including the files that have
    // to fall back (quoted scalars with escapes, a value containing ": ").
    expect(counts.yaml).toBeGreaterThan(0);
  });

  it("takes the fast path for the overwhelming majority of the store", { timeout: 120_000 }, () => {
    // Guards the equivalence test above: if the fast path silently stopped
    // being taken, both paths would be YAML and the equality would be vacuous.
    resetFrontmatterParserStats();
    let parsed = 0;
    for (const file of storeFiles) {
      const before = frontmatterParserStats();
      parseMemoryContent(readFileSync(file, "utf8"), basename(file), MTIME);
      const after = frontmatterParserStats();
      if (after.fastPath !== before.fastPath || after.yamlPath !== before.yamlPath) parsed++;
    }
    const { fastPath, yamlPath } = frontmatterParserStats();
    expect(parsed).toBeGreaterThan(1000);
    expect(fastPath + yamlPath).toBe(parsed);
    expect(fastPath / parsed).toBeGreaterThanOrEqual(0.9);
  });
});

// ---------------------------------------------------------------------------
// 2. Instrumentation
// ---------------------------------------------------------------------------

describe("which parser answers", () => {
  it("uses the fast path for a flat scalar document", () => {
    const content = "---\nname: a-topic\ndescription: something\ntype: feedback\n---\nbody\n";
    expect(pathTaken(content)).toBe("fast");
    const parsed = expectEquivalent(content);
    expect(parsed.name).toBe("a-topic");
    expect(parsed.description).toBe("something");
    expect(parsed.type).toBe("feedback");
  });

  it("uses the fast path for the gen-2 nested metadata shape", () => {
    const content = [
      "---",
      "name: nested-shape",
      "description: a nested metadata map",
      "metadata:",
      "  node_type: memory",
      "  type: project",
      "  modified: 2026-08-11T01:17:02.742Z",
      "---",
      "body",
    ].join("\n");
    expect(pathTaken(content)).toBe("fast");
    const parsed = expectEquivalent(content);
    expect(parsed.type).toBe("project");
    expect(parsed.modified).toBe("2026-08-11T01:17:02.742Z");
  });

  it("falls back to YAML for a list", () => {
    expect(pathTaken("---\ntags:\n  - a\n  - b\n---\nbody")).toBe("yaml");
  });

  it("falls back to YAML for a nested map two levels deep", () => {
    expect(pathTaken("---\nmetadata:\n  inner:\n    type: feedback\n---\nbody")).toBe("yaml");
  });

  it("falls back to YAML for a block scalar", () => {
    expect(pathTaken("---\ndescription: |\n  two\n  lines\n---\nbody")).toBe("yaml");
  });

  it("falls back to YAML for a flow collection", () => {
    expect(pathTaken("---\ntags: [a, b]\n---\nbody")).toBe("yaml");
  });

  it("falls back to YAML for an anchor", () => {
    expect(pathTaken("---\nname: &x topic\ndescription: *x\n---\nbody")).toBe("yaml");
  });

  it("does not consult a parser at all without frontmatter", () => {
    expect(pathTaken("# Heading\n\nbody")).toBe("none");
    expect(pathTaken("---\nname: unterminated\nbody")).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 3. Edges, compared against YAML every time
// ---------------------------------------------------------------------------

describe("frontmatter edges", () => {
  it("empty frontmatter", () => {
    const content = "---\n---\n# Heading\n\nbody\n";
    const parsed = expectEquivalent(content, "empty-one.md");
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.raw).toEqual({});
    expect(parsed.name).toBe("empty-one");
    // An empty block is a YAML null document, not a mapping: the content is
    // preserved verbatim rather than stripped.
    expect(parsed.body).toBe(content);
  });

  it("no frontmatter", () => {
    const content = "# Config Audit\n\nprose\n";
    const parsed = expectEquivalent(content, "project_config-audit.md");
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.name).toBe("project_config-audit");
    expect(parsed.description).toBe("Config Audit");
    expect(parsed.type).toBe("project");
    expect(parsed.body).toBe(content);
  });

  it("CRLF line endings", () => {
    const content = "---\r\nname: crlf\r\ndescription: windows\r\n---\r\nbody\r\n";
    // The delimiter scan splits on "\n" and rejoins the block with "\n", so the
    // CR before the closing rule survives as the block's last byte and YAML
    // keeps it in the value ("windows\r"). The fast path would have to return
    // that CR as content too; it declines instead, so CRLF documents stay on
    // YAML. Both paths must still agree.
    expect(pathTaken(content)).toBe("yaml");
    const parsed = expectEquivalent(content);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.name).toBe("crlf");
    expect(parsed.description).toBe("windows"); // trimmed by the field extraction
    expect(parsed.raw).toEqual({ name: "crlf", description: "windows\r" });
    expect(parsed.body).toBe("body\r\n");
  });

  it("a value containing a colon", () => {
    // Not followed by a space: still a plain scalar.
    expect(pathTaken("---\nurl: http://example.test/a\n---\nbody")).toBe("fast");
    expect(expectEquivalent("---\nurl: http://example.test/a\n---\nbody").raw).toEqual({
      url: "http://example.test/a",
    });
    // In a quoted scalar a colon-space is content, and the fast path keeps it.
    expect(pathTaken('---\ndescription: "a: b"\n---\nbody')).toBe("fast");
    expect(expectEquivalent('---\ndescription: "a: b"\n---\nbody').description).toBe("a: b");
    // Unquoted `: ` makes YAML reject the whole block; both paths must agree
    // that there is no frontmatter at all.
    const rejected = "---\ndescription: a: b\n---\nbody";
    const parsed = expectEquivalent(rejected);
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe(rejected);
  });

  it("a quoted value", () => {
    const content = "---\nname: \"quoted\"\ndescription: 'single'\n---\nbody";
    expect(pathTaken(content)).toBe("fast");
    const parsed = expectEquivalent(content);
    expect(parsed.name).toBe("quoted");
    expect(parsed.description).toBe("single");
  });

  it("a quoted value that spans lines", () => {
    const content =
      '---\nname: wrapped\ndescription: "Proxmox networking: shared vendor-data,\n  eth0 assumed by tooling"\n---\nbody';
    expect(pathTaken(content)).toBe("fast");
    const parsed = expectEquivalent(content);
    expect(parsed.description).toBe(
      "Proxmox networking: shared vendor-data, eth0 assumed by tooling",
    );
  });

  it("a plain value that spans lines", () => {
    const content =
      "---\nname: wrapped-plain\ndescription: one two\n  three four\n  five\n---\nbody";
    expect(pathTaken(content)).toBe("fast");
    const parsed = expectEquivalent(content);
    expect(parsed.description).toBe("one two three four five");
  });

  it("a blank line inside a spanned value folds to a newline, so it falls back", () => {
    const content = "---\ndescription: one\n\n  two\n---\nbody";
    expect(pathTaken(content)).toBe("yaml");
    expect(expectEquivalent(content).description).toBe("one\ntwo");
  });

  it("a document with a list", () => {
    const content = "---\nname: listed\ntags:\n  - alpha\n  - beta\n---\nbody";
    expect(pathTaken(content)).toBe("yaml");
    const parsed = expectEquivalent(content);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.raw).toEqual({ name: "listed", tags: ["alpha", "beta"] });
  });

  it("a document with a nested map", () => {
    const content = "---\nmetadata:\n  node_type: memory\n  type: user\n---\nbody";
    expect(pathTaken(content)).toBe("fast");
    const parsed = expectEquivalent(content);
    expect(parsed.type).toBe("user");
    expect(parsed.raw).toEqual({ metadata: { node_type: "memory", type: "user" } });
  });

  it("a file whose frontmatter never terminates", () => {
    const content = "---\nname: dangling\ndescription: no closing rule\n";
    const parsed = expectEquivalent(content, "dangling.md");
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.name).toBe("dangling");
    expect(parsed.body).toBe(content);
  });

  it("duplicate keys (YAML rejects the block)", () => {
    const content = "---\nname: one\nname: two\n---\nbody";
    expect(pathTaken(content)).toBe("yaml");
    const parsed = expectEquivalent(content);
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe(content);
  });

  it("an empty value", () => {
    const content = "---\nname:\ndescription: after\n---\nbody";
    expect(pathTaken(content)).toBe("fast");
    const parsed = expectEquivalent(content);
    expect(parsed.name).toBe("topic"); // an empty name is falsy, so the filename wins
    expect(parsed.raw).toEqual({ name: null, description: "after" });
  });

  it("a block scalar keeps its trailing newline on the YAML path only", () => {
    const content = "---\ndescription: >\n  folded\n  block\n---\nbody";
    expect(pathTaken(content)).toBe("yaml");
    // The field extraction trims, so the block scalar's trailing newline is
    // not observable here — only the folded text is.
    expect(expectEquivalent(content).description).toBe("folded block");
  });

  it("a value that ends with a colon (a mapping marker to YAML)", () => {
    const content = "---\nname: dangling:\n---\nbody";
    expect(pathTaken(content)).toBe("yaml");
    expect(expectEquivalent(content).hasFrontmatter).toBe(false);
  });

  it("a continuation line that reads as a mapping entry", () => {
    // YAML rejects a nested mapping inside a plain scalar, both shapes.
    for (const content of [
      "---\ndescription: one\n  two: three\n---\nbody",
      "---\ndescription: one\n  two:\n---\nbody",
    ]) {
      expect(pathTaken(content)).toBe("yaml");
      expect(expectEquivalent(content).hasFrontmatter).toBe(false);
    }
  });

  it("a whitespace line holding a tab", () => {
    // Blank to a naive trim, but YAML reports a tab-indentation error after an
    // empty value, so the block has no frontmatter at all.
    const content = "---\nname: \n\t\n---\nbody";
    expect(pathTaken(content)).toBe("yaml");
    expect(expectEquivalent(content).hasFrontmatter).toBe(false);
  });

  it("a '#' comment after a value", () => {
    const content = "---\nname: commented # trailing\n---\nbody";
    expect(pathTaken(content)).toBe("yaml");
    expect(expectEquivalent(content).name).toBe("commented");
  });
});

describe("scalar resolution matches YAML's core schema", () => {
  // Both the patterns and their resolution are copied from yaml's default
  // (core) schema. If the library changes either, this corpus fails and the
  // fast path must be brought back in line before it is trusted again.
  const scalars = [
    "0",
    "4",
    "-7",
    "+7",
    "007",
    "1_000",
    "2147483648",
    "9007199254740993",
    "1.5",
    "-0.0",
    "+.25",
    "1.",
    "1e3",
    "1E-3",
    ".5e2",
    "0x1f",
    "0o17",
    ".inf",
    "-.inf",
    ".nan",
    ".NaN",
    "true",
    "True",
    "TRUE",
    "false",
    "False",
    "FALSE",
    "tRue",
    "null",
    "Null",
    "NULL",
    "~",
    "nULL",
    "yes",
    "no",
    "on",
    "off",
    "2026-08-11T01:17:02.742Z",
    "2026-08-11",
    "12:30",
    "a#b",
    "a #b",
    "x:y",
    "plain text",
    "it's",
    "0.0.0",
    "v1.2.3",
  ];

  it("resolves every scalar exactly as `yaml.parse` does", () => {
    for (const scalar of scalars) {
      const content = `---\nvalue: ${scalar}\n---\nbody`;
      const next = parseNew(content);
      const old = parseOld(content);
      expect(next.raw, `scalar ${JSON.stringify(scalar)}`).toEqual(old.raw);
    }
  });
});

describe("generated documents agree with YAML", () => {
  // A deterministic generator over the constructs the scanner models and the
  // ones it must refuse. The store proves today's shapes; this covers shapes a
  // store edit could produce tomorrow (mixed indentation, bare continuation
  // text, comments, tabs, wrapped quotes, block scalars, duplicate keys).
  // Anchors and aliases are left out on purpose: `yaml.parse` resolves them to
  // shared objects and cycles, which deep equality then has to walk.
  const KEYS = ["name", "description", "type", "metadata", "a", "b.c", "d_e", "F9", "modified"];
  const ATOMS = [
    "x",
    "x y",
    "4",
    "true",
    "~",
    "null",
    "2026-08-11T01:17:02.742Z",
    "a:b",
    "a#b",
    "http://host/p?a=b",
    "x, y",
    "-x",
    "[x",
    "{x",
    "~x",
    "? x",
    "x:y:z",
    "é",
    "x  ",
  ];
  const INDENTS = ["", "", "", " ", "  ", "  ", "   ", "    ", "      "];

  /** Linear congruential generator, so a failure is reproducible. */
  function makeRandom(seed: number): (max: number) => number {
    let state = seed >>> 0;
    return (max: number) => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state % max;
    };
  }

  function generatedDocs(seed: number, count: number): string[] {
    const rnd = makeRandom(seed);
    const pick = <T>(items: T[]): T => items[rnd(items.length)] as T;
    const indent = () => pick(INDENTS);
    const line = (): string => {
      const roll = rnd(100);
      const pad = indent();
      if (roll < 12) return pad;
      if (roll < 20) return `${pad}# ${pick(ATOMS)}`;
      if (roll < 55) return `${pad}${pick(KEYS)}: ${pick(ATOMS)}`;
      if (roll < 65) return `${pad}${pick(KEYS)}:${pick(["", " ", "  "])}`;
      if (roll < 75) {
        const quote = pick(['"', "'"]);
        return `${pad}${pick(KEYS)}: ${quote}${pick(ATOMS)}${pick(["", quote])}`;
      }
      if (roll < 85) return `${pad}${pick(ATOMS)}`;
      if (roll < 92) {
        return `${pad}${pick(KEYS)}:${pick([" ", ""])}${pick(["|", ">", "[a]", "{a: 1}", "%TAG", "? k"])}`;
      }
      return `${pad}${pick(KEYS)}: ${pick(ATOMS)} # ${pick(ATOMS)}`;
    };
    const docs: string[] = [];
    for (let i = 0; i < count; i++) {
      const lines: string[] = [];
      const n = 1 + rnd(6);
      for (let j = 0; j < n; j++) lines.push(line());
      docs.push(`---\n${lines.join(pick(["\n", "\n", "\n", "\r\n"]))}\n---\nbody\n`);
    }
    return docs;
  }

  it("agrees on 3000 generated documents", () => {
    const mismatches: string[] = [];
    for (const content of generatedDocs(0x5eed1234, 3000)) {
      try {
        expect(parseNew(content)).toEqual(parseOld(content));
      } catch {
        mismatches.push(content);
        if (mismatches.length > 5) break;
      }
    }
    expect(mismatches).toEqual([]);
  });
});
