// Smoke tests for the resolver, parsers and injector. Every store is built
// under a temp HOME, so the suite runs the same on any machine.

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMemoryContent } from "../src/frontmatter.js";
import { parseIndexContent } from "../src/index-parser.js";
import { buildMemoryInjection } from "../src/injector.js";
import { encodePath, resolveMemoryDirs } from "../src/resolver.js";
import type { MemoryDir as MemoryDirType } from "../src/types.js";

// None of these paths exist on disk: outside a repository the resolver uses
// the cwd itself as the project identity root, so only the encoded store
// under the temp HOME matters.
const APP_CWD = "/home/user/workspace/my-app";
const UNKNOWN_CWD = "/home/user/workspace/nonexistent-project";

/** Run each test under its own temp HOME, restoring the previous one after. */
function useTempHome(prefix: string): () => string {
  let home = "";
  let origHome: string | undefined;
  beforeEach(() => {
    origHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), prefix));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (origHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });
  return () => home;
}

/** The encoded project dir for `cwd` under `home` (holds MEMORY.md or memory/). */
const projectRoot = (home: string, cwd: string) =>
  join(home, ".claude", "projects", encodePath(cwd));

/** Build a standard-layout store: <project>/memory/MEMORY.md plus topics. */
function makeStandardStore(home: string, cwd: string, index: string): string {
  const mem = join(projectRoot(home, cwd), "memory");
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, "MEMORY.md"), index);
  return mem;
}

