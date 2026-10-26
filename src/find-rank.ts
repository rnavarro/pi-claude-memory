// Relevance ranking for find_memory.
//
// Any keyword is enough to match; entries are ranked by a field-weighted BM25
// (BM25F-style: term frequencies are weighted per field before saturation) with
// IDF computed over the store being searched. Two exact tiers sit above the
// BM25 order so the old all-words behaviour is never lost: an entry holding the
// whole query as a phrase ranks first, then one holding every keyword, then
// everything else by score.
//
// All-words used to be the only semantics, and on a full-sentence question it
// matched almost nothing: measured against the real ~1,600-entry store it found
// the answer for 1 of 25 questions, against 16 of 25 in the top five for this
// ranking.

/** Which part of an entry a keyword was found in. */
export type FindField = "title" | "summary" | "filename" | "body";

/** Per-field weight applied to term frequency and length. Metadata is written
 * to summarise the entry, so a hit there says more than a passing mention in a
 * long body. */
const FIELD_WEIGHT: Record<FindField, number> = {
  title: 3,
  summary: 3,
  filename: 2,
  body: 1,
};

const K1 = 1.2;
const B = 0.75;

/** Words that carry no search meaning in a question. Kept short on purpose:
 * over-stopping hides real keywords ("key", "host", "run" are meaningful here). */
const STOPWORDS = new Set(
  (
    "a an the and or but if then else of to in on at by for from with without into onto over under " +
    "about as is are was were be been being do does did doing done have has had i me my we our us " +
    "you your it its this that these those there here what which who whom whose why how when where " +
    "can could should would will shall may might must not no yes any either neither all some both " +
    "each every other another than too very just still ever really instead also so such only own " +
    "same few more most much many out up down off again once am get got make makes made go going " +
    "want need tell say says said look looks like whether think kind kinds doesn don isn aren wasn " +
    "after before during toward across"
  ).split(" "),
);

/** Lowercased alphanumeric tokens. Punctuation splits ("my-app" is two
 * tokens), which matches how the store's filenames and prose are written. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** The query's search terms: tokens minus stopwords and single characters,
 * deduplicated. If filtering leaves nothing (a query of only stopwords), the
 * raw tokens are used rather than refusing the search. */
export function queryTerms(query: string): string[] {
  const raw = tokenize(query);
  const kept = raw.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(kept.length > 0 ? kept : raw)];
}

/** One searchable entry. `body` is null when the topic could not be read. */
export interface RankInput {
  title: string;
  summary: string;
  filename: string;
  body: string | null;
}

export interface RankResult {
  /** BM25F score; 0 means no keyword matched. */
  score: number;
  /** 2 = whole query as a phrase, 1 = every keyword present, 0 = partial. */
  tier: 0 | 1 | 2;
  /** Fields containing at least one keyword, in display order. */
  fields: FindField[];
}

/** The entry's searchable fields, in the order they are displayed. */
function fieldsOf(e: RankInput): [FindField, string][] {
  const out: [FindField, string][] = [
    ["title", e.title],
    ["summary", e.summary],
    ["filename", e.filename],
  ];
  if (e.body !== null) out.push(["body", e.body]);
  return out;
}

