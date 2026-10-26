// Correction-triggered and tool-call-triggered reviews, driven through the
// real extension entry point with runAutoLearn replaced by a hand-resolved
// fake. No LLM is called: the fake records each launch and returns a
// deferred the test settles, so single-flight, queueing, debounce and the
// shutdown revision gate are observed on the production wiring.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Launch {
  chunk: string;
  resolve: (written: number) => void;
}

const fake = vi.hoisted(() => ({
  launches: [] as Launch[],
  active: 0,
  maxActive: 0,
  autoResolve: false,
}));

vi.mock("../src/auto-learn.js", async (orig) => {
  const actual = await orig<typeof import("../src/auto-learn.js")>();
  return {
    ...actual,
    runAutoLearn: vi.fn((_ctx: unknown, _cfg: unknown, _cwd: string, chunk: string) => {
      fake.active++;
      fake.maxActive = Math.max(fake.maxActive, fake.active);
      if (fake.autoResolve) {
        fake.active--;
        fake.launches.push({ chunk, resolve: () => {} });
        return Promise.resolve(0);
      }
      return new Promise<number>((res) => {
        fake.launches.push({
          chunk,
          resolve: (n) => {
            fake.active--;
            res(n);
          },
        });
      });
    }),
  };
});

import piClaudeMemory from "../src/index.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

let tmpHome: string;
let origHome: string | undefined;
let origAgentDir: string | undefined;
let origSubagentChild: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  origAgentDir = process.env.PI_CODING_AGENT_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "pcm-correction-"));
  process.env.HOME = tmpHome;
  delete process.env.PI_CODING_AGENT_DIR;
  // This file drives the extension through its real entry point, so it must
  // not inherit the parent PROCESS's identity either. Suite runs launched from
  // inside a pi subagent carry PI_SUBAGENT_CHILD=1 in the environment, and
  // piClaudeMemory() turns autoLearn off for a subagent unless
  // subagentAutoLearn is set, which unregisters turn_end, tool_result,
  // agent_settled, input, session_before_compact and session_shutdown all at
  // once. Every test that expects a launch then fails on an empty recorder
  // (the run reports 13 failed / 5 passed), and the 5 that pass are exactly
  // the ones asserting that nothing happens. The subagent describe block below
  // sets the variable itself for the tests that want it, so clear it here and
  // restore it afterwards.
  origSubagentChild = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  fake.launches = [];
  fake.active = 0;
  fake.maxActive = 0;
  fake.autoResolve = false;
});

