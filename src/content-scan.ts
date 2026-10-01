// Content scan for memory writes: auto-learned candidates (every rule) and
// explicit write_memory calls (injection and invisible-character rules only).
//
// Auto-learn writes text an LLM extracted from a conversation, and that text
// can carry whatever the conversation carried: a pasted token, or instructions
// planted in a tool result. A written entry's title and description land in
// MEMORY.md, which is injected into every turn of every later session, so a
// bad candidate is a persistent prompt injection or a persistent secret leak.
//
// This module is pure and import-free on purpose: no fs, no logging, no
// sibling imports, so it can be run standalone (e.g. a read-only sweep over a
// real store) and tested without a store.
//
// Scope, deliberately narrow:
// - Prompt-injection phrases and fake role/boundary tags. Conservative: the
//   store is full of notes about agents, prompts and tools, so only phrasings
//   that address the reader as an instruction are matched, and a tag counts
//   only as a closing tag or alone on its own line, never named in prose.
// - Invisible / control characters: zero-width (soft hyphen, CGJ, Mongolian
//   vowel separator included), bidi overrides and isolates, Unicode tag
//   characters, C0/C1 controls other than tab and newline.
// - Secret VALUES, never secret keywords. Notes ABOUT tokens ("pass show
//   work/api-password", MY_SERVICE_TOKEN, an "API Token" field name) are
//   legitimate and must pass; only known key formats and long random-looking
//   strings (mixed-case base64-ish, or 32+ hex after a credential label) are rejected, and only after
//   "=" or ":", "Bearer", a credential flag (--token, --api-key) or
//   "token is". Hyphenated names and model ids, hashes after a digest word,
//   and SSH public-key blobs are not secrets.
// - Every regex is linear or bounded: the rules run on LLM output, which an
//   attacker can shape.
//
// Reasons never contain a raw secret: matched snippets are masked to their
// first 4 characters plus "***", because reasons go to the debug log.

/** Result of scanning one candidate. */
export type ContentScanResult = { ok: true } | { ok: false; reasons: string[] };

/** One finding inside one piece of text. `snippet` is already masked when the
 *  finding is a secret, and truncated otherwise. */
export interface ContentFinding {
  kind: "injection" | "invisible" | "secret";
  rule: string;
  snippet: string;
}

/** Mask a secret value: keep the first 4 characters only. */
export function maskSecret(value: string): string {
  return `${value.slice(0, 4)}***`;
}

function clip(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ---------------------------------------------------------------------------
// Prompt injection
// ---------------------------------------------------------------------------

/** Role and boundary tag names: system blocks, this plugin's own memory
 *  boundary, and chat roles. Used as a regex alternation. */
const ROLE_TAG_NAMES =
  "system|system[-_]prompt|system[-_]reminder|instructions?|memory|memory[-_]index|memory[-_]note|memory[-_]search|stored[-_]memory|assistant|user|human|developer";

const INJECTION_RULES: { rule: string; re: RegExp }[] = [
  {
    rule: "ignore-previous-instructions",
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|foregoing)\s+(?:instructions|prompts?|rules|directions|directives|guidelines|context)\b/i,
  },
  {
    rule: "ignore-all-instructions",
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all|any)\s+(?:of\s+)?(?:the\s+|your\s+)?(?:instructions|rules|directives|guidelines)\b/i,
  },
  {
    rule: "disregard-system-prompt",
    re: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:the\s+|your\s+|any\s+)?(?:system|developer)\s+(?:prompt|message|instructions)\b/i,
  },
  {
    // A role reassignment addressed to the reader. "you are now on branch X"
    // is ordinary prose, so the phrase must continue into a persona or mode.
    rule: "role-reassignment",
    re: /\byou\s+are\s+now\s+(?:a|an|the|in|operating\s+as|acting\s+as)\s+(?:new\s+|different\s+|unrestricted\s+|unfiltered\s+|jailbroken\s+)?(?:assistant|ai|agent|model|persona|character|dan\b|developer\s+mode|god\s+mode|jailbreak|unrestricted|unfiltered)/i,
  },
  {
    rule: "new-instructions-header",
    re: /(?:^|\n)[ \t]{0,40}(?:new|updated|real|actual)[ \t]+(?:system[ \t]+)?instructions[ \t]{0,40}:/i,
  },
  {
    // Fake role or boundary tags. A CLOSING tag is rejected anywhere: nothing
    // legitimate closes a system block, this plugin's own memory boundary, or
    // a chat turn. An OPENING tag is rejected only when it sits alone on its
    // own line, the shape of a real block; a tag named inline in prose
    // ("wrapped in <memory-index> tags", "/home/<user>/Maildir") passes.
    rule: "fake-role-tag",
    re: new RegExp(`<[ \\t]{0,20}/[ \\t]{0,20}(?:${ROLE_TAG_NAMES})[ \\t]{0,20}>`, "i"),
  },
  {
    rule: "fake-role-tag",
    re: new RegExp(
      `^[ \\t]{0,40}<[ \\t]{0,20}(?:${ROLE_TAG_NAMES})[ \\t]{0,20}>[ \\t]{0,40}$`,
      "im",
    ),
  },
  {
    rule: "chat-template-token",
    re: /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/i,
  },
];

