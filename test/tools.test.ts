// Tool-level tests: project-scoped recall, write and remove, plus the
// fail-closed refusal of a request that still names a memory tier.
//
// There is one store per project. Claude Code has no cross-project auto-memory
// (its cross-project mechanism is user-scope instructions), so this plugin keeps
// none either: the second tier, its cross-tier fallback, the cross-store index
// sweep, and the `tier` parameter are all gone.

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

/** The retired cross-project store. Nothing may read or write it any more. */
const retiredGlobalDir = () => join(tmpHome, ".claude", "memory");

/** Create the project store for a cwd and return its paths. */
function makeStore(cwd: string, index = "# P\n", files: Record<string, string> = {}) {
  const dir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), index);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { dir, indexPath: join(dir, "MEMORY.md") };
}

const textOf = (res: { content: { type: string; text?: string }[] }) =>
  (res.content[0] as { type: string; text: string }).text;

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

describe("recall_memory against the project store", () => {
  it("finds an entry that is in the store", async () => {
    const cwd = join(tmpHome, "work", "proj");
    makeStore(cwd, "# P\n- [Bar](bar.md) — b\n", {
      "bar.md": "---\ndescription: b\ntype: project\n---\nbar body\n",
    });

    const res = await recallMemoryTool.execute(
      "t1",
      { name: "bar" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    expect(textOf(res)).toContain("bar body");
    expect((res.details as { tier: string }).tier).toBe("project");
  });

  it("reports a miss without consulting anything outside this project", async () => {
    const cwd = join(tmpHome, "work", "proj");
    makeStore(cwd);
    // A decoy of the same name in the retired store, to prove it is not a
    // fallback: with one store, a miss is a miss.
    const globalDir = retiredGlobalDir();
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "foo.md"), "---\ndescription: f\n---\nfoo global body\n");

    const res = await recallMemoryTool.execute(
      "t2",
      { name: "foo" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    const text = textOf(res);
    expect(text).toMatch(/not found/i);
    expect(text).not.toContain("foo global body");
  });

  it("says so when this project has no store yet", async () => {
    const cwd = join(tmpHome, "work", "never-created");
    const res = await recallMemoryTool.execute(
      "t3",
      { name: "anything" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    expect(textOf(res)).toContain("No memory store for this project yet");
  });

  it("reports 'too large' rather than 'not found' for an entry it cannot read", async () => {
    // "not found" is the least informative failure there is, and a model told
    // that may simply write the memory again, duplicating a file that is
    // sitting right there.
    const cwd = join(tmpHome, "work", "oversize");
    makeStore(cwd, "# P\n- [Huge](huge.md) — h\n", {
      "huge.md": `---\ndescription: h\ntype: reference\n---\n${"x".repeat(1_100_000)}`,
    });

    const res = await recallMemoryTool.execute(
      "t4",
      { name: "huge" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    const text = textOf(res);
    expect(text).toContain("too large");
    expect(text).not.toMatch(/not found/i);
  });
});

describe("write_memory creates the project store on first write", () => {
  it("creates the store and never the retired cross-project one", async () => {
    const cwd = join(tmpHome, "fresh", "project");
    const res = await writeMemoryTool.execute(
      "t5",
      {
        name: "fresh-entry",
        description: "written on a fresh installation",
        type: "feedback",
        body: "A durable preference learned before any store existed.",
        pinned: false,
      },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    expect((res.details as { ok: boolean }).ok).toBe(true);

    const dir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
    expect(existsSync(join(dir, "fresh-entry.md"))).toBe(true);
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("fresh-entry.md");
    // The retired tier is not created, not written, not consulted.
    expect(existsSync(retiredGlobalDir())).toBe(false);
  });
});

describe("remove_memory", () => {
  it("trashes the entry and drops its index line", async () => {
    const cwd = join(tmpHome, "work", "proj");
    const store = makeStore(cwd, "# P\n- [Foo](foo.md) — f\n", {
      "foo.md": "---\ndescription: f\ntype: project\n---\nbody\n",
    });

    const res = await removeMemoryTool.execute(
      "t6",
      { name: "foo" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    expect((res.details as { ok: boolean }).ok).toBe(true);
    expect(existsSync(join(store.dir, "foo.md"))).toBe(false);
    expect(readFileSync(store.indexPath, "utf8")).not.toContain("(foo.md)");
  });

  it("reports a refusal instead of claiming success", async () => {
    // `.trash` present as a plain file: the move cannot happen, and the tool
    // must say so rather than reporting a removal that did not occur.
    const cwd = join(tmpHome, "work", "refused");
    const store = makeStore(cwd, "# P\n- [Foo](foo.md) — f\n", {
      "foo.md": "---\ndescription: f\ntype: project\n---\nbody\n",
    });
    writeFileSync(join(store.dir, ".trash"), "not a directory\n");

    const res = await removeMemoryTool.execute(
      "t7",
      { name: "foo" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    expect(textOf(res)).toContain("not a plain directory");
    expect((res.details as { ok: boolean }).ok).toBe(false);
    expect(existsSync(join(store.dir, "foo.md"))).toBe(true);
    expect(readFileSync(store.indexPath, "utf8")).toContain("(foo.md)");
  });

  it("says so when this project has no store yet", async () => {
    const cwd = join(tmpHome, "work", "no-store");
    const res = await removeMemoryTool.execute(
      "t8",
      { name: "anything" },
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    expect(textOf(res)).toContain("No memory store for this project yet");
  });
});

describe("a request that still names a tier is refused, not retargeted", () => {
  // The injected anchor taught the model to pass tier: "global" for months, and
  // a model can carry the habit across sessions. Quietly treating that as the
  // project store would silently change where a write or a removal lands, so it
  // is refused with an explanation the model can learn from.
  it("refuses write_memory with tier: global and writes nothing", async () => {
    const cwd = join(tmpHome, "work", "legacy");
    const store = makeStore(cwd);

    const res = await writeMemoryTool.execute(
      "t9",
      {
        name: "legacy-write",
        description: "d",
        type: "reference",
        body: "b",
        pinned: false,
        tier: "global",
      } as never,
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    expect(textOf(res)).toContain('No "global" memory tier');
    expect(existsSync(join(store.dir, "legacy-write.md"))).toBe(false);
    expect(readFileSync(store.indexPath, "utf8")).not.toContain("legacy-write");
  });

  it("refuses remove_memory with tier: global and removes nothing", async () => {
    const cwd = join(tmpHome, "work", "legacy-remove");
    const store = makeStore(cwd, "# P\n- [Foo](foo.md) — f\n", {
      "foo.md": "---\ndescription: f\ntype: project\n---\nbody\n",
    });

    const res = await removeMemoryTool.execute(
      "t10",
      { name: "foo", tier: "global" } as never,
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    expect(textOf(res)).toContain('No "global" memory tier');
    expect(existsSync(join(store.dir, "foo.md"))).toBe(true);
    expect(readFileSync(store.indexPath, "utf8")).toContain("(foo.md)");
  });

  it("refuses recall_memory with tier: global", async () => {
    const cwd = join(tmpHome, "work", "legacy-recall");
    makeStore(cwd, "# P\n- [Foo](foo.md) — f\n", {
      "foo.md": "---\ndescription: f\ntype: project\n---\nbody\n",
    });

    const res = await recallMemoryTool.execute(
      "t11",
      { name: "foo", tier: "global" } as never,
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    expect(textOf(res)).toContain('No "global" memory tier');
  });

  it("accepts a harmless tier: project echo", async () => {
    const cwd = join(tmpHome, "work", "echo");
    makeStore(cwd, "# P\n- [Foo](foo.md) — f\n", {
      "foo.md": "---\ndescription: f\ntype: project\n---\nbody\n",
    });

    const res = await recallMemoryTool.execute(
      "t12",
      { name: "foo", tier: "project" } as never,
      undefined as never,
      undefined as never,
      makeCtx(cwd),
    );
    expect(textOf(res)).toContain("body");
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
    expect(typeof textOf(res)).toBe("string");
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

describe("write_memory honours demoteIndexOverflow from settings.json", () => {
  it("archives the overflow when the key is on, and not when it is absent", async () => {
    const cwd = join(tmpHome, "work", "demote");
    const seeded = Array.from({ length: 205 }, (_, i) => `- [E${i + 1}](e${i + 1}.md) — s`);
    const store = makeStore(cwd, `${seeded.join("\n")}\n`);
    const params = {
      name: "fresh-fact",
      description: "a freshly learned fact",
      type: "reference" as const,
      body: "body\n",
    };
    const write = () =>
      writeMemoryTool.execute("t1", params, undefined as never, undefined as never, makeCtx(cwd));

    // No settings.json yet: the planner is off and the index only grows.
    expect(textOf(await write())).not.toContain("Archived");
    expect(readFileSync(store.indexPath, "utf8")).not.toContain("## Archive");

    // This is the wiring guard: the key has to reach the writer through the
    // tool, so a call site that forgets to pass it fails here.
    mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".pi", "agent", "settings.json"),
      JSON.stringify({ "pi-claude-memory": { demoteIndexOverflow: true } }),
    );

    expect(textOf(await write())).toContain("Archived");
    expect(readFileSync(store.indexPath, "utf8")).toContain("## Archive");
  });
});
