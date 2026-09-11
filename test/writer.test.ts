// Tests for memory-writer: write, remove, read, wikilink resolution.
// Uses a temp dir to avoid touching the real Claude Code memory store.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMemoryContent } from "../src/frontmatter.js";
import { parseIndexContent } from "../src/index-parser.js";
import {
  atomicWriteFileNoClobber,
  buildFrontmatterYaml,
  readMemory,
  removeMemory,
  resolveWikilinks,
  withIndexRetry,
  writeMemory,
} from "../src/memory-writer.js";
import type { MemoryDir } from "../src/types.js";

let tmpDir: string;
let dir: MemoryDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcm-test-"));
  dir = {
    tier: "project",
    dir: tmpDir,
    indexPath: join(tmpDir, "MEMORY.md"),
    label: "test-project",
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildFrontmatterYaml", () => {
  it("emits valid gen-2 YAML with nested metadata", () => {
    const yaml = buildFrontmatterYaml(
      { name: "prefer-jq", description: "Use jq for JSON", type: "feedback", pinned: false },
      "2026-08-20T15:00:00.000Z",
    );
    expect(yaml).toContain("---");
    expect(yaml).toContain("name: prefer-jq");
    expect(yaml).toContain("type: feedback");
    expect(yaml).toContain("node_type: memory");
    // Round-trip via parseMemoryContent
    const parsed = parseMemoryContent(`${yaml}\nUse jq.`, "prefer-jq.md", Date.now());
    expect(parsed.name).toBe("prefer-jq");
    expect(parsed.type).toBe("feedback");
  });

  it("includes pinned flag when true", () => {
    const yaml = buildFrontmatterYaml(
      { name: "never-push-master", description: "Don't push", type: "feedback", pinned: true },
      "2026-08-20T15:00:00.000Z",
    );
    expect(yaml).toContain("pinned: true");
  });
});