// ---------------------------------------------------------------------------
// Invisible / control characters
// ---------------------------------------------------------------------------

const INVISIBLE_RULES: { rule: string; re: RegExp }[] = [
  // Soft hyphen, combining grapheme joiner, Mongolian vowel separator, ZWSP,
  // ZWNJ, ZWJ, LRM, RLM, word joiner and invisible operators, BOM/ZWNBSP.
  { rule: "zero-width", re: /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]|\u034F/u },
  { rule: "bidi-override", re: /[\u202A-\u202E\u2066-\u2069]/u },
  { rule: "unicode-tag", re: /[\u{E0000}-\u{E007F}]/u },
  // C0 controls except tab (09), LF (0A), CR (0D); DEL; C1 controls.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters is the point
  { rule: "control-char", re: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u },
];

function codepoint(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** Known credential formats. Each is a VALUE shape; none is a keyword. */
const SECRET_FORMAT_RULES: { rule: string; re: RegExp }[] = [
  { rule: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { rule: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { rule: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  // OpenAI-style sk- keys. "sk-" also opens ordinary hyphenated words, so the
  // value must look like a key (checked in looksRandom), not just be long.
  { rule: "sk-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { rule: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { rule: "private-key-pem", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { rule: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { rule: "stripe-webhook-secret", re: /\bwhsec_[A-Za-z0-9]{16,}/g },
  { rule: "gitlab-pat", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { rule: "digitalocean-token", re: /\bdo[pro]_v1_[a-f0-9]{64}/g },
  // Starts only where a token run starts, and bounded: otherwise every "eyJ"
  // inside "eyJ-eyJ-..." is a fresh start that rescans the rest of the run,
  // which is quadratic.
  {
    rule: "jwt",
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{0,2000}/g,
  },
];

/** The end of a token: not followed by another token character, and a "."
 *  only as sentence punctuation (not "x.example.com"). Trailing ",;)" and a
 *  closing quote are not token characters, so they already end a token. */
const TOKEN_END = String.raw`(?![A-Za-z0-9+/_-])(?!\.[A-Za-z0-9_-])`;

/** A long token assigned after "=" or ":". The token alphabet excludes "."
 *  and leading "/" so paths, hostnames and URLs never qualify. */
const ASSIGNED_TOKEN_RE = new RegExp(
  String.raw`[=:][ \t]{0,40}["'${"`"}]?([A-Za-z0-9+_-][A-Za-z0-9+/_-]{31,}={0,2})${TOKEN_END}`,
  "g",
);

/** A token after a word that introduces one without "=" or ":": an HTTP
 *  "Bearer", a credential flag (--token, --api-key), or "token is". The noun
 *  list is limited to credential words, so "the commit is <sha>" never
 *  qualifies. */
const INTRODUCED_TOKEN_RE = new RegExp(
  String.raw`(?:\bbearer|(?:^|[\s"'(])--?(?:token|auth[-_]?token|access[-_]?token|api[-_]?key|api[-_]?token|secret|password|passwd|auth|credentials?)|\b(?:api[-_]?key|token|key|password|passwd|secret|pat|auth|credentials?)[ \t]{1,20}(?:is|was))[ \t]{1,20}["'${"`"}]?([A-Za-z0-9+_-][A-Za-z0-9+/_-]{23,}={0,2})${TOKEN_END}`,
  "gi",
);

/** A credential-like label right before an "=" or ":" (API_KEY=, apiKey=,
 *  "OpenWeatherMap key:", CF_DNS_API_TOKEN=). Bare hex counts as a secret only
 *  after one of these: unlabeled hex is usually an id, hash or signature. */
const CREDENTIAL_LABEL_RE =
  /(?:key|apikey|api_key|token|secret|password|passwd|pat|auth|credentials?|bearer)s?["'\]]?[ \t]{0,3}$/i;

/** An SSH public-key blob: base64 of a length-prefixed "ssh-*", "sk-ssh-*",
 *  "ecdsa-*" or "sk-ecdsa-*" key type name. Public material, not a secret. */
const SSH_PUBLIC_BLOB_RE = /^AAAA[A-Za-z0-9](?:3NzaC1|nNrLXNzaC1|2VjZHNh|nNrLWVjZHNh)/;

/** Hash / fingerprint / public-material prefixes that precede a long random
 *  string without it being a secret. Checked against the text just before the
 *  "=" or ":". */
const NON_SECRET_CONTEXT_RE =
  /(?:sha(?:1|224|256|384|512)|md5|blake2b?|sri|integrity|fingerprint|checksum|digest|hash|commit|revision|rev|uuid|guid|public[\s_-]?key|pubkey|publickey|ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp\d+)\W{0,3}$/i;

function shannonBitsPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether one separator-delimited segment reads as part of a name: a word
 *  ("Coder", camelCase "maxWorkers"), a word with digits ("Qwen3", "FP8"), a
 *  pure number ("0731", "4"), or a short size/version tag ("480B", "A35B").
 *  Counted as class changes: a lower-to-upper hump or a letter/digit switch.
 *  A random base64url segment switches class nearly every character. */
function isIdentifierSegment(seg: string): boolean {
  if (/^\d+$/.test(seg)) return true;
  if (!/^[A-Za-z0-9]+$/.test(seg)) return false;
  let changes = 0;
  for (let i = 1; i < seg.length; i++) {
    const a = seg[i - 1] ?? "";
    const b = seg[i] ?? "";
    const aDigit = /\d/.test(a);
    const bDigit = /\d/.test(b);
    if (aDigit !== bDigit) changes++;
    else if (/[a-z]/.test(a) && /[A-Z]/.test(b)) changes++;
  }
  return changes <= 2;
}

/** Whether a token reads as machine-random rather than as words or an
 *  identifier: mixed character classes and high per-character entropy.
 *  `labeled`: a credential-like label introduces the token. */
function looksRandom(token: string, labeled = false): boolean {
  // Long hex (API keys, webhook secrets) is single-case with at most 4 bits
  // per character, so it cannot pass the mixed-case and entropy checks below.
  // It counts only when labeled as a credential: unlabeled hex is far more
  // often a machine id, a hash or a signature.
  if (labeled && /^[0-9a-f]{32,}$/i.test(token) && /[0-9]/.test(token) && /[a-f]/i.test(token)) {
    return shannonBitsPerChar(token) >= 3.0;
  }
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  if (!hasDigit) return false;
  if (!(hasUpper && hasLower)) return false;
  // Identifier-shaped: words joined by separators (SOME_ENV_VAR_NAME,
  // my-long-kebab-name-2). Random tokens rarely have long letter-only runs
  // split cleanly by separators.
  // Path-shaped: "/" belongs to standard base64, "-" and "_" to base64url;
  // a token mixing them is not either encoding, it is a path or a model id
  // (provider/Model-Name-0731).
  if (token.includes("/") && /[-_]/.test(token)) return false;
  const segments = token.split(/[_-]/).filter(Boolean);
  if (segments.length >= 3 && segments.every(isIdentifierSegment)) return false;
  return shannonBitsPerChar(token) >= 4.0;
}

/** The shared judgement for a token found by a generic (non-format) rule:
 *  not after a hash/fingerprint/public-key context, not an SSH public-key
 *  blob, and random-looking rather than an identifier. `at` is where the
 *  match (its "=", ":" or introducing word) begins; `introduced` is true for
 *  INTRODUCED_TOKEN_RE, whose introducing word is itself a credential label. */
function isGenericSecret(text: string, at: number, value: string, introduced: boolean): boolean {
  const before = text.slice(Math.max(0, at - 40), at);
  if (NON_SECRET_CONTEXT_RE.test(before)) return false;
  if (SSH_PUBLIC_BLOB_RE.test(value)) return false;
  return looksRandom(value, introduced || CREDENTIAL_LABEL_RE.test(before));
}

function findSecrets(text: string): ContentFinding[] {
  const found: ContentFinding[] = [];
  const seen = new Set<string>();
  for (const { rule, re } of SECRET_FORMAT_RULES) {
    for (const m of text.matchAll(re)) {
      const value = m[0];
      if (rule === "sk-key" && !looksRandom(value.slice(3))) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      found.push({ kind: "secret", rule, snippet: maskSecret(value) });
    }
  }
  for (const re of [ASSIGNED_TOKEN_RE, INTRODUCED_TOKEN_RE]) {
    for (const m of text.matchAll(re)) {
      const value = m[1] ?? "";
      if (!value || seen.has(value)) continue;
      if (!isGenericSecret(text, m.index ?? 0, value, re === INTRODUCED_TOKEN_RE)) continue;
      seen.add(value);
      found.push({ kind: "secret", rule: "high-entropy-assignment", snippet: maskSecret(value) });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The finding kinds a scan can run. */
export type ContentFindingKind = ContentFinding["kind"];

const ALL_KINDS: readonly ContentFindingKind[] = ["injection", "invisible", "secret"];

/** Every finding in one piece of text, limited to `kinds` (all by default). */
export function findContentIssues(
  text: string,
  kinds: readonly ContentFindingKind[] = ALL_KINDS,
): ContentFinding[] {
  const findings: ContentFinding[] = [];
  if (kinds.includes("injection")) {
    for (const { rule, re } of INJECTION_RULES) {
      const m = re.exec(text);
      if (m) findings.push({ kind: "injection", rule, snippet: clip(m[0]) });
    }
  }
  if (kinds.includes("invisible")) {
    for (const { rule, re } of INVISIBLE_RULES) {
      const m = re.exec(text);
      if (m) findings.push({ kind: "invisible", rule, snippet: codepoint(m[0]) });
    }
  }
  if (kinds.includes("secret")) findings.push(...findSecrets(text));
  return findings;
}

/** Every regex the scan runs, labelled by rule, for tests that bound their
 *  running time. Callers must clone a "g" regex before use (lastIndex). */
export function scanRules(): { rule: string; re: RegExp }[] {
  return [
    ...INJECTION_RULES,
    ...INVISIBLE_RULES,
    ...SECRET_FORMAT_RULES,
    { rule: "assigned-token", re: ASSIGNED_TOKEN_RE },
    { rule: "introduced-token", re: INTRODUCED_TOKEN_RE },
    { rule: "non-secret-context", re: NON_SECRET_CONTEXT_RE },
    { rule: "ssh-public-blob", re: SSH_PUBLIC_BLOB_RE },
    { rule: "credential-label", re: CREDENTIAL_LABEL_RE },
  ];
}

/** The fields of a candidate that reach disk. */
export interface ScannableCandidate {
  name: string;
  description: string;
  body: string;
}

/**
 * Scan an auto-learn candidate's title, description and body. Title and
 * description become the MEMORY.md index line, injected every turn; the body
 * is what recall_memory returns. Any finding in any field rejects the entry.
 */
export function scanMemoryCandidate(
  c: ScannableCandidate,
  kinds: readonly ContentFindingKind[] = ALL_KINDS,
): ContentScanResult {
  const reasons: string[] = [];
  const fields: [string, string][] = [
    ["title", c.name],
    ["description", c.description],
    ["body", c.body],
  ];
  const inIndexFields = new Set<string>();
  for (const [field, value] of fields) {
    for (const f of findContentIssues(value, kinds)) {
      reasons.push(`${f.kind}:${f.rule} in ${field} (${f.snippet})`);
      if (field !== "body") inIndexFields.add(`${f.kind}:${f.rule}:${f.snippet}`);
    }
  }
  // The index line joins title and description, so a phrase split across the
  // two ("Ignore all previous" + "instructions: ...") is only visible joined.
  // A finding already reported for one field alone is not repeated.
  for (const f of findContentIssues(`${c.name} ${c.description}`, kinds)) {
    if (inIndexFields.has(`${f.kind}:${f.rule}:${f.snippet}`)) continue;
    reasons.push(`${f.kind}:${f.rule} in title+description (${f.snippet})`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** The finding kinds the explicit write_memory tool is scanned for.
 *
 * write_memory's arguments are authored by the model, not typed by the user, so
 * a prompt injection planted in a tool result can reach them just as it reaches
 * an auto-learn candidate. Secret rules are left out on this path: saving a
 * credential the user asked to keep is a deliberate choice, and the secret
 * rules' false positives would block ordinary requests. */
export const WRITE_TOOL_SCAN_KINDS: readonly ContentFindingKind[] = ["injection", "invisible"];

/** Scan a write_memory call: the same fields and joined index line as
 *  scanMemoryCandidate, with the injection and invisible-character rules only. */
export function scanWriteToolInput(c: ScannableCandidate): ContentScanResult {
  return scanMemoryCandidate(c, WRITE_TOOL_SCAN_KINDS);
}
