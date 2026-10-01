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
import { FileTaskArchive } from './archive/archive-store';
import { FocusTicker } from './focus/focus-ticker';
import { createBridgeSyncProvider } from './sync/provider';
import { SyncBusyError, SyncEngine, SyncNotConfiguredError } from './sync/engine';
import {
  DEFAULT_SYNC_INTERVAL_MS,
  isSyncConfigured,
  loadSyncConfig,
  redactSyncConfig,
  saveSyncConfig,
  validateSyncConfigPatch,
  type RedactedSyncConfig,
} from './sync/sync-config';

export interface StartedAgent {
  /** Absolute path the op log and token live in. Shown by the desktop shell. */
  dataDir: string;
  store: AgentStore;
  opLog: OpLogStore;
  server: LocalRestApiServer;
  /** Null when sync is not configured (no access token). */
  sync: SyncEngine | null;
  /**
   * Validates, persists and applies a sync config patch (same path as
   * POST /sync/config). Used by the desktop settings window.
   */
  updateSyncConfig: (patch: unknown) => RedactedSyncConfig;
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
  const archive = new FileTaskArchive(dataDir);
  const focusTicker = new FocusTicker(store);

  // Assigned after hydration (the engine needs the store); the sink below
  // closes over the binding, not the value.
  let sync: SyncEngine | null = null;

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
    // Tracked after the append, back-to-back: the uploader must only ever see
    // durable ops (see noteLocalOps).
    opLog.noteLocalOps(ops.map((op) => op.id));
    opLog.recordLocalClock(store.vectorClock);
    sync?.notifyLocalChange();
  });

  const hydrated = hydrateFromOpLog(store, opLog.all());
  // Persist remote clocks observed in the log, not just the store's copy:
  // without this a future compaction/truncation would lose causality and the
  // next local op would look concurrent with history already applied.
  for (const op of opLog.all()) {
    opLog.mergeRemoteVectorClock(op.vectorClock);
  }

  // SuperSync, when configured. Without an access token the bridge is a
  // local-only REST server and every sync route reports unconfigured.
  // `recycleSyncEngine` also runs after every POST /sync/config, so
  // provisioning, disabling and interval changes apply without a restart.
  const recycleSyncEngine = (reason: string): void => {
    const cfg = loadSyncConfig(dataDir);
    if (isSyncConfigured(cfg)) {
      if (!sync) {
        const provider = createBridgeSyncProvider(dataDir);
        sync = new SyncEngine({ store, opLog, provider, archive });
      } else {
        sync.bumpEpoch();
      }
      sync.start(
        cfg.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
        cfg.syncOnLocalChange ?? true,
      );
      if (reason === 'startup') {
        // Best effort: a failed first sync must not take the REST API down
        // with it. The timer and the local-change trigger keep retrying.
        void sync.syncNow(reason).catch((error: unknown) => {
          if (!(error instanceof SyncBusyError)) {
            console.warn('[sync] Startup sync failed; will retry', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      }
    } else if (sync) {
      sync.stop();
      sync = null;
    }
  };
  recycleSyncEngine('startup');

  // Shared by POST /sync/config and the desktop settings window: one
  // validation + persist + recycle path, so the two can never disagree.
  const applySyncConfigPatch = (patch: unknown): RedactedSyncConfig => {
    const validated = validateSyncConfigPatch(patch);
    const saved = saveSyncConfig(dataDir, validated);
    recycleSyncEngine(isSyncConfigured(saved) ? 'config-enabled' : 'config-disabled');
    return redactSyncConfig(saved);
  };

  const server = new LocalRestApiServer({
    dataDir,
    port,
    onRequest: createRouteHandler({
      store,
      archive,
      sync: {
        status: () => {
          const engine: SyncEngine | null = sync;
          return engine
            ? { ...engine.status(), enabled: true as const }
            : {
                enabled: false as const,
                running: false,
                lastSyncAt: null,
                lastResult: null,
                lastError: null,
                lastErrorCode: null,
                authFailedSince: null,
                consecutiveFailures: 0,
                nextRetryAt: null,
                tokenExpiresAt: null,
                tokenExpiringSoon: false,
                pendingUpload: opLog.pendingUpload().length,
              };
        },
        trigger: () => {
          const engine: SyncEngine | null = sync;
          if (!engine) {
            throw new SyncNotConfiguredError();
          }
          return engine.syncNow('manual');
        },
      },
      syncConfig: {
        get: () => redactSyncConfig(loadSyncConfig(dataDir)),
        update: (patch: unknown) => applySyncConfigPatch(patch),
      },
    }),
  });
  await server.listen();
  focusTicker.start();
  const address = server.address();

  console.log(
    `[bridge] data dir   ${resolve(dataDir)}\n` +
      `[bridge] client id  ${opLog.clientId}\n` +
      `[bridge] replayed   ${hydrated.applied} operation(s)\n` +
      `[bridge] listening  http://${address?.host}:${address?.port}\n` +
      `[bridge] token      ${server.token}\n` +
      (sync
        ? `[bridge] sync       SuperSync enabled (base: ${loadSyncConfig(dataDir).baseUrl ?? 'default'})`
        : `[bridge] sync       not configured — add accessToken to sync.json to enable`),
  );

  return {
    dataDir: resolve(dataDir),
    store,
    opLog,
    server,
    // Getter, not a snapshot: POST /sync/config can start or stop the engine
    // at runtime, and readers (routes, shell, tests) must see the current one.
    get sync(): SyncEngine | null {
      return sync;
    },
    updateSyncConfig: (patch: unknown) => applySyncConfigPatch(patch),
    stop: async () => {
      sync?.stop();
      focusTicker.stop();
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
