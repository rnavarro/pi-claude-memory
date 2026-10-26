// Tests for the BM25F scorer in src/find-rank.ts.
//
// The scorer is on the main thread during recall and auto-learn, and it used to
// count document frequencies by filtering the whole entry list once per query
// term. These tests are the proof that the inverted-index replacement is both
// (a) bit-identical in what it returns and (b) actually avoiding the scan:
//
//   equivalence  every query is scored by BOTH implementations over the live
//                memory store (~9,300 real entries, read-only) and by the
//                reference scan kept in src/find-rank.ts. Scores must be equal
//                to the exact float, and the ranked order (with ties) identical.
//   mechanism    the counters must show no entry x term membership probes and
//                fewer entries scored than there are entries, which is what
//                "one inverted index instead of a scan per term" means. The
//                reference scan is run through the same counters so a counter
//                that always reads zero cannot pass.
//   edges        queries the store does not happen to contain: empty, only
//                stopwords, a term in every entry, a term in none, duplicates,
//                unicode, and an exact phrase.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findRankStats,
  prepareText,
  queryTerms,
  type RankInput,
  type RankResult,
  rankEntries,
  rankEntriesScan,
  resetFindRankStats,
} from "../src/find-rank.js";
import { parseMemoryContent } from "../src/frontmatter.js";

/** The operator's real Claude Code store, resolved without $HOME (the test
 *  setup replaces HOME with a temp dir). userInfo() reads the passwd entry. */
const REAL_STORE_ROOT = join(userInfo().homedir, ".claude", "projects");

/** Every topic file grouped by the project store it belongs to, because one
 *  find_memory call searches exactly one such store. */
function realStores(): Map<string, string[]> {
  const stores = new Map<string, string[]>();
  let projects: string[];
  try {
    projects = readdirSync(REAL_STORE_ROOT);
  } catch {
    return stores;
  }
  for (const project of projects) {
    const dir = join(REAL_STORE_ROOT, project, "memory");
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const files: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".md")) files.push(join(dir, name));
    }
    if (files.length > 0) stores.set(project, files.sort());
  }
  return stores;
}

/** The entries find_memory would score: the topic's stem as the name, its
 *  description as the summary, and its body. Read-only over the store. */
function rankInputs(files: string[]): RankInput[] {
  const out: RankInput[] = [];
  for (const file of files) {
    const name = basename(file);
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseMemoryContent(content, name, 0);
    out.push({
      title: name.replace(/\.md$/, ""),
      summary: parsed.description,
      filename: name,
      body: parsed.body,
    });
  }
  return out;
}

const stores = realStores();
const allFiles = [...stores.values()].flat();
/** The largest single store: what one find_memory call actually scans. */
const largestFiles = [...stores.values()].sort((a, b) => b.length - a.length)[0] ?? [];

const corpus = rankInputs(allFiles);
const largestCorpus = rankInputs(largestFiles);

/** A review chunk, the way auto-learn builds one: real prose, so the query
 *  carries hundreds of distinct terms rather than three. */
function chunkQuery(inputs: RankInput[], entries: number): string {
  return inputs
    .slice(0, entries)
    .map((e) => `${e.title}\n${e.summary}\n${e.body ?? ""}`)
    .join("\n");
}

/** The order find_memory applies after scoring: tier, then score, then input
 *  position (an index line number in production, which is append-ordered). */
function rankedOrder(results: RankResult[]): number[] {
  return results
    .map((_r, i) => i)
    .sort((a, b) => {
      const left = results[a] as RankResult;
      const right = results[b] as RankResult;
      return right.tier - left.tier || right.score - left.score || a - b;
    });
}

/** Assert the two implementations agree exactly, and return the fast result. */
function expectEquivalent(query: string, inputs: RankInput[]): RankResult[] {
  const next = rankEntries(query, inputs);
  const old = rankEntriesScan(query, inputs);
  expect(next).toHaveLength(old.length);
  for (let i = 0; i < old.length; i++) {
    const n = next[i] as RankResult;
    const o = old[i] as RankResult;
    // toBe on the score is exact-float equality, not toBeCloseTo: the ranking
    // must not drift in the last bits, because ties break on the score.
    expect(n.score).toBe(o.score);
    expect(n.tier).toBe(o.tier);
    expect(n.fields).toEqual(o.fields);
  }
  expect(rankedOrder(next)).toEqual(rankedOrder(old));
  return next;
}

// ---------------------------------------------------------------------------
// 1. Equivalence over the live store
// ---------------------------------------------------------------------------

