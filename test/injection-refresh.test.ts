// When the injected MEMORY.md is recomputed from disk.
//
// Claude Code refreshes auto memory at session start and after compaction,
// never after a write and never per turn. This plugin now does the same: the
// frozen injection is dropped at session_start and session_compact only, so a
// write_memory or remove_memory call leaves the system prompt byte-identical
// and the prompt cache intact.
//
// These tests drive the real extension entry point through a fake ExtensionAPI
// that records handlers and tools, so they exercise the production wiring
// rather than calling internals by hand.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piClaudeMemory from "../src/index.js";
import { encodePath } from "../src/resolver.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; execute: (...a: unknown[]) => Promise<unknown> };

let tmpHome: string;
let origHome: string | undefined;
let origAgentDir: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  origAgentDir = process.env.PI_CODING_AGENT_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "pcm-refresh-"));
  process.env.HOME = tmpHome;
  // loadConfig and the debug log resolve the agent dir from this variable
  // first; an inherited value would point them at the operator's real one.
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = origAgentDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** A session branch shared across loads, as pi keeps it across /reload. */
type Branch = { type: string; customType?: string; data?: unknown }[];

/** Load the extension against a fake API and return a small driver. */
function loadExtension(cwd: string, branch: Branch = []) {
  const handlers = new Map<string, Handler[]>();
  const tools: Tool[] = [];
  piClaudeMemory({
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: "custom", customType, data });
    },
    on: (name: string, h: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(h);
      handlers.set(name, list);
    },
    registerTool: (t: Tool) => {
      tools.push(t);
    },
  } as never);

  const ctx = { cwd, sessionManager: { getBranch: () => [...branch] } };
  const fire = async (name: string, event: unknown) => {
    let last: unknown;
    for (const h of handlers.get(name) ?? []) last = await h(event, ctx);
    return last;
  };
  const tool = (name: string) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`${name} was not registered`);
    return t;
  };

  /** Run before_agent_start the way pi 1.2.0 does: handlers may edit the
   * shared systemPromptOptions (sections included) or return a forced prompt.
   * `legacyHost` omits sections, as hosts before pi 0.86 did. */
  const startTurn = async (legacyHost = false) => {
    const sections: Record<string, string> = {};
    const res = (await fire("before_agent_start", {
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "BASE PROMPT\n",
      systemPromptOptions: legacyHost ? { selectedTools: [] } : { selectedTools: [], sections },
    })) as { systemPrompt?: string } | undefined;
    return { res, sections };
  };

  return {
    startTurn,
    /** Run before_agent_start and return the system prompt it produces,
     * rendering named sections in pi's tag-wrapped form. */
    async prompt(): Promise<string> {
      const { res, sections } = await startTurn();
      if (res?.systemPrompt !== undefined) return res.systemPrompt;
      const rendered = Object.entries(sections).map(([k, v]) => `<${k}>\n${v}\n</${k}>`);
      if (rendered.length === 0) throw new Error("before_agent_start injected nothing");
      return `BASE PROMPT\n${rendered.join("\n\n")}`;
    },
    sessionStart: (reason = "startup") => fire("session_start", { type: "session_start", reason }),
    compacted: () => {
      branch.push({ type: "compaction" });
      return fire("session_compact", {
        type: "session_compact",
        compactionEntry: {},
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      });
    },
    write: (name: string, description: string) =>
      tool("write_memory").execute(
        "w1",
        { name, description, type: "project", body: `${name} body`, pinned: false },
        undefined,
        undefined,
        ctx,
      ),
    remove: (name: string) =>
      tool("remove_memory").execute("r1", { name }, undefined, undefined, ctx),
  };
}

/** Create the project store for a cwd with the given index and topic files. */
function makeStore(cwd: string, index: string, files: Record<string, string> = {}) {
  const dir = join(tmpHome, ".claude", "projects", encodePath(cwd), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), index);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return join(dir, "MEMORY.md");
}

const topic = (d: string) => `---\ndescription: ${d}\ntype: project\n---\nbody\n`;

describe("the injected MEMORY.md is not refreshed by a write", () => {
  it("write_memory leaves the next system prompt byte-identical", async () => {
    const cwd = join(tmpHome, "work", "write");
    makeStore(cwd, "# P\n- [Alpha](alpha.md) — first entry\n", {
      "alpha.md": topic("first entry"),
    });
    const ext = loadExtension(cwd);
    await ext.sessionStart();

    const before = await ext.prompt();
    expect(before).toContain("alpha.md");

    const res = (await ext.write("beta-entry", "written mid-session")) as {
      details: { ok: boolean };
    };
    expect(res.details.ok).toBe(true);

    const after = await ext.prompt();
    expect(after).toBe(before);
    expect(after).not.toContain("beta-entry.md");
  });

  it("remove_memory leaves the next system prompt byte-identical", async () => {
    const cwd = join(tmpHome, "work", "remove");
    makeStore(cwd, "# P\n- [Alpha](alpha.md) — first entry\n- [Gamma](gamma.md) — doomed\n", {
      "alpha.md": topic("first entry"),
      "gamma.md": topic("doomed"),
    });
    const ext = loadExtension(cwd);
    await ext.sessionStart();

    const before = await ext.prompt();
    expect(before).toContain("gamma.md");

    const res = (await ext.remove("gamma")) as { details: { ok: boolean } };
    expect(res.details.ok).toBe(true);

    const after = await ext.prompt();
    expect(after).toBe(before);
  });
});

