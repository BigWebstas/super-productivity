/**
 * Logging setup for the agent.
 *
 * Super Productivity's `Log` defaults to VERBOSE, which is right for a GUI app
 * with a user-facing log export and wrong for a background service: every
 * reducer pass logs its action type, so the agent's stdout becomes unusable as
 * a diagnostic and a Windows service log fills with noise.
 *
 * The level is lowered rather than the logger replaced, so the app's own error
 * and critical paths still surface — including the ones the sync engine relies
 * on (`OpLog.critical` on vector-clock corruption).
 */
import { Log, LogLevel } from '../../../../src/app/core/log';

export type AgentLogLevel = 'error' | 'info';

const LEVEL_BY_NAME: Record<AgentLogLevel, LogLevel> = {
  // ERROR still lets WARN through: the app logs recoverable sync problems at
  // warn, and those are exactly what makes a sync failure diagnosable.
  error: LogLevel.ERROR,
  info: LogLevel.NORMAL,
};

export const configureAgentLogging = (level: AgentLogLevel = 'error'): void => {
  Log.setLevel(LEVEL_BY_NAME[level]);
};
