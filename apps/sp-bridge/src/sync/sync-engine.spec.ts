import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '../test/harness';
import { AgentStore } from '../store/agent-store';
import { OpLogStore } from '../oplog/op-log-store';
import { buildOperation } from '../oplog/operation-factory';
import { SyncEngine } from './engine';
import { WorkContextType } from '../../../../src/app/features/work-context/work-context.model';
import { TASK_FEATURE_NAME } from '../../../../src/app/features/tasks/store/task.reducer';
import { INBOX_PROJECT } from '../../../../src/app/features/project/project.const';
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import { createTask } from '../../../../src/app/features/tasks/task.test-helper';
import { encrypt } from '@sp/sync-core';
import { AuthFailSPError } from '@sp/sync-providers/errors';
import { classifySyncError, nextRetryDelayMs } from './sync-errors';
import type { Operation } from '../../../../src/app/op-log/core/operation.types';
import type { SuperSyncProvider } from '@sp/sync-providers/super-sync';
import type {
  OpUploadResponse,
  ServerSyncOperation,
} from '@sp/sync-providers/provider-types';

const LOCAL_ID = 'E_local01';
const REMOTE_ID = 'E_other01';

const withDirs = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-bridge-sync-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const fixedId = (id: string) => (): string => id;

interface StubServer {
  ops: ServerSyncOperation[];
  uploaded: { opId: string; encrypted: boolean }[];
  seqCalls: number[];
  key: string | undefined;
  ready: boolean;
  encryptionEnabled: boolean;
  gapOnce: boolean;
  rejectIds: Set<string>;
  token: string;
  expiresAt?: number;
  authFail: boolean;
  cacheInvalidations: number;
}

const makeStubServer = (overrides: Partial<StubServer> = {}): StubServer => ({
  ops: [],
  uploaded: [],
  seqCalls: [],
  key: 'test-key-0001',
  ready: true,
  encryptionEnabled: false,
  gapOnce: false,
  rejectIds: new Set(),
  token: 'stub-token-0001',
  authFail: false,
  cacheInvalidations: 0,
  ...overrides,
});

const stubProvider = (server: StubServer): SuperSyncProvider => {
  let seq = 0;
  return {
    isEncryptionMandatory: true,
    isReady: async () => server.ready,
    getEncryptKey: async () => server.key,
    isEncryptionEnabled: async () => server.encryptionEnabled,
    invalidateCredentialCache: () => {
      server.cacheInvalidations++;
    },
    privateCfg: {
      load: async () => ({
        accessToken: server.token,
        baseUrl: undefined,
        expiresAt: server.expiresAt,
      }),
      setComplete: async () => undefined,
      updatePartial: async () => undefined,
      upsertPartial: async () => undefined,
      clear: async () => undefined,
    },
    getLastServerSeq: async () => seq,
    setLastServerSeq: async (next: number) => {
      seq = next;
      server.seqCalls.push(next);
    },
    downloadOps: async (sinceSeq: number) => {
      if (server.authFail) {
        throw new AuthFailSPError('stub 401');
      }
      if (server.gapOnce && sinceSeq > 0) {
        server.gapOnce = false;
        return { ops: [], hasMore: false, latestSeq: 7, gapDetected: true };
      }
      const ops = server.ops.filter((o) => o.serverSeq > sinceSeq);
      const latestSeq = ops.length ? Math.max(...ops.map((o) => o.serverSeq)) : sinceSeq;
      return { ops, hasMore: false, latestSeq };
    },
    uploadOps: async (ops) => {
      const results = ops.map((op) => ({
        opId: op.id,
        accepted: !server.rejectIds.has(op.id),
      }));
      for (const op of ops) {
        server.uploaded.push({
          opId: op.id,
          encrypted: !!op.isPayloadEncrypted && typeof op.payload === 'string',
        });
      }
      const response: OpUploadResponse = {
        results,
        latestSeq: seq,
      };
      return response;
    },
  } as unknown as SuperSyncProvider;
};

const addTaskOp = (
  id: string,
  title: string,
  clientId: string,
  clock: Record<string, number>,
  timestamp: number,
): Operation =>
  buildOperation({
    action: TaskSharedActions.addTask({
      task: createTask({ id, title, tagIds: [], projectId: INBOX_PROJECT.id }),
      workContextId: INBOX_PROJECT.id,
      workContextType: WorkContextType.PROJECT,
      isAddToBacklog: false,
      isAddToBottom: true,
    }),
    clientId,
    vectorClock: clock,
    timestamp,
  });

const updateTaskOp = (
  id: string,
  title: string,
  clientId: string,
  clock: Record<string, number>,
  timestamp: number,
): Operation =>
  buildOperation({
    action: TaskSharedActions.updateTask({ task: { id, changes: { title } } }),
    clientId,
    vectorClock: clock,
    timestamp,
  });

