// pi-claude-memory — shared Claude Code memory store for Pi
//
// Reads and writes the same memory files Claude Code uses:
//   ~/.claude/projects/<path-hash>/memory/  (project tier)
//   ~/.claude/memory/                        (global tier)
//
// See PLAN.md for the full design. This is a placeholder entry point
// to be filled in during Phase 1 (read-only harness).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
  // Phase 1: read-only harness
  // - resolver: cwd -> ~/.claude/projects/<encoded>/memory/
  // - frontmatter parser: 3 generations of YAML schema
  // - index parser: MEMORY.md link entries + hand-authored sections
  // - injector: bimodal (index always + file bodies under 5K token cap)
  //
  // Phase 2: tools (recall_memory, write_memory, remove_memory)
  // Phase 3: auto-learning via completeSimple() with glm-5.2-flex-fast
  // Phase 4: polish (/memory command, config, tests)
}