describe("resolver", () => {
  const home = useTempHome("pcm-smoke-res-");

  it("encodes paths the way Claude Code does", () => {
    expect(encodePath(APP_CWD)).toBe("-home-user-workspace-my-app");
    expect(encodePath("/home/user/workspace/other-project")).toBe(
      "-home-user-workspace-other-project",
    );
  });

  it("resolves a standard-layout project store", () => {
    const mem = makeStandardStore(home(), APP_CWD, "# My App\n- [T](t.md) — x\n");
    const result = resolveMemoryDirs(APP_CWD);
    expect(result.project).not.toBeNull();
    expect(result.project?.tier).toBe("project");
    expect(result.project?.dir).toBe(mem);
    expect(result.project?.dir).toContain("my-app");
    expect(result.project?.indexPath).toBe(join(mem, "MEMORY.md"));
    expect(result.project && existsSync(result.project.indexPath)).toBe(true);
  });

  it("resolves a root-level MEMORY.md with no memory/ subdir to the project dir", () => {
    // Layout 2 without the sibling memory/: topics live next to the index.
    const proj = projectRoot(home(), APP_CWD);
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "MEMORY.md"), "- [T](t.md) — x\n");
    const result = resolveMemoryDirs(APP_CWD);
    expect(result.project?.indexPath).toBe(join(proj, "MEMORY.md"));
    expect(result.project?.dir).toBe(proj);
  });

  it("returns null project for unknown cwd", () => {
    makeStandardStore(home(), APP_CWD, "# My App\n");
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

describe("injector (bounded index)", () => {
  const home = useTempHome("pcm-smoke-inj-");

  it("injects a bounded index and no full text for a resolved store", () => {
    const mem = makeStandardStore(
      home(),
      APP_CWD,
      "# My App - Working Memory\n\n## Feedback\n- [No auth](feedback_no_auth.md) — owner decision\n",
    );
    writeFileSync(
      join(mem, "feedback_no_auth.md"),
      "---\ndescription: owner decision\ntype: feedback\n---\nAPP_BODY_SENTINEL\n",
    );
    const result = resolveMemoryDirs(APP_CWD);
    const { text } = buildMemoryInjection(result.project);
    expect(text).toContain("## Memory");
    expect(text).toContain("My App - Working Memory");
    expect(text).toContain("[No auth](feedback_no_auth.md)");
    expect(text).not.toContain("APP_BODY_SENTINEL");
    expect(text).toContain("#### Index");
    // This assertion used to be the opposite: "#### Full Text" plus a loaded
    // body. Bodies are not loaded at prompt-build time under this contract.
    expect(text).not.toContain("#### Full Text");
  });
});

describe("Layout-2 anomaly: root MEMORY.md with topics in memory/", () => {
  it("resolves the index at the root and the topic base to memory/", () => {
    // This LOCKS the resolver behaviour rather than "fixing" hrefs to be
    // relative to the index file. Real stores have been seen with exactly
    // this shape: a root MEMORY.md whose lines are bare (`user_location.md`)
    // with the topics in the sibling memory/. The read base is memory/, so
    // those bare hrefs resolve for recall. Emitting index-relative links
    // instead (memory/foo.md) would resolve to memory/memory/foo.md and MISS.
    //
    // The assertion used to be that the topic BODY was injected, which proved
    // href resolution end to end. Injection no longer reads bodies, so this
    // now asserts the two paths the resolver picked; href resolution itself is
    // covered by the writer/recall tests, which still read topics.
    const home = mkdtempSync(join(tmpdir(), "pcm-l2-"));
    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const cwd = `/home/user/workspace/pcm-l2-${process.pid}-${Date.now()}`;
      const proj = join(home, ".claude", "projects", encodePath(cwd));
      const mem = join(proj, "memory");
      mkdirSync(mem, { recursive: true });
      writeFileSync(join(proj, "MEMORY.md"), "- [User location](user_location.md) — Springfield\n");
      writeFileSync(
        join(mem, "user_location.md"),
        "---\ndescription: loc\ntype: user\n---\nLOCATION_BODY_SENTINEL\n",
      );

      const resolved = resolveMemoryDirs(cwd);
      expect(resolved.project?.indexPath).toBe(join(proj, "MEMORY.md"));
      expect(resolved.project?.dir).toBe(mem);

      const { text } = buildMemoryInjection(resolved.project);
      expect(text).toContain("[User location](user_location.md)");
      expect(text).not.toContain("LOCATION_BODY_SENTINEL");
    } finally {
      if (origHome === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = origHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("injector reads the index and nothing else", () => {
  const mk = (root: string): MemoryDirType => ({
    tier: "project",
    dir: root,
    indexPath: join(root, "MEMORY.md"),
    label: "project",
  });
  const FM = "---\ndescription: d\ntype: project\n---\n";

  it("rejects a symlinked index by its INDEX content, not by a body", () => {
    // The old form of this test put the sentinel in an outside TOPIC and
    // asserted that body was absent. Under zero preloading that assertion
    // passes even if the outside INDEX is injected, because no body is ever
    // read — a vacuous pass that would have hidden the regression. The
    // sentinel therefore lives in the outside index itself.
    const proj = mkdtempSync(join(tmpdir(), "pcm-idx-p-"));
    const outside = mkdtempSync(join(tmpdir(), "pcm-idx-o-"));
    writeFileSync(join(outside, "MEMORY.md"), "# OUTSIDE_INDEX_SENTINEL\n");
    writeFileSync(join(outside, "evil.md"), `${FM}OUTSIDE_BODY_SENTINEL\n`);
    symlinkSync(join(outside, "MEMORY.md"), join(proj, "MEMORY.md"));

    const { text, warnings } = buildMemoryInjection(mk(proj));
    expect(text).not.toContain("OUTSIDE_INDEX_SENTINEL");
    expect(text).not.toContain("OUTSIDE_BODY_SENTINEL");
    expect(warnings.join(" ")).toContain("symlink");

    for (const d of [proj, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("still injects the index of a store whose own path is behind a symlink", () => {
    // A dotfiles-managed ~/.claude is the real case: rejecting it would drop
    // every entry. The path is read THROUGH the symlinked directory, so the
    // lstat on the index itself still sees a regular file.
    const real = mkdtempSync(join(tmpdir(), "pcm-link-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "pcm-link-p-"));
    writeFileSync(join(real, "MEMORY.md"), "# M\n- [T](t.md) — x\n");
    writeFileSync(join(real, "t.md"), `${FM}VIA_LINKED_ROOT\n`);
    const linked = join(linkParent, "store");
    symlinkSync(real, linked);

    const { text } = buildMemoryInjection(mk(linked));
    expect(text).toContain("[T](t.md)");
    expect(text).not.toContain("VIA_LINKED_ROOT");

    for (const d of [real, linkParent]) rmSync(d, { recursive: true, force: true });
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
    writeFileSync(join(root, "MEMORY.md"), "# M\n- [X](x.md) — s\n");
    writeFileSync(join(root, "x.md"), "---\ndescription: d\ntype: project\n---\nbody\n");
    const proj: MemoryDirType = {
      tier: "project",
      dir: root,
      indexPath: join(root, "MEMORY.md"),
      label: "project",
    };
    const { text } = buildMemoryInjection(proj, {
      hasCtxSearch: true,
      autoLearn: false,
      reviewIntervalTurns: 10,
    });
    expect(text).not.toContain("{{REVIEWER}}");
    expect(text).toContain("only way a fact survives");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("pins live in the index line, not in the topic", () => {
  it("marks an entry pinned only when the LINE carries the marker", () => {
    // The honesty half of item 4. Nothing reads a topic's frontmatter looking
    // for a pin any more (bodies are never opened), so the index line is the
    // only place a pin can be expressed. This locks that: a plain line stays
    // unpinned no matter what the topic file says, and the parser cannot even
    // see a topic file's frontmatter from here.
    const dir = mkdtempSync(join(tmpdir(), "pcm-pin-line-"));
    const content = [
      "- [Plain](plain.md) — no marker on this line",
      "- ⛔ [Marked](marked.md) — carries the marker",
      "- [Also plain](also.md) — [pin] spelled out in the summary",
    ].join("\n");
    const parsed = parseIndexContent(content, dir);
    const pinnedByTitle = new Map(parsed.entries.map((e) => [e.title, e.pinned]));
    expect(pinnedByTitle.get("Plain")).toBe(false);
    expect(pinnedByTitle.get("Marked")).toBe(true);
    // [pin] in the remainder counts too, which is the documented second shape.
    expect(pinnedByTitle.get("Also plain")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not promote a pinned line that falls below the index cutoff", () => {
    // A pin cannot rescue an entry the cutoff dropped: the excerpt is a prefix
    // of the file, so a marker below it is simply not in the injected text.
    const dir = mkdtempSync(join(tmpdir(), "pcm-pin-cut-"));
    const filler = Array.from({ length: 210 }, (_, i) => `- [F${i}](f${i}.md) — filler`);
    const content = [...filler, "- ⛔ [Buried](buried.md) — pinned but below the cut"].join("\n");
    writeFileSync(join(dir, "MEMORY.md"), `${content}\n`);
    const dirs = {
      tier: "project" as const,
      dir,
      indexPath: join(dir, "MEMORY.md"),
      label: "project",
    };
    const { text } = buildMemoryInjection(dirs, {
      hasCtxSearch: true,
      autoLearn: false,
      reviewIntervalTurns: 10,
    });
    expect(text).toContain("Index truncated at 200 lines");
    expect(text).not.toContain("Buried");
    rmSync(dir, { recursive: true, force: true });
  });
});
