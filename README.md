# pi-claude-memory

A Pi extension that shares a memory store with Claude Code.

It reads and writes the same files Claude Code does: per-topic Markdown files
with YAML frontmatter, plus a `MEMORY.md` index that links them. Both agents
therefore see one store rather than two that drift apart. Memory is injected
into every prompt, can be written and recalled on demand through tools, and can
be reviewed and extended in the background from the conversation itself.

## Install

```bash
pnpm add pi-claude-memory
```

Add it to Pi's extension list in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["pi-claude-memory"]
}
```

Or point Pi at a local checkout, which is what the development workflow below
uses.

## How it works

**Two tiers.** Memory resolves per working directory:

| Tier | Location | Scope |
| --- | --- | --- |
| project | `~/.claude/projects/<encoded-cwd>/memory/` | this project only |
| global | `~/.claude/memory/` | every project |

A read that misses in the requested tier falls back to the other one. A write
or removal targets an exactly matching project store, so a mutation never lands
in another project's memory by accident. Project entries win the shared
injection budget, so a local correction outranks a global default.

**Injection.** Every turn the injector assembles a routing anchor, the index,
and as many full entry bodies as fit in the token budget. Entries whose bodies
did not fit are marked `⟨index-only⟩` so the model knows to fetch them; entries
whose file is gone are marked `⟨missing⟩` so it does not try. Cross-tier entries
are tagged with the tier that owns them.

**Auto-learning.** After a configurable number of turns Pi runs a background
review of the recent conversation, using a model of your choosing, and writes
any durable facts it finds into the store. The reviewer is told the identity of
every existing entry, so it supersedes an entry instead of creating a
duplicate. It runs on shutdown and before compaction as well.

**Tools.** `recall_memory`, `write_memory`, and `remove_memory`. Removal moves
the file into a per-removal directory under `.trash/` rather than deleting it,
and reports honestly when an index line was not found.

## Configuration

Settings live in `~/.pi/agent/settings.json` under a `pi-claude-memory` key.
Every field is optional.

```json
{
  "pi-claude-memory": {
    "autoLearn": false,
    "reviewIntervalTurns": 20,
    "injectTokenCap": 8000
  }
}
```

| Option | Default | Purpose |
| --- | --- | --- |
| `debugLog` | `true` | Write structured NDJSON to `~/.pi/agent/pi-claude-memory/debug/<sessionId>.ndjson` (rotated at 10 MB) |
| `autoLearn` | `true` | Run the background reviewer at all |
| `reviewIntervalTurns` | `10` | Turns between periodic reviews |
| `injectTokenCap` | `5000` | Token budget shared by both tiers each turn |
| `reviewModel` | `neuralwatt/deepseek-v4-flash` | Model used for reviews, as `{ "provider": ..., "id": ... }` |
| `reviewThinking` | `off` | Reasoning effort for the reviewer |
| `reviewMaxOutputTokens` | `2048` | Reviewer output cap |
| `reviewMaxChunkChars` | `50000` | Conversation characters sent per review |
| `reviewOnShutdown` | `true` | Review once when the session ends |
| `shutdownMinChunkChars` | `1000` | Do not review tiny shutdown chunks |
| `shutdownTimeoutMs` | `5000` | Total shutdown budget for awaiting and running a review |
| `reviewOnCompact` | `true` | Review before context compaction |

Values that are present but invalid (wrong type, or a number out of range) fall
back to the default and produce a warning, rather than being silently accepted.

## Development

```bash
pnpm install
pnpm check     # biome lint + tsc + vitest
```

`pnpm check` is the gate. It type-checks the test suite as well as `src/`.

Reading and writing the store is guarded: paths are canonicalized, files must
be plain regular files under an approved store root, sizes are capped before any
bytes reach the prompt, and locks are not used. This is deliberate. Claude Code
is a second writer that will not honour a lock file, so correctness under
concurrent writes is best-effort: writes are atomic, index updates re-read and
merge on divergence, and an update that loses a race is reported rather than
silently dropped.

## License

MIT
