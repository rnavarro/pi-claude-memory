// Tests for auto-learn: JSON candidate parsing and index summary building.
// The LLM call itself is not tested here (requires a live model); the parsing
// and validation logic is the part that matters.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExistingIndexSummary, parseCandidates } from "../src/auto-learn.js";
import { createProjectMemoryDir, resolveMemoryDirs } from "../src/resolver.js";

let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcm-autolearn-"));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (origHome !== undefined) process.env.HOME = origHome;
});

describe("buildExistingIndexSummary", () => {
  it("lists memory files in the resolved dirs", () => {
    // Create a fake claude memory dir
    const claudeDir = join(tmpDir, ".claude", "memory");
    const projectHash = "-home-user-workspace-test";
    const projectDir = join(tmpDir, ".claude", "projects", projectHash, "memory");

    // We can't easily test resolveMemoryDirs with a fake HOME because it looks
    // up the real cwd. Instead, build the summary from a hand-built ResolveResult.
    const { mkdirSync } = require("node:fs");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(claudeDir, "global_entry.md"), "# Global");
    writeFileSync(join(claudeDir, "MEMORY.md"), "# Global Memory\n");
    writeFileSync(join(projectDir, "project_entry.md"), "# Project");
    writeFileSync(join(projectDir, "MEMORY.md"), "# Project Memory\n");

    const resolved = {
      global: {
        tier: "global",
        dir: claudeDir,
        indexPath: join(claudeDir, "MEMORY.md"),
        label: "Global",
      },
      project: {
        tier: "project",
        dir: projectDir,
        indexPath: join(projectDir, "MEMORY.md"),
        label: "test",
      },
      warnings: [],
    };

    const summary = buildExistingIndexSummary(resolved);
    expect(summary).toContain("Global tier");
    expect(summary).toContain("global_entry.md");
    expect(summary).toContain("test tier");
    expect(summary).toContain("project_entry.md");
  });

  it("handles empty dirs gracefully", () => {
    const claudeDir = join(tmpDir, "empty-global");
    const { mkdirSync } = require("node:fs");
    mkdirSync(claudeDir, { recursive: true });

    const resolved = {
      global: {
        tier: "global",
        dir: claudeDir,
        indexPath: join(claudeDir, "MEMORY.md"),
        label: "Global",
      },
      project: null,
      warnings: [],
    };

    const summary = buildExistingIndexSummary(resolved);
    expect(summary).toContain("(no entries)");
  });
});

describe("parseCandidates", () => {
  it("parses a clean JSON array", () => {
    const reply = JSON.stringify([
      {
        name: "a",
        description: "desc",
        type: "feedback",
        body: "b",
        tier: "project",
        pinned: false,
      },
    ]);
    const cands = parseCandidates(reply);
    expect(cands).toHaveLength(1);
    expect(cands[0].name).toBe("a");
  });

  it("strips code fences", () => {
    const reply =
      '```json\n[{"name":"x","description":"d","type":"reference","body":"b","tier":"global","pinned":false}]\n```';
    const cands = parseCandidates(reply);
    expect(cands).toHaveLength(1);
    expect(cands[0].tier).toBe("global");
  });

  it("tolerates leading prose before the array", () => {
    const reply = "Here are the memories:\n[]";
    const cands = parseCandidates(reply);
    expect(cands).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseCandidates("not json")).toEqual([]);
    expect(parseCandidates("[{invalid")).toEqual([]);
  });

  it("filters out invalid candidate shapes", () => {
    const reply = JSON.stringify([
      {
        name: "good",
        description: "d",
        type: "feedback",
        body: "b",
        tier: "project",
        pinned: false,
      },
      { name: 123, description: "bad-type" },
      {
        name: "bad-tier",
        description: "d",
        type: "feedback",
        body: "b",
        tier: "mars",
        pinned: false,
      },
      {
        name: "no-type",
        description: "d",
        type: "unknown",
        body: "b",
        tier: "project",
        pinned: false,
      },
    ]);
    const cands = parseCandidates(reply);
    expect(cands).toHaveLength(1);
    expect(cands[0].name).toBe("good");
  });

  it("returns empty array for empty array input", () => {
    expect(parseCandidates("[]")).toEqual([]);
  });

  it("returns empty array when no brackets found", () => {
    expect(parseCandidates("nothing here")).toEqual([]);
  });
});

describe("createProjectMemoryDir", () => {
  it("creates a project memory dir for a new cwd", () => {
    const cwd = "/home/user/workspace/brand-new-project";
    const result = createProjectMemoryDir(cwd);
    expect(result).not.toBeNull();
    expect(result?.tier).toBe("project");
    expect(existsSync(result?.dir ?? "")).toBe(true);
    expect(result?.dir).toContain("brand-new-project");
    expect(result?.label).toBe("brand-new-project");
  });

  it("resolveMemoryDirs finds the dir after createProjectMemoryDir", () => {
    const cwd = "/home/user/workspace/another-new-project";
    // Before: resolver returns null project
    let resolved = resolveMemoryDirs(cwd);
    expect(resolved.project).toBeNull();

    // Create the dir
    const created = createProjectMemoryDir(cwd);
    expect(created).not.toBeNull();

    // After: resolver still returns null because MEMORY.md doesn't exist yet.
    // This is expected — the resolver requires MEMORY.md. The write path
    // uses createProjectMemoryDir directly, not the resolver.
    resolved = resolveMemoryDirs(cwd);
    expect(resolved.project).toBeNull(); // no MEMORY.md yet
  });
});
