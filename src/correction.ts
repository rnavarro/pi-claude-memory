// Correction detector: does the user's latest message correct the agent?
//
// A correction ("no, use pnpm", "don't touch the lockfile", "from now on run
// the linter first") is the single most valuable thing for auto-learn to save,
// and the every-N-turns review can arrive long after it, or never in a short
// session. index.ts uses this to trigger an early review instead.
//
// Leans toward recall. A false positive costs one debounced background
// review; a miss leaves the correction to the periodic and shutdown reviews,
// which may come much later. Still, most patterns are anchored at the start
// of a sentence, ordinary idioms ("no problem", "don't worry", "never mind")
// are excluded, "stop" needs a gerund ("stop adding comments", not "stop the
// server"), "X not Y" contrasts need a short sentence or a code-ish token, and
// questions count only for the strongest markers.
//
// Every pattern has a name, returned by detectCorrectionPattern, so the debug
// log can record WHICH pattern fired (never the message text) for tuning.
//
// Pure: no state, no I/O. Exported for tests.

/** Leading fillers stripped before the sentence-anchored patterns run, so
 * "no, don't do that" and "please never commit" are anchored at the verb. */
const LEAD_FILLER =
  /^(?:(?:no|nope|nah|wait|ugh|actually|again|please|and|but|so|also|ok|okay|hey|seriously|hmm|look)\b[\s,!:;\-—–]*)+/;

/** Words after "don't" that make an idiom, not an instruction. */
const DONT_STOP = new Set([
  "worry",
  "bother",
  "mind",
  "forget",
  "hesitate",
  "panic",
  "stress",
  "apologize",
  "apologise",
  "sweat",
  "know",
  "care",
  "think",
  "you",
  "we",
  "i",
  "they",
]);

/** Words after "never" that make an idiom, not an instruction. */
const NEVER_STOP = new Set(["mind", "heard", "seen", "knew", "thought", "been", "was", "had"]);

/** Words after "not" that make a hedge, not a "not X, Y" correction. */
const NOT_STOP = /^not\s+(?:sure|bad|yet|really|now|quite|much|exactly|necessarily|a problem)\b/;

/** What may follow a leading "no," without making it a correction. Checked
 * before NO_REMAINDER_GO, so "no, that's fine" and "no, you're right" lose. */
const NO_REMAINDER_STOP =
  /^(?:thanks|thank|problem|worries|worry|need|rush|way|idea|clue|pressure|never mind|(?:don't|dont|do not) (?:worry|bother|mind|apologi[sz]e|sweat)|(?:that|it)(?:'s| is) (?:fine|ok|okay|all|alright|good)|all good|i'm good|go ahead|you(?:'re| are) right)\b/;

/** What must follow a leading "no," for it to be a correction: an
 * instruction, a restatement, or a claim about what is true. "No, I don't
 * think so" answers a question; "no, use pnpm" corrects. */
