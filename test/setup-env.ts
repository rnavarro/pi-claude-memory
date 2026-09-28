// Runs before every test file. The resolver honours CLAUDE_CONFIG_DIR (and,
// alongside it, CLAUDE_CODE_PROJECT_DIR_NAME) ahead of HOME, exactly as Claude
// Code does. A suite launched from inside a Claude Code session inherits those
// variables, so tests that isolate themselves with a temp HOME would otherwise
// write into the operator's real ~/.claude/projects. Tests that exercise these
// variables set them explicitly.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
