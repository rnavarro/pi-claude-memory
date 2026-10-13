// The suite never writes the operator's real debug log. test/setup-env.ts
// points HOME at a throwaway directory and clears PI_CODING_AGENT_DIR; this
// checks the result against the account's home from the password database,
// which HOME does not change. The check is against the real ~/.pi, not the
// whole home: the throwaway HOME lives under tmpdir(), and TMPDIR may itself
// sit inside the real home.

import { userInfo } from "node:os";
import { join, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("test isolation of the debug log", () => {
  it("resolves pi's agent dir outside the real home", () => {
    const realPiDir = join(userInfo().homedir, ".pi");
    expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(`${getAgentDir()}${sep}`.startsWith(`${realPiDir}${sep}`)).toBe(false);
  });
});