afterEach(() => {
  vi.useRealTimers();
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = origAgentDir;
  if (origSubagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = origSubagentChild;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Let the .then/.catch/.finally/drain chain of a settled review run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** Load the extension with the given settings and return a driver. */
async function load(settings: Record<string, unknown>) {
  const agentDir = join(tmpHome, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      "pi-claude-memory": {
        debugLog: false,
        reviewIntervalTurns: 10,
        shutdownMinChunkChars: 0,
        ...settings,
      },
    }),
  );

  const handlers = new Map<string, Handler[]>();
  piClaudeMemory({
    on: (name: string, h: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(h);
      handlers.set(name, list);
    },
    registerTool: () => {},
  } as never);

  const branch: { type: string; message: { role: string; content: string } }[] = [];
  const ctx = {
    cwd: join(tmpHome, "proj"),
    sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
  };
  const fire = async (name: string, event: unknown) => {
    let last: unknown;
    for (const h of handlers.get(name) ?? []) last = await h(event, ctx);
    return last;
  };

  // Every test starts a fresh session: resets the module-level state.
  await fire("session_start", { type: "session_start" });

  return {
    handlers,
    /** A user message: the input event, then its turn in the branch. */
    async say(text: string) {
      await fire("input", { type: "input", text, source: "interactive" });
      branch.push({ type: "message", message: { role: "user", content: text } });
    },
    async turn(n = 1) {
      for (let i = 0; i < n; i++) {
        branch.push({ type: "message", message: { role: "assistant", content: `reply ${i}` } });
        await fire("turn_end", { type: "turn_end", turnIndex: i });
      }
    },
    async toolResults(n: number) {
      for (let i = 0; i < n; i++) {
        await fire("tool_result", {
          type: "tool_result",
          toolName: "bash",
          content: [{ type: "text", text: `out ${i}` }],
        });
      }
    },
    settle: () => fire("agent_settled", { type: "agent_settled" }),
    /** session_before_compact over a snapshot (default: the branch so far). */
    compact: (entries = [...branch]) =>
      fire("session_before_compact", {
        type: "session_before_compact",
        reason: "threshold",
        willRetry: false,
        branchEntries: entries,
      }),
    shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
  };
}

describe("environment isolation", () => {
  // Guard for the failure mode described in beforeEach: this is the assertion
  // that fails, in a suite launched from a subagent, if the PI_SUBAGENT_CHILD
  // sanitisation is ever removed. It is a precondition of every test below.
  it("does not inherit PI_SUBAGENT_CHILD from the parent process", () => {
    expect(process.env.PI_SUBAGENT_CHILD).toBeUndefined();
  });
});

describe("correction trigger", () => {
  it("a correction triggers exactly one review at settle, containing the correction", async () => {
    const d = await load({});
    await d.say("no, use pnpm");
    await d.turn();
    expect(fake.launches).toHaveLength(0); // not at input time
    await d.settle();
    expect(fake.launches).toHaveLength(1);
    expect(fake.launches[0]?.chunk).toContain("no, use pnpm");

    fake.launches[0]?.resolve(1);
    await flush();
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(1);
  });

  it("an ordinary message triggers nothing before the turn interval", async () => {
    const d = await load({});
    await d.say("no problem, carry on");
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(0);
  });

  it("a triggered review resets the periodic turn counter", async () => {
    const d = await load({ reviewIntervalTurns: 3 });
    await d.turn(2);
    await d.say("don't touch the lockfile");
    await d.settle();
    expect(fake.launches).toHaveLength(1);
    fake.launches[0]?.resolve(0);
    await flush();
    // Without the reset this third turn would reach the interval of 3.
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(1);
  });
});

describe("single flight and the pending correction", () => {
  it("never starts a second review while one is in flight, then runs the queued correction", async () => {
    const d = await load({ reviewIntervalTurns: 2 });
    await d.turn(2);
    await d.settle(); // periodic review, left in flight
    expect(fake.launches).toHaveLength(1);

    await d.say("never push to main");
    await d.turn();
    await d.settle(); // correction due, slot busy: queued
    expect(fake.launches).toHaveLength(1);
    expect(fake.maxActive).toBe(1);

    fake.launches[0]?.resolve(0);
    await flush();
    expect(fake.launches).toHaveLength(2);
    expect(fake.launches[1]?.chunk).toContain("never push to main");
    expect(fake.maxActive).toBe(1);

    // Consumed: the drained review cleared the flag.
    fake.launches[1]?.resolve(0);
    await flush();
    await d.settle();
    expect(fake.launches).toHaveLength(2);
  });
});

describe("debounce", () => {
  it("allows at most one triggered review per window and keeps the blocked correction", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const d = await load({ reviewTriggerDebounceSeconds: 60 });

    await d.say("no, use pnpm");
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(1);
    fake.launches[0]?.resolve(0);
    await flush();

    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
    await d.say("stop adding comments");
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(1); // debounced

    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(2); // the blocked correction was kept
    expect(fake.launches[1]?.chunk).toContain("stop adding comments");
  });

  it("does not debounce the periodic turn trigger", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const d = await load({ reviewIntervalTurns: 2, reviewTriggerDebounceSeconds: 60 });
    await d.say("no, use pnpm");
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(1);
    fake.launches[0]?.resolve(0);
    await flush();

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    await d.turn(2);
    await d.settle();
    expect(fake.launches).toHaveLength(2);
  });
});

describe("tool-call trigger", () => {
  it("reviews after reviewEveryToolCalls tool results, not before", async () => {
    const d = await load({ reviewEveryToolCalls: 3 });
    await d.say("please build it");
    await d.toolResults(2);
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(0);

    await d.toolResults(1);
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(1);
    expect(fake.launches[0]?.chunk).toContain("### Tool Results");

    // The count reset with the launch.
    fake.launches[0]?.resolve(0);
    await flush();
    await d.toolResults(2);
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(1);
  });
});

describe("config off-switches", () => {
  it("reviewOnCorrection: false registers no input handler and triggers nothing", async () => {
    const d = await load({ reviewOnCorrection: false });
    expect(d.handlers.has("input")).toBe(false);
    await d.say("no, use pnpm");
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(0);
  });

  it("reviewEveryToolCalls: 0 disables the tool-call trigger", async () => {
    const d = await load({ reviewEveryToolCalls: 0 });
    await d.say("please build it");
    await d.toolResults(100);
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(0);
  });
});

