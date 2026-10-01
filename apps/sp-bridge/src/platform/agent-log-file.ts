/**
 * Persists the agent's diagnostics to a file.
 *
 * Why this exists: every diagnostic in the agent goes through `console`
 * (Super Productivity's `Log` is a thin wrapper over it, see
 * `src/app/core/log.ts`). A GUI Electron app on Windows has no attached
 * console, so that output is discarded. The result is that a startup failure
 * produces no evidence at all — the process dies during module evaluation,
 * above `app.whenReady()` and outside the try/catch in it, so there is no
 * window, no tray, no error dialog and no data directory. That is exactly the
 * failure this file exists to make visible.
 *
 * Two rules, both learned the hard way:
 *
 *  1. It must be imported FIRST, before anything that can throw. Imports are
 *    evaluated in order, so installing this first means everything after it —
 *     including a module that throws at load time — is covered.
 *  2. It must never throw. A logger that can crash the app is worse than no
 *     logger, so every filesystem call is guarded and failures fall back to
 *     silently doing nothing.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BRIDGE_LOG_FILENAME, defaultDataDir, migrateLegacyDataDir } from './data-dir';

/** Rotate once past this, keeping exactly one previous file. */
const MAX_LOG_BYTES = 1024 * 1024;

let logFilePath: string | null = null;

export const agentLogPath = (): string | null => logFilePath;

const write = (line: string): void => {
  if (!logFilePath) {
    return;
  }
  try {
    appendFileSync(logFilePath, line, 'utf8');
  } catch {
    // A full disk or a read-only profile must not take the app down with it.
  }
};

const rotateIfOversized = (path: string): void => {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    // No existing file, or not renameable. Either way there is nothing to do.
  }
};

/** Wraps a console method so it still writes to the terminal AND the file. */
const tee =
  (original: (...args: unknown[]) => void) =>
  (...args: unknown[]): void => {
    const line =
      `[${new Date().toISOString()}] ` +
      args
        .map((a) => {
          if (typeof a === 'string') {
            return a;
          }
          if (a instanceof Error) {
            return a.stack ?? `${a.name}: ${a.message}`;
          }
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
    write(`${line}\n`);
    original(...args);
  };

/**
 * Points the console at `<dataDir>/bridge.log`.
 *
 * Idempotent, and safe to call when the data dir cannot be created: it then
 * leaves the console untouched and reports a null path.
 */
export const installAgentLogFile = (dataDir: string = defaultDataDir()): void => {
  if (logFilePath) {
    return;
  }
  // Migrate the pre-rename directory before creating anything, so the log
  // file lands next to the migrated op log rather than beside a fresh one.
  migrateLegacyDataDir(dataDir);
  try {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, BRIDGE_LOG_FILENAME);
    rotateIfOversized(path);
    logFilePath = path;
  } catch {
    return;
  }

  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = tee(original) as unknown as (typeof console)[typeof method];
  }
};

// Installed at import time, deliberately. This module is imported for its side
// effect and first in the entry, and a statement here would run AFTER the
// hoisted imports of the entry that pull in everything able to throw — the
// exact ordering trap documented in headless-globals-install.ts.
installAgentLogFile();
