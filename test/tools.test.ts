// Tool-level tests: entry-level recall fallback, strict explicit tier, and
// global store creation on fresh installations.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodePath } from "../src/resolver.js";
import {
  recallMemoryTool,
  registerMemoryTools,
  removeMemoryTool,
  writeMemoryTool,
} from "../src/tools.js";

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

describe("tool error handling", () => {
  it("write_memory returns ok:false instead of rejecting when the write fails", async () => {
    // Make the topic path unwritable by planting a DIRECTORY where the file
    // must go — the writer's mkdir/rename then fails.
    const cwd = join(tmpHome, "work", "errproj");
    const projDir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
    mkdirSync(join(projDir, "blocked.md"), { recursive: true });

    const res = await writeMemoryTool.execute(
      "t-err",
      { name: "blocked", description: "d", type: "project", body: "b" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    // Must not throw: a rejected tool call is worse than an ok:false result.
    const text = (res.content[0] as { type: string; text: string }).text;
    expect(typeof text).toBe("string");
    expect((res.details as { ok: boolean }).ok).toBe(false);
  });
});

describe("write_memory guidelines do not promise a reviewer", () => {
  // The guideline is the text the model reads immediately before deciding
  // whether to call write_memory. It hardcoded "A background reviewer sweeps
  // every 10 turns", contradicting the injected anchor whenever autoLearn was
  // off or the interval differed — and with autoLearn off it told the model to
  // withhold routine memories from a sweep that never runs.
  it("states no reviewer cadence in the static guideline", () => {
    const guidelines = (writeMemoryTool as unknown as { promptGuidelines: string[] })
      .promptGuidelines;
    const joined = guidelines.join("\n");
    expect(joined).not.toContain("every 10 turns");
    expect(joined).not.toMatch(/reviewer sweeps/i);
    // The anchor owns the statement, so the guideline points at it.
    expect(joined).toContain("memory anchor");
  });
});

describe("remove_memory cross-tier", () => {
  let cwd: string;
  let projDir: string;
  let globalDir: string;
  let projIndex: string;
  let globalIndex: string;

  const run = (params: Record<string, unknown>) =>
    removeMemoryTool.execute("t1", params, undefined as never, undefined as never, makeCtx(cwd));

  const textOf = (res: { content: { type: string; text?: string }[] }) =>
    (res.content[0] as { type: string; text: string }).text;

  beforeEach(() => {
    cwd = join(tmpHome, "work", "proj");
    projDir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
    globalDir = join(tmpHome, ".claude", "memory");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    projIndex = join(projDir, "MEMORY.md");
    globalIndex = join(globalDir, "MEMORY.md");
    // Global OWNS the topic; the project index reaches it by absolute href —
    // the shape the real my-app store has.
    writeFileSync(join(globalDir, "shared.md"), "---\ndescription: s\ntype: reference\n---\ns\n");
    writeFileSync(globalIndex, "# G\n- [Shared](shared.md) — s\n");
    writeFileSync(projIndex, `# P\n- [Shared](${join(globalDir, "shared.md")}) — s\n`);
  });

  it("removes a global entry with no tier named even though a project store exists", async () => {
    // The previous fallback fired only when the requested tier had NO
    // directory. With a project store present, this answered "not found" in
    // project and never consulted global, while recall_memory found it fine.
    const res = await run({ name: "shared" });
    expect((res.details as { ok: boolean }).ok).toBe(true);
    expect(existsSync(join(globalDir, "shared.md"))).toBe(false);
    expect(readFileSync(globalIndex, "utf8")).not.toContain("shared.md");
    expect(textOf(res)).toContain("Global tier");
  });

  it("strips the other tier's dangling cross-tier link in the same operation", async () => {
    const res = await run({ name: "shared" });
    // The project index linked the trashed file by absolute href. Leaving that
    // line behind advertises a memory that no longer exists.
    expect(readFileSync(projIndex, "utf8")).not.toContain("shared.md");
    expect(textOf(res)).toContain("cross-tier link");
  });

  it("honors an explicitly named tier strictly", async () => {
    const res = await run({ name: "shared", tier: "project" });
    expect((res.details as { ok: boolean }).ok).toBe(false);
    // Nothing removed from either store.
    expect(existsSync(join(globalDir, "shared.md"))).toBe(true);
    expect(readFileSync(globalIndex, "utf8")).toContain("shared.md");
    expect(readFileSync(projIndex, "utf8")).toContain("shared.md");
  });
});

describe("recall_memory reports the most informative failure", () => {
  it("does not say 'not found' for an entry that exists but is unreadable", () => {
    // The entry is absent from project but present-and-oversize in global. The
    // old code kept the FIRST miss, so the caller was told the memory does not
    // exist — and a model told that may simply write it again, duplicating a
    // file that is sitting right there.
    const cwd = join(tmpHome, "work", "proj2");
    const projDir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
    const globalDir = join(tmpHome, ".claude", "memory");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(projDir, "MEMORY.md"), "# P\n");
    writeFileSync(join(globalDir, "MEMORY.md"), "# G\n- [Huge](huge.md) — h\n");
    writeFileSync(
      join(globalDir, "huge.md"),
      `---\ndescription: h\ntype: reference\n---\n${"x".repeat(1_100_000)}`,
    );

    return recallMemoryTool
      .execute("t1", { name: "huge" }, undefined as never, undefined as never, makeCtx(cwd))
      .then((res) => {
        const text = (res.content[0] as { type: string; text: string }).text;
        expect(text).toContain("too large");
        expect(text).not.toMatch(/not found/i);
      });
  });
});

describe("remove_memory cleans every index that references the topic", () => {
  it("strips the other tier's dangling reference even when a tier is named", async () => {
    // The my-app layout: the PROJECT index links a GLOBAL topic by
    // absolute href. Naming tier:"global" (which the injected anchor teaches
    // the model to do for an entry it tagged "[in global tier]") used to make
    // alsoUnlink empty, because it was derived from the candidate list — and
    // that list holds exactly one element when a tier is named. The global file
    // was trashed while the project index kept advertising it.
    const cwd = join(tmpHome, "work", "myapp");
    const projDir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
    const globalDir = join(tmpHome, ".claude", "memory");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    const globalTopic = join(globalDir, "shared_rule.md");
    writeFileSync(globalTopic, "---\ndescription: s\ntype: feedback\n---\nrule\n");
    writeFileSync(join(globalDir, "MEMORY.md"), "# G\n- [Shared](shared_rule.md) — rule\n");
    writeFileSync(join(projDir, "MEMORY.md"), `# P\n- [Shared](${globalTopic}) — rule\n`);

    const res = await removeMemoryTool.execute(
      "t1",
      { name: "shared_rule", tier: "global" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );

    expect((res.details as { ok: boolean }).ok).toBe(true);
    expect(readFileSync(join(globalDir, "MEMORY.md"), "utf8")).not.toContain("shared_rule.md");
    // The dangling absolute reference is gone too, despite the named tier.
    expect(readFileSync(join(projDir, "MEMORY.md"), "utf8")).not.toContain(globalTopic);
  });

  it("does not fall through to the other tier when the first tier refuses", async () => {
    // A refusal is an ANSWER about the tier that refused, not an invitation to
    // try the other store. Falling through deleted an entry the caller never
    // named: with `.trash` present as a plain file in the project tier, the
    // project removal was refused and the GLOBAL copy was trashed instead,
    // reported as success.
    const cwd = join(tmpHome, "work", "proj");
    const projDir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
    const globalDir = join(tmpHome, ".claude", "memory");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    writeFileSync(join(projDir, "foo.md"), "---\ndescription: p\ntype: project\n---\nP\n");
    writeFileSync(join(projDir, "MEMORY.md"), "# P\n- [Foo](foo.md) — project\n");
    writeFileSync(join(projDir, ".trash"), "not a directory\n");

    writeFileSync(join(globalDir, "foo.md"), "---\ndescription: g\ntype: reference\n---\nG\n");
    writeFileSync(join(globalDir, "MEMORY.md"), "# G\n- [Foo](foo.md) — global\n");

    const res = await removeMemoryTool.execute(
      "t1",
      { name: "foo" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    const text = (res.content[0] as { type: string; text: string }).text;

    // The refusal is reported...
    expect(text).toContain("not a plain directory");
    // ...and BOTH stores are intact: the project entry survives its own
    // refused removal, and the global entry was never a candidate for it.
    expect(existsSync(join(projDir, "foo.md"))).toBe(true);
    expect(existsSync(join(globalDir, "foo.md"))).toBe(true);
    expect(readFileSync(join(globalDir, "MEMORY.md"), "utf8")).toContain("(foo.md)");
  });
});

describe("registered tools run inside a debug-log context", () => {
  it("emits tool-path diagnostics with no hand-established context", async () => {
    // Tool calls arrive OUTSIDE the lifecycle handlers, so no AsyncLocalStorage
    // context is active. Every debugLog in the read/write/remove path was
    // silently discarded in production: the ambiguity diagnostic proved below
    // existed, was unreachable, and a test that wrapped the call by hand passed
    // anyway. Reaching the tool through registerMemoryTools is the point — it
    // is the only path production uses.
    const cwd = join(tmpHome, "work", "logged");
    const projDir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "MEMORY.md"), "# M\n");
    // Two stems that slugify alike make readMemory log the ambiguity.
    writeFileSync(join(projDir, "Foo Bar.md"), "---\ndescription: a\ntype: reference\n---\nA\n");
    writeFileSync(join(projDir, "FOO  BAR.md"), "---\ndescription: b\ntype: reference\n---\nB\n");

    const registered: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> = [];
    registerMemoryTools({
      registerTool: (t: never) => {
        registered.push(t);
      },
    } as never);
    const tool = registered.find((t) => t.name === "recall_memory");
    if (!tool) throw new Error("recall_memory was not registered");

    await tool.execute("t1", { name: "foo bar" }, undefined, undefined, { cwd });

    // No session_start ran, so the logger falls back to debug.ndjson under the
    // agent dir this test controls through HOME.
    const logPath = join(tmpHome, ".pi", "agent", "pi-claude-memory", "debug.ndjson");
    expect(existsSync(logPath)).toBe(true);
    const logged = readFileSync(logPath, "utf8");
    expect(logged).toContain("tool.recall_memory");
    expect(logged).toContain("topic_ambiguous");
  });
});