describe("subagent mode", () => {
  const REVIEW_EVENTS = [
    "turn_end",
    "tool_result",
    "agent_settled",
    "input",
    "session_before_compact",
    "session_shutdown",
  ];

  async function loadChild(settings: Record<string, unknown>) {
    const orig = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      return await load(settings);
    } finally {
      if (orig === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = orig;
    }
  }

  it("registers no review handler, so a task prompt that reads as a correction reviews nothing", async () => {
    const d = await loadChild({});
    for (const name of REVIEW_EVENTS) expect(d.handlers.has(name)).toBe(false);
    await d.say("actually, use the ansible key instead");
    await d.turn(30);
    await d.settle();
    await d.shutdown();
    expect(fake.launches).toHaveLength(0);
  });

  it("subagentAutoLearn: true restores the reviewer in a subagent", async () => {
    const d = await loadChild({ subagentAutoLearn: true });
    await d.say("no, use pnpm");
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(1);
  });

  it("a top-level session is unaffected by the subagent settings", async () => {
    const d = await load({ subagentAutoLearn: false });
    expect(d.handlers.has("input")).toBe(true);
    await d.say("no, use pnpm");
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(1);
  });
});

describe("shutdown revision gate after a triggered review", () => {
  it("skips the shutdown review when the triggered review covered everything", async () => {
    const d = await load({});
    await d.say("no, use pnpm");
    await d.turn();
    await d.settle();
    fake.launches[0]?.resolve(1);
    await flush();

    fake.autoResolve = true;
    await d.shutdown();
    expect(fake.launches).toHaveLength(1);
  });

  it("still reviews at shutdown when a turn arrived after the triggered review", async () => {
    const d = await load({});
    await d.say("no, use pnpm");
    await d.turn();
    await d.settle();
    fake.launches[0]?.resolve(1);
    await flush();
    await d.turn();

    fake.autoResolve = true;
    await d.shutdown();
    expect(fake.launches).toHaveLength(2);
  });

  it("a correction arriving during a review is not marked reviewed by it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const d = await load({ reviewTriggerDebounceSeconds: 60 });
    await d.say("no, use pnpm");
    await d.turn();
    await d.settle(); // triggered review A, in flight, starts the debounce window

    // A steered correction mid-review: no turn completes before A settles.
    await d.say("from now on use tabs");
    await d.settle(); // queued behind A
    fake.launches[0]?.resolve(1);
    await flush(); // the drain is debounced, so the correction stays queued
    expect(fake.launches).toHaveLength(1);

    fake.autoResolve = true;
    await d.shutdown();
    expect(fake.launches).toHaveLength(2);
    expect(fake.launches[1]?.chunk).toContain("from now on use tabs");
  });
});

describe("pre-compaction review consumes the settle triggers", () => {
  it("resets the turn and tool-call counters when it launches", async () => {
    const d = await load({ reviewIntervalTurns: 3, reviewEveryToolCalls: 3 });
    await d.say("please build it");
    await d.toolResults(2);
    await d.turn(2);
    await d.compact();
    expect(fake.launches).toHaveLength(1);
    fake.launches[0]?.resolve(0);
    await flush();

    // Without the reset both counters would reach 3 here and fire a review
    // over the compaction summary.
    await d.toolResults(1);
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(1);
  });

  it("consumes a correction the snapshot contains", async () => {
    const d = await load({});
    await d.say("no, use pnpm");
    await d.turn();
    await d.compact();
    expect(fake.launches).toHaveLength(1);
    expect(fake.launches[0]?.chunk).toContain("no, use pnpm");
    fake.launches[0]?.resolve(0);
    await flush();
    await d.settle();
    expect(fake.launches).toHaveLength(1);
  });

  it("keeps a correction the snapshot does not contain", async () => {
    const d = await load({});
    await d.say("please build it");
    await d.turn();
    const snapshot = [
      { type: "message", message: { role: "user", content: "please build it" } },
      { type: "message", message: { role: "assistant", content: "x".repeat(50) } },
    ];
    await d.say("no, use pnpm");
    await d.compact(snapshot);
    expect(fake.launches).toHaveLength(1);
    fake.launches[0]?.resolve(0);
    await flush();
    await d.turn();
    await d.settle();
    expect(fake.launches).toHaveLength(2);
    expect(fake.launches[1]?.chunk).toContain("no, use pnpm");
  });
});