/** The query as written, whitespace-collapsed, for the exact-phrase tier. */
function phraseOf(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Which exact tier a scored entry earns. The tiers use substring matching over
 * the raw text, which is what find_memory's all-words mode always did, so every
 * hit that mode found still ranks above a partial match. */
function tierOf(score: number, phrase: string, terms: readonly string[], all: string): 0 | 1 | 2 {
  return score > 0 && phrase.length > 0 && all.includes(phrase)
    ? 2
    : score > 0 && terms.every((t) => all.includes(t))
      ? 1
      : 0;
}

/** Counters for the work one ranking call did, so the equivalence test can
 * observe which loop ran instead of inferring it from a wall clock.
 *
 * `termDocProbes` counts entry x term membership tests used to derive document
 * frequencies: the reference scan makes one per term per entry. `entriesScored`
 * counts entries whose scoring loop ran at all. Neither is a diagnostic for
 * operators; nothing reads them outside `test/find-rank.test.ts`. */
export interface FindRankStats {
  termDocProbes: number;
  entriesScored: number;
}

let termDocProbes = 0;
let entriesScored = 0;

/** Work counters for the scorer since the last reset. */
export function findRankStats(): FindRankStats {
  return { termDocProbes, entriesScored };
}

export function resetFindRankStats(): void {
  termDocProbes = 0;
  entriesScored = 0;
}

/** Rank every entry against `query`. Returns one result per input, in input
 * order; callers sort. IDF is computed over `inputs`, i.e. per call over the
 * store being searched.
 *
 * One pass over the entries builds the inverted index: per query term, the
 * documents holding it and the term's weight in each, in the order the term
 * first appeared in that entry. Document frequency is then the posting's
 * length, so IDF costs O(terms) instead of one full scan of the entries per
 * term, and only entries that contain a query term are scored at all. The same
 * entry x term pairs are summed in the same order as the reference scan, so the
 * scores are identical to the last bit rather than merely close. */
export function rankEntries(query: string, inputs: RankInput[]): RankResult[] {
  const terms = queryTerms(query);
  const n = inputs.length;
  const phrase = phraseOf(query);
  const results: RankResult[] = new Array(n);
  if (n === 0) return results;

  // Query term -> its index in `terms` (queryTerms already deduplicated, so no
  // term appears twice and the index is stable).
  const termIndex = new Map<string, number>();
  for (let i = 0; i < terms.length; i++) termIndex.set(terms[i] as string, i);

  // The postings, flat: entry `d` owns slots [docStart[d], docStart[d] + docCount[d]),
  // pushed in entry order and, within an entry, in term-first-seen order.
  const slotTerm: number[] = [];
  const slotWeight: number[] = [];
  const docStart = new Int32Array(n);
  const docCount = new Int32Array(n);
  const docLength = new Float64Array(n);
  const matched: number[] = [];
  const matchedFields: FindField[][] = [];
  const matchedLowered: string[][] = [];

  // Reused across entries: an entry's term frequencies are copied into the
  // postings as it is read, so no Map per entry is retained.
  const tf = new Map<string, number>();
  let totalLength = 0;
  for (let d = 0; d < n; d++) {
    const e = inputs[d] as RankInput;
    tf.clear();
    let length = 0;
    const hitFields: FindField[] = [];
    const lowered: string[] = [];
    for (const [field, text] of fieldsOf(e)) {
      const w = FIELD_WEIGHT[field];
      const low = text.toLowerCase();
      lowered.push(low);
      const tokens = tokenize(low);
      length += w * tokens.length;
      let hit = false;
      for (const tok of tokens) {
        if (!termIndex.has(tok)) continue;
        tf.set(tok, (tf.get(tok) ?? 0) + w);
        hit = true;
      }
      if (hit) hitFields.push(field);
    }
    docLength[d] = length;
    totalLength += length;
    if (tf.size === 0) continue;
    matched.push(d);
    docStart[d] = slotTerm.length;
    docCount[d] = tf.size;
    matchedFields.push(hitFields);
    matchedLowered.push(lowered);
    for (const [t, w] of tf) {
      slotTerm.push(termIndex.get(t) as number);
      slotWeight.push(w);
    }
  }

  // Total length is summed in entry order, as the reference does, so the average
  // (and everything scaled by it) is bit-identical.
  const avgLength = totalLength / n || 1;

  const df = new Int32Array(terms.length);
  for (let s = 0; s < slotTerm.length; s++) df[slotTerm[s] as number]++;
  const idf = new Float64Array(terms.length);
  for (let t = 0; t < terms.length; t++) {
    const seen = df[t] as number;
    idf[t] = Math.log(1 + (n - seen + 0.5) / (seen + 0.5));
  }

  entriesScored += matched.length;
  for (let m = 0; m < matched.length; m++) {
    const d = matched[m] as number;
    const start = docStart[d] as number;
    const end = start + (docCount[d] as number);
    // Depends only on the entry's length, so it is computed once per entry
    // rather than once per term. Same arithmetic, same result.
    const denom = K1 * (1 - B + (B * (docLength[d] as number)) / avgLength);
    let score = 0;
    for (let s = start; s < end; s++) {
      const w = slotWeight[s] as number;
      score += (idf[slotTerm[s] as number] as number) * ((w * (K1 + 1)) / (w + denom));
    }
    const all = (matchedLowered[m] as string[]).join("\n");
    results[d] = {
      score,
      tier: tierOf(score, phrase, terms, all),
      fields: matchedFields[m] as FindField[],
    };
  }
  for (let d = 0; d < n; d++) {
    // No query term in this entry: the reference's score is 0 by construction,
    // which forces tier 0 and no matching fields without looking at the text.
    if (docCount[d] === 0) results[d] = { score: 0, tier: 0, fields: [] };
  }
  return results;
}

/** The pre-inverted-index scorer: one full pass over every entry per query term
 * to count document frequencies, then a second pass that scans each entry's term
 * frequencies. Kept as the reference the equivalence test compares against, so a
 * change to the scoring maths cannot pass by being identical to itself. Slow by
 * construction (O(terms x entries)) and never used in production. */
export function rankEntriesScan(query: string, inputs: RankInput[]): RankResult[] {
  const terms = queryTerms(query);
  // A Set for the per-token membership test: a review chunk used as the query
  // carries thousands of terms, and a linear scan per token made ranking a
  // large store quadratic in practice.
  const termSet = new Set(terms);
  const phrase = phraseOf(query);

  // Per entry: weighted term frequencies, weighted length, and which fields hit.
  const docs = inputs.map((e) => {
    const tf = new Map<string, number>();
    const hitFields: FindField[] = [];
    let length = 0;
    const lowered: string[] = [];
    for (const [field, text] of fieldsOf(e)) {
      const w = FIELD_WEIGHT[field];
      const low = text.toLowerCase();
      lowered.push(low);
      const tokens = tokenize(low);
      length += w * tokens.length;
      let hit = false;
      for (const tok of tokens) {
        if (!termSet.has(tok)) continue;
        tf.set(tok, (tf.get(tok) ?? 0) + w);
        hit = true;
      }
      if (hit) hitFields.push(field);
    }
    return { tf, length, hitFields, lowered };
  });

  const n = docs.length;
  const avgLength = n > 0 ? docs.reduce((s, d) => s + d.length, 0) / n || 1 : 1;
  const idf = new Map<string, number>();
  for (const t of terms) {
    termDocProbes += n;
    const df = docs.filter((d) => d.tf.has(t)).length;
    idf.set(t, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  entriesScored += n;
  return docs.map((d) => {
    let score = 0;
    for (const [t, f] of d.tf) {
      const norm = f + K1 * (1 - B + (B * d.length) / avgLength);
      score += (idf.get(t) ?? 0) * ((f * (K1 + 1)) / norm);
    }
    const tier = tierOf(score, phrase, terms, d.lowered.join("\n"));
    return { score, tier, fields: d.hitFields };
  });
}
