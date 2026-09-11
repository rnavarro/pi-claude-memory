// Tests for what the injected index TELLS the model about its entries.
//
// The index is in every prompt, so a wrong marker costs a wasted tool call on
// every turn it is wrong: ⟨index-only⟩ is an instruction to call recall_memory,
// and an entry rendered under the wrong tier heading sends that call to the
// wrong store.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMemoryInjection } from "../src/injector.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcm-inj-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a store root and return the MemoryDir describing it. */
function mkStore(
  name: string,
  tier: "project" | "global",
  label: string,
  indexBody: string,
  files: Record<string, string> = {},
) {
  const root = join(tmpDir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), indexBody);
  for (const [n, b] of Object.entries(files)) writeFileSync(join(root, n), b);
  return { tier, dir: root, indexPath: join(root, "MEMORY.md"), label };
}

const doc = (body: string) => `---\ndescription: d\ntype: reference\n---\n${body}\n`;

/** The rendered section for one tier.
 *
 * Assertions must be scoped to it: the routing anchor also spells out the
 * marker legend (⟨index-only⟩, ⟨missing⟩, [in global tier]), so whole-prompt
 * substring checks match the LEGEND rather than the index entry. */
function tierSection(text: string, label: string): string {
  const start = text.indexOf(`### Memory (${label})`);
  if (start === -1) return "";
  const next = text.indexOf("### Memory (", start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

describe("injector index markers tell the truth", () => {
  it("marks a missing entry as missing, not as fetchable", () => {
    // reconcileIndex already knows the file is gone, so advertising it as
    // ⟨index-only⟩ invited a recall_memory call that was certain to fail.
    const proj = mkStore("p", "project", "proj", "# P\n- [Gone](gone.md) — g\n");
    const { text } = buildMemoryInjection(proj, null, 20_000);
    const section = tierSection(text, "proj");
    expect(section).toContain("⟨missing⟩");
    expect(section).not.toContain("⟨index-only⟩");
  });

  it("still marks a present-but-unloaded entry as index-only", () => {
    // Regression guard: the missing marker must not swallow the normal case.
    const long = doc(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
    const proj = mkStore("p2", "project", "proj", "# P\n- [Big](big.md) — b\n", { "big.md": long });
    const { text } = buildMemoryInjection(proj, null, 50);
    const section = tierSection(text, "proj");
    expect(section).toContain("⟨index-only⟩");
    expect(section).not.toContain("⟨missing⟩");
  });

  it("annotates a cross-tier entry with the tier that owns it", () => {
    const gRoot = join(tmpDir, "g");
    const glob = mkStore("g", "global", "global", "# G\n- [Shared](shared.md) — s\n", {
      "shared.md": doc("SHARED_BODY"),
    });
    const proj = mkStore(
      "p3",
      "project",
      "proj",
      `# P\n- [Shared](${join(gRoot, "shared.md")}) — s\n`,
    );
    const { text } = buildMemoryInjection(proj, glob, 20_000);
    // Rendering it under "Memory (proj)" with no note sends a model that
    // believes that heading to recall_memory with the project tier, which
    // answers "not found" for a file one tier away.
    expect(tierSection(text, "proj")).toContain("[in global tier]");
  });

  it("does not annotate an entry that belongs to the tier it is listed under", () => {
    const proj = mkStore("p4", "project", "proj", "# P\n- [Mine](mine.md) — m\n", {
      "mine.md": doc("MINE"),
    });
    const { text } = buildMemoryInjection(proj, null, 20_000);
    const section = tierSection(text, "proj");
    expect(section).not.toContain("[in project tier]");
    expect(section).not.toContain("[in global tier]");
  });

  it("does not mark an entry index-only when a later tier injects its body", () => {
    // The first tier renders against a loadedPaths set that cannot yet contain
    // a body the second tier goes on to inject. Here the project index lists a
    // large file unpinned (so the project pass skips it) while the global index
    // pins the same file (so the global pass loads it). Rendering as we went
    // advertised ⟨index-only⟩ for text that IS in the prompt.
    const long = doc(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
    const glob = mkStore("g2", "global", "global", `# G\n- ⛔ [Big](big.md) — b\n`, {
      "big.md": long,
    });
    const proj = mkStore(
      "p5",
      "project",
      "proj",
      `# P\n- [Big](${join(tmpDir, "g2", "big.md")}) — b\n`,
    );
    const { text } = buildMemoryInjection(proj, glob, 20_000);
    // Its body is in the prompt via the global (pinned) pass.
    expect(text).toContain("line 199");
    // The line is really rendered (guards against a vacuous assertion)...
    expect(tierSection(text, "proj")).toContain("Big");
    // ...and must not invite a fetch for a body that is already in the prompt.
    expect(tierSection(text, "proj")).not.toContain("⟨index-only⟩");
  });
});

describe("anchor gating keeps the index guidance", () => {
  it("drops only the ctx_search clause, not the index sentence", () => {
    const proj = mkStore("p6", "project", "proj", "# P\n- [Mine](mine.md) — m\n", {
      "mine.md": doc("MINE"),
    });
    const { text } = buildMemoryInjection(proj, null, 20_000, /* hasCtxSearch */ false);
    // The clause that explains what the injected index IS must survive the
    // strip; previously it shared a line with the ctx_search clause and was
    // deleted along with it.
    expect(text).toContain("Durable facts across sessions");
    expect(text).not.toContain("ctx_search");
  });
});
