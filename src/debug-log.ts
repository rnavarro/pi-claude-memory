// Debug logging: structured NDJSON logs for diagnosing extension behavior.
//
// Modeled on pi-observational-memory's debug-log.ts. Writes per-session NDJSON
// files to ~/.pi/agent/pi-claude-memory/debug/<sessionId>.ndjson with rotation.
// Enabled by default (like observational-memory). Disable via settings.json:
//   "pi-claude-memory": { "debugLog": false }
//
// Every log entry is a JSON object with:
//   ts, event, cwd, sessionId, data
//
// Usage:
//   withDebugLogContext({ enabled, cwd, sessionId }, () => { ... });
//   debugLog("injector.build", { entries: 5, tokens: 1200 });
//
// All logging is best-effort: errors in the logger itself are swallowed so
// they never affect memory behavior.

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB rotation threshold
const DEBUG_LOG_DIR = join("pi-claude-memory", "debug");
const FALLBACK_LOG = join("pi-claude-memory", "debug.ndjson");

export interface DebugLogContext {
  enabled: boolean;
  cwd?: string;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<DebugLogContext>();

/** Run a function with debug log context. Nested calls merge context. */
export function withDebugLogContext<T>(context: DebugLogContext, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run({ ...parent, ...context }, fn);
}

/** Get the current debug log context (for checking enabled state). */
export function getDebugLogContext(): DebugLogContext | undefined {
  return storage.getStore();
}

/** Sanitize a session ID for use as a filename. */
function safeSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  if (!trimmed) return undefined;
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  if (!/[A-Za-z0-9]/.test(sanitized)) return undefined;
  return sanitized;
}

/** Resolve the debug log file path for the current context. */
function debugLogPath(context: DebugLogContext): string {
  const safeSid = safeSessionId(context.sessionId);
  const relative = safeSid ? join(DEBUG_LOG_DIR, `${safeSid}.ndjson`) : FALLBACK_LOG;
  return join(getAgentDir(), relative);
}

/** Write a structured debug log entry. No-op if debug logging is disabled. */
export function debugLog(event: string, data: Record<string, unknown> = {}): void {
  const context = storage.getStore();
  if (context?.enabled !== true) return;

  try {
    const path = debugLogPath(context);
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    const payload = {
      ts: new Date().toISOString(),
      event,
      cwd: context.cwd,
      sessionId: context.sessionId,
      data,
    };
    appendFileSync(path, `${JSON.stringify(payload)}\n`, "utf-8");
  } catch {
    // Debug logging must never affect memory behavior.
  }
}

/** Rotate the log file if it exceeds the max size. */
function rotateIfNeeded(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size < DEBUG_LOG_MAX_BYTES) return;
  const backupPath = `${path}.1`;
  if (existsSync(backupPath)) unlinkSync(backupPath);
  renameSync(path, backupPath);
}
