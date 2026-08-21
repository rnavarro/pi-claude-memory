// Tests for memory-writer: write, remove, read, wikilink resolution.
// Uses a temp dir to avoid touching the real Claude Code memory store.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMemoryContent } from "../src/frontmatter.js";
import { parseIndexContent } from "../src/index-parser.js";
import {
  buildFrontmatterYaml,
  readMemory,
  removeMemory,
  resolveWikilinks,
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
    });
    writeMemory(dir, {
      name: "test-entry",
      description: "Updated description",
      type: "feedback",
      body: "Updated body.",
      pinned: false,
      tier: "project",
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
    });
    const content = readFileSync(join(tmpDir, "round-trip-test.md"), "utf8");
    const parsed = parseMemoryContent(content, "round-trip-test.md", Date.now());
    expect(parsed.name).toBe("round-trip-test");
    expect(parsed.description).toBe("Testing round trip");
    expect(parsed.type).toBe("reference");
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.body).toContain("Some reference content.");
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
    });
    writeMemory(dir, {
      name: "beta",
      description: "Second",
      type: "reference",
      body: "Beta content.",
      pinned: true,
      tier: "project",
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
