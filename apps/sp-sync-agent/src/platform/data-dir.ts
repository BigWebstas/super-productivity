/**
 * The agent's data directory.
 *
 * Extracted so the logger and the agent cannot disagree about where state
 * lives. The logger needs it BEFORE the agent starts — it has to create the
 * directory and open the log file first, so that a failure during startup is
 * recorded rather than lost.
 *
 * Defaults to `%APPDATA%/sp-sync-agent` on Windows and
 * `~/.local/share/sp-sync-agent` elsewhere, so the agent's state is not mixed
 * into Super Productivity's own profile — they are separate clients that
 * happen to speak the same protocol.
 *
 * `SP_AGENT_DATA_DIR` overrides it, and the logger honours the same variable:
 * pointing the agent at a directory has to move its op log AND its log file,
 * or a redirected run leaves its diagnostics behind in the default location.
 */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const defaultDataDir = (): string => {
  const override = process.env.SP_AGENT_DATA_DIR;
  if (override) {
    return override;
  }
  return platform() === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'sp-sync-agent')
    : join(homedir(), '.local', 'share', 'sp-sync-agent');
};

export const AGENT_LOG_FILENAME = 'agent.log';
