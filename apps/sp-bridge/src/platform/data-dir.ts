/**
 * The bridge's data directory.
 *
 * Extracted so the logger and the bridge cannot disagree about where state
 * lives. The logger needs it BEFORE the bridge starts — it has to create the
 * directory and open the log file first, so that a failure during startup is
 * recorded rather than lost.
 *
 * Defaults to `%APPDATA%/sp-bridge` on Windows and
 * `~/.local/share/sp-bridge` elsewhere, so the bridge's state is not mixed
 * into Super Productivity's own profile — they are separate clients that
 * happen to speak the same protocol.
 *
 * `SP_BRIDGE_DATA_DIR` overrides it, and the logger honours the same variable:
 * pointing the bridge at a directory has to move its op log AND its log file,
 * or a redirected run leaves its diagnostics behind in the default location.
 * The `SP_AGENT_*` names from before the rename are still honoured as a
 * fallback so existing scripts keep working.
 *
 * Previously (as sp-sync-agent) the directory was `sp-sync-agent`. On first
 * start with the new default, an existing legacy directory is moved over
 * intact — client id, op log, token and all — so no history is orphaned. An
 * explicit directory override disables the migration: pointing somewhere on
 * purpose must not drag state along uninvited.
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir as osHomedir, platform as osPlatform } from 'node:os';

const DATA_DIR_NAME = 'sp-bridge';
const LEGACY_DATA_DIR_NAME = 'sp-sync-agent';

const dataDirFor = (name: string): string =>
  osPlatform() === 'win32'
    ? join(process.env.APPDATA ?? join(osHomedir(), 'AppData', 'Roaming'), name)
    : join(osHomedir(), '.local', 'share', name);

export const defaultDataDir = (): string => {
  const override = process.env.SP_BRIDGE_DATA_DIR ?? process.env.SP_AGENT_DATA_DIR;
  if (override) {
    return override;
  }
  return dataDirFor(DATA_DIR_NAME);
};

const legacyDataDir = (): string => dataDirFor(LEGACY_DATA_DIR_NAME);

export const isExplicitDataDir = (): boolean =>
  !!(process.env.SP_BRIDGE_DATA_DIR ?? process.env.SP_AGENT_DATA_DIR);

/**
 * Moves the pre-rename `sp-sync-agent` directory to the new default, once.
 *
 * Runs before anything reads state: the op log's client id is a persisted,
 * non-regenerable vector-clock key, so leaving the old directory behind would
 * mint a fresh identity and permanently fork this device's history. Best
 * effort by design — a logger/storage call that can crash the app is worse
 * than an unmigrated directory.
 */
export const migrateLegacyDataDir = (target: string = defaultDataDir()): void => {
  if (isExplicitDataDir()) {
    return;
  }
  try {
    if (!existsSync(join(target, 'meta.json'))) {
      const legacy = legacyDataDir();
      if (existsSync(join(legacy, 'meta.json'))) {
        mkdirSync(dirname(target), { recursive: true });
        renameSync(legacy, target);
        console.log(`[bridge] Migrated data directory ${legacy} → ${target}`);
      }
    }
    // The log file was renamed with the project: roll the old name over so a
    // migrated directory keeps one continuous log.
    const oldLog = join(target, 'agent.log');
    const newLog = join(target, BRIDGE_LOG_FILENAME);
    if (!existsSync(newLog) && existsSync(oldLog)) {
      renameSync(oldLog, newLog);
    }
  } catch {
    // Migration is convenience, not correctness: worst case the bridge starts
    // with a fresh identity in the new directory and the old one stays put.
  }
};

export const BRIDGE_LOG_FILENAME = 'bridge.log';

/** Pre-rename name. Do not use for new code. */
export const AGENT_LOG_FILENAME = BRIDGE_LOG_FILENAME;
