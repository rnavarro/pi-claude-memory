// Runs before every test file. The resolver honours CLAUDE_CONFIG_DIR (and,
// alongside it, CLAUDE_CODE_PROJECT_DIR_NAME) ahead of HOME, exactly as Claude
// Code does. A suite launched from inside a Claude Code session inherits those
// variables, so tests that isolate themselves with a temp HOME would otherwise
// write into the operator's real ~/.claude/projects. Tests that exercise these
// variables set them explicitly.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;

// The debug log (and loadConfig) resolve through pi's getAgentDir(), which
// reads PI_CODING_AGENT_DIR and otherwise HOME. A test that opens a debug-log
// context without its own temp HOME used to append NDJSON to the operator's
// real ~/.pi/agent/pi-claude-memory/debug/. Every test file now starts under a
// throwaway HOME; tests that set HOME themselves restore to this one.
delete process.env.PI_CODING_AGENT_DIR;
const suiteHome = mkdtempSync(join(tmpdir(), "pcm-suite-home-"));
process.env.HOME = suiteHome;
afterAll(() => {
  rmSync(suiteHome, { recursive: true, force: true });
});