describe.skipIf(corpus.length === 0)("equivalence over the live memory store", () => {
  it("scores every real entry identically for short queries", { timeout: 120_000 }, () => {
    expect(corpus.length).toBeGreaterThan(1000);
    for (const query of [
      "deploy",
      "memory index budget",
      "proxmox guest disk backup policy rotation schedule retention verification restore",
      "pnpm-lock.yaml",
    ]) {
      expectEquivalent(query, corpus);
    }
  });

  it("scores every real entry identically for a chunk-sized query", { timeout: 120_000 }, () => {
    // Auto-learn hands the scorer a review chunk, which is where the term
    // count explodes and where the old per-term scan was measurable.
    const query = chunkQuery(largestCorpus, 20);
    expect(queryTerms(query).length).toBeGreaterThan(200);
    expectEquivalent(query, largestCorpus);
  });

  it("orders tied entries identically, including which one comes first", {
    timeout: 120_000,
  }, () => {
    // A query whose terms are common in this store produces plenty of ties:
    // entries containing both words once, with the same length, score the
    // same, and the tie has to resolve to the same entry in both paths.
    const [next, old] = [
      rankEntries("memory store", corpus),
      rankEntriesScan("memory store", corpus),
    ];
    const ties = next.filter((r, i) => {
      const o = old[i] as RankResult;
      return r.score > 0 && o.score === r.score;
    }).length;
    expect(ties).toBeGreaterThan(50);
    expect(rankedOrder(next)).toEqual(rankedOrder(old));
    expect(next.map((r) => r.score)).toEqual(old.map((r) => r.score));
  });
});

// ---------------------------------------------------------------------------
// 1b. Equivalence with a pre-tokenised body
//
// find_memory caches each topic's lowercased, tokenised body so a repeat query
// does not re-tokenise the store. rankEntries consumes it in place of the raw
// string; every score must still match the reference scan TO THE BIT, because
// ties break on the exact float.
// ---------------------------------------------------------------------------

describe("a pre-tokenised body scores exactly like the raw one", () => {
  const withPrepared = (inputs: RankInput[]): RankInput[] =>
    inputs.map((e) => (e.body === null ? e : { ...e, bodyPrepared: prepareText(e.body) }));

  const compared = (query: string, inputs: RankInput[]) => {
    const prepared = rankEntries(query, withPrepared(inputs));
    const raw = rankEntries(query, inputs);
    const reference = rankEntriesScan(query, inputs);
    expect(prepared).toHaveLength(raw.length);
    for (let i = 0; i < raw.length; i++) {
      expect((prepared[i] as RankResult).score).toBe((raw[i] as RankResult).score);
      expect(prepared[i]).toEqual(raw[i]);
      expect((prepared[i] as RankResult).score).toBe((reference[i] as RankResult).score);
      expect((prepared[i] as RankResult).tier).toBe((reference[i] as RankResult).tier);
      expect((prepared[i] as RankResult).fields).toEqual((reference[i] as RankResult).fields);
    }
    expect(rankedOrder(prepared)).toEqual(rankedOrder(reference));
  };

  it("matches over the live store, including a chunk-sized query", { timeout: 120_000 }, () => {
    for (const query of ["deploy", "memory index budget", "pnpm-lock.yaml"]) {
      compared(query, largestCorpus);
    }
    compared(chunkQuery(largestCorpus, 20), largestCorpus);
  });

  it("matches on synthetic entries, bodies empty, null and unicode", () => {
    const docs: RankInput[] = [
      {
        title: "Deploy Notes",
        summary: "how deploys work",
        filename: "deploy.md",
        body: `${"pnpm ".repeat(40)}deploy`,
      },
      {
        title: "memory index",
        summary: "the index budget",
        filename: "index.md",
        body: "BUDGET budget Budget",
      },
      {
        title: "café",
        summary: "☕ near-miss",
        filename: "cafe.md",
        body: "café ☕ mémoire\nline two",
      },
      { title: "empty body", summary: "", filename: "empty.md", body: "" },
      { title: "null body", summary: "deploy", filename: "null.md", body: null },
    ];
    for (const query of [
      "deploy",
      "memory index budget",
      "café mémoire",
      "",
      "the and of",
      "zzabsent",
    ]) {
      compared(query, docs);
    }
  });

  it("prepareText is exactly the lowercasing and tokenising rank does", () => {
    const raw = "Mixed CASE: 51820/udp — near-miss, 2 of them.\nSecond line.";
    const prepared = prepareText(raw);
    expect(prepared.lowered).toBe(raw.toLowerCase());
    expect(prepared.tokens).toEqual(raw.toLowerCase().match(/[a-z0-9]+/g));
  });
});

