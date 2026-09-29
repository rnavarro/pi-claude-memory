// The suite never writes the operator's real debug log. test/setup-env.ts
// points HOME at a throwaway directory and clears PI_CODING_AGENT_DIR; this
// checks the result against the account's home from the password database,
// which HOME does not change.

import { userInfo } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("test isolation of the debug log", () => {
  it("resolves pi's agent dir outside the real home", () => {
    const realHome = userInfo().homedir;
    expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(getAgentDir().startsWith(realHome)).toBe(false);
  });
});
