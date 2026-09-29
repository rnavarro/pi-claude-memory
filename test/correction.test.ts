import { describe, expect, it } from "vitest";
import { detectCorrection, detectCorrectionPattern } from "../src/correction.js";

describe("detectCorrection: hits", () => {
  const hits = [
    "no, use pnpm",
    "No. Use the other config file.",
    "Nope, the file is in src/",
    "don't do that",
    "Do not touch the lockfile",
    "Please don't commit without asking.",
    "stop adding comments to every line",
    "Stop doing that.",
    "never push to main",
    "Always run the tests before committing",
    "that's wrong",
    "That is not what I asked",
    "not npm, pnpm",
    "Not the staging db, but prod",
    "I told you to use rg",
    "I already told you this",
    "I told you to use rg, why did you use grep?",
    "from now on, write tests first",
    "From now on use tabs",
    "instead use the helper in utils",
    "Instead, run the formatter",
    "use pnpm instead",
    "run it with sudo, not as root",
    "Ok. Never use console.log for logging.",
    "Thanks. From now on, keep replies short",
    "NO, USE PNPM",
    "that’s wrong", // curly apostrophe
    "we use pnpm here, not npm",
    "We use tabs here",
    "that's not how it works",
    "it's 8443 not 8080",
    "revert it",
    "Revert that.",
    "I prefer jq",
    "I'd rather you use jq",
    "Actually the port is 8443",
    "Actually, it lives in ~/.config",
    "No — use pnpm",
    "no – use pnpm",
    "no - use pnpm",
    "you keep adding comments",
    "Why do you keep doing that?",
    "port 8443, not 8080",
  ];
  for (const text of hits) {
    it(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectCorrection(text)).toBe(true);
    });
  }
});

describe("detectCorrection: non-hits", () => {
  const misses = [
    "",
    "no problem",
    "No problem, thanks!",
    "no worries",
    "No, thanks",
    "no, that's fine",
    "No, you're right",
    "No, don't worry about it",
    "No, I don't think so",
    "no",
    "No.",
    "No need to rush",
    "don't worry",
    "Don't worry about the tests for now",
    "don't forget the changelog",
    "stop the server",
    "Stop the dev server and restart it",
    "never mind",
    "Never mind, it works now",
    "no, what does that flag do?",
    "No, why did it fail?",
    "don't you think that's slow?",
    "should I always use pnpm here?",
    "not sure, maybe try again",
    "Not bad, thanks",
    "can you add a test for this?",
    "please fix the failing build",
    "Looks good, ship it",
    "/commit never push to main",
    "!rm -rf build",
    "the log says:\n```\nnever retry\ndon't do that\n```",
    "the error is `don't use eval`",
    "> never push to main\nwhat does this line in the docs mean?",
    'the doc says "always use tabs" but the code uses spaces',
    "I know, nobody told me either",
    "Nothing changed after the rebuild",
    "Now run the benchmarks",
    "Actually, that works great",
    "Actually, never mind",
    "Actually, can you also add a test?",
    "I do not know",
    "it is not working",
    "I'm not sure",
    "the build is not ready yet and the docs are not either, which is fine by me",
    "revert the last commit on the release branch?",
    "we should look at the logs",
    "I'm not a fan of long functions but this one is fine for now",
  ];
  for (const text of misses) {
    it(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectCorrection(text)).toBe(false);
    });
  }
});

describe("detectCorrectionPattern", () => {
  it("names the pattern that fired, or null", () => {
    expect(detectCorrectionPattern("it's 8443 not 8080")).toBe("x-not-y");
    expect(detectCorrectionPattern("No — use pnpm")).toBe("leading-no");
    expect(detectCorrectionPattern("Actually the port is 8443")).toBe("actually");
    expect(detectCorrectionPattern("no problem")).toBeNull();
  });
});
