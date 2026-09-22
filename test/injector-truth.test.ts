// Tests for what the injected index tells the model, under the bounded-index
// contract: the project index is injected, verbatim, cut at Claude Code's
// 200-line / 25KB startup limit — and no topic body is read at all.
//
// Two failure modes matter here and they pull in opposite directions:
//   - injecting an unbounded index (the bug this contract fixed: 1341 lines
//     and ~74k tokens in one real store)
//   - reading topic bodies at prompt-build time (which starved, and which
//     made several older tests pass for the wrong reason — a body that is
//     never read cannot leak, so "absent body" alone proves nothing)

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMemoryInjection } from "../src/injector.js";
import { INDEX_STARTUP_MAX_BYTES } from "../src/types.js";

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
  label: string,
  indexBody: string,
  files: Record<string, string> = {},
) {
  const root = join(tmpDir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), indexBody);
  for (const [n, b] of Object.entries(files)) writeFileSync(join(root, n), b);
  return { tier: "project" as const, dir: root, indexPath: join(root, "MEMORY.md"), label };
}

const doc = (body: string) => `---\ndescription: d\ntype: reference\n---\n${body}\n`;

/** The rendered section for one tier, so an assertion cannot match the routing
 *  anchor or another tier's block instead of the index it means to check. */
function tierSection(text: string, label: string): string {
  const start = text.indexOf(`### Memory (${label})`);
  if (start === -1) return "";
  // Search for a NEWLINE-prefixed heading: "### " alone also matches inside
  // "#### Index", which truncated this helper's result to a single "#".
  const next = text.indexOf("\n### ", start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

describe("bounded index injection", () => {
  it("injects the index and no topic bodies", () => {
    const proj = mkStore("p", "proj", "# P\n- [Small](small.md) — s\n", {
      "small.md": doc("SECRET_BODY"),
    });
    const { text } = buildMemoryInjection(proj);
    const section = tierSection(text, "proj");
    expect(section).toContain("[Small](small.md)");
    expect(text).not.toContain("SECRET_BODY");
    // No full-text section means no section heading advertising one either.
    expect(text).not.toContain("Full Text");
  });

  it("never reads a topic body, even for an absolute href outside the store", () => {
    // Guards the regression, rather than proving non-read: a body that is
    // never opened cannot leak, so this passes trivially under the contract
    // and fails the moment body loading is reintroduced.
    const outside = join(tmpDir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "evil.md"), doc("OUTSIDE_TOPIC_BODY"));
    const proj = mkStore("p-out", "proj", `# P\n- [Evil](${join(outside, "evil.md")}) — e\n`);
    const { text } = buildMemoryInjection(proj);
    expect(text).toContain("[Evil]");
    expect(text).not.toContain("OUTSIDE_TOPIC_BODY");
  });
});

describe("the startup limit is on SOURCE lines, like Claude Code's", () => {
  it("cuts at 200 lines and says exactly what was cut", () => {
    const entries = Array.from({ length: 210 }, (_, i) => `- [E${i + 1}](e${i + 1}.md) — d`);
    const proj = mkStore("p-lines", "proj", `# P\n${entries.join("\n")}\n`);
    const { text } = buildMemoryInjection(proj);
    const section = tierSection(text, "proj");
    // "# P" is line 1, so line 200 is E199 and E200 is the first dropped entry.
    expect(section).toContain("[E199]");
    expect(section).not.toContain("[E200]");
    // Derived from the file rather than hardcoded: the exact total depends on
    // the trailing newline, and the point is that the notice states the real
    // count, not a specific number.
    const totalLines = readFileSync(proj.indexPath, "utf8").split("\n").length;
    expect(section).toContain(`200 of ${totalLines} lines`);
    expect(section).toContain("cannot be recalled by name");
  });

  it("counts prose and blank lines against the limit, not just entries", () => {
    // Only two entries exist, so an entry-counting implementation would inject
    // both. The limit is on the FILE, so the second is below the cut.
    const filler = Array.from({ length: 199 }, () => "prose line");
    const body = [...filler, "- [Last](last.md) — l", "- [Cut](cut.md) — c"].join("\n");
    const proj = mkStore("p-prose", "proj", `${body}\n`);
    const { text } = buildMemoryInjection(proj);
    const section = tierSection(text, "proj");
    expect(section).toContain("[Last](last.md)");
    expect(section).not.toContain("[Cut](cut.md)");
  });

  it("cuts at the byte limit when that binds first", () => {
    const entries = Array.from(
      { length: 30 },
      (_, i) => `- [B${i + 1}](b${i + 1}.md) — ${"x".repeat(900)}`,
    );
    const proj = mkStore("p-bytes", "proj", `${entries.join("\n")}\n`);
    const { text } = buildMemoryInjection(proj);
    const section = tierSection(text, "proj");
    expect(section).toContain("[B1](b1.md)");
    expect(section).not.toContain("[B30](b30.md)");
    expect(section).toContain(`${INDEX_STARTUP_MAX_BYTES} bytes`);
  });

  it("does not promote a pinned entry from below the cut", () => {
    // A pin means "important", not "reordered". Promoting it would change the
    // order of the file the model is shown and make the excerpt unpredictable.
    const filler = Array.from({ length: 200 }, (_, i) => `- [F${i}](f${i}.md) — f`);
    const body = [...filler, "- ⛔ [Pinned](pinned.md) — p"].join("\n");
    const proj = mkStore("p-pin", "proj", `${body}\n`);
    const { text } = buildMemoryInjection(proj);
    const section = tierSection(text, "proj");
    expect(section).toContain("[F0](f0.md)");
    expect(section).not.toContain("[Pinned](pinned.md)");
  });

  it("injects an index that fits without a truncation notice", () => {
    const proj = mkStore("p-fit", "proj", "# P\n- [One](one.md) — o\n");
    const { text } = buildMemoryInjection(proj);
    const section = tierSection(text, "proj");
    expect(section).toContain("[One](one.md)");
    expect(section).not.toContain("truncated");
  });
});

describe("availability is no longer claimed at injection time", () => {
  it("tells the model a link is not a guarantee, and to recall by filename", () => {
    // The old contract marked ⟨missing⟩/⟨unavailable⟩ per entry. Nothing is
    // inspected now, so the anchor must not imply every link resolves, and it
    // must say FILENAME because the resolver does not accept a display title.
    const proj = mkStore("p-gone", "proj", "# P\n- [Gone](gone.md) — g\n");
    const { text } = buildMemoryInjection(proj);
    expect(text).toContain("does not guarantee its file is readable");
    expect(text).toContain("passing its FILENAME");
    expect(text).not.toContain("⟨index-only⟩");
    expect(text).not.toContain("⟨missing⟩");
  });

  it("warns instead of injecting when MEMORY.md is a symlink", () => {
    const outside = join(tmpDir, "outside-index");
    mkdirSync(outside, { recursive: true });
    // The sentinel is in the OUTSIDE INDEX, not a topic body. Asserting only
    // that a body is absent would pass even if the outside index were injected,
    // because no body is read under this contract.
    writeFileSync(join(outside, "MEMORY.md"), "# OUTSIDE_INDEX_SENTINEL\n");
    const proj = mkStore("p-link", "proj", "# P\n");
    rmSync(join(proj.dir, "MEMORY.md"));
    symlinkSync(join(outside, "MEMORY.md"), join(proj.dir, "MEMORY.md"));

    const { text, warnings } = buildMemoryInjection(proj);
    expect(text).not.toContain("OUTSIDE_INDEX_SENTINEL");
    expect(warnings.join(" ")).toContain("MEMORY.md not injected");
    expect(warnings.join(" ")).toContain("symlink");
  });
});

describe("anchor gating keeps the index guidance", () => {
  it("drops only the ctx_search clause, not the index sentence", () => {
    const proj = mkStore("p6", "proj", "# P\n- [Mine](mine.md) — m\n");
    const { text } = buildMemoryInjection(proj, { hasCtxSearch: false });
    // The clause explaining what the injected index IS must survive the strip;
    // it once shared a line with the ctx_search clause and was deleted with it.
    expect(text).toContain("Durable facts across sessions");
    expect(text).not.toContain("ctx_search");
  });
});
