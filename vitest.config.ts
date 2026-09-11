import { defineConfig } from "vitest/config";

// Discovery is pinned to test/ — the repo also contains a vendored,
// gitignored .pi/extensions tree whose tests expect a different cwd and
// toolchain, and must never run as part of this package's suite.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