describe("the injected MEMORY.md is refreshed at the Claude Code points", () => {
  it("session_compact makes the next turn reflect the store, mid-session writes included", async () => {
    const cwd = join(tmpHome, "work", "compact");
    makeStore(cwd, "# P\n- [Alpha](alpha.md) — first entry\n", {
      "alpha.md": topic("first entry"),
    });
    const ext = loadExtension(cwd);
    await ext.sessionStart();

    const before = await ext.prompt();
    expect(before).not.toContain("delta-entry.md");

    await ext.write("delta-entry", "learned before compaction");
    // Still frozen until the compaction lands.
    expect(await ext.prompt()).toBe(before);

    await ext.compacted();

    const after = await ext.prompt();
    expect(after).not.toBe(before);
    expect(after).toContain("delta-entry.md");
    expect(after).toContain("learned before compaction");
    expect(after).toContain("alpha.md");
  });

  it("session_start still recomputes from disk", async () => {
    const cwd = join(tmpHome, "work", "restart");
    const indexPath = makeStore(cwd, "# P\n- [Alpha](alpha.md) — first entry\n", {
      "alpha.md": topic("first entry"),
    });
    const ext = loadExtension(cwd);
    await ext.sessionStart();

    const before = await ext.prompt();
    // Edited outside this session, as Claude Code or another Pi would.
    writeFileSync(indexPath, "# P\n- [Omega](omega.md) — edited elsewhere\n");
    writeFileSync(indexPath.replace("MEMORY.md", "omega.md"), topic("edited elsewhere"));
    expect(await ext.prompt()).toBe(before);

    await ext.sessionStart();

    const after = await ext.prompt();
    expect(after).toContain("omega.md");
    expect(after).not.toContain("alpha.md");
  });
});

describe("/reload keeps the injected MEMORY.md", () => {
  // /reload re-imports the extension and fires session_start with reason
  // "reload". Re-rendering there picked up topics written earlier in the
  // session, changing the system prompt mid-session.
  it("restores the exact text sent before the reload", async () => {
    const cwd = join(tmpHome, "work", "reload");
    makeStore(cwd, "# P\n- [Alpha](alpha.md) — first entry\n", {
      "alpha.md": topic("first entry"),
    });
    const branch: Branch = [];
    const ext = loadExtension(cwd, branch);
    await ext.sessionStart();
    const before = await ext.prompt();
    await ext.write("beta-entry", "written mid-session");

    const reloaded = loadExtension(cwd, branch);
    await reloaded.sessionStart("reload");

    const after = await reloaded.prompt();
    expect(after).toBe(before);
    expect(after).not.toContain("beta-entry.md");
  });

  it("renders fresh on a reload after a compaction", async () => {
    const cwd = join(tmpHome, "work", "reload-compacted");
    makeStore(cwd, "# P\n- [Alpha](alpha.md) — first entry\n", {
      "alpha.md": topic("first entry"),
    });
    const branch: Branch = [];
    const ext = loadExtension(cwd, branch);
    await ext.sessionStart();
    await ext.prompt();
    await ext.write("beta-entry", "written mid-session");
    await ext.compacted();

    const reloaded = loadExtension(cwd, branch);
    await reloaded.sessionStart("reload");

    expect(await reloaded.prompt()).toContain("beta-entry.md");
  });

  it("renders fresh on resume", async () => {
    const cwd = join(tmpHome, "work", "resume");
    makeStore(cwd, "# P\n- [Alpha](alpha.md) — first entry\n", {
      "alpha.md": topic("first entry"),
    });
    const branch: Branch = [];
    const ext = loadExtension(cwd, branch);
    await ext.sessionStart();
    await ext.prompt();
    await ext.write("beta-entry", "written mid-session");

    const resumed = loadExtension(cwd, branch);
    await resumed.sessionStart("resume");

    expect(await resumed.prompt()).toContain("beta-entry.md");
  });
});

describe("the memory block is a named prompt section", () => {
  // Returning a whole forced systemPrompt left handlers that run later unable
  // to adjust their own parts of the prompt.
  it("adds a memory section and forces no prompt", async () => {
    const cwd = join(tmpHome, "work", "section");
    makeStore(cwd, "# P\n- [Alpha](alpha.md) — first entry\n", {
      "alpha.md": topic("first entry"),
    });
    const ext = loadExtension(cwd);
    await ext.sessionStart();

    const { res, sections } = await ext.startTurn();

    expect(res).toBeUndefined();
    expect(Object.keys(sections)).toEqual(["memory"]);
    expect(sections.memory).toContain("<memory-index>");
    expect(sections.memory).toContain("alpha.md");
    expect(sections.memory).toBe(sections.memory?.trim());
  });

  it("appends to the prompt on a host without sections", async () => {
    const cwd = join(tmpHome, "work", "section-legacy");
    makeStore(cwd, "# P\n- [Alpha](alpha.md) — first entry\n", {
      "alpha.md": topic("first entry"),
    });
    const ext = loadExtension(cwd);
    await ext.sessionStart();

    const { res } = await ext.startTurn(true);

    expect(res?.systemPrompt?.startsWith("BASE PROMPT\n")).toBe(true);
    expect(res?.systemPrompt).toContain("alpha.md");
  });
});
