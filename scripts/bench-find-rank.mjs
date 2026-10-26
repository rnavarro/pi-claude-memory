#!/usr/bin/env node
// Times the find_memory scorer over the live memory store.
//
// Corpora come from ~/.claude/projects/*/memory/*.md, read-only: real filenames
// as names, real `description:` as summaries, real bodies. The scorer is timed
// once per (corpus size, query) pair for every implementation the module
// exports:
//
//   rankEntries       the production path
//   rankEntriesScan   the pre-inverted-index path, when the module still has it
//
// The module is TypeScript, so it is bundled to a temp file with the esbuild
// CLI that already ships in node_modules (no new dependency, no build step
// checked in), the same way scripts/bench-frontmatter.mjs does it.
//
// Usage: node scripts/bench-find-rank.mjs [--rounds N] [--store DIR]

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const rounds = Number(argValue("--rounds", "3"));
const storeRoot = argValue("--store", join(homedir(), ".claude", "projects"));
const repoRoot = new URL("..", import.meta.url).pathname;

async function loadRank() {
  const dir = mkdtempSync(join(tmpdir(), "pcm-rank-bench-"));
  const outfile = join(dir, "find-rank.cjs");
  const bundle = spawnSync(
    join(repoRoot, "node_modules", ".bin", "esbuild"),
    [
      join(repoRoot, "src", "find-rank.ts"),
      "--bundle",
      "--format=cjs",
      "--platform=node",
      `--outfile=${outfile}`,
      "--log-level=error",
    ],
    { encoding: "utf8" },
  );
  if (bundle.status !== 0) {
    console.error(bundle.stderr || `esbuild exited ${bundle.status}`);
    process.exit(2);
  }
  const mod = createRequire(import.meta.url)(outfile);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `description:` from a topic's frontmatter, unquoted; "" when absent. */
function descriptionOf(content) {
  const end = content.indexOf("\n---", 4);
  if (!content.startsWith("---") || end < 0) return "";
  const block = content.slice(4, end);
  const line = block.split("\n").find((l) => l.startsWith("description:"));
  if (!line) return "";
  return line
    .slice("description:".length)
    .trim()
    .replace(/^["']|["']$/g, "");
}

/** Every topic file in the store, grouped by project store directory. */
function collectStore() {
  const byStore = new Map();
  let projects;
  try {
    projects = readdirSync(storeRoot);
  } catch {
    console.error(`no store at ${storeRoot}`);
    process.exit(2);
  }
  for (const project of projects) {
    const dir = join(storeRoot, project, "memory");
    let names;
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const docs = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".md")) continue;
      let content;
      try {
        content = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      const end = content.indexOf("\n---", 4);
      docs.push({
        title: basename(name, ".md"),
        summary: descriptionOf(content),
        filename: name,
        body: end >= 0 ? content.slice(end + 4) : content,
      });
    }
    if (docs.length > 0) byStore.set(project, docs);
  }
  return byStore;
}

const { mod, cleanup } = await loadRank();
const { rankEntries, queryTerms } = mod;
const impls = [["after ", rankEntries]];
if (typeof mod.rankEntriesScan === "function") impls.push(["before", mod.rankEntriesScan]);

const byStore = collectStore();
const all = [...byStore.values()].flat();
if (all.length === 0) {
  console.error(`no memory files under ${storeRoot}`);
  cleanup();
  process.exit(2);
}

// The largest single project store is what one find_memory call actually sees.
const largest = [...byStore.entries()].sort((a, b) => b[1].length - a[1].length)[0];
const corpora = [
  ["largest project store", largest[0].slice(0, 44), largest[1]],
  ["all project stores", "every ~/.claude/projects/*/memory", all],
];

// Queries: one word, a phrase, a question, and a review chunk. The chunk is real
// prose from the store, which is what auto-learn's relevance selection hands the
// scorer, and it is where the term count explodes.
const longQuestion =
  "why does the rotating backup policy for the proxmox guest disks keep failing verification " +
  "when the retention schedule says the restore should already have been tested against the " +
  "snapshot before promoting the archive to the offsite bucket";
const chunkText = all
  .slice(0, 60)
  .map((d) => `${d.title}\n${d.summary}\n${d.body}`)
  .join("\n");
const queries = [
  ["1 term", "deploy"],
  ["3 terms", "memory index budget"],
  ["10 terms", "proxmox guest disk backup policy rotation schedule retention verification restore"],
  ["30 terms", longQuestion],
  ["chunk", chunkText],
];

const bytes = all.reduce(
  (sum, d) => sum + Buffer.byteLength(`${d.title}${d.summary}${d.filename}${d.body}`, "utf8"),
  0,
);
const fmt = (n, d = 1) => n.toFixed(d);
const best = (xs) => Math.min(...xs);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(
  `find-rank: ${all.length} docs across ${byStore.size} stores, ${(bytes / 1024 / 1024).toFixed(2)} MiB of text`,
);
console.log(`rounds:    ${rounds} (best of, ms)`);
console.log("");

for (const [label, where, corpus] of corpora) {
  console.log(`${label}: ${corpus.length} docs  (${where})`);
  for (const [qname, query] of queries) {
    const terms = queryTerms(query).length;
    const timings = [];
    let mismatch = 0;
    for (const [impl, fn] of impls) {
      // Warm, then measure: module init and the first Map allocation are not
      // the steady-state cost recall and auto-learn pay.
      fn(query, corpus);
      const times = [];
      let expected = null;
      for (let r = 0; r < rounds; r++) {
        const t = performance.now();
        const out = fn(query, corpus);
        times.push(performance.now() - t);
        if (impl === "before") expected = out;
        else if (expected !== null) {
          mismatch = out.filter((r2, i) => r2.score !== expected[i].score || r2.tier !== expected[i].tier)
            .length;
        }
      }
      timings.push([impl, best(times), median(times)]);
    }
    // The pre-index path allocates one filtered array per term, so its runs
    // swing with GC; the minimum and the median are both printed rather than
    // picking whichever one flatters the change.
    const line = timings
      .map(([impl, ms, med]) => `${impl} ${fmt(ms).padStart(8)} ms (median ${fmt(med).padStart(8)})`)
      .join("   ");
    console.log(`  ${qname.padEnd(8)} ${String(terms).padStart(4)} terms   ${line}`);
    if (mismatch > 0) console.log(`    !! ${mismatch} results differ from the pre-index scorer`);
  }
  console.log("");
}

cleanup();