const setup = async (
  dir: string,
  server: StubServer,
): Promise<{ store: AgentStore; opLog: OpLogStore; engine: SyncEngine }> => {
  const opLog = OpLogStore.open(dir, {}, fixedId(LOCAL_ID));
  const store = new AgentStore(opLog.clientId, undefined, opLog.vectorClock);
  store.onOperations((ops) => {
    opLog.appendSync(ops);
    opLog.noteLocalOps(ops.map((op) => op.id));
    opLog.recordLocalClock(store.vectorClock);
  });
  const engine = new SyncEngine({ store, opLog, provider: stubProvider(server) });
  return { store, opLog, engine };
};

const taskTitle = (store: AgentStore, id: string): string | undefined =>
  (
    store.state[TASK_FEATURE_NAME] as unknown as {
      entities: Record<string, { title: string }>;
    }
  ).entities[id]?.title;

describe('SyncEngine', () => {
  it('skips the cycle when the provider is not ready', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer({ ready: false });
      const { engine } = await setup(dir, server);
      const result = await engine.syncNow('test');
      assert.equal(result.downloaded, 0);
      assert.equal(result.uploaded, 0);
      assert.equal(server.seqCalls.length, 0);
    });
  });

  it('refuses to run without an encryption key (mandatory)', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer({ key: undefined });
      const { engine } = await setup(dir, server);
      await assert.rejects(() => engine.syncNow('test'), /encryption/i);
    });
  });

  it('uploads pending ops encrypted and advances the upload cursor', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, opLog, engine } = await setup(dir, server);
      store.dispatch(
        TaskSharedActions.addTask({
          task: createTask({
            id: 't1',
            title: 'hello',
            tagIds: [],
            projectId: INBOX_PROJECT.id,
          }),
          workContextId: INBOX_PROJECT.id,
          workContextType: WorkContextType.PROJECT,
          isAddToBacklog: false,
          isAddToBottom: true,
        }),
      );
      assert.equal(opLog.pendingUpload().length, 1);

      const result = await engine.syncNow('test');
      assert.equal(result.uploaded, 1);
      assert.equal(server.uploaded.length, 1);
      assert.equal(server.uploaded[0].encrypted, true);
      assert.equal(opLog.pendingUpload().length, 0);
    });
  });

  it('downloads and applies a remote op, advancing the server cursor', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const remote = addTaskOp('r1', 'from server', REMOTE_ID, { [REMOTE_ID]: 1 }, 1000);
      server.ops = [{ serverSeq: 1, op: remote, receivedAt: 1000 }];
      const { store, engine } = await setup(dir, server);

      const result = await engine.syncNow('test');
      assert.equal(result.downloaded, 1);
      assert.equal(result.applied, 1);
      assert.equal(taskTitle(store, 'r1'), 'from server');
      assert.deepEqual(server.seqCalls, [1]);
    });
  });

  it('dedupes redelivered ops across cycles', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const remote = addTaskOp('r1', 'once', REMOTE_ID, { [REMOTE_ID]: 1 }, 1000);
      server.ops = [{ serverSeq: 1, op: remote, receivedAt: 1000 }];
      const { engine } = await setup(dir, server);

      assert.equal((await engine.syncNow('a')).applied, 1);
      // Cursor stays (server keeps returning the op); the second cycle must
      // recognise it by id rather than re-apply.
      server.seqCalls.length = 0;
      const second = await engine.syncNow('b');
      assert.equal(second.applied, 0);
    });
  });

  it('resolves a concurrent edit remote-wins by timestamp', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, engine } = await setup(dir, server);
      const local = addTaskOp('t1', 'local', LOCAL_ID, { [LOCAL_ID]: 1 }, 1000);
      store.dispatch(
        TaskSharedActions.addTask({
          task: createTask({
            id: 't1',
            title: 'local',
            tagIds: [],
            projectId: INBOX_PROJECT.id,
          }),
          workContextId: INBOX_PROJECT.id,
          workContextType: WorkContextType.PROJECT,
          isAddToBacklog: false,
          isAddToBottom: true,
        }),
      );
      void local;
      const remote = updateTaskOp(
        't1',
        'remote',
        REMOTE_ID,
        { [REMOTE_ID]: 1 },
        Date.now() + 60_000,
      );
      server.ops = [{ serverSeq: 1, op: remote, receivedAt: 2000 }];

      const result = await engine.syncNow('test');
      assert.equal(result.conflicts, 1);
      assert.equal(result.remoteWins, 1);
      assert.equal(taskTitle(store, 't1'), 'remote');
    });
  });

  it('resolves a concurrent edit local-wins by keeping local state', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, opLog, engine } = await setup(dir, server);
      store.dispatch(
        TaskSharedActions.addTask({
          task: createTask({
            id: 't1',
            title: 'local',
            tagIds: [],
            projectId: INBOX_PROJECT.id,
          }),
          workContextId: INBOX_PROJECT.id,
          workContextType: WorkContextType.PROJECT,
          isAddToBacklog: false,
          isAddToBottom: true,
        }),
      );
      const remote = updateTaskOp('t1', 'stale', REMOTE_ID, { [REMOTE_ID]: 1 }, 1);
      server.ops = [{ serverSeq: 1, op: remote, receivedAt: 1 }];

      const result = await engine.syncNow('test');
      assert.equal(result.conflicts, 1);
      assert.equal(result.localWins, 1);
      // The win is synthesized into a dominating LWW update: applied locally,
      // uploaded so every other client converges the same way.
      assert.equal(result.applied, 1);
      assert.equal(taskTitle(store, 't1'), 'local');
      assert.equal(result.uploaded, 1);
      assert.equal(opLog.pendingUpload().length, 0);
    });
  });

  it('holds the cursor when a downloaded op cannot be decrypted', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { engine } = await setup(dir, server);
      const remote = addTaskOp('r1', 'secret', REMOTE_ID, { [REMOTE_ID]: 1 }, 1000);
      const ciphertext = await encrypt(JSON.stringify(remote.payload), 'wrong-key');
      server.ops = [
        {
          serverSeq: 1,
          op: { ...remote, payload: ciphertext, isPayloadEncrypted: true },
          receivedAt: 1000,
        },
      ];

      await assert.rejects(() => engine.syncNow('test'), /decrypt/i);
      assert.equal(server.seqCalls.length, 0);
    });
  });

  it('resets and re-downloads on a server gap', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer({ gapOnce: true });
      const remote = addTaskOp('r1', 'after gap', REMOTE_ID, { [REMOTE_ID]: 1 }, 1000);
      server.ops = [{ serverSeq: 3, op: remote, receivedAt: 1000 }];
      const { store, engine } = await setup(dir, server);

      const result = await engine.syncNow('test');
      assert.equal(result.applied, 1);
      assert.equal(taskTitle(store, 'r1'), 'after gap');
    });
  });

  it('refuses plaintext ops on an encrypted account', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer({ encryptionEnabled: true });
      const remote = addTaskOp('r1', 'plain', REMOTE_ID, { [REMOTE_ID]: 1 }, 1000);
      server.ops = [{ serverSeq: 1, op: remote, receivedAt: 1000 }];
      const { engine } = await setup(dir, server);
      await assert.rejects(() => engine.syncNow('test'), /plaintext/i);
      assert.equal(server.seqCalls.length, 0);
    });
  });

  it('keeps rejected uploads pending for re-evaluation', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, opLog, engine } = await setup(dir, server);
      const [op] = store.dispatch(
        TaskSharedActions.addTask({
          task: createTask({
            id: 't1',
            title: 'x',
            tagIds: [],
            projectId: INBOX_PROJECT.id,
          }),
          workContextId: INBOX_PROJECT.id,
          workContextType: WorkContextType.PROJECT,
          isAddToBacklog: false,
          isAddToBottom: true,
        }),
      );
      server.rejectIds.add(op.id);

      const result = await engine.syncNow('test');
      assert.equal(result.uploaded, 0);
      assert.equal(opLog.pendingUpload().length, 1);
    });
  });

  it('flags auth failures sticky until the next success', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer({ authFail: true });
      const { engine } = await setup(dir, server);
      await assert.rejects(() => engine.syncNow('test'), /stub 401/);
      assert.equal(engine.lastErrorCode, 'auth_failed');
      assert.ok(engine.authFailedSince !== null);
      assert.equal(engine.consecutiveFailures, 1);
      assert.equal(engine.isBackedOff(Date.now()), true);

      server.authFail = false;
      const result = await engine.syncNow('test');
      assert.equal(result.downloaded, 0);
      assert.equal(engine.lastErrorCode, null);
      assert.equal(engine.authFailedSince, null);
      assert.equal(engine.consecutiveFailures, 0);
      assert.equal(engine.isBackedOff(Date.now()), false);
    });
  });

  it('invalidates provider caches when the token rotates', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { engine } = await setup(dir, server);
      await engine.syncNow('first');
      assert.equal(server.cacheInvalidations, 0);

      server.token = 'stub-token-0002';
      await engine.syncNow('second');
      assert.equal(server.cacheInvalidations, 1);
    });
  });

  it('reports an expiring token before it fails', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer({ expiresAt: Date.now() + 3_600_000 });
      const { engine } = await setup(dir, server);
      await engine.syncNow('test');
      const status = engine.status();
      assert.equal(status.tokenExpiringSoon, true);
      assert.ok(status.tokenExpiresAt !== null);
    });
  });
});

describe('sync-errors', () => {
  it('classifies auth, network, crypto and server failures', () => {
    assert.equal(classifySyncError(new AuthFailSPError('x')), 'auth_failed');
    assert.equal(classifySyncError(new TypeError('fetch failed')), 'network');
    assert.equal(
      classifySyncError(new Error('1 op could not be decrypted')),
      'encryption',
    );
    assert.equal(classifySyncError(new Error('boom (HTTP 503)')), 'server');
    assert.equal(classifySyncError(new Error('nope')), 'unknown');
  });

  it('backs off 1m, 2m, 4m capped at 15m', () => {
    assert.equal(nextRetryDelayMs(0), 0);
    assert.equal(nextRetryDelayMs(1), 60_000);
    assert.equal(nextRetryDelayMs(2), 120_000);
    assert.equal(nextRetryDelayMs(3), 240_000);
    assert.equal(nextRetryDelayMs(10), 900_000);
  });
});
