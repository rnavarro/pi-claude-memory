// Tests for memory-writer: write, remove, read, wikilink resolution.
// Uses a temp dir to avoid touching the real Claude Code memory store.

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as debugLogModule from "../src/debug-log.js";
import { parseMemoryContent } from "../src/frontmatter.js";
import { parseIndexContent } from "../src/index-parser.js";
import { buildMemoryInjection } from "../src/injector.js";
import {
  atomicWriteFile,
  atomicWriteFileNoClobber,
  buildFrontmatterYaml,
  createTempFile,
  IndexPublishConflictError,
  readMemory,
  removeMemory,
  resolveWikilinks,
  resolveWriteTarget,
  verifyIndexPublish,
  withIndexRetry,
  writeMemory,
} from "../src/memory-writer.js";
import type { MemoryDir } from "../src/types.js";
import { INDEX_MAX_BYTES } from "../src/types.js";

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
      allowOverwrite: true,
    });
    writeMemory(dir, {
      name: "test-entry",
      description: "Updated description",
      type: "feedback",
      body: "Updated body.",
      pinned: false,
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
      allowOverwrite: true,
    });
    const result = removeMemory(dir, { name: "to-remove" });
    expect(result.ok).toBe(true);
    expect(existsSync(join(tmpDir, "to-remove.md"))).toBe(false);
    expect(existsSync(join(tmpDir, ".trash"))).toBe(true);
    const idx = readFileSync(dir.indexPath, "utf8");
    expect(idx).not.toContain("to-remove.md");
  });

  it("fails gracefully for unknown names", () => {
    const result = removeMemory(dir, { name: "nonexistent" });
    expect(result.ok).toBe(false);
  });

  it("refuses to remove the index file (MEMORY.md)", () => {
    writeFileSync(dir.indexPath, "# Index\n\n- [x](x.md) — s\n", "utf8");
    const result = removeMemory(dir, { name: "MEMORY.md" });
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

    const result = removeMemory(nestedDir, { name: "../victim" });
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
      allowOverwrite: true,
    });
    writeMemory(dir, {
      name: "beta",
      description: "Second",
      type: "reference",
      body: "Beta content.",
      pinned: true,
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

    const removed = removeMemory(dir, { name: "sub/nested.md" });
    expect(removed.ok).toBe(false);
    expect(existsSync(join(dir.dir, "sub", "nested.md"))).toBe(true);

    // A nested binary lookalike ("..") is neutralized by slugify but must
    // never resolve via the raw fallback either.
    const traversal = removeMemory(dir, { name: "../outer.md" });
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

    const removed = removeMemory(dir, { name: "innocent.md" });
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

  it("warns when a write pushes MEMORY.md past the injected excerpt limit", () => {
    // Writes APPEND, so an index past the cutoff means the entry just written
    // sits below the cut and is never injected: the failure this warning makes
    // visible. It is the write-side half of the bounded-index contract, since
    // the reader can only report the truncation, not prevent it.
    const indexPath = join(dir.dir, "MEMORY.md");
    const filler = Array.from({ length: 205 }, (_, i) => `- [F${i}](f${i}.md) — f`).join("\n");
    writeFileSync(indexPath, `${filler}\n`);
    const result = writeMemory(dir, {
      name: "past-the-cut",
      description: "d",
      type: "reference",
      body: "body",
      pinned: false,
      allowOverwrite: false,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("past the injected excerpt limit");
  });

  it("does not warn while the index still fits the excerpt", () => {
    writeFileSync(join(dir.dir, "MEMORY.md"), "# M\n- [One](one.md) — o\n");
    const result = writeMemory(dir, {
      name: "fits",
      description: "d",
      type: "reference",
      body: "body",
      pinned: false,
      allowOverwrite: false,
    });
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("excerpt limit");
  });

  it("withIndexRetry yields instead of overwriting a writer that keeps winning", () => {
    const indexPath = join(dir.dir, "MEMORY.md");
    writeFileSync(indexPath, "BASE\n");
    let competitorWrites = 0;

    // A competitor landing on EVERY attempt is the case the retry loop cannot
    // win. The old behaviour published our content anyway on the final
    // attempt, silently replacing their rows and reporting success.
    expect(() =>
      withIndexRetry(indexPath, (content) => {
        competitorWrites += 1;
        writeFileSync(indexPath, `${content}COMPETITOR${competitorWrites}\n`);
        return `${content}MINE\n`;
      }),
    ).toThrow(IndexPublishConflictError);

    const final = readFileSync(indexPath, "utf8");
    expect(final).toContain("COMPETITOR3");
    expect(final).not.toContain("MINE");
    expect(competitorWrites).toBe(3);
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
    const r = removeMemory(dir, { name: "../outer" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir.dir, "outer.md"))).toBe(true);
  });

  it("rejects separator-bearing names instead of aliasing a slugged topic", () => {
    writeFileSync(
      join(dir.dir, "subnested.md"),
      "---\ndescription: d\ntype: reference\n---\nbody\n",
    );
    // slugify("sub/nested") === "subnested" — must not reach it.
    const r = removeMemory(dir, { name: "sub/nested" });
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
      allowOverwrite: true,
    });
    expect(w.ok).toBe(true);
    const idx = readFileSync(dir.indexPath, "utf8");
    expect((idx.match(/\(foo\.md\)/g) ?? []).length).toBe(1);
    expect(idx).toContain("new summary");

    // Removal strips the line entirely — no orphan link to a trashed file
    const r = removeMemory(dir, { name: "foo" });
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

describe("index resurrection guards", () => {
  // The cross-process race cannot be interleaved from single-threaded test
  // code: nothing runs between atomicWriteFile() and the next readFileSync().
  // So these tests drive the two reachable seams directly —
  // verifyIndexPublish (the post-publish path) and a stateful fn (the retry
  // path) — with a real filesystem and no mocking.
  const appendTopic = (name: string) => (content: string) =>
    content.includes(`(${name}.md)`) ? content : `${content}- [Topic](${name}.md) \u2014 d\n`;

  describe("verifyIndexPublish (post-publish re-apply)", () => {
    it("re-applies on the concurrent writer's content when the guard passes", () => {
      const root = mkdtempSync(join(tmpdir(), "pcm-vip-"));
      const idx = join(root, "MEMORY.md");
      writeFileSync(join(root, "topic.md"), "x");
      // Simulate: we published `next`, then a clobbering writer (not a remover)
      // replaced the index before our verify read.
      const next = "# M\n- [Topic](topic.md) \u2014 d\n";
      writeFileSync(idx, "# M\n- [Other](other.md) \u2014 o\n");
      let guardCalls = 0;
      verifyIndexPublish(idx, next, appendTopic("topic"), () => {
        guardCalls++;
        return true;
      });
      const final = readFileSync(idx, "utf8");
      // Their line survives AND ours was merged back in.
      expect(final).toContain("(other.md)");
      expect(final).toContain("(topic.md)");
      expect(guardCalls).toBe(1);
      rmSync(root, { recursive: true, force: true });
    });

    it("vetoes the re-apply when the guard reports the topic is gone", () => {
      const root = mkdtempSync(join(tmpdir(), "pcm-vip2-"));
      const idx = join(root, "MEMORY.md");
      // A concurrent remove_memory trashed the topic and stripped our line.
      const next = "# M\n- [Topic](topic.md) \u2014 d\n";
      writeFileSync(idx, "# M\n- [Other](other.md) \u2014 o\n");
      verifyIndexPublish(idx, next, appendTopic("topic"), () => false);
      const final = readFileSync(idx, "utf8");
      expect(final).toContain("(other.md)");
      // The trashed topic is NOT resurrected.
      expect(final).not.toContain("(topic.md)");
      rmSync(root, { recursive: true, force: true });
    });

    it("does not consult the guard when our publish landed cleanly", () => {
      const root = mkdtempSync(join(tmpdir(), "pcm-vip3-"));
      const idx = join(root, "MEMORY.md");
      const next = "# M\n- [Topic](topic.md) \u2014 d\n";
      writeFileSync(idx, next);
      let guardCalls = 0;
      verifyIndexPublish(idx, next, appendTopic("topic"), () => {
        guardCalls++;
        return false;
      });
      expect(readFileSync(idx, "utf8")).toBe(next);
      expect(guardCalls).toBe(0);
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("retry path (the wider window)", () => {
    it("vetoes publication when the topic vanished between retries", () => {
      // The retry `continue` re-runs fn on the concurrent writer's content,
      // and an append closure re-adds a missing line — with no post-write
      // verify involved. Here fn's own side effect forces the retry (so
      // after !== before) and removes the topic, exactly as a concurrent
      // remove_memory would (it trashes the file BEFORE stripping the line).
      const root = mkdtempSync(join(tmpdir(), "pcm-retry-"));
      const idx = join(root, "MEMORY.md");
      const topic = join(root, "topic.md");
      writeFileSync(topic, "x");
      writeFileSync(idx, "# M\n- [Other](other.md) \u2014 o\n");
      let calls = 0;
      withIndexRetry(
        idx,
        (content) => {
          calls++;
          if (calls === 1) {
            // Force the contention check to fail -> retry.
            writeFileSync(idx, "# M\n- [A](a.md) \u2014 a\n");
          }
          if (calls === 2) {
            // The remover lands: index rewritten, topic trashed.
            writeFileSync(idx, "# M\n- [B](b.md) \u2014 b\n");
            rmSync(topic);
          }
          return `${content}- [Topic](topic.md) \u2014 d\n`;
        },
        () => existsSync(topic),
      );
      const final = readFileSync(idx, "utf8");
      // The trashed topic was never linked.
      expect(final).not.toContain("(topic.md)");
      // Prove the branch was actually reached: fn ran more than once (the
      // retry fired), so a passing test cannot be a vacuous one.
      expect(calls).toBeGreaterThan(1);
      rmSync(root, { recursive: true, force: true });
    });

    it("still appends normally when the topic exists", () => {
      const root = mkdtempSync(join(tmpdir(), "pcm-retry-ok-"));
      const idx = join(root, "MEMORY.md");
      const topic = join(root, "ok.md");
      writeFileSync(topic, "x");
      writeFileSync(idx, "# M\n");
      withIndexRetry(idx, appendTopic("ok"), () => existsSync(topic));
      expect(readFileSync(idx, "utf8")).toContain("(ok.md)");
      rmSync(root, { recursive: true, force: true });
    });
  });
});

describe("trash recoverability", () => {
  it("keeps BOTH versions when the same topic is removed twice in one millisecond", () => {
    // The old naming was `filename.${Date.now()}.bak`, which collides within a
    // millisecond and is then silently overwritten by renameSync — destroying
    // the first backup despite the recoverable-never-deletes promise.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      writeMemory(dir, {
        name: "versioned",
        description: "v1",
        type: "project",
        body: "first version",
        pinned: false,
        allowOverwrite: false,
      });
      removeMemory(dir, { name: "versioned" });

      writeMemory(dir, {
        name: "versioned",
        description: "v2",
        type: "project",
        body: "second version",
        pinned: false,
        allowOverwrite: false,
      });
      removeMemory(dir, { name: "versioned" });

      // Two distinct backups, both intact.
      const trashDir = join(dir.dir, ".trash");
      const entries = readdirSync(trashDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      expect(entries.length).toBe(2);
      const bodies = entries
        .map((e) => readFileSync(join(trashDir, e.name, "versioned.md"), "utf8"))
        .join("\n");
      expect(bodies).toContain("first version");
      expect(bodies).toContain("second version");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to move a file through a symlinked .trash", () => {
    writeMemory(dir, {
      name: "through-link",
      description: "d",
      type: "project",
      body: "body",
      pinned: false,
      allowOverwrite: false,
    });
    const outside = mkdtempSync(join(tmpdir(), "pcm-trash-out-"));
    // .trash as a symlink to an outside directory.
    symlinkSync(outside, join(dir.dir, ".trash"));
    const res = removeMemory(dir, { name: "through-link" });
    expect(res.ok).toBe(false);
    // The topic is untouched and nothing landed outside the store.
    expect(existsSync(join(dir.dir, "through-link.md"))).toBe(true);
    expect(readdirSync(outside).length).toBe(0);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("atomicWriteFile temp cleanup", () => {
  it("leaves no .tmp behind when the publish fails", () => {
    // Make the rename fail by making the target a non-empty directory.
    const target = join(dir.dir, "noisy.md");
    mkdirSync(target);
    writeFileSync(join(target, "blocker"), "x");
    expect(() => atomicWriteFile(target, "content")).toThrow();
    const leftovers = readdirSync(dir.dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("index lines matched by resolved target, not href spelling", () => {
  // An index line may reach a topic through an absolute href — a shape the
  // parser supports and Claude Code writes (two exist in a real project index
  // on this machine). Replace/remove used to match only the literal
  // `(filename.md)` spelling, so those lines were neither replaced (a duplicate
  // was appended) nor removed (the link survived while the tool reported
  // success). Both are deterministic single-process bugs — no race needed.
  const absoluteHref = (name: string) =>
    `- [${name}](${join(tmpDir, `${name}.md`)}) — from Claude Code`;
  const write = (name: string) =>
    writeMemory(dir, {
      name,
      description: `desc ${name}`,
      type: "project",
      body: `body ${name}`,
      pinned: false,
      allowOverwrite: true,
    });

  it("replaces a line written with an absolute href instead of duplicating it", () => {
    writeFileSync(join(tmpDir, "alpha.md"), "---\ntype: project\n---\nold\n");
    writeFileSync(join(tmpDir, "MEMORY.md"), `${absoluteHref("alpha")}\n- [Other](other.md) — o\n`);
    write("alpha");
    const index = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    const alphaLines = index.split("\n").filter((l) => l.includes("alpha.md"));
    expect(alphaLines).toHaveLength(1); // not two
    expect(index).toContain("(other.md)"); // unrelated prose preserved
  });

  it("removes a line written with an absolute href and reports it as removed", () => {
    writeFileSync(join(tmpDir, "beta.md"), "---\ntype: project\n---\nold\n");
    writeFileSync(join(tmpDir, "MEMORY.md"), `${absoluteHref("beta")}\n- [Other](other.md) — o\n`);
    const result = removeMemory(dir, { name: "beta" });
    expect(result.ok).toBe(true);
    const index = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    // The link does NOT survive pointing at a file that is now in .trash/
    expect(index).not.toContain("beta.md");
    expect(index).toContain("(other.md)");
    expect(result.message).not.toContain("no matching");
  });

  it("matches ./ and dir/../ spellings of the same target", () => {
    writeFileSync(join(tmpDir, "gamma.md"), "---\ntype: project\n---\nold\n");
    writeFileSync(join(tmpDir, "MEMORY.md"), `- [G](./gamma.md) — dot slash\n`);
    write("gamma");
    const index = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(index.split("\n").filter((l) => l.includes("gamma.md"))).toHaveLength(1);

    writeFileSync(join(tmpDir, "MEMORY.md"), `- [G](sub/../gamma.md) — traversal\n`);
    const res = removeMemory(dir, { name: "gamma" });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(tmpDir, "MEMORY.md"), "utf8")).not.toContain("gamma.md");
  });

  it("still removes only the addressed topic", () => {
    writeFileSync(join(tmpDir, "delta.md"), "---\ntype: project\n---\nold\n");
    writeFileSync(join(tmpDir, "epsilon.md"), "---\ntype: project\n---\nold\n");
    writeFileSync(join(tmpDir, "MEMORY.md"), `- [D](delta.md) — d\n- [E](epsilon.md) — e\n`);
    removeMemory(dir, { name: "delta" });
    const index = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(index).not.toContain("delta.md");
    expect(index).toContain("(epsilon.md)");
  });

  it("reports honestly when no line matched", () => {
    writeFileSync(join(tmpDir, "orphan.md"), "---\ntype: project\n---\nold\n");
    writeFileSync(join(tmpDir, "MEMORY.md"), `- [Other](other.md) — o\n`);
    const res = removeMemory(dir, { name: "orphan" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("no matching MEMORY.md line");
  });
});

describe("dash-less index lines are parsed, not discarded as prose", () => {
  // The parser required `— summary`, so "- [Critical rule](rule.md)" fell
  // through as raw prose: its body was never loaded, its pin was ignored, and
  // it got no ⟨index-only⟩ marker — while the writer's regexes treated the same
  // line as an index line. One grammar now covers both.
  it("parses a link line with no summary as an entry", () => {
    const parsed = parseIndexContent("- ⛔ [Critical rule](rule.md)\n", tmpDir);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].title).toBe("Critical rule");
    expect(parsed.entries[0].summary).toBe("");
    expect(parsed.entries[0].pinned).toBe(true); // pin marker honored
  });

  it("parses an absolute href with no summary", () => {
    const parsed = parseIndexContent(`- [Abs](${join(tmpDir, "abs.md")})\n`, tmpDir);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].filePath).toBe(join(tmpDir, "abs.md"));
  });

  it("still treats non-link prose as prose", () => {
    const parsed = parseIndexContent("## Header\n- [A](a.md) trailing text\n", tmpDir);
    expect(parsed.entries).toHaveLength(0);
  });
});

describe("non-slug-normal stems are addressable and supersedable", () => {
  // A topic whose stem is not slug-normal ("Foo Bar.md", or uppercase) has a
  // slug that differs from its stem, so the slug-derived path does not exist.
  // Supersession of such a topic silently no-opped: the snapshot lookup hit
  // via the raw-stem alias, then the stat of the slug path threw ENOENT and
  // the candidate was skipped as "deleted". writeMemory also wrote the slug
  // path, which would have created a duplicate rather than superseding.
  const seed = (stem: string) =>
    writeFileSync(join(tmpDir, stem), "---\ntype: project\ndescription: original\n---\nold body\n");

  it("resolveWriteTarget targets the existing file, not the slug path", () => {
    seed("Foo Bar.md");
    expect(resolveWriteTarget(dir, "Foo Bar")).toBe("Foo Bar.md");
    // The slug resolves too, so a model returning either form works.
    expect(resolveWriteTarget(dir, "foo-bar")).toBe("Foo Bar.md");
  });

  it("falls back to the slug path when nothing exists", () => {
    expect(resolveWriteTarget(dir, "Brand New")).toBe("brand-new.md");
  });

  it("overwrite supersedes the existing stem in place, with no duplicate file", () => {
    seed("Foo Bar.md");
    const res = writeMemory(dir, {
      name: "Foo Bar",
      description: "updated",
      type: "project",
      body: "new body",
      pinned: false,
      allowOverwrite: true,
    });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(tmpDir, "Foo Bar.md"), "utf8")).toContain("new body");
    // The whole point: one file, not a slug-named twin beside it.
    expect(existsSync(join(tmpDir, "foo-bar.md"))).toBe(false);
  });

  it("a plain write refuses rather than duplicating an existing stem", () => {
    seed("Foo Bar.md");
    const res = writeMemory(dir, {
      name: "Foo Bar",
      description: "x",
      type: "project",
      body: "b",
      pinned: false,
      allowOverwrite: false,
    });
    expect(res.ok).toBe(false);
    expect(existsSync(join(tmpDir, "foo-bar.md"))).toBe(false);
  });

  it("read and remove address a non-slug-normal stem by its slug", () => {
    seed("Foo Bar.md");
    const read = readMemory(dir, "foo-bar");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.content).toContain("old body");

    const rem = removeMemory(dir, { name: "foo-bar" });
    expect(rem.ok).toBe(true);
    expect(existsSync(join(tmpDir, "Foo Bar.md"))).toBe(false);
  });

  it("ambiguous slug matches resolve to nothing rather than an arbitrary file", () => {
    seed("Foo Bar.md");
    writeFileSync(join(tmpDir, "foo bar.md"), "---\ntype: project\n---\nx\n");
    // Both slugify to "foo-bar"; picking either would be a guess.
    expect(resolveWriteTarget(dir, "foo-bar")).toBe("foo-bar.md");
    const read = readMemory(dir, "foo-bar");
    expect(read.ok).toBe(false);
  });
});

describe("writer index reads are guarded like the parser's", () => {
  // withIndexRetry read MEMORY.md with a bare readFileSync. A symlinked index
  // pulled an unrelated file's bytes into the store, and the publish then
  // replaced the LINK with a regular file containing them — laundering outside
  // content past the read-side guards and into every future prompt. A dangling
  // symlink made existsSync false, so every write silently reported success
  // while indexing nothing.
  const write = (name: string) =>
    writeMemory(dir, {
      name,
      description: `desc ${name}`,
      type: "project",
      body: `body ${name}`,
      pinned: false,
      allowOverwrite: false,
    });

  it("does not launder an outside file's bytes through a symlinked index", () => {
    const outside = join(tmpDir, "..", `outside-${process.pid}-${Date.now()}.txt`);
    writeFileSync(outside, "SECRET_SENTINEL\n");
    symlinkSync(outside, join(tmpDir, "MEMORY.md"));

    const res = write("alpha");

    // The write is reported as unindexed rather than as success.
    expect(res.ok).toBe(true);
    expect(res.message).toContain("index update failed");
    // The outside file was neither read into the store nor overwritten.
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("SECRET_SENTINEL\n");
    // MEMORY.md is still the symlink — we refused rather than replaced it.
    expect(lstatSync(join(tmpDir, "MEMORY.md")).isSymbolicLink()).toBe(true);
    rmSync(outside, { force: true });
  });

  it("reports failure for a dangling symlinked index instead of silent success", () => {
    symlinkSync(join(tmpDir, "nonexistent-target.md"), join(tmpDir, "MEMORY.md"));
    const res = write("beta");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("index update failed");
    // The link was not silently replaced by a regular index file.
    expect(lstatSync(join(tmpDir, "MEMORY.md")).isSymbolicLink()).toBe(true);
  });

  it("refuses an oversize index rather than appending past the parse cap", () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), `# big\n${"x".repeat(1_000_001)}\n`);
    const res = write("gamma");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("index update failed");
    expect(res.message).toContain("cap");
  });

  it("does not lift a symlinked topic's metadata into the new memory", () => {
    const outside = join(tmpDir, "..", `meta-${process.pid}-${Date.now()}.md`);
    writeFileSync(
      outside,
      "---\nname: outside\ndescription: outside desc\ntype: reference\nmetadata:\n  originSessionId: LEAKED_SENTINEL\n---\noutside body\n",
    );
    symlinkSync(outside, join(tmpDir, "leak.md"));
    writeFileSync(join(tmpDir, "MEMORY.md"), "# M\n");

    const res = writeMemory(dir, {
      name: "leak",
      description: "ours",
      type: "project",
      body: "our body",
      pinned: false,
      allowOverwrite: true,
    });
    expect(res.ok).toBe(true);
    const written = readFileSync(join(tmpDir, "leak.md"), "utf8");
    expect(written).toContain("our body");
    expect(written).not.toContain("LEAKED_SENTINEL");
    rmSync(outside, { force: true });
  });

  it("still updates a normal index and preserves provenance metadata", () => {
    // The guard must not break the ordinary path it protects.
    writeFileSync(
      join(tmpDir, "delta.md"),
      "---\nname: delta\ndescription: d\ntype: project\nmetadata:\n  originSessionId: KEEP_ME\n---\nold\n",
    );
    writeFileSync(join(tmpDir, "MEMORY.md"), "# M\n");
    const res = writeMemory(dir, {
      name: "delta",
      description: "updated",
      type: "project",
      body: "new body",
      pinned: false,
      allowOverwrite: true,
    });
    expect(res.ok).toBe(true);
    expect(res.message).not.toContain("index update failed");
    const written = readFileSync(join(tmpDir, "delta.md"), "utf8");
    expect(written).toContain("new body");
    expect(written).toContain("KEEP_ME"); // provenance survives
    expect(readFileSync(join(tmpDir, "MEMORY.md"), "utf8")).toContain("(delta.md)");
  });
});

describe("write-time size validation", () => {
  // The read paths cap topics at TOPIC_FILE_MAX_BYTES, but publication had no
  // corresponding check: a larger body reported success, got an index line, and
  // was then unreadable through recall_memory and silently dropped from
  // injection. An over-long description could push MEMORY.md past the parser's
  // cap instead, which makes parseIndexFile return null and hides EVERY entry
  // in that tier.
  const write = (name: string, body: string, description = `desc ${name}`) =>
    writeMemory(dir, {
      name,
      description,
      type: "project",
      body,
      pinned: false,
      allowOverwrite: false,
    });

  it("refuses a body the read paths would reject", () => {
    const res = write("huge", "x".repeat(1_000_001));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("too large to write");
    // Nothing half-written, and no index line for a body nobody can read.
    expect(existsSync(join(tmpDir, "huge.md"))).toBe(false);
  });

  it("accepts a body just under the cap", () => {
    const res = write("oksize", "y".repeat(999_000));
    expect(res.ok).toBe(true);
    const read = readMemory(dir, "oksize");
    expect(read.ok).toBe(true);
  });

  it("refuses an index update that would cross the parser's cap", () => {
    // Index sits just below INDEX_MAX_BYTES; a long description pushes the
    // line past it, which would make the whole tier unparseable.
    const line = "- [Filler](filler.md) — f\n";
    const lineBytes = Buffer.byteLength(line, "utf8");
    // Sit just under the cap, sized in BYTES (the em-dash is 3 bytes).
    const filler = `# M\n${line.repeat(Math.floor(950_000 / lineBytes))}`;
    writeFileSync(join(tmpDir, "MEMORY.md"), filler);
    const before = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(Buffer.byteLength(before, "utf8")).toBeLessThan(1_000_000);

    // The topic itself stays under the topic cap, so only the INDEX crosses.
    const res = write("bigdesc", "body", "d".repeat(80_000));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("index update failed");
    expect(res.message).toContain("cap");
    // The existing index is untouched rather than truncated or corrupted.
    expect(readFileSync(join(tmpDir, "MEMORY.md"), "utf8")).toBe(before);
  });
});

describe("entry identity for underscore-named entries", () => {
  const writeJq = (over = {}) =>
    writeMemory(dir, {
      name: "feedback_prefer_jq",
      description: "new desc",
      type: "feedback",
      body: "new body",
      pinned: false,
      allowOverwrite: true,
      ...over,
    });

  it("derives a readable title from the stem instead of mangling it", () => {
    // Real corpus stems look like this (feedback_prefer_jq.md, user_location.md).
    // The old title split was on hyphens only, so an underscore stem stayed one
    // unsplit word and the line read `[Feedback_prefer_jq]`. (An earlier version
    // of this comment claimed slugify() STRIPS underscores and produced
    // "Feedbackpreferjq". It does not: slugify's character class is
    // [^a-z0-9._-], which keeps '_'. The assertion below used to test for the
    // title that never existed, so it passed against the broken code too.)
    writeFileSync(
      join(tmpDir, "feedback_prefer_jq.md"),
      "---\ndescription: old\ntype: feedback\n---\nold\n",
    );
    writeFileSync(
      join(tmpDir, "MEMORY.md"),
      "# M\n- [feedback_prefer_jq.md](feedback_prefer_jq.md) — old\n",
    );
    const res = writeJq();
    expect(res.ok).toBe(true);
    const idx = readFileSync(dir.indexPath, "utf8");
    // What the hyphen-only split actually produced — this assertion has teeth.
    expect(idx).not.toContain("Feedback_prefer_jq");
    expect(idx).toContain("[Feedback Prefer Jq](feedback_prefer_jq.md)");
  });

  it("resolves the exact stem, and the documented suffix form does not work", () => {
    // Locks the recall_memory docstring: it used to advertise
    // 'never-push-master' for feedback_never_push_master.md, which the matcher
    // can never resolve (the stem's slug keeps no separator, so the suffix
    // form slugifies differently). The description now names the full stem.
    writeFileSync(
      join(tmpDir, "feedback_never_push_master.md"),
      "---\ndescription: np\ntype: feedback\n---\nnp\n",
    );
    expect(readMemory(dir, "feedback_never_push_master").ok).toBe(true);
    expect(readMemory(dir, "never-push-master").ok).toBe(false);
  });

  it("does not promise that an unrelated later write repairs the index", () => {
    // The failure note said the topic "will not be injected until the next
    // successful write to this store". patchIndexAppend only ever touches the
    // entry being written, so an unrelated write does nothing for this one.
    const outside = join(tmpDir, "outside.md");
    writeFileSync(outside, "untouched\n");
    // A symlinked index is refused by the writer's own guard.
    symlinkSync(outside, join(tmpDir, "MEMORY.md"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = writeJq();
      expect(res.ok).toBe(true);
      expect(res.message).toContain("index update failed");
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("next successful write to this store");
      expect(logged).toContain("until this entry is written again");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("temporary files cannot be hijacked", () => {
  it("does not follow a planted symlink at the predictable temp path", () => {
    // The temp name is predictable (PID + timestamp), and writeFileSync(tmpPath)
    // FOLLOWS a symlink at that path. The old code truncated whatever it pointed
    // at, then renamed the symlink itself into place as the topic — modifying a
    // file outside the store, reporting success, and leaving an entry that
    // recall and containment both reject. Exclusive creation ("wx") refuses the
    // existing path outright and picks a fresh name.
    const outside = join(tmpDir, "outside-sentinel.md");
    writeFileSync(outside, "IMPORTANT ORIGINAL\n");

    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    try {
      const planted = join(tmpDir, `.topic.md.${process.pid}.1700000000000.0.tmp`);
      symlinkSync(outside, planted);

      atomicWriteFile(join(tmpDir, "topic.md"), "NEW CONTENT\n");

      // The outside file is untouched...
      expect(readFileSync(outside, "utf8")).toBe("IMPORTANT ORIGINAL\n");
      // ...and the published topic is a real file carrying our bytes, not a
      // symlink to somewhere else.
      expect(lstatSync(join(tmpDir, "topic.md")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(tmpDir, "topic.md"), "utf8")).toBe("NEW CONTENT\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("createTempFile never returns a path it did not create", () => {
    const outside = join(tmpDir, "outside2.md");
    writeFileSync(outside, "KEEP\n");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_001));
    try {
      const planted = join(tmpDir, `.t.md.${process.pid}.1700000000001.0.tmp`);
      symlinkSync(outside, planted);
      const created = createTempFile(tmpDir, join(tmpDir, "t.md"), "body\n");
      expect(created).not.toBe(planted);
      // It created a regular file, and the planted link still points elsewhere.
      expect(lstatSync(created).isSymbolicLink()).toBe(false);
      expect(readFileSync(outside, "utf8")).toBe("KEEP\n");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the index correction path is guarded like the main path", () => {
  it("refuses to re-apply a merge that would cross the index size cap", () => {
    // Two individually-valid versions can merge past the cap here. Above the
    // cap parseIndexFile returns null, which hides EVERY entry in the tier.
    // Sized in BYTES and close to the cap (the em-dash is 3 bytes), so the
    // append below genuinely crosses it.
    const line = "- [F](f.md) — s\n";
    const lineBytes = Buffer.byteLength(line, "utf8");
    const filler = `# M\n${line.repeat(Math.floor(980_000 / lineBytes))}`;
    writeFileSync(dir.indexPath, filler);
    const before = readFileSync(dir.indexPath, "utf8");
    expect(Buffer.byteLength(before)).toBeLessThan(INDEX_MAX_BYTES);
    expect(Buffer.byteLength(before)).toBeGreaterThan(900_000);

    // Simulate a concurrent writer's content that is NOT ours (so the
    // correction path runs) and an append that pushes past the cap.
    writeFileSync(dir.indexPath, `${before}- [Other](o.md) — o\n`);
    const landed = readFileSync(dir.indexPath, "utf8");
    // The refusal must REACH THE CALLER. Returning quietly reported a clean
    // write for a topic that has no index line and will never be injected.
    expect(() =>
      verifyIndexPublish(
        dir.indexPath,
        "SOMETHING ELSE",
        (content) => `${content}${"x".repeat(40_000)}\n`,
      ),
    ).toThrow(/exceed/);

    const after = readFileSync(dir.indexPath, "utf8");
    expect(landed.length).toBeGreaterThan(0);
    expect(after).toBe(landed); // nothing re-published
    expect(Buffer.byteLength(after)).toBeLessThanOrEqual(INDEX_MAX_BYTES);
  });

  it("does not read through a symlinked index on the correction path", () => {
    const outside = join(tmpDir, "outside-index.md");
    writeFileSync(outside, `# OUTSIDE\n${"- [X](x.md) — x\n".repeat(5)}`);
    symlinkSync(outside, dir.indexPath);
    const before = readFileSync(outside, "utf8");

    // assertIndexReadable now sits OUTSIDE the read's catch, so a recognised
    // unsafe index is reported to the caller instead of being swallowed as
    // "index vanished".
    expect(() =>
      verifyIndexPublish(dir.indexPath, "DIFFERENT", (content) => `${content}INJECTED\n`),
    ).toThrow(/not a regular file/);

    // The symlink is still a symlink and its target was never rewritten.
    expect(lstatSync(dir.indexPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe(before);
  });
});

describe("a FIFO in the store never blocks prompt construction", () => {
  it("is never opened at all", () => {
    // A FIFO named *.md and linked from the index used to hang prompt
    // construction: openSync(path, "r") on a FIFO BLOCKS until a writer
    // appears, so the regular-file check behind it never ran. The loader fixed
    // that with O_NONBLOCK; the bounded-index contract then removed the read
    // entirely, so no topic is opened at injection time and the hang is
    // structurally impossible rather than merely guarded.
    //
    // The FIFO is kept as a guard against reintroducing a body read, not as a
    // test of non-regular rejection: that check now lives on the recall path
    // (resolveTopicFile lstats and refuses a non-regular topic before its
    // read). A writer is held open so this test cannot hang even if a body read
    // returns.
    const d = join(tmpDir, "fifo-store");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "MEMORY.md"), "# F\n- [Blocked](blocked.md) — b\n");
    execFileSync("mkfifo", [join(d, "blocked.md")]);
    // Hold the FIFO open O_RDWR|O_NONBLOCK: O_RDWR counts as BOTH a reader and
    // a writer, so it never blocks (O_WRONLY|O_NONBLOCK would fail ENXIO with no
    // reader) and it means a plain blocking read-open would also return. That
    // keeps this test non-hanging either way.
    const wfd = openSync(join(d, "blocked.md"), constants.O_RDWR | constants.O_NONBLOCK);
    try {
      const res = buildMemoryInjection({
        tier: "project",
        dir: d,
        indexPath: join(d, "MEMORY.md"),
        label: "fifo",
      });
      // Completing is the assertion. The index line is injected verbatim, so
      // "Blocked" appears from the INDEX, not from reading the FIFO.
      expect(res.text).toContain("Blocked");
    } finally {
      closeSync(wfd);
    }
  });
});

describe("an ambiguous name is recorded, not reported as absent", () => {
  it("names the colliding candidates in the debug log", () => {
    // Two stems that slugify alike are unaddressable by any name. Refusing to
    // guess is correct, but the caller only ever saw "Memory not found: ...",
    // which is wrong and impossible to diagnose from the message.
    const { withDebugLogContext } = debugLogModule;
    writeFileSync(join(tmpDir, "Foo Bar.md"), "---\ndescription: a\ntype: reference\n---\na\n");
    writeFileSync(join(tmpDir, "FOO  BAR.md"), "---\ndescription: b\ntype: reference\n---\nb\n");
    const sid = `ambig-${process.pid}`;
    const res = withDebugLogContext({ enabled: true, cwd: tmpDir, sessionId: sid }, () =>
      readMemory(dir, "foo bar"),
    );
    expect(res.ok).toBe(false);
    const logPath = join(
      process.env.HOME ?? tmpDir,
      ".pi",
      "agent",
      "pi-claude-memory",
      "debug",
      `${sid}.ndjson`,
    );
    const logged = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    expect(logged).toContain("topic_ambiguous");
    expect(logged).toContain("Foo Bar.md");
  });
});

describe("an exact name resolves to the exact file", () => {
  it("prefers the caller's exact stem over a slug-alike when both exist", () => {
    // Two different topics whose stems differ only by the characters slugify
    // folds. Slug-first made `readMemory(dir, "Foo Bar")` read foo-bar.md, so an
    // exact, on-disk name resolved to a DIFFERENT topic — and an overwrite or a
    // removal landed on the wrong file.
    writeFileSync(
      join(tmpDir, "Foo Bar.md"),
      "---\ndescription: spaced\ntype: reference\n---\nSPACED\n",
    );
    writeFileSync(
      join(tmpDir, "foo-bar.md"),
      "---\ndescription: slugged\ntype: reference\n---\nSLUGGED\n",
    );

    const spaced = readMemory(dir, "Foo Bar");
    const slugged = readMemory(dir, "foo-bar");
    if (!spaced.ok || !slugged.ok) throw new Error("expected both names to resolve");
    expect(spaced.content).toContain("SPACED");
    expect(slugged.content).toContain("SLUGGED");

    // The destructive path follows the same identity: the exact file goes and
    // the slug-alike survives.
    const res = removeMemory(dir, { name: "Foo Bar" });
    expect(res.ok).toBe(true);
    expect(existsSync(join(tmpDir, "Foo Bar.md"))).toBe(false);
    expect(existsSync(join(tmpDir, "foo-bar.md"))).toBe(true);
  });
});

describe("write-path fidelity", () => {
  it("does not read an oversize existing topic just to preserve provenance", () => {
    // The new-content cap runs AFTER the preserve-read, so it cannot bound it.
    // A very large existing topic was loaded and parsed synchronously in full
    // before the replacement was written. Recall and injection already refuse a
    // file this size, so the model can never see it anyway: skip preservation
    // and replace it.
    const huge =
      "---\n" +
      "name: huge-topic\n" +
      "description: Written by Claude Code\n" +
      "metadata:\n" +
      "  node_type: memory\n" +
      "  type: feedback\n" +
      "  originSessionId: SHOULD-NOT-SURVIVE\n" +
      "---\n\n" +
      "x".repeat(1_200_000);
    writeFileSync(join(tmpDir, "huge-topic.md"), huge, "utf8");

    const res = writeMemory(dir, {
      name: "huge-topic",
      description: "replaced",
      type: "feedback",
      body: "small now",
      pinned: false,
      allowOverwrite: true,
    });

    expect(res.ok).toBe(true);
    const content = readFileSync(join(tmpDir, "huge-topic.md"), "utf8");
    expect(content).toContain("small now");
    // Preservation was skipped, so the oversize file's provenance did not ride
    // along — and the 1.2 MB was never read to find it.
    expect(content).not.toContain("SHOULD-NOT-SURVIVE");
  });

  it("emits a parseable index line for a stem containing a bracket", () => {
    // A legal on-disk name may contain ']'. The title is interpolated inside
    // [..], so an unsanitised stem produced `- [A]b](a]b.md) — ...`, which no
    // index regex matches. The line becomes prose: its body is never injected,
    // it can never be replaced (each write appends another malformed duplicate)
    // and never removed.
    writeFileSync(join(tmpDir, "a]b.md"), "---\ndescription: b\ntype: reference\n---\nBODY\n");
    writeFileSync(join(tmpDir, "MEMORY.md"), "# M\n");

    const res = writeMemory(dir, {
      name: "a]b",
      description: "bracketed stem",
      type: "reference",
      body: "BODY2",
      pinned: false,
      allowOverwrite: true,
    });
    expect(res.ok).toBe(true);

    const parsed = parseIndexContent(readFileSync(join(tmpDir, "MEMORY.md"), "utf8"), tmpDir);
    const links = parsed.lines.filter((l) => "href" in l) as Array<{ href: string }>;
    expect(links.length).toBe(1);
    expect(links[0].href).toBe("a]b.md");
  });

  it("throws when the corrective index re-apply would exceed the cap", () => {
    // A DETECTED divergence we could not repair. Returning normally reported a
    // clean write for a topic that has no index line and will never be injected.
    const root = mkdtempSync(join(tmpdir(), "pcm-vip-cap-"));
    const idx = join(root, "MEMORY.md");
    // Their content already sits at the cap, so merging our line must overflow.
    writeFileSync(idx, "y".repeat(INDEX_MAX_BYTES - 10));
    expect(() =>
      verifyIndexPublish(idx, "OUR-PUBLISH\n", (content) => `${content}${"z".repeat(100)}\n`),
    ).toThrow(/exceed/);
    rmSync(root, { recursive: true, force: true });
  });

  it("throws when a symlink replaced the index after publication", () => {
    // assertIndexReadable is now outside the read's catch: a RECOGNISED unsafe
    // index is a detected problem, not the concurrent-removal race that is
    // allowed to pass quietly.
    const root = mkdtempSync(join(tmpdir(), "pcm-vip-sym-"));
    const outside = join(root, "outside.md");
    const idx = join(root, "MEMORY.md");
    writeFileSync(outside, "# OUTSIDE\n");
    symlinkSync(outside, idx);
    expect(() => verifyIndexPublish(idx, "OUR-PUBLISH\n", (c) => c)).toThrow(/not a regular file/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("index overflow demotion (opt-in)", () => {
  const link = (n: number) => `- [E${n}](e${n}.md) — s${n}`;
  /** Seed the index past the 200-line startup bound. */
  const seedOverflow = (count: number) => {
    const lines = Array.from({ length: count }, (_, i) => link(i + 1));
    writeFileSync(dir.indexPath, `${lines.join("\n")}\n`);
    return lines;
  };
  const indexLines = () => readFileSync(dir.indexPath, "utf8").split("\n");
  const entry = {
    name: "new-one",
    description: "a freshly learned fact",
    type: "reference" as const,
    body: "body\n",
    pinned: false,
    allowOverwrite: true,
  };

  it("leaves the index alone when the option is off", () => {
    const seeded = seedOverflow(205);
    writeMemory(dir, entry);

    const after = indexLines();
    expect(after).not.toContain("## Archive");
    for (const line of seeded) expect(after).toContain(line);
    // Appended at the end, which is where the excerpt cut falls.
    expect(after.at(-2)).toContain("new-one");
  });

  it("archives the oldest entries and keeps the new one inside the cut", () => {
    const seeded = seedOverflow(205);
    const result = writeMemory(dir, entry, { demoteIndexOverflow: true });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Archived");
    const after = indexLines();
    const marker = after.indexOf("## Archive");
    expect(marker).toBeGreaterThan(-1);

    // The new entry is ABOVE the heading, so the next session can see it. This
    // is the whole point: an append would land below the cut.
    const live = after.slice(0, marker);
    expect(live.some((l) => l.includes("new-one"))).toBe(true);
    expect(live.length).toBeLessThanOrEqual(200);
    expect(after.slice(marker)).toContain(seeded[0]);
    // Nothing was destroyed: every seeded line is still in the file.
    for (const line of seeded) expect(after).toContain(line);
  });
});
