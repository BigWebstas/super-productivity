/**
 * Agent entry point.
 *
 * Wires the pieces in dependency order and starts the REST API:
 *   headless globals → logging → op log → store (hydrated) → REST server
 *
 * The data directory defaults to `%APPDATA%/sp-bridge` on Windows and
 * `~/.local/share/sp-bridge` elsewhere (see ./platform/data-dir).
 */
import { basename, resolve } from 'node:path';
import {
  defaultDataDir,
  isExplicitDataDir,
  migrateLegacyDataDir,
} from './platform/data-dir';
import { installHeadlessGlobals } from './platform/headless-globals';
import { configureAgentLogging } from './platform/agent-logging';
import { generateClientId } from '../../../src/app/core/util/generate-client-id';
import { AgentStore } from './store/agent-store';
import { OpLogStore } from './oplog/op-log-store';
import { hydrateFromOpLog } from './oplog/hydrate';
import { createRouteHandler } from './rest/router';
import { LocalRestApiServer, LOCAL_REST_API_PORT } from './rest/server';

export interface StartedAgent {
  /** Absolute path the op log and token live in. Shown by the desktop shell. */
  dataDir: string;
  store: AgentStore;
  opLog: OpLogStore;
  server: LocalRestApiServer;
  stop: () => Promise<void>;
}

/**
 * Boots the agent.
 *
 * `onOperations` is registered before the server starts, so a request can never
 * produce state that is not already on its way to disk.
 */
export const startAgent = async (
  dataDir: string = defaultDataDir(),
  port: number = LOCAL_REST_API_PORT,
): Promise<StartedAgent> => {
  installHeadlessGlobals();
  const logLevelEnv = process.env.SP_BRIDGE_LOG_LEVEL ?? process.env.SP_AGENT_LOG_LEVEL;
  configureAgentLogging(logLevelEnv === 'info' ? 'info' : 'error');

  // Runs before anything reads state when the caller uses the default
  // directory (an explicit directory opts out — see data-dir.ts). The logger
  // already migrated at import time; this second call is a no-op for it.
  if (!isExplicitDataDir()) {
    migrateLegacyDataDir(defaultDataDir());
  }

  const opLog = OpLogStore.open(dataDir, {}, generateClientId);
  const store = new AgentStore(opLog.clientId, undefined, opLog.vectorClock);

  // Registered before hydration so nothing can slip through unpersisted.
  // Synchronous and throwing: `appendSync` fails loudly so a non-durable
  // change throws out of `dispatch` (→ HTTP 500) instead of resolving into a
  // 201 with no operation behind it. State was already reduced at that point,
  // but observers are only notified after the sink accepts, so nothing downstream
  // treats the change as applied.
  store.onOperations((ops) => {
    try {
      opLog.appendSync(ops);
    } catch (error) {
      console.error(
        '[bridge] FAILED TO PERSIST OPERATIONS — this state change has no durable ' +
          'operation behind it and will diverge on the next sync:',
        error,
      );
      throw error;
    }
    opLog.recordLocalClock(store.vectorClock);
  });

  const hydrated = hydrateFromOpLog(store, opLog.all());
  // Persist remote clocks observed in the log, not just the store's copy:
  // without this a future compaction/truncation would lose causality and the
  // next local op would look concurrent with history already applied.
  for (const op of opLog.all()) {
    opLog.mergeRemoteVectorClock(op.vectorClock);
  }
  const server = new LocalRestApiServer({
    dataDir,
    port,
    onRequest: createRouteHandler({ store }),
  });
  await server.listen();
  const address = server.address();

  console.log(
    `[bridge] data dir   ${resolve(dataDir)}\n` +
      `[bridge] client id  ${opLog.clientId}\n` +
      `[bridge] replayed   ${hydrated.applied} operation(s)\n` +
      `[bridge] listening  http://${address?.host}:${address?.port}\n` +
      `[bridge] token      ${server.token}\n` +
      `[bridge] sync       not enabled yet — see the roadmap in the README`,
  );

  return {
    dataDir: resolve(dataDir),
    store,
    opLog,
    server,
    stop: async () => {
      await server.close();
      opLog.close();
    },
  };
};

/**
 * True when this module was started directly rather than imported.
 *
 * Extension-agnostic on purpose: the same file is run as `src/main.ts` through
 * the dev runner and as `dist/main.js` from the bundle, and a check that only
 * matched one of them would leave the other silently doing nothing on startup.
 */
const isEntryPoint = (): boolean => {
  const invoked = process.argv[1];
  if (!invoked) {
    return false;
  }
  return basename(invoked).replace(/\.[cm]?[jt]s$/, '') === 'main';
};

if (isEntryPoint()) {
  const portEnv = process.env.SP_BRIDGE_PORT ?? process.env.SP_AGENT_PORT;
  const port = portEnv ? Number.parseInt(portEnv, 10) : LOCAL_REST_API_PORT;
  const dataDir = process.env.SP_BRIDGE_DATA_DIR ?? process.env.SP_AGENT_DATA_DIR;
  startAgent(dataDir, port).catch((error: unknown) => {
    console.error('[bridge] Failed to start:', error);
    process.exitCode = 1;
  });
}
