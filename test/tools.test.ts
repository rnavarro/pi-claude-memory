// Tool-level tests: entry-level recall fallback, strict explicit tier, and
// global store creation on fresh installations.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodePath } from "../src/resolver.js";
import { recallMemoryTool, writeMemoryTool } from "../src/tools.js";

let tmpHome: string;
let origHome: string | undefined;

const makeCtx = (cwd: string) => ({ cwd }) as never;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "pcm-tools-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("recall_memory tier fallback", () => {
  let cwd: string;

  beforeEach(() => {
    // Project store exists (with only bar.md); global store has foo.md.
    cwd = join(tmpHome, "work", "proj");
    const projDir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "MEMORY.md"), "# Proj\n- [Bar](bar.md) — b\n");
    writeFileSync(join(projDir, "bar.md"), "---\ndescription: b\ntype: project\n---\nbar body\n");

    const globalDir = join(tmpHome, ".claude", "memory");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "MEMORY.md"), "# Global\n- [Foo](foo.md) — f\n");
    writeFileSync(
      join(globalDir, "foo.md"),
      "---\ndescription: f\ntype: reference\n---\nfoo global body\n",
    );
  });

  it("falls back to the other tier when the ENTRY is missing from the requested one", async () => {
    const res = await recallMemoryTool.execute(
      "t1",
      { name: "foo" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    const text = (res.content[0] as { type: string; text: string }).text;
    expect(text).toContain("foo global body");
    expect(text).toContain("Global tier");
    expect((res.details as { tier: string }).tier).toBe("global");
  });

  it("honors an explicitly named tier strictly (no cross-tier confusion)", async () => {
    const res = await recallMemoryTool.execute(
      "t2",
      { name: "foo", tier: "project" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    const text = (res.content[0] as { type: string; text: string }).text;
    expect(text).toContain("not found");
  });

  it("still finds an entry present in the requested tier", async () => {
    const res = await recallMemoryTool.execute(
      "t3",
      { name: "bar" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    const text = (res.content[0] as { type: string; text: string }).text;
    expect(text).toContain("bar body");
  });
});

describe("write_memory global store creation", () => {
  it("creates the global memory dir on first global write (fresh install)", async () => {
    const cwd = join(tmpHome, "fresh", "project");
    // No ~/.claude/memory yet.
    const res = await writeMemoryTool.execute(
      "t4",
      {
        name: "fresh-global-entry",
        description: "written before any global store exists",
        type: "feedback",
        body: "A durable preference learned on a fresh installation.",
        tier: "global",
        pinned: false,
      },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    const text = (res.content[0] as { type: string; text: string }).text;
    expect(text).not.toContain("No global memory directory");

    const globalDir = join(tmpHome, ".claude", "memory");
    expect(existsSync(join(globalDir, "fresh-global-entry.md"))).toBe(true);
    const idx = readFileSync(join(globalDir, "MEMORY.md"), "utf8");
    expect(idx).toContain("fresh-global-entry.md");
  });
});

describe("recall_memory with an absent project store", () => {
  // Regression: resolving the requested directory first and only falling
  // back after a failed READ meant that when NO project store existed for
  // the cwd, recall_memory answered "No memory directory available
  // (tier=project)" while a global store full of memories sat unread.
  it("falls back to the global store when there is no project directory", async () => {
    const cwd = join(tmpHome, "work", "never-created");
    const globalDir = join(tmpHome, ".claude", "memory");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "global-only.md"),
      "---\ndescription: g\ntype: reference\n---\nglobal only body\n",
    );

    const res = await recallMemoryTool.execute(
      "t-absent",
      { name: "global-only" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    const text = (res.content[0] as { type: string; text: string }).text;
    expect(text).toContain("global only body");
    expect(text).not.toContain("No memory directory available");
    expect((res.details as { tier: string }).tier).toBe("global");
  });

  it("still honors an explicitly named tier strictly", async () => {
    const cwd = join(tmpHome, "work", "never-created-2");
    const globalDir = join(tmpHome, ".claude", "memory");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "global-only-2.md"),
      "---\ndescription: g\ntype: reference\n---\nglobal only body 2\n",
    );

    const res = await recallMemoryTool.execute(
      "t-strict",
      { name: "global-only-2", tier: "project" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    const text = (res.content[0] as { type: string; text: string }).text;
    expect(text).toContain("No memory directory available");
  });
});