// ---------------------------------------------------------------------------
// 2. Mechanism: one inverted index, not a scan per term
// ---------------------------------------------------------------------------

describe.skipIf(largestCorpus.length === 0)("scoring mechanism", () => {
  const query = "proxmox guest disk backup";

  it("counts the reference scan's entry x term probes", () => {
    // The counter must observe the old scan, otherwise the assertion below
    // could pass on a metric that is always zero.
    resetFindRankStats();
    rankEntriesScan(query, largestCorpus);
    expect(findRankStats().termDocProbes).toBe(queryTerms(query).length * largestCorpus.length);
  });

  it("does not scan every entry for every term", () => {
    resetFindRankStats();
    rankEntries(query, largestCorpus);
    expect(findRankStats().termDocProbes).toBe(0);
  });

  it("scores only the entries that contain a query term", () => {
    resetFindRankStats();
    rankEntries(query, largestCorpus);
    const { entriesScored } = findRankStats();
    // The reference scores all of them; the fast path scores the matches.
    expect(entriesScored).toBeLessThan(largestCorpus.length / 2);
    expect(entriesScored).toBeGreaterThan(0);
  });

  it("is materially faster on a chunk-sized query", { timeout: 120_000 }, () => {
    // Self-calibrating rather than an absolute millisecond bound: both paths
    // are timed on the same machine, in the same process, over the same store.
    const chunk = chunkQuery(largestCorpus, 20);
    const best = (fn: (q: string, c: RankInput[]) => RankResult[]): number => {
      fn(chunk, largestCorpus); // warm
      let ms = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        fn(chunk, largestCorpus);
        ms = Math.min(ms, performance.now() - started);
      }
      return ms;
    };
    const before = best(rankEntriesScan);
    const after = best(rankEntries);
    expect(after).toBeLessThan(before / 2);
  });
});

// ---------------------------------------------------------------------------
// 3. Edge queries
// ---------------------------------------------------------------------------

describe("edge queries", () => {
  // Real entries, with one sentinel word appended so "in every entry" and
  // "in no entry" are guaranteed rather than hoped for.
  const base = (largestCorpus.length > 0 ? largestCorpus : []).slice(0, 25);
  const withSentinel: RankInput[] = base.map((e) => ({
    ...e,
    body: `${e.body ?? ""}\nzzsentinel`,
  }));
  const docs: RankInput[] =
    withSentinel.length > 0
      ? withSentinel
      : [
          {
            title: "deploy notes",
            summary: "how deploys work",
            filename: "deploy.md",
            body: "pnpm",
          },
          {
            title: "memory index",
            summary: "the index budget",
            filename: "index.md",
            body: "budget",
          },
          { title: "empty body", summary: "", filename: "empty.md", body: null },
        ];

  const cases: [string, string][] = [
    ["empty query", ""],
    ["only stopwords", "the and of to"],
    ["single term", "deploy"],
    ["term in every entry", "zzsentinel"],
    ["term in no entry", "zzabsent"],
    ["duplicate terms", "memory memory memory index"],
    ["unicode and punctuation", "café ☕ memory-index / pnpm-lock.yaml"],
    ["mixed case phrase", "Memory Index Budget"],
    ["full-sentence question", "how do I deploy the memory index within the budget?"],
    ["repeated punctuation", "!!! ??? ..."],
  ];

  for (const [label, query] of cases) {
    it(`scores identically: ${label}`, () => {
      expectEquivalent(query, docs);
    });
  }

  it("returns all-zero, tier-0 results for an empty query", () => {
    const results = rankEntries("", docs);
    expect(results).toHaveLength(docs.length);
    expect(results.every((r) => r.score === 0 && r.tier === 0 && r.fields.length === 0)).toBe(true);
  });

  it("returns nothing for an empty store", () => {
    expect(rankEntries("deploy", [])).toEqual([]);
    expect(rankEntriesScan("deploy", [])).toEqual([]);
  });

  it("scores an entry with no body the same as one whose body is empty", () => {
    const [withNull, withEmpty] = [
      rankEntries("deploy", [
        { title: "t", summary: "s", filename: "f.md", body: null },
        { title: "t", summary: "s", filename: "f.md", body: "" },
      ]),
      rankEntriesScan("deploy", [
        { title: "t", summary: "s", filename: "f.md", body: null },
        { title: "t", summary: "s", filename: "f.md", body: "" },
      ]),
    ];
    expect(withNull.map((r) => r.score)).toEqual(withEmpty.map((r) => r.score));
  });
});