describe("writeMemory", () => {
  it("writes a new memory file and patches MEMORY.md", () => {
    const result = writeMemory(dir, {
      name: "prefer-jq-for-json",
      description: "Use jq for JSON processing",
      type: "feedback",
      body: "Always use `jq` for parsing JSON in shell scripts.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(tmpDir, "prefer-jq-for-json.md"))).toBe(true);
    expect(existsSync(dir.indexPath)).toBe(true);

    // MEMORY.md should have a link entry
    const idx = readFileSync(dir.indexPath, "utf8");
    expect(idx).toContain("[");
    expect(idx).toContain("prefer-jq-for-json.md");
    expect(idx).toContain("Use jq for JSON processing");
  });

  it("writes pinned entries with the ⛔ marker", () => {
    writeMemory(dir, {
      name: "agents-must-use-worktrees",
      description: "Shared checkout causes stale flash",
      type: "feedback",
      body: "Always use worktrees.",
      pinned: true,
      tier: "project",
      allowOverwrite: true,
    });
    const idx = readFileSync(dir.indexPath, "utf8");
    expect(idx).toContain("⛔");
  });

  it("overwrites an existing file and replaces the MEMORY.md link line", () => {
    writeMemory(dir, {
      name: "test-entry",
      description: "First description",
      type: "feedback",
      body: "First body.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    writeMemory(dir, {
      name: "test-entry",
      description: "Updated description",
      type: "feedback",
      body: "Updated body.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    const idx = readFileSync(dir.indexPath, "utf8");
    // Should have exactly one link line
    const matches = idx.match(/^- \[.*\]\(test-entry\.md\)/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(idx).toContain("Updated description");
  });

  it("preserves hand-authored MEMORY.md sections when appending", () => {
    writeFileSync(dir.indexPath, "# Project Notes\n\n## Feedback\n\nSome prose.\n", "utf8");
    writeMemory(dir, {
      name: "new-entry",
      description: "A new one",
      type: "feedback",
      body: "Body.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    const idx = readFileSync(dir.indexPath, "utf8");
    expect(idx).toContain("# Project Notes");
    expect(idx).toContain("Some prose.");
    expect(idx).toContain("new-entry.md");
  });

  it("rejects empty names", () => {
    const result = writeMemory(dir, {
      name: "!!!",
      description: "bad",
      type: "feedback",
      body: "x",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    expect(result.ok).toBe(false);
  });

  it("emits YAML that round-trips through parseMemoryContent", () => {
    writeMemory(dir, {
      name: "round-trip-test",
      description: "Testing round trip",
      type: "reference",
      body: "Some reference content.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    const content = readFileSync(join(tmpDir, "round-trip-test.md"), "utf8");
    const parsed = parseMemoryContent(content, "round-trip-test.md", Date.now());
    expect(parsed.name).toBe("round-trip-test");
    expect(parsed.description).toBe("Testing round trip");
    expect(parsed.type).toBe("reference");
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.body).toContain("Some reference content.");
  });

  it("persists priority to frontmatter and reads it back", () => {
    writeMemory(dir, {
      name: "prioritized-entry",
      description: "Has explicit priority",
      type: "project",
      body: "Body.",
      pinned: false,
      tier: "project",
      priority: 4,
      allowOverwrite: true,
    });
    const content = readFileSync(join(tmpDir, "prioritized-entry.md"), "utf8");
    expect(content).toContain("priority: 4");
    const parsed = parseMemoryContent(content, "prioritized-entry.md", Date.now());
    expect(parsed.priority).toBe(4);
  });

  it("clears pinned on overwrite from pinned:true to pinned:false", () => {
    // First write: pinned
    writeMemory(dir, {
      name: "pin-toggle",
      description: "Starts pinned",
      type: "feedback",
      body: "Body.",
      pinned: true,
      tier: "project",
      allowOverwrite: true,
    });
    let content = readFileSync(join(tmpDir, "pin-toggle.md"), "utf8");
    expect(content).toContain("pinned: true");

    // Overwrite: clear pinned
    writeMemory(dir, {
      name: "pin-toggle",
      description: "Now unpinned",
      type: "feedback",
      body: "Body.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    content = readFileSync(join(tmpDir, "pin-toggle.md"), "utf8");
    const parsed = parseMemoryContent(content, "pin-toggle.md", Date.now());
    expect(parsed.pinned).toBe(false);
    // metadata block must not carry a pinned key
    expect(content).not.toMatch(/^\s{2}pinned:/m);

    // Index line should also lose the pin marker
    const idx = readFileSync(dir.indexPath, "utf8");
    expect(idx).not.toContain("⛔");
  });

  it("clears priority on overwrite when priority is omitted", () => {
    writeMemory(dir, {
      name: "prio-toggle",
      description: "Has priority",
      type: "project",
      body: "Body.",
      pinned: false,
      tier: "project",
      priority: 5,
      allowOverwrite: true,
    });
    expect(readFileSync(join(tmpDir, "prio-toggle.md"), "utf8")).toContain("priority: 5");

    // Overwrite without priority — should be cleared, not preserved
    writeMemory(dir, {
      name: "prio-toggle",
      description: "No priority now",
      type: "project",
      body: "Body.",
      pinned: false,
      tier: "project",
      priority: null,
      allowOverwrite: true,
    });
    const content = readFileSync(join(tmpDir, "prio-toggle.md"), "utf8");
    const parsed = parseMemoryContent(content, "prio-toggle.md", Date.now());
    expect(parsed.priority).toBeNull();
    expect(content).not.toMatch(/^\s{2}priority:/m);
  });

  it("skips when allowOverwrite=false and file exists (auto-learn collision guard)", () => {
    // First write succeeds
    writeMemory(dir, {
      name: "existing-entry",
      description: "Original",
      type: "feedback",
      body: "Original body.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    const originalContent = readFileSync(join(tmpDir, "existing-entry.md"), "utf8");

    // Second write with allowOverwrite=false should skip
    const result = writeMemory(dir, {
      name: "existing-entry",
      description: "Attempted overwrite",
      type: "feedback",
      body: "New body that should NOT be written.",
      pinned: false,
      tier: "project",
      allowOverwrite: false,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already exists");

    // Original file is untouched
    const afterContent = readFileSync(join(tmpDir, "existing-entry.md"), "utf8");
    expect(afterContent).toBe(originalContent);
    expect(afterContent).toContain("Original body.");
    expect(afterContent).not.toContain("New body");
  });

  it("preserves originSessionId from existing file on overwrite", () => {
    // Simulate a Claude Code-authored file with originSessionId
    const claudeContent =
      "---\n" +
      "name: claude-authored\n" +
      "description: Written by Claude Code\n" +
      "metadata:\n" +
      "  node_type: memory\n" +
      "  type: feedback\n" +
      "  originSessionId: abc-123-def\n" +
      "  modified: 2026-01-01T00:00:00.000Z\n" +
      "---\n\nOriginal Claude body.\n";
    writeFileSync(join(tmpDir, "claude-authored.md"), claudeContent, "utf8");

    // Overwrite via tool (allowOverwrite=true)
    const result = writeMemory(dir, {
      name: "claude-authored",
      description: "Updated by Pi",
      type: "feedback",
      body: "Updated body.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    expect(result.ok).toBe(true);

    // originSessionId should survive
    const content = readFileSync(join(tmpDir, "claude-authored.md"), "utf8");
    expect(content).toContain("originSessionId: abc-123-def");
    expect(content).toContain("Updated body.");
    expect(content).toContain("Updated by Pi");
  });
});

describe("removeMemory", () => {
  it("moves the file to .trash/ and removes the MEMORY.md link", () => {
    writeMemory(dir, {
      name: "to-remove",
      description: "Will be removed",
      type: "feedback",
      body: "Body.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    const result = removeMemory(dir, { name: "to-remove", tier: "project" });
    expect(result.ok).toBe(true);
    expect(existsSync(join(tmpDir, "to-remove.md"))).toBe(false);
    expect(existsSync(join(tmpDir, ".trash"))).toBe(true);
    const idx = readFileSync(dir.indexPath, "utf8");
    expect(idx).not.toContain("to-remove.md");
  });

  it("fails gracefully for unknown names", () => {
    const result = removeMemory(dir, { name: "nonexistent", tier: "project" });
    expect(result.ok).toBe(false);
  });

  it("refuses to remove the index file (MEMORY.md)", () => {
    writeFileSync(dir.indexPath, "# Index\n\n- [x](x.md) — s\n", "utf8");
    const result = removeMemory(dir, { name: "MEMORY.md", tier: "project" });
    expect(result.ok).toBe(false);
    expect(existsSync(dir.indexPath)).toBe(true);
  });

  it("refuses traversal names that would escape the memory dir", () => {
    // Nested layout: mem dir is nested-root/mem, victim is nested-root/victim.md
    // (a real escape would reach it via ../victim).
    const nestedRoot = join(tmpDir, "nested-root");
    const memDir = join(nestedRoot, "mem");
    mkdirSync(memDir, { recursive: true });
    const nestedDir: MemoryDir = {
      tier: "project",
      dir: memDir,
      indexPath: join(memDir, "MEMORY.md"),
      label: "test",
    };
    const victim = join(nestedRoot, "victim.md");
    writeFileSync(victim, "secret", "utf8");

    const result = removeMemory(nestedDir, { name: "../victim", tier: "project" });
    expect(result.ok).toBe(false);
    expect(existsSync(victim)).toBe(true); // untouched
    expect(readFileSync(victim, "utf8")).toBe("secret");
  });
});

describe("readMemory", () => {
  it("reads a file by slug name", () => {
    writeMemory(dir, {
      name: "findable",
      description: "Can be found",
      type: "feedback",
      body: "Content here.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    const result = readMemory(dir, "findable");
    if (!result.ok) throw new Error("expected ok");
    expect(result.content).toContain("findable");
    expect(result.content).toContain("Content here.");
  });

  it("fails for unknown names", () => {
    const result = readMemory(dir, "nonexistent");
    expect(result.ok).toBe(false);
  });

  it("refuses traversal names that would read outside the memory dir", () => {
    const nestedRoot = join(tmpDir, "nested-root");
    const memDir = join(nestedRoot, "mem");
    mkdirSync(memDir, { recursive: true });
    const nestedDir: MemoryDir = {
      tier: "project",
      dir: memDir,
      indexPath: join(memDir, "MEMORY.md"),
      label: "test",
    };
    const victim = join(nestedRoot, "secret.md");
    writeFileSync(victim, "secret content", "utf8");

    const result = readMemory(nestedDir, "../secret");
    expect(result.ok).toBe(false);
  });
});

describe("resolveWikilinks", () => {
  it("resolves [[wikilinks]] to files that exist", () => {
    writeMemory(dir, {
      name: "target",
      description: "link target",
      type: "reference",
      body: "Target content.",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    const body = "See [[target]] for details.";
    const { text, resolved, unresolved } = resolveWikilinks(body, dir);
    expect(resolved).toEqual(["target.md"]);
    expect(unresolved).toEqual([]);
    expect(text).toContain("[target](target.md)");
  });

  it("leaves [[wikilinks]] unresolved when the file doesn't exist", () => {
    const body = "See [[missing-link]] for details.";
    const { text, resolved, unresolved } = resolveWikilinks(body, dir);
    expect(unresolved).toEqual(["missing-link"]);
    expect(resolved).toEqual([]);
    expect(text).toContain("missing-link");
  });

  it("handles [[name|display]] piped wikilinks", () => {
    writeMemory(dir, {
      name: "piped-target",
      description: "piped target",
      type: "reference",
      body: "x",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    const body = "See [[piped-target|the target]] for more.";
    const { text, resolved } = resolveWikilinks(body, dir);
    expect(resolved).toEqual(["piped-target.md"]);
    expect(text).toContain("[the target](piped-target.md)");
  });
});

describe("end-to-end: write then read then parse index", () => {
  it("full cycle produces consistent files and index", () => {
    // Write two memories
    writeMemory(dir, {
      name: "alpha",
      description: "First",
      type: "feedback",
      body: "Alpha content. See [[beta]].",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    writeMemory(dir, {
      name: "beta",
      description: "Second",
      type: "reference",
      body: "Beta content.",
      pinned: true,
      tier: "project",
      allowOverwrite: true,
    });

    // Read alpha and check wikilink resolution
    const read = readMemory(dir, "alpha");
    if (!read.ok) throw new Error("expected ok");
    expect(read.content).toContain("[beta](beta.md)");

    // Parse the MEMORY.md index
    const idxContent = readFileSync(dir.indexPath, "utf8");
    const parsed = parseIndexContent(idxContent, tmpDir);
    expect(parsed.entries).toHaveLength(2);
    const betaEntry = parsed.entries.find((e) => e.href === "beta.md");
    expect(betaEntry?.pinned).toBe(true);
  });
});

describe("mutation guards", () => {
  it("writeMemory rejects the reserved slug 'memory'", () => {
    const result = writeMemory(dir, {
      name: "memory",
      description: "trying to shadow the index",
      type: "reference",
      body: "nope",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Reserved memory name");
    // Nothing was written at all
    expect(existsSync(join(dir.dir, "memory.md"))).toBe(false);
    // Case variant is also rejected via the case-insensitive slug check
    const upper = writeMemory(dir, {
      name: "Memory",
      description: "case variant",
      type: "reference",
      body: "nope",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    expect(upper.ok).toBe(false);
  });

  it("read/remove refuse nested-path names even when lexically inside the dir", () => {
    writeFileSync(join(dir.dir, "outer.md"), "---\ndescription: d\ntype: reference\n---\nbody\n");
    mkdirSync(join(dir.dir, "sub"), { recursive: true });
    writeFileSync(
      join(dir.dir, "sub", "nested.md"),
      "---\ndescription: d\ntype: reference\n---\nbody\n",
    );

    const removed = removeMemory(dir, { name: "sub/nested.md", tier: "project" });
    expect(removed.ok).toBe(false);
    expect(existsSync(join(dir.dir, "sub", "nested.md"))).toBe(true);

    // A nested binary lookalike ("..") is neutralized by slugify but must
    // never resolve via the raw fallback either.
    const traversal = removeMemory(dir, { name: "../outer.md", tier: "project" });
    expect(traversal.ok).toBe(false);
    expect(existsSync(join(dir.dir, "outer.md"))).toBe(true);
  });

  it("read/remove refuse a symlinked topic pointing outside the store", () => {
    // Target OUTSIDE the memory dir
    const outsideDir = mkdtempSync(join(tmpdir(), "pcm-outside-"));
    const outside = join(outsideDir, "victim.md");
    writeFileSync(outside, "---\ndescription: outside\ntype: reference\n---\nsecret\n");

    // Symlink placed INSIDE the store pointing at it
    const linkPath = join(dir.dir, "innocent.md");
    symlinkSync(outside, linkPath);

    const read = readMemory(dir, "innocent.md");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.message).toContain("not found");

    const removed = removeMemory(dir, { name: "innocent.md", tier: "project" });
    expect(removed.ok).toBe(false);
    // The outside victim was not touched, and the link still exists
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(linkPath)).toBe(true);

    rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("index concurrency primitives", () => {
  it("atomicWriteFileNoClobber refuses to destroy a concurrently created file", () => {
    const target = join(dir.dir, "race.md");
    // First publication wins
    expect(atomicWriteFileNoClobber(target, "first\n")).toBe(true);
    // A competing writer created the target in the meantime — must NOT clobber
    expect(atomicWriteFileNoClobber(target, "second\n")).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("first\n");
    // No temp litter left behind
    const leftovers = readdirSync(dir.dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("withIndexRetry merges concurrent index edits instead of losing them", () => {
    const indexPath = join(dir.dir, "MEMORY.md");
    writeFileSync(indexPath, "BASE\n");
    let competitorLanded = false;

    withIndexRetry(indexPath, (content) => {
      if (!competitorLanded) {
        // Simulate a competing writer landing between our read and re-read
        competitorLanded = true;
        writeFileSync(indexPath, `${content}COMPETITOR\n`);
      }
      return `${content}MINE\n`;
    });

    const final = readFileSync(indexPath, "utf8");
    expect(final).toContain("COMPETITOR");
    expect(final).toContain("MINE");
  });

  it("withIndexRetry treats a null return as nothing-to-do and writes no file", () => {
    const missing = join(dir.dir, "does-not-exist.md");
    withIndexRetry(missing, () => "should never be written\n");
    expect(existsSync(missing)).toBe(false);

    const existing = join(dir.dir, "noop.md");
    writeFileSync(existing, "unchanged\n");
    withIndexRetry(existing, (content) => (content === "changed" ? "x" : null));
    expect(readFileSync(existing, "utf8")).toBe("unchanged\n");
  });
});

describe("name policy and index lines", () => {
  it("never slugifies a traversal name into a different topic (extensionless)", () => {
    writeFileSync(join(dir.dir, "outer.md"), "---\ndescription: d\ntype: reference\n---\nbody\n");
    // slugify("../outer") === "outer" — the old candidate order would remove
    // outer.md through a name the caller never legitimately addressed.
    const r = removeMemory(dir, { name: "../outer", tier: "project" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir.dir, "outer.md"))).toBe(true);
  });

  it("rejects separator-bearing names instead of aliasing a slugged topic", () => {
    writeFileSync(
      join(dir.dir, "subnested.md"),
      "---\ndescription: d\ntype: reference\n---\nbody\n",
    );
    // slugify("sub/nested") === "subnested" — must not reach it.
    const r = removeMemory(dir, { name: "sub/nested", tier: "project" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir.dir, "subnested.md"))).toBe(true);
  });

  it("prefers the explicit filename over the slug-appended candidate", () => {
    writeFileSync(
      join(dir.dir, "alpha.md"),
      "---\ndescription: plain\ntype: reference\n---\nalpha plain\n",
    );
    writeFileSync(
      join(dir.dir, "alpha.md.md"),
      "---\ndescription: doubled\ntype: reference\n---\nalpha doubled\n",
    );
    const read = readMemory(dir, "alpha.md");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.content).toContain("alpha plain");
  });

  it("writeMemory rejects unsafe names and empty or multiline descriptions", () => {
    const base = {
      description: "valid",
      type: "reference" as const,
      body: "b",
      pinned: false,
      tier: "project" as const,
      allowOverwrite: true,
    };
    expect(writeMemory(dir, { ...base, name: "../evil" }).ok).toBe(false);
    expect(writeMemory(dir, { ...base, name: "ok-name", description: "" }).ok).toBe(false);
    expect(writeMemory(dir, { ...base, name: "ok-name", description: "   " }).ok).toBe(false);
    expect(writeMemory(dir, { ...base, name: "ok-name", description: "a\nb" }).ok).toBe(false);
    // Sanity: the valid form still writes
    expect(writeMemory(dir, { ...base, name: "ok-name" }).ok).toBe(true);
  });

  it("replaces and removes dash-less hand-authored index lines", () => {
    // A pre-existing topic whose index line lacks the — summary tail.
    writeFileSync(
      join(dir.dir, "foo.md"),
      "---\ndescription: old\ntype: reference\n---\nold body\n",
    );
    writeFileSync(dir.indexPath, "- [Foo](foo.md)\n");

    // Overwrite via writeMemory: the dash-less line is REPLACED, not duplicated
    const w = writeMemory(dir, {
      name: "foo",
      description: "new summary",
      type: "reference",
      body: "new body",
      pinned: false,
      tier: "project",
      allowOverwrite: true,
    });
    expect(w.ok).toBe(true);
    const idx = readFileSync(dir.indexPath, "utf8");
    expect((idx.match(/\(foo\.md\)/g) ?? []).length).toBe(1);
    expect(idx).toContain("new summary");

    // Removal strips the line entirely — no orphan link to a trashed file
    const r = removeMemory(dir, { name: "foo", tier: "project" });
    expect(r.ok).toBe(true);
    expect(readFileSync(dir.indexPath, "utf8")).not.toContain("foo.md");
  });
});

describe("index-line integrity", () => {
  it("derives the title from the slug so bracket-bearing names stay matchable", () => {
    // "a]b" slugifies to "ab"; using the RAW name as the title emitted
    // "- [A]b](ab.md) — ...", which no index regex can match.
    const res = writeMemory(dir, {
      name: "a]b",
      description: "bracketed",
      type: "project",
      tier: "project",
      body: "body",
      pinned: false,
      allowOverwrite: true,
    });
    expect(res.ok).toBe(true);
    const index = readFileSync(join(dir.dir, "MEMORY.md"), "utf8");
    expect(index).toContain("- [Ab](ab.md) — bracketed");
    expect(index).not.toContain("A]b");

    // And the line must be rewritable (not duplicated) on a second write.
    writeMemory(dir, {
      name: "a]b",
      description: "updated",
      type: "project",
      tier: "project",
      body: "body2",
      pinned: false,
      allowOverwrite: true,
    });
    const after = readFileSync(join(dir.dir, "MEMORY.md"), "utf8");
    expect(after.match(/\(ab\.md\)/g)).toHaveLength(1);
    expect(after).toContain("updated");
  });

  it("does not add a leading blank line to an empty index", () => {
    writeFileSync(join(dir.dir, "MEMORY.md"), "");
    writeMemory(dir, {
      name: "first entry",
      description: "first",
      type: "project",
      tier: "project",
      body: "body",
      pinned: false,
      allowOverwrite: false,
    });
    const index = readFileSync(join(dir.dir, "MEMORY.md"), "utf8");
    expect(index.startsWith("- [First Entry](first-entry.md)")).toBe(true);
    expect(index.startsWith("\n")).toBe(false);
  });

  it("reports index-update failure without losing the topic file", () => {
    // Force patchIndexAppend to throw by making MEMORY.md a directory.
    mkdirSync(join(dir.dir, "MEMORY.md"));
    const res = writeMemory(dir, {
      name: "orphan",
      description: "orphan",
      type: "project",
      tier: "project",
      body: "orphan body",
      pinned: false,
      allowOverwrite: false,
    });
    // The write itself succeeded and the caller is told the index lagged.
    expect(res.ok).toBe(true);
    expect(res.message).toContain("index update failed");
    // Topic file is on disk despite the failed index patch.
    expect(existsSync(join(dir.dir, "orphan.md"))).toBe(true);
  });
});

describe("index re-apply guard", () => {
  // The re-apply path sits in the rename->verify gap and cannot be reached
  // deterministically from outside the module (ESM namespaces are not
  // mockable, so readFileSync cannot be intercepted mid-window). What IS
  // testable is the guard's effect through the real callers:
  //
  //   - patchIndexAppend passes () => existsSync(topic), so a topic that a
  //     concurrent remove just trashed is never re-linked;
  //   - withIndexRetry still works when no guard is supplied (it is exported).
  //
  // The mechanism itself (unconditional re-apply resurrects a removed line)
  // was confirmed by probe: applying the append closure to content that
  // lacks the line re-adds it. See the round-5 findings.
  it("keeps a removed entry removed through the real removeMemory path", () => {
    writeMemory(dir, {
      name: "removable",
      description: "d",
      type: "project",
      tier: "project",
      body: "body",
      pinned: false,
      allowOverwrite: false,
    });
    expect(readFileSync(join(dir.dir, "MEMORY.md"), "utf8")).toContain("(removable.md)");
    const removed = removeMemory(dir, { name: "removable", tier: "project" });
    expect(removed.ok).toBe(true);
    const after = readFileSync(join(dir.dir, "MEMORY.md"), "utf8");
    expect(after).not.toContain("(removable.md)");
    // The topic is in .trash/, and no index line points at the dead path.
    expect(existsSync(join(dir.dir, "removable.md"))).toBe(false);
  });

  it("still writes correctly when withIndexRetry is called without a guard", () => {
    const root = mkdtempSync(join(tmpdir(), "pcm-noguard-"));
    const idx = join(root, "MEMORY.md");
    writeFileSync(idx, "# Memories\n");
    withIndexRetry(idx, (content) =>
      content.includes("(t.md)") ? content : `${content}- [T](t.md) \u2014 s\n`,
    );
    expect(readFileSync(idx, "utf8")).toContain("(t.md)");
    rmSync(root, { recursive: true, force: true });
  });
});
