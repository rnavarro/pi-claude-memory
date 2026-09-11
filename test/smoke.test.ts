// Quick smoke test against the real Claude Code memory corpus
// Run: node --import tsx test/smoke.test.ts

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMemoryContent } from "../src/frontmatter.js";
import { parseIndexContent } from "../src/index-parser.js";
import { buildMemoryInjection } from "../src/injector.js";
import { encodePath, resolveMemoryDirs } from "../src/resolver.js";
import type { MemoryDir as MemoryDirType } from "../src/types.js";

const APP_CWD = "/home/user/workspace/my-app";
const OTHER_CWD = "/home/user/workspace/other-project";
const UNKNOWN_CWD = "/home/user/workspace/nonexistent-project";

// The resolver and injector describes run against the real Claude Code
// memory corpus on this machine. They are skipped when that corpus is
// absent (e.g. CI / a fresh clone) so the suite stays portable; the pure
// frontmatter and index-parser describes always run.
const REAL_CORPUS = existsSync(APP_CWD) && existsSync(join(homedir(), ".claude/memory"));

describe.skipIf(!REAL_CORPUS)("resolver", () => {
  it("encodes paths the way Claude Code does", () => {
    expect(encodePath(APP_CWD)).toBe("-home-user-workspace-my-app");
    expect(encodePath("/home/user/workspace/foo-bar")).toBe(
      "-home-user-workspace-foo-bar",
    );
  });

  it("resolves my-app project memory", () => {
    const result = resolveMemoryDirs(APP_CWD);
    expect(result.project).not.toBeNull();
    expect(result.project?.tier).toBe("project");
    expect(result.project?.dir).toContain("my-app");
    expect(result.project && existsSync(result.project.indexPath)).toBe(true);
  });

  it("resolves other-project (root-level MEMORY.md anomaly)", () => {
    const result = resolveMemoryDirs(OTHER_CWD);
    expect(result.project).not.toBeNull();
    expect(result.project && existsSync(result.project.indexPath)).toBe(true);
  });

  it("resolves global memory", () => {
    const result = resolveMemoryDirs(APP_CWD);
    expect(result.global).not.toBeNull();
    expect(result.global?.dir).toContain(".claude/memory");
  });

  it("returns null project for unknown cwd", () => {
    const result = resolveMemoryDirs(UNKNOWN_CWD);
    expect(result.project).toBeNull();
  });
});

describe("frontmatter", () => {
  it("parses gen 1 (flat top-level type)", () => {
    const content = `---
name: Prefer jq for JSON
description: Use jq for JSON processing
type: feedback
---

Use \`jq\` for JSON parsing.`;
    const parsed = parseMemoryContent(content, "feedback_prefer_jq.md", Date.now());
    expect(parsed.name).toBe("Prefer jq for JSON");
    expect(parsed.type).toBe("feedback");
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.body).toContain("Use `jq`");
  });

  it("parses gen 2 (nested metadata)", () => {
    const content = `---
name: never-push-to-the-default-branch
description: "The default branch is protected"
metadata:
  node_type: memory
  type: feedback
  originSessionId: b203f5ed-2fbd-4995-805c-f0f8ca9e7fea
  modified: 2026-08-11T01:17:02.742Z
---

NEVER push directly.`;
    const parsed = parseMemoryContent(content, "feedback_never_push_master.md", Date.now());
    expect(parsed.name).toBe("never-push-to-the-default-branch");
    expect(parsed.type).toBe("feedback");
    expect(parsed.modified).toBe("2026-08-11T01:17:02.742Z");
  });

  it("parses gen 3 (no frontmatter)", () => {
    const content = `# Config Audit — 2026-02-27

Three-persona audit across all 8 site routers.`;
    const parsed = parseMemoryContent(content, "audit-2026-02-27.md", Date.now());
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.name).toBe("audit-2026-02-27");
    expect(parsed.body).toContain("Three-persona audit");
  });

  it("infers type from filename when not in frontmatter", () => {
    const content = `# Just a heading\n\nSome content.`;
    const parsed = parseMemoryContent(content, "reference_firmware_dump.md", Date.now());
    expect(parsed.type).toBe("reference");
  });
});

describe("index-parser", () => {
  it("parses link entries and non-link lines", () => {
    const content = `# My App - Working Memory

## Feedback
- [No auth](feedback_no_auth.md) — owner decision
- ⛔ [Agents must use worktrees](feedback_agents_use_worktrees.md) — shared checkout caused stale flash

## Other`;
    const parsed = parseIndexContent(content, "/fake/dir");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].title).toBe("No auth");
    expect(parsed.entries[0].href).toBe("feedback_no_auth.md");
    expect(parsed.entries[0].summary).toBe("owner decision");
    expect(parsed.entries[0].pinned).toBe(false);
    expect(parsed.entries[1].pinned).toBe(true);
    expect(parsed.lines).toHaveLength(7); // all 7 lines including blanks
  });

  it("handles cross-tier absolute hrefs", () => {
    const content = `- [Prefer jq](/home/user/.claude/memory/feedback_prefer_jq.md) — use jq`;
    const parsed = parseIndexContent(content, "/home/user/.claude/projects/whatever/memory");
    expect(parsed.entries[0].filePath).toBe("/home/user/.claude/memory/feedback_prefer_jq.md");
  });
});

