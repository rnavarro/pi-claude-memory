// Per-operation path resolution cache.
//
// Both sides of a MEMORY.md round trip resolve one path per LINK LINE: the
// writer compares every line against the entry being written, the parser
// canonicalizes every href, and the reviewer's index summary canonicalizes
// every entry again to decide which store owns it. Each of those resolutions
// was a realpathSync, which is an lstat walk per path component — so a store
// with a few thousand entries spent thousands of synchronous syscalls on the
// main thread per write, and a stall profile of a live session put every one of
// its loudest samples inside this loop.
//
// A PathCache makes one operation resolve each unique path at most once, and
// skips realpath entirely for a leaf that lstat already shows is not a symlink.
//
// Scope is the OPERATION, not the process. A module-level cache would be wrong
// twice over: a path can change between operations (a topic moved to .trash/,
// a symlink retargeted, an index replaced), and the resolution is stale the
// moment it does. Each write, removal, parse and review pass constructs its own
// cache and drops it.
//
// Behaviour is unchanged by construction:
//  - a symlinked leaf still resolves through realpathSync, exactly as before;
//  - a non-symlinked leaf resolves to <canonical directory>/<basename>, which is
//    what realpathSync returns for it — the leaf contributes no link of its
//    own, so only its DIRECTORY has to be canonicalized, once per operation;
//  - a path that cannot be resolved keeps its lexical spelling, the bug-for-bug
//    fallback the call sites always had (a missing file cannot be realpath'd).

import { lstatSync, realpathSync, type Stats, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The three filesystem calls this cache wraps. Narrow on purpose: a test can
 * hand in counting wrappers and measure the real work without stubbing the
 * filesystem out from under the code being measured. */
export interface PathFs {
  lstatSync(path: string): Stats;
  realpathSync(path: string): string;
  statSync(path: string): Stats;
}

const nodePathFs: PathFs = {
  lstatSync: (path) => lstatSync(path),
  realpathSync: (path) => realpathSync(path),
  statSync: (path) => statSync(path),
};

export class PathCache {
  readonly #fs: PathFs;
  /** lexical path → canonical path, or null when it does not resolve. Also
   * carries the identity entries (`canonical → canonical`), so asking for the
   * realpath of an already-resolved path costs nothing — that second ask is
   * exactly what the reviewer's ownership test does for every entry the parser
   * just resolved. */
  readonly #canonical = new Map<string, string | null>();
  /** directory → canonical directory, with the lexical path as the fallback. */
  readonly #dirs = new Map<string, string>();
  /** path → lstat result, or null when it does not exist. */
  readonly #lstats = new Map<string, Stats | null>();
  /** path → mtimeMs, 0 when unknown. */
  readonly #mtimes = new Map<string, number>();

  constructor(fs: PathFs = nodePathFs) {
    this.#fs = fs;
  }

  /** lstat, memoised. Null when the path cannot be stat'd at all. */
  lstatOf(path: string): Stats | null {
    const hit = this.#lstats.get(path);
    if (hit !== undefined) return hit;
    let st: Stats | null = null;
    try {
      st = this.#fs.lstatSync(path);
    } catch {
      st = null;
    }
    this.#lstats.set(path, st);
    return st;
  }

  /** realpath, memoised. Null when it cannot be resolved — a missing path, a
   * dangling symlink, an unreadable component — so callers can keep the exact
   * "cannot canonicalize" branch they had when realpathSync threw. */
  realpathOf(path: string): string | null {
    const hit = this.#canonical.get(path);
    if (hit !== undefined) return hit;
    let out: string | null;
    try {
      out = this.#fs.realpathSync(path);
    } catch {
      out = null;
    }
    this.#canonical.set(path, out);
    return out;
  }

  /** Canonical form of a DIRECTORY, falling back to its lexical path when it
   * cannot be resolved. Memoised, so a store whose root is a symlink (a
   * dotfiles-managed ~/.claude) costs one realpath per operation instead of one
   * per entry. */
  canonicalDir(dir: string): string {
    const hit = this.#dirs.get(dir);
    if (hit !== undefined) return hit;
    const out = this.realpathOf(dir) ?? dir;
    this.#dirs.set(dir, out);
    return out;
  }

  /** Canonical form of an already-lexically-resolved path.
   *
   * This is resolveHref's rule, hoisted so it runs once per unique path rather
   * than once per index line. A SYMLINK is the only leaf that needs the kernel
   * to walk a chain; anything else resolves to its canonical directory plus its
   * own name, which is precisely what realpathSync would have returned. */
  resolvePath(lexical: string): string {
    const cached = this.#canonical.get(lexical);
    if (cached !== undefined) return cached ?? lexical;

    const st = this.lstatOf(lexical);
    if (st === null) {
      // Missing or unreadable: realpathSync threw here too, and the caller kept
      // the lexical path. Cache the failure so a line pointing at a missing
      // topic is not re-lstat'd once per occurrence.
      this.#canonical.set(lexical, null);
      return lexical;
    }
    if (st.isSymbolicLink()) {
      // A dangling symlink lands here and realpath fails; the lexical spelling
      // is then what the caller always got.
      const real = this.realpathOf(lexical);
      return real ?? lexical;
    }
    const resolved = join(this.canonicalDir(dirname(lexical)), basename(lexical));
    this.#canonical.set(lexical, resolved);
    // A path built from a canonical directory and a non-symlink leaf IS its own
    // realpath, so record that identity. Without it the next caller that asks
    // for realpathOf(resolved) — the reviewer's ownership test, once per entry —
    // pays a syscall to learn what this call already knew.
    this.#canonical.set(resolved, resolved);
    return resolved;
  }

  /** mtime in epoch ms, or 0 when the file cannot be stat'd. Memoised: the fit
   * planner asks for a topic's recency once per index LINE, and an index that
   * carries duplicate lines for one topic used to stat that topic once per line. */
  mtimeMs(path: string): number {
    const hit = this.#mtimes.get(path);
    if (hit !== undefined) return hit;
    let out = 0;
    try {
      out = this.#fs.statSync(path).mtimeMs;
    } catch {
      out = 0;
    }
    this.#mtimes.set(path, out);
    return out;
  }
}

/** A cache for one operation. Never share one between operations: see the
 * scope note at the top of this file. */
export function createPathCache(fs: PathFs = nodePathFs): PathCache {
  return new PathCache(fs);
}