const NO_REMAINDER_GO =
  /^(?:use|do|don't|dont|never|always|not|it's|it is|it should|that's|that is|this is|the|i said|i meant|i asked|i told|i want|i wanted|i need|we|you should|you need|you have|instead|just|run|try|put|call|keep|leave|stop|wrong|remove|delete|add|change|make)\b/;

type Pattern = readonly [name: string, re: RegExp];

/** Matched even in a question: these phrases are corrections however they end. */
const STRONG: readonly Pattern[] = [
  ["told-you", /^i (?:already |just |literally )?(?:told|asked) you\b/],
  ["i-said", /^i (?:already |just )?said (?:not|to|don't|never|always|use)\b/],
  [
    "thats-wrong",
    /^(?:that|this|it)(?:'s| is) (?:wrong|incorrect|not right|not correct|not what i (?:asked|said|meant|wanted))\b/,
  ],
  ["youre-wrong", /^(?:you(?:'re| are)) wrong\b/],
  ["not-how", /\bnot how (?:it|this|that|we|you|i)\b/],
  ["you-keep", /\byou keep (?:\w+ing|on)\b/],
  ["from-now-on", /\bfrom now on\b/],
];

/** Sentence-start patterns that count only when the sentence is not a question. */
const PLAIN: readonly Pattern[] = [
  ["stop-ing", /^stop \w+ing\b/],
  ["always", /^(?:always) \w+/],
  ["instead", /^instead,? (?:use|do|run|try|call|put|write)\b/],
  ["use-instead", /^use \S.* instead\b/],
  ["use-not", /^(?:use|run|call|put|write) [^,]+, not \S/],
  ["prefer", /^i(?:'d| would)? (?:prefer|rather)\b/],
  [
    "revert",
    /^(?:revert|undo|roll back)\s+(?:it|that|this|those|these|your|what you|the (?:last )?changes?)\b/,
  ],
  ["we-use-here", /^we (?:use|run|prefer|do|keep|put)\b.*\bhere\b/],
];

/** A leading "actually" that is not agreement or a retraction. */
const ACTUALLY = /^actually\b[\s,:\-—–]*(\S.*)$/;
const ACTUALLY_STOP =
  /^(?:never mind|thanks|thank|no worries|(?:that|it|this)(?:'s| is)? ?(?:works?|worked|fine|good|great|perfect|looks|ok|okay|right|correct))\b/;

/** "X not Y" contrast, ending the sentence or a clause: "it's 8443 not 8080",
 * "we use pnpm here, not npm". X must not be an auxiliary ("do not know",
 * "is not working") and Y not a hedge ("not sure"). */
const CONTRAST = /(?:^|\s)([^\s,]+),?\s+not\s+([^\s,]+)\s*(?:,|$)/;
const CONTRAST_X_STOP = new Set([
  "do",
  "does",
  "did",
  "is",
  "are",
  "was",
  "were",
  "am",
  "i'm",
  "can",
  "could",
  "should",
  "would",
  "will",
  "have",
  "has",
  "had",
  "why",
  "or",
  "if",
  "and",
  "but",
  "probably",
  "just",
  "maybe",
  "still",
  "really",
  "definitely",
  "certainly",
  "absolutely",
  "may",
  "might",
  "must",
  "it's",
  "that's",
  "isn't",
  "whether",
  "hopefully",
  "i",
  "we",
  "you",
  "they",
  "it",
  "that",
  "this",
  "why",
]);
const CONTRAST_Y_STOP = new Set([
  "sure",
  "yet",
  "really",
  "now",
  "bad",
  "quite",
  "much",
  "exactly",
  "necessarily",
  "today",
  "working",
  "work",
  "works",
  "enough",
  "always",
  "anymore",
  "important",
  "needed",
  "required",
  "possible",
  "ideal",
  "great",
]);
/** Code-ish: a digit, or a character that shows up in paths, flags, hosts. */
const CODEISH = /[\d./_:=@#-]/;

function contrastIsCorrection(s: string): boolean {
  const m = CONTRAST.exec(s);
  if (!m) return false;
  const x = m[1] ?? "";
  const y = m[2] ?? "";
  if (CONTRAST_X_STOP.has(x) || CONTRAST_Y_STOP.has(y)) return false;
  const short = s.split(/\s+/).length <= 8;
  return short || CODEISH.test(x) || CODEISH.test(y);
}

/** Remove material the user is quoting rather than saying: fenced code,
 * inline code, blockquote lines, and double-quoted spans. */
function stripQuoted(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^[ \t]*>.*$/gm, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/“[^”\n]*”/g, " ");
}

interface Sentence {
  body: string;
  question: boolean;
}

/** Split into sentences, keeping whether each one ended with a question mark. */
function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const m of text.matchAll(/[^.!?;\n]+[.!?;]*/g)) {
    const raw = m[0].trim();
    const body = raw.replace(/[.!?;]+$/, "").trim();
    if (body) out.push({ body, question: raw.endsWith("?") });
  }
  return out;
}

/** One sentence, fillers already stripped. Returns the pattern name. */
function sentencePattern(s: string, question: boolean): string | null {
  for (const [name, re] of STRONG) if (re.test(s)) return name;
  if (question) return null;

  const dont = /^(?:don't|dont|do not)\s+([a-z']+)/.exec(s);
  if (dont && !DONT_STOP.has(dont[1] ?? "")) return "dont";

  const never = /^never\s+([a-z']+)/.exec(s);
  if (never && !NEVER_STOP.has(never[1] ?? "")) return "never";

  if (/^not\s+[^,]+,\s*(?:but\s+)?\S/.test(s) && !NOT_STOP.test(s)) return "not-x-y";

  for (const [name, re] of PLAIN) if (re.test(s)) return name;

  if (contrastIsCorrection(s)) return "x-not-y";
  return null;
}

/** A sentence opening with "actually" that goes on to state something:
 * "Actually the port is 8443". Checked before the filler strip removes it. */
function actuallyIsCorrection(body: string, question: boolean): boolean {
  if (question) return false;
  const m = ACTUALLY.exec(body);
  if (!m) return false;
  return !ACTUALLY_STOP.test((m[1] ?? "").trim());
}

/** A message that opens with "no" / "nope" and goes on to say something
 * ("no, use X", "No — use X", "No. The file is in src"), rather than "no
 * problem" or a bare "no" answering a yes/no question. */
function leadingNoIsCorrection(sents: Sentence[]): boolean {
  const first = sents[0];
  if (!first || first.question) return false;
  const m = /^(?:no|nope)\b\s*[,:;!\-—–]*\s*(.*)$/.exec(first.body);
  if (!m) return false;
  const rest = (m[1] ?? "").trim();
  if (rest) {
    // "no, <something>" in the same sentence. Without the separator this is
    // "no problem", "no need", "no way": the regex above allows a bare
    // space, so require punctuation or a dash between "no" and the rest.
    if (!/^(?:no|nope)\s*[,:;!\-—–]/.test(first.body)) return false;
    return !NO_REMAINDER_STOP.test(rest) && NO_REMAINDER_GO.test(rest);
  }
  // A bare "No." followed by a further statement: "No. Use the other one."
  const next = sents[1];
  if (!next || next.question) return false;
  return !NO_REMAINDER_STOP.test(next.body) && NO_REMAINDER_GO.test(next.body);
}

/**
 * The name of the pattern that marks the text as the user correcting the
 * agent or stating a standing rule, or null. Case-insensitive; quoted and
 * code text is ignored; slash commands and `!` shell escapes never match.
 */
export function detectCorrectionPattern(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("!")) return null;

  const cleaned = stripQuoted(trimmed.toLowerCase().replace(/[‘’]/g, "'"));
  const sents = sentences(cleaned);
  if (sents.length === 0) return null;

  if (leadingNoIsCorrection(sents)) return "leading-no";

  for (const { body, question } of sents) {
    if (actuallyIsCorrection(body, question)) return "actually";
    const s = body.replace(LEAD_FILLER, "").trim();
    if (!s) continue;
    const name = sentencePattern(s, question);
    if (name) return name;
  }
  return null;
}

/** True when detectCorrectionPattern finds any pattern. */
export function detectCorrection(text: string): boolean {
  return detectCorrectionPattern(text) !== null;
}
