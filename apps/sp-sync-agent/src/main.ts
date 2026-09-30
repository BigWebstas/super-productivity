/**
 * Agent entry point.
 *
 * Wires the pieces in dependency order and starts the REST API:
 *   headless globals → logging → op log → store (hydrated) → REST server
 *
 * The data directory defaults to `%APPDATA%/sp-sync-agent` on Windows and
 * `~/.local/share/sp-sync-agent` elsewhere (see ./platform/data-dir).
 */
import { basename, resolve } from 'node:path';
import { defaultDataDir } from './platform/data-dir';
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
  configureAgentLogging(process.env.SP_AGENT_LOG_LEVEL === 'info' ? 'info' : 'error');

  const opLog = OpLogStore.open(dataDir, {}, generateClientId);
  const store = new AgentStore(opLog.clientId, undefined, opLog.vectorClock);

  // Registered before hydration so nothing can slip through unpersisted.
  store.onOperations((ops) => {
    // Fire-and-forget: `append` is synchronous up to the fsync inside an async
    // wrapper, and a REST response must not be delayed behind a disk flush it
    // does not depend on. Failures are logged rather than thrown because the
    // state change has already been applied to the store.
    void opLog.append(ops).catch((error: unknown) => {
      console.error(
        '[agent] FAILED TO PERSIST OPERATIONS — this state change has no durable ' +
          'operation behind it and will diverge on the next sync:',
        error,
      );
    });
    opLog.recordLocalClock(store.vectorClock);
  });

  const hydrated = hydrateFromOpLog(store, opLog.all());
  const server = new LocalRestApiServer({
    dataDir,
    port,
    onRequest: createRouteHandler({ store }),
  });
  await server.listen();
  const address = server.address();

  console.log(
    `[agent] data dir   ${resolve(dataDir)}\n` +
      `[agent] client id  ${opLog.clientId}\n` +
      `[agent] replayed   ${hydrated.applied} operation(s)\n` +
      `[agent] listening  http://${address?.host}:${address?.port}\n` +
      `[agent] token      ${server.token}\n` +
      `[agent] sync       not enabled yet — see the roadmap in the README`,
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
  const port = process.env.SP_AGENT_PORT
    ? Number.parseInt(process.env.SP_AGENT_PORT, 10)
    : LOCAL_REST_API_PORT;
  startAgent(process.env.SP_AGENT_DATA_DIR, port).catch((error: unknown) => {
    console.error('[agent] Failed to start:', error);
    process.exitCode = 1;
  });
}