describe.skipIf(!REAL_CORPUS)("injector", () => {
  it("builds injection for my-app", () => {
    const result = resolveMemoryDirs(APP_CWD);
    const { text } = buildMemoryInjection(result.project, result.global);
    expect(text).toContain("## Memory");
    expect(text).toContain("APP");
    expect(text).toContain("Prefer jq");
    // Should have the index section
    expect(text).toContain("#### Index");
    // Should have some full-text files loaded
    expect(text).toContain("#### Full Text");
  });

  it("builds injection for global-only project", () => {
    const result = resolveMemoryDirs(UNKNOWN_CWD);
    const { text } = buildMemoryInjection(result.project, result.global);
    expect(text).toContain("Global");
    expect(text).toContain("Prefer jq");
  });
});

// Synthetic injector test — pure (temp dirs + hand-built MemoryDir), always
// runs regardless of corpus availability. Exercises the large-file bypass:
// an index-pinned (⛔) entry over 60 lines must be fully injected even
// though its frontmatter has no pinned flag (finding #16), while an
// unpinned large file stays index-only.
describe("injector (synthetic, index-pin bypass)", () => {
  it("fully injects an index-pinned large file; leaves unpinned large files index-only", () => {
    const dir = join(tmpdir(), `pcm-pinbypass-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    // 80-line body — well over the 60-line threshold
    const bigBody = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(
      join(dir, "MEMORY.md"),
      `- ⛔ [Pinned big](pinned_big.md) — always in\n- [Unpinned big](unpinned_big.md) — index only\n`,
    );
    const mkFile = (name: string) =>
      writeFileSync(
        join(dir, name),
        `---\ndescription: ${name}\ntype: reference\n---\n${bigBody}\n`,
      );
    // pinned_big.md deliberately has NO pinned frontmatter — the pin lives
    // only in the index (⛔ marker), like entries written by other agents.
    mkFile("pinned_big.md");
    mkFile("unpinned_big.md");

    const memDir = {
      tier: "global" as const,
      dir,
      indexPath: join(dir, "MEMORY.md"),
      label: "Test",
    };
    const { text } = buildMemoryInjection(null, memDir, 20000);

    expect(text).toContain("#### Full Text");
    // The index-pinned big file must be fully loaded...
    expect(text).toContain("line 79");
    // ...while the unpinned big file stays index-only.
    const fullText = text.slice(text.indexOf("#### Full Text"));
    expect(fullText).not.toContain("unpinned_big");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("injector read-side containment", () => {
  // Synthetic dirs (no real corpus needed)
  const mkDir = (root: string, tier: "project" | "global"): MemoryDirType => ({
    tier,
    dir: root,
    indexPath: join(root, "MEMORY.md"),
    label: tier,
  });

  it("skips index hrefs pointing outside the memory stores", () => {
    const projRoot = mkdtempSync(join(tmpdir(), "pcm-contain-p-"));
    const globalRoot = mkdtempSync(join(tmpdir(), "pcm-contain-g-"));
    mkdirSync(projRoot, { recursive: true });
    mkdirSync(globalRoot, { recursive: true });

    // Legitimate topic
    writeFileSync(
      join(projRoot, "inside.md"),
      "---\ndescription: d\ntype: project\n---\ninside body\n",
    );
    // Outside absolute href
    const outsideDir = mkdtempSync(join(tmpdir(), "pcm-outside-"));
    const outsidePath = join(outsideDir, "victim.md");
    writeFileSync(outsidePath, "---\ndescription: d\ntype: project\n---\nsecret outside body\n");
    // Symlinked "topic" inside the store pointing outside
    symlinkSync(outsidePath, join(projRoot, "sneaky.md"));

    // Traversal href (../ relative escapes projRoot)
    writeFileSync(
      join(outsideDir, "traversal.md"),
      "---\ndescription: d\ntype: project\n---\ntraversal body\n",
    );

    writeFileSync(
      join(projRoot, "MEMORY.md"),
      `- [Inside](inside.md) — in\n` +
        `- [Victim](${outsidePath}) — out\n` +
        `- [Sneaky](sneaky.md) — sneaky\n` +
        `- [Traversal](../../${basename(outsideDir)}/traversal.md) — trav\n`,
    );

    const { text, warnings } = buildMemoryInjection(
      mkDir(projRoot, "project"),
      mkDir(globalRoot, "global"),
      5000,
      true,
    );
    expect(text).toContain("inside body");
    expect(text).not.toContain("secret outside body");
    expect(text).not.toContain("traversal body");
    // Inside-body link present in index regardless of full-text load
    expect(warnings.join("\n")).not.toContain("secret");

    rmSync(projRoot, { recursive: true, force: true });
    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("still loads legitimate cross-tier absolute hrefs", () => {
    const projRoot = mkdtempSync(join(tmpdir(), "pcm-cross-p-"));
    const globalRoot = mkdtempSync(join(tmpdir(), "pcm-cross-g-"));
    mkdirSync(projRoot, { recursive: true });
    mkdirSync(globalRoot, { recursive: true });

    writeFileSync(
      join(globalRoot, "shared.md"),
      "---\ndescription: d\ntype: reference\n---\ncross-tier body\n",
    );
    writeFileSync(
      join(projRoot, "MEMORY.md"),
      `- [Shared](${join(globalRoot, "shared.md")}) — cross-tier\n`,
    );

    const { text } = buildMemoryInjection(
      mkDir(projRoot, "project"),
      mkDir(globalRoot, "global"),
      5000,
      true,
    );
    expect(text).toContain("cross-tier body");

    rmSync(projRoot, { recursive: true, force: true });
    rmSync(globalRoot, { recursive: true, force: true });
  });
});
