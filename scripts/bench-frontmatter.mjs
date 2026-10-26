#!/usr/bin/env node
// Times frontmatter parsing over the whole live memory store.
//
// Two numbers per run, over the same files in the same order:
//
//   before  parseMemoryContent(.., { yamlOnly: true })  — the pre-fast-path path
//   after   parseMemoryContent(..)                      — fast path when it can
//
// The module is TypeScript, so it is bundled to a temp file with the esbuild
// CLI that already ships in node_modules (no new dependency, no build step
// checked in: `node_modules/.bin/esbuild --bundle`).
//
// Usage: node scripts/bench-frontmatter.mjs [--rounds N] [--store DIR]

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const rounds = Number(argValue("--rounds", "5"));
const storeRoot = argValue("--store", join(homedir(), ".claude", "projects"));
const repoRoot = new URL("..", import.meta.url).pathname;

async function loadFrontmatter() {
  const dir = mkdtempSync(join(tmpdir(), "pcm-bench-"));
  const outfile = join(dir, "frontmatter.cjs");
  const bundle = spawnSync(
    join(repoRoot, "node_modules", ".bin", "esbuild"),
    [
      join(repoRoot, "src", "frontmatter.ts"),
      "--bundle",
      // CJS output, because `yaml` is CJS: bundling it into an ESM file turns
      // its `require("process")` into an unsupported dynamic require.
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

/** Every topic file in the store, with its basename and mtime. */
function collectStore() {
  const files = [];
  let projects;
  try {
    projects = readdirSync(storeRoot);
  } catch {
    console.error(`no store at ${storeRoot}`);
    process.exit(2);
  }
  for (const project of projects) {
    const dir = join(storeRoot, project, "memory");
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".md")) files.push({ path: join(dir, name), name });
    }
  }
  return files;
}

function measure(fn) {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const { mod, cleanup } = await loadFrontmatter();
const { parseMemoryContent, frontmatterParserStats, resetFrontmatterParserStats } = mod;

const files = collectStore();
if (files.length === 0) {
  console.error(`no memory files under ${storeRoot}`);
  cleanup();
  process.exit(2);
}

// Reads are outside parseMemoryContent, but they are part of the same
// maintenance sweep, so their cost is measured and reported rather than guessed.
const readMs = measure(() => {
  for (const file of files) {
    file.content = readFileSync(file.path, "utf8");
    file.mtime = statSync(file.path).mtimeMs;
  }
});
const bytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0);

const run = (options) => () => {
  for (const file of files) parseMemoryContent(file.content, file.name, file.mtime, options);
};

// Warm up both paths so neither pays for lazy module initialisation.
for (const file of files.slice(0, 500)) {
  parseMemoryContent(file.content, file.name, file.mtime, { yamlOnly: true });
  parseMemoryContent(file.content, file.name, file.mtime);
}

const before = [];
const after = [];
for (let r = 0; r < rounds; r++) {
  before.push(measure(run({ yamlOnly: true })));
  after.push(measure(run()));
}

// How many blocks the fast path answered, so a speed-up cannot come from work
// that quietly stopped happening.
resetFrontmatterParserStats();
run()();
const { fastPath, yamlPath } = frontmatterParserStats();

const best = (xs) => Math.min(...xs);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const perFile = (ms) => (ms * 1000) / files.length;

const beforeBest = best(before);
const afterBest = best(after);
const reduction = 1 - afterBest / beforeBest;

const fmt = (n, d = 1) => n.toFixed(d);
console.log(
  `parsed:  ${fastPath + yamlPath} blocks: ${fastPath} fast path, ${yamlPath} YAML ` +
    `(${fmt((fastPath / (fastPath + yamlPath)) * 100)}% fast)`,
);
console.log(`store:   ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB, ${storeRoot}`);
console.log(`reads:   ${fmt(readMs)} ms for the whole store (outside the timed loop)`);
console.log(`rounds:  ${rounds} (best of, ms)`);
console.log("");
console.log(`before:  ${fmt(beforeBest)} ms  (${fmt(perFile(beforeBest))} us/file, mean ${fmt(mean(before))} ms)`);
console.log(`after:   ${fmt(afterBest)} ms  (${fmt(perFile(afterBest))} us/file, mean ${fmt(mean(after))} ms)`);
console.log("");
console.log(`removed: ${fmt(beforeBest - afterBest)} ms, ${fmt(reduction * 100)}% of parse time`);
console.log(`         ${fmt((beforeBest - afterBest) / readMs, 1)}x the cost of reading the whole store`);

cleanup();
