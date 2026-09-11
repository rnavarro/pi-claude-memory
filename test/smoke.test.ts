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

describe("frontmatter: a non-frontmatter block is never stripped", () => {
  // splitFrontmatter accepted anything between two `---` lines and returned a
  // body with the middle removed, then `parseYamlFrontmatter(...) ?? {}` threw
  // the parsed result away. A Markdown preference sitting between two rule
  // lines therefore vanished from BOTH the body and the metadata — silent data
  // loss in injection and recall alike.
  it("preserves prose between two --- rule lines", () => {
    const content = `---
Keep this important preference.
---
Remaining text.`;
    const parsed = parseMemoryContent(content, "note.md", Date.now());
    expect(parsed.body).toContain("Keep this important preference.");
    expect(parsed.body).toContain("Remaining text.");
    // It is not frontmatter, and nothing was silently discarded.
    expect(parsed.hasFrontmatter).toBe(false);
  });

  it("preserves content when the block is unparseable YAML", () => {
    const content = `---
{ this is: not: valid: yaml
---
body after`;
    const parsed = parseMemoryContent(content, "note.md", Date.now());
    expect(parsed.body).toContain("not: valid: yaml");
    expect(parsed.body).toContain("body after");
  });

  it("does not treat a ---- rule as a frontmatter opener", () => {
    const content = `----
name: not frontmatter
----
body`;
    const parsed = parseMemoryContent(content, "note.md", Date.now());
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toContain("name: not frontmatter");
  });

  it("still strips a block that really is frontmatter", () => {
    const content = `---
name: real
description: a real memory
type: feedback
---
the body`;
    const parsed = parseMemoryContent(content, "real.md", Date.now());
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.name).toBe("real");
    expect(parsed.type).toBe("feedback");
    expect(parsed.body).not.toContain("type: feedback");
    expect(parsed.body).toContain("the body");
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

describe("cross-tier injection does not duplicate a shared topic", () => {
  // A project index may link an absolute href into the global store, and the
  // global index lists the same file relatively. Each tier built its OWN
  // loadedPaths set, so the body was emitted twice and charged twice against
  // the shared budget — confirmed live: a real project index on this machine
  // has two such absolute cross-tier hrefs.
  const mkStore = (root: string, indexLines: string, files: Record<string, string>) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "MEMORY.md"), indexLines);
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(root, name), `---\ndescription: ${name}\ntype: reference\n---\n${body}\n`);
    }
    return { tier: "global" as const, dir: root, indexPath: join(root, "MEMORY.md"), label: root };
  };

  it("emits a cross-tier-linked body exactly once", () => {
    const base = mkdtempSync(join(tmpdir(), "pcm-xtier-"));
    const globalRoot = join(base, "global");
    const projectRoot = join(base, "project");
    const globalDir = mkStore(globalRoot, "- [Shared](shared.md) — the shared topic\n", {
      "shared.md": "SHARED_BODY_SENTINEL",
    });
    // The project index reaches the SAME global file by absolute href.
    const projectDir = {
      ...mkStore(
        projectRoot,
        `- [Shared](${join(globalRoot, "shared.md")}) — cross-tier link\n`,
        {},
      ),
      tier: "project" as const,
      label: "project",
    };

    const { text } = buildMemoryInjection(projectDir, globalDir, 20000);
    const occurrences = text.split("SHARED_BODY_SENTINEL").length - 1;
    expect(occurrences).toBe(1);

    rmSync(base, { recursive: true, force: true });
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

describe("injector containment: symlinked ancestors and roots", () => {
  const mk = (root: string, tier: "project" | "global"): MemoryDirType => ({
    tier,
    dir: root,
    indexPath: join(root, "MEMORY.md"),
    label: tier,
  });
  const FM = "---\ndescription: d\ntype: project\n---\n";

  it("rejects a topic reached through a symlinked DIRECTORY inside the store", () => {
    const proj = mkdtempSync(join(tmpdir(), "pcm-anc-p-"));
    const glob = mkdtempSync(join(tmpdir(), "pcm-anc-g-"));
    const outside = mkdtempSync(join(tmpdir(), "pcm-anc-o-"));
    writeFileSync(join(outside, "secret.md"), `${FM}ANCESTOR_LINK_SECRET\n`);
    // A symlinked directory INSIDE the store: lexical containment passes,
    // so this is only closed by canonicalizing the path.
    symlinkSync(outside, join(proj, "bridge"));
    writeFileSync(join(proj, "MEMORY.md"), "- [S](bridge/secret.md) — bridged\n");

    const { text } = buildMemoryInjection(mk(proj, "project"), mk(glob, "global"), 5000, true);
    expect(text).not.toContain("ANCESTOR_LINK_SECRET");

    for (const d of [proj, glob, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("still loads a store whose own path is behind a symlink", () => {
    const real = mkdtempSync(join(tmpdir(), "pcm-link-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "pcm-link-p-"));
    const glob = mkdtempSync(join(tmpdir(), "pcm-link-g-"));
    writeFileSync(join(real, "t.md"), `${FM}VIA_LINKED_ROOT\n`);
    writeFileSync(join(real, "MEMORY.md"), "- [T](t.md) — x\n");
    const linked = join(linkParent, "store");
    symlinkSync(real, linked);

    const { text } = buildMemoryInjection(mk(linked, "project"), mk(glob, "global"), 5000, true);
    expect(text).toContain("VIA_LINKED_ROOT");
    // The body is in the prompt, so the index line must NOT claim otherwise.
    // (Match on the link line, not the anchor, which mentions the phrase.)
    expect(text).not.toContain("(t.md) — x ⟨index-only⟩");

    for (const d of [real, linkParent, glob]) rmSync(d, { recursive: true, force: true });
  });

  it("loads a topic referenced by a non-canonical absolute href", () => {
    const proj = mkdtempSync(join(tmpdir(), "pcm-nc-p-"));
    const glob = mkdtempSync(join(tmpdir(), "pcm-nc-g-"));
    writeFileSync(join(proj, "ok.md"), `${FM}NONCANON_BODY\n`);
    // Doubled separator in an absolute href: previously reached the injector
    // as a different string than the loader's key, so the entry was injected
    // AND marked index-only.
    writeFileSync(join(proj, "MEMORY.md"), `- [Ok](${join(proj, "//ok.md")}) — x\n`);

    const { text } = buildMemoryInjection(mk(proj, "project"), mk(glob, "global"), 5000, true);
    expect(text).toContain("NONCANON_BODY");
    expect(text).not.toContain("//ok.md) — x ⟨index-only⟩");

    for (const d of [proj, glob]) rmSync(d, { recursive: true, force: true });
  });

  it("ignores an index whose path is a directory or symlink", () => {
    const proj = mkdtempSync(join(tmpdir(), "pcm-idx-p-"));
    const glob = mkdtempSync(join(tmpdir(), "pcm-idx-g-"));
    const outside = mkdtempSync(join(tmpdir(), "pcm-idx-o-"));
    writeFileSync(join(outside, "MEMORY.md"), `- [Evil](${join(outside, "evil.md")}) — x\n`);
    writeFileSync(join(outside, "evil.md"), `${FM}SYMLINKED_INDEX_PAYLOAD\n`);
    // MEMORY.md itself as a symlink to an outside index.
    symlinkSync(join(outside, "MEMORY.md"), join(proj, "MEMORY.md"));

    const { text } = buildMemoryInjection(mk(proj, "project"), mk(glob, "global"), 5000, true);
    expect(text).not.toContain("SYMLINKED_INDEX_PAYLOAD");

    for (const d of [proj, glob, outside]) rmSync(d, { recursive: true, force: true });
  });
});

describe("routing anchor tells the truth about the reviewer", () => {
  it("promises a reviewer with the configured interval when autoLearn is on", async () => {
    const { reviewerClause } = await import("../src/injector.js");
    const c = reviewerClause(true, 25);
    expect(c).toContain("every 25 turns");
    expect(c).not.toContain("every 10 turns");
  });

  it("drops the reviewer promise when autoLearn is off", async () => {
    const { reviewerClause } = await import("../src/injector.js");
    const c = reviewerClause(false, 10);
    // Telling the model to withhold memories in favour of a reviewer that
    // never runs is a silent memory-loss mode.
    expect(c).not.toContain("reviewer sweeps");
    expect(c).toContain("only way a fact survives");
  });

  it("renders the anchor without a leftover template placeholder", async () => {
    const { buildMemoryInjection, MEMORY_ROUTING_ANCHOR } = await import("../src/injector.js");
    expect(MEMORY_ROUTING_ANCHOR).toContain("{{REVIEWER}}");
    const root = mkdtempSync(join(tmpdir(), "pcm-anchor-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "MEMORY.md"), "# M\n- [X](x.md) \u2014 s\n");
    writeFileSync(join(root, "x.md"), "---\ndescription: d\ntype: project\n---\nbody\n");
    const proj: MemoryDirType = {
      tier: "project",
      dir: root,
      indexPath: join(root, "MEMORY.md"),
      label: "project",
    };
    const { text } = buildMemoryInjection(proj, null, 5000, true, false, 10);
    expect(text).not.toContain("{{REVIEWER}}");
    expect(text).toContain("only way a fact survives");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("pinned entry demotion is never silent", () => {
  const mkdir2 = (root: string, tier: "project" | "global"): MemoryDirType => ({
    tier,
    dir: root,
    indexPath: join(root, "MEMORY.md"),
    label: tier,
  });

  it("warns when a pinned entry exceeds the remaining budget", () => {
    const root = mkdtempSync(join(tmpdir(), "pcm-pin-"));
    const body = "p".repeat(40000); // far beyond a tiny cap
    writeFileSync(
      join(root, "big-pinned.md"),
      `---\ndescription: d\ntype: project\n---\n${body}\n`,
    );
    writeFileSync(join(root, "MEMORY.md"), "# M\n- ⛔ [Big pinned](big-pinned.md) — d\n");
    const dir = mkdir2(root, "project");
    // Tiny cap so the pinned body cannot fit.
    const { warnings } = buildMemoryInjection(dir, null, 50);
    expect(warnings.some((w) => w.includes("pinned entry") && w.includes("index-only"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not warn for a pinned entry that fits", () => {
    const root = mkdtempSync(join(tmpdir(), "pcm-pin-ok-"));
    writeFileSync(
      join(root, "small-pinned.md"),
      "---\ndescription: d\ntype: project\n---\nsmall\n",
    );
    writeFileSync(join(root, "MEMORY.md"), "# M\n- ⛔ [Small pinned](small-pinned.md) — d\n");
    const dir = mkdir2(root, "project");
    const { warnings } = buildMemoryInjection(dir, null, 20000);
    expect(warnings.some((w) => w.includes("pinned entry"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
