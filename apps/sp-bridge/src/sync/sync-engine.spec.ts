import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '../test/harness';
import { AgentStore } from '../store/agent-store';
import { FileTaskArchive } from '../archive/archive-store';
import { OpLogStore } from '../oplog/op-log-store';
import { buildOperation } from '../oplog/operation-factory';
import { SyncEngine } from './engine';
import { WorkContextType } from '../../../../src/app/features/work-context/work-context.model';
import { TASK_FEATURE_NAME } from '../../../../src/app/features/tasks/store/task.reducer';
import { PROJECT_FEATURE_NAME } from '../../../../src/app/features/project/store/project.reducer';
import { TAG_FEATURE_NAME } from '../../../../src/app/features/tag/store/tag.reducer';
import { INBOX_PROJECT } from '../../../../src/app/features/project/project.const';
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import { addProject } from '../../../../src/app/features/project/store/project.actions';
import { addTag } from '../../../../src/app/features/tag/store/tag.actions';
import { createTask } from '../../../../src/app/features/tasks/task.test-helper';
import { encrypt } from '@sp/sync-core';
import { AuthFailSPError } from '@sp/sync-providers/errors';
import { classifySyncError, nextRetryDelayMs } from './sync-errors';
import { ActionType } from '../../../../src/app/op-log/core/action-types.enum';
import { OpType, type Operation } from '../../../../src/app/op-log/core/operation.types';
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
  downloadSinceSeqs: number[];
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
  downloadSinceSeqs: [],
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
    downloadOps: async (sinceSeq: number, excludeClient?: string) => {
      server.downloadSinceSeqs.push(sinceSeq);
      if (server.authFail) {
        throw new AuthFailSPError('stub 401');
      }
      if (server.gapOnce && sinceSeq > 0) {
        server.gapOnce = false;
        return { ops: [], hasMore: false, latestSeq: 7, gapDetected: true };
      }
      let ops = server.ops.filter((o) => o.serverSeq > sinceSeq);
      if (excludeClient) {
        ops = ops.filter((o) => o.op.clientId !== excludeClient);
      }
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
): Promise<{
  store: AgentStore;
  opLog: OpLogStore;
  engine: SyncEngine;
  archive: FileTaskArchive;
}> => {
  const opLog = OpLogStore.open(dir, {}, fixedId(LOCAL_ID));
  const store = new AgentStore(opLog.clientId, undefined, opLog.vectorClock);
  store.onOperations((ops) => {
    opLog.appendSync(ops);
    opLog.noteLocalOps(ops.map((op) => op.id));
    opLog.recordLocalClock(store.vectorClock);
  });
  const archive = new FileTaskArchive(dir);
  const engine = new SyncEngine({
    store,
    opLog,
    provider: stubProvider(server),
    archive,
  });
  return { store, opLog, engine, archive };
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

  it('folds applied remote clocks into the next local op', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const remote = addTaskOp('r1', 'from server', REMOTE_ID, { [REMOTE_ID]: 1 }, 1000);
      server.ops = [{ serverSeq: 1, op: remote, receivedAt: 1000 }];
      const { store, engine } = await setup(dir, server);
      await engine.syncNow('download');

      // Without the merge this carries only the local client and reads as
      // concurrent with applied history on the server (which rejects it).
      const [next] = store.dispatch(
        TaskSharedActions.addTask({
          task: createTask({
            id: 't1',
            title: 'after',
            tagIds: [],
            projectId: INBOX_PROJECT.id,
          }),
          workContextId: INBOX_PROJECT.id,
          workContextType: WorkContextType.PROJECT,
          isAddToBacklog: false,
          isAddToBottom: true,
        }),
      );
      assert.equal(next.vectorClock[REMOTE_ID], 1);
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

  it('applies a downloaded archive op to the archive file', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, engine, archive } = await setup(dir, server);
      store.dispatch(
        TaskSharedActions.addTask({
          task: createTask({
            id: 't1',
            title: 'doomed',
            tagIds: [],
            projectId: INBOX_PROJECT.id,
          }),
          workContextId: INBOX_PROJECT.id,
          workContextType: WorkContextType.PROJECT,
          isAddToBacklog: false,
          isAddToBottom: true,
        }),
      );
      // Drain the local add so the archive op below meets no pending ops.
      await engine.syncNow('drain');
      const live = (
        store.state[TASK_FEATURE_NAME] as unknown as {
          entities: Record<string, Record<string, unknown>>;
        }
      ).entities['t1'];
      const remote = buildOperation({
        action: TaskSharedActions.moveToArchive({
          tasks: [{ ...live, subTasks: [] }] as never,
        }),
        clientId: REMOTE_ID,
        vectorClock: { [REMOTE_ID]: 1 },
        timestamp: Date.now(),
      });
      server.ops = [{ serverSeq: 2, op: remote, receivedAt: Date.now() }];

      const result = await engine.syncNow('test');
      assert.equal(result.applied, 1);
      assert.equal(taskTitle(store, 't1'), undefined);
      assert.equal(archive.hasTask('t1'), true);
      assert.equal(archive.getById('t1')?.title, 'doomed');
    });
  });

  it('propagates a winning local delete as a dominating replacement', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, engine } = await setup(dir, server);
      store.dispatch(
        TaskSharedActions.addTask({
          task: createTask({
            id: 't1',
            title: 'doomed',
            tagIds: [],
            projectId: INBOX_PROJECT.id,
          }),
          workContextId: INBOX_PROJECT.id,
          workContextType: WorkContextType.PROJECT,
          isAddToBacklog: false,
          isAddToBottom: true,
        }),
      );
      await engine.syncNow('drain');
      server.uploaded.length = 0;
      const live = (
        store.state[TASK_FEATURE_NAME] as unknown as {
          entities: Record<string, Record<string, unknown>>;
        }
      ).entities['t1'];
      store.dispatch(
        TaskSharedActions.deleteTask({
          task: { ...live, subTasks: [] } as never,
        }),
      );
      // Older concurrent remote update loses to the delete.
      const remote = updateTaskOp('t1', 'resurrect', REMOTE_ID, { [REMOTE_ID]: 2 }, 1);
      server.ops = [{ serverSeq: 3, op: remote, receivedAt: 1 }];

      const result = await engine.syncNow('test');
      assert.equal(result.conflicts, 1);
      assert.equal(result.localWins, 1);
      assert.equal(taskTitle(store, 't1'), undefined);
      // The vehicle is a Delete with a clock dominating the remote side...
      assert.equal(server.uploaded.length, 1);
      // ...and the task stays deleted (no resurrection).
      assert.equal(taskTitle(store, 't1'), undefined);
    });
  });

  it('resyncs from seq 0 and reconciles remote history', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, engine } = await setup(dir, server);
      const remote1 = addTaskOp('r1', 'Remote 1', REMOTE_ID, { [REMOTE_ID]: 1 }, 100);
      server.ops = [{ serverSeq: 1, op: remote1, receivedAt: 100 }];

      // Initial sync advances cursor to 1
      const res1 = await engine.syncNow('first-sync');
      assert.equal(res1.downloaded, 1);
      assert.equal(res1.applied, 1);
      assert.equal(taskTitle(store, 'r1'), 'Remote 1');
      assert.deepEqual(server.downloadSinceSeqs, [0]);

      // Add another op on server at seq 2
      const remote2 = addTaskOp('r2', 'Remote 2', REMOTE_ID, { [REMOTE_ID]: 2 }, 200);
      server.ops.push({ serverSeq: 2, op: remote2, receivedAt: 200 });

      // Normal sync fetches with sinceSeq: 1
      const res2 = await engine.syncNow('second-sync');
      assert.equal(res2.downloaded, 1);
      assert.equal(res2.applied, 1);
      assert.equal(taskTitle(store, 'r2'), 'Remote 2');
      assert.deepEqual(server.downloadSinceSeqs, [0, 1]);

      // Local change pending upload
      store.dispatch(
        TaskSharedActions.addTask({
          task: createTask({
            id: 'local1',
            title: 'Local task',
            tagIds: [],
            projectId: INBOX_PROJECT.id,
          }),
          workContextId: INBOX_PROJECT.id,
          workContextType: WorkContextType.PROJECT,
          isAddToBacklog: false,
          isAddToBottom: true,
        }),
      );

      // Now call resync() -> forces download from sinceSeq: 0 and uploads local pending op
      const res3 = await engine.resync('user-resync');
      // Downloaded all ops starting from seq 0 (seq 1 and seq 2)
      assert.equal(res3.downloaded, 2);
      // Replayed all server ops onto clean baseline
      assert.equal(res3.applied, 2);
      // Uploaded pending local op
      assert.equal(res3.uploaded, 1);
      // Download call requested sinceSeq: 0
      assert.deepEqual(server.downloadSinceSeqs, [0, 1, 0]);
      // Both remote and local state are preserved
      assert.equal(taskTitle(store, 'r1'), 'Remote 1');
      assert.equal(taskTitle(store, 'r2'), 'Remote 2');
      assert.equal(taskTitle(store, 'local1'), 'Local task');
    });
  });

  it('resyncs and reconstructs projects and tags from server ops while preserving local work', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, engine } = await setup(dir, server);

      const projOp = buildOperation({
        action: addProject({
          project: {
            id: 'p1',
            title: 'Remote Project 1',
            isArchived: false,
            isDone: false,
            taskIds: [],
            backlogTaskIds: [],
            noteIds: [],
          } as never,
        }),
        clientId: REMOTE_ID,
        vectorClock: { [REMOTE_ID]: 1 },
        timestamp: 100,
      });

      const tagOp = buildOperation({
        action: addTag({
          tag: {
            id: 't1',
            title: 'Remote Tag 1',
            taskIds: [],
            created: 200,
          } as never,
        }),
        clientId: REMOTE_ID,
        vectorClock: { [REMOTE_ID]: 2 },
        timestamp: 200,
      });

      const taskOp = addTaskOp(
        'r1',
        'Remote Task in P1',
        REMOTE_ID,
        { [REMOTE_ID]: 3 },
        300,
      );

      server.ops = [
        { serverSeq: 1, op: projOp, receivedAt: 100 },
        { serverSeq: 2, op: tagOp, receivedAt: 200 },
        { serverSeq: 3, op: taskOp, receivedAt: 300 },
      ];

      // Initial sync
      const res1 = await engine.syncNow('initial');
      assert.equal(res1.downloaded, 3);
      assert.equal(res1.applied, 3);

      const pState1 = (
        store.state[PROJECT_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      const tState1 = (
        store.state[TAG_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      assert.equal(pState1['p1']?.title, 'Remote Project 1');
      assert.equal(tState1['t1']?.title, 'Remote Tag 1');

      // Local pending change
      store.dispatch(
        TaskSharedActions.addTask({
          task: createTask({
            id: 'local1',
            title: 'Local task in P1',
            tagIds: ['t1'],
            projectId: 'p1',
          }),
          workContextId: 'p1',
          workContextType: WorkContextType.PROJECT,
          isAddToBacklog: false,
          isAddToBottom: true,
        }),
      );

      // Trigger full resync
      const res2 = await engine.resync('user-resync');
      assert.equal(res2.downloaded, 3);
      assert.equal(res2.applied, 3);
      assert.equal(res2.uploaded, 1);

      // Verify projects, tags, and tasks are all present
      const pState2 = (
        store.state[PROJECT_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      const tState2 = (
        store.state[TAG_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      assert.equal(pState2['p1']?.title, 'Remote Project 1');
      assert.equal(tState2['t1']?.title, 'Remote Tag 1');
      assert.equal(taskTitle(store, 'r1'), 'Remote Task in P1');
      assert.equal(taskTitle(store, 'local1'), 'Local task in P1');
    });
  });

  it('resyncs full-state SYNC_IMPORT operations reconstructing projects and tags', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, engine } = await setup(dir, server);

      const syncImportOp: Operation = {
        id: 'import-op-1',
        actionType: ActionType.LOAD_ALL_DATA,
        opType: OpType.SyncImport,
        entityType: 'ALL',
        payload: {
          project: {
            ids: ['p_imported'],
            entities: {
              p_imported: { id: 'p_imported', title: 'Imported Project' },
            },
          },
          tag: {
            ids: ['t_imported'],
            entities: {
              t_imported: { id: 't_imported', title: 'Imported Tag' },
            },
          },
          task: {
            ids: [],
            entities: {},
          },
        },
        clientId: REMOTE_ID,
        vectorClock: { [REMOTE_ID]: 1 },
        timestamp: 100,
        schemaVersion: 1,
      };

      server.ops = [{ serverSeq: 1, op: syncImportOp, receivedAt: 100 }];

      const res = await engine.resync('import-resync');
      assert.equal(res.downloaded, 1);
      assert.equal(res.applied, 1);

      const projects = (
        store.state[PROJECT_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      const tags = (
        store.state[TAG_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      assert.equal(projects['p_imported']?.title, 'Imported Project');
      assert.equal(tags['t_imported']?.title, 'Imported Tag');
    });
  });

  it('does not drop concurrent entity creations as superseded when local entity state is undefined', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, engine } = await setup(dir, server);

      // Local op on task1 advances client clock
      store.dispatch(
        TaskSharedActions.addTask({
          task: createTask({
            id: 't-local',
            title: 'Local task',
            tagIds: [],
            projectId: INBOX_PROJECT.id,
          }),
          workContextId: INBOX_PROJECT.id,
          workContextType: WorkContextType.PROJECT,
          isAddToBacklog: false,
          isAddToBottom: true,
        }),
      );
      await engine.syncNow('drain');

      // Server op creates tag t1 concurrently (remote clock does not know local clock)
      const remoteTag = buildOperation({
        action: addTag({
          tag: {
            id: 't-remote',
            title: 'Remote Tag',
            taskIds: [],
            created: 50,
          } as never,
        }),
        clientId: REMOTE_ID,
        vectorClock: { [REMOTE_ID]: 1 },
        timestamp: 50,
      });
      server.ops = [{ serverSeq: 2, op: remoteTag, receivedAt: 50 }];

      const res = await engine.syncNow('download-remote-tag');
      assert.equal(res.applied, 1);
      assert.equal(res.rejectedRemote, 0);

      const tags = (
        store.state[TAG_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      assert.equal(tags['t-remote']?.title, 'Remote Tag');
    });
  });

  it('resyncs operations authored by the local clientId itself when excludeClient is omitted', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, engine } = await setup(dir, server);

      // Server contains an operation uploaded by LOCAL_ID (e.g. from a prior session or device)
      const ownProjectOp = buildOperation({
        action: addProject({
          project: {
            id: 'p_own',
            title: 'Own Project',
            taskIds: [],
            isArchived: false,
          } as never,
        }),
        clientId: LOCAL_ID,
        vectorClock: { [LOCAL_ID]: 1 },
        timestamp: 50,
      });
      server.ops = [{ serverSeq: 1, op: ownProjectOp, receivedAt: 50 }];

      // Normal sync excludes LOCAL_ID
      const normalRes = await engine.syncNow('normal-sync');
      assert.equal(normalRes.downloaded, 0);

      // Resync downloads everything including LOCAL_ID ops
      const resyncRes = await engine.resync('full-resync');
      assert.equal(resyncRes.downloaded, 1);
      assert.equal(resyncRes.applied, 1);

      const projects = (
        store.state[PROJECT_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      assert.equal(projects['p_own']?.title, 'Own Project');
    });
  });

  it('resyncs full-state SYNC_IMPORT operations with plural keys (projects, tags, tasks)', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, engine } = await setup(dir, server);

      const syncImportOp: Operation = {
        id: 'import-op-plural',
        actionType: ActionType.LOAD_ALL_DATA,
        opType: OpType.SyncImport,
        entityType: 'ALL',
        payload: {
          projects: {
            ids: ['p_plural'],
            entities: {
              p_plural: { id: 'p_plural', title: 'Plural Project' },
            },
          },
          tags: {
            ids: ['t_plural'],
            entities: {
              t_plural: { id: 't_plural', title: 'Plural Tag' },
            },
          },
          tasks: {
            ids: [],
            entities: {},
          },
        },
        clientId: REMOTE_ID,
        vectorClock: { [REMOTE_ID]: 1 },
        timestamp: 100,
        schemaVersion: 1,
      };

      server.ops = [{ serverSeq: 1, op: syncImportOp, receivedAt: 100 }];

      const res = await engine.resync('plural-import-resync');
      assert.equal(res.downloaded, 1);
      assert.equal(res.applied, 1);

      const projects = (
        store.state[PROJECT_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      const tags = (
        store.state[TAG_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      assert.equal(projects['p_plural']?.title, 'Plural Project');
      assert.equal(tags['t_plural']?.title, 'Plural Tag');
    });
  });

  it('resyncs with flat action payloads for addProject and addTag', async () => {
    return withDirs(async (dir) => {
      const server = makeStubServer();
      const { store, engine } = await setup(dir, server);

      const flatProjectOp: Operation = {
        id: 'op-flat-proj',
        actionType: addProject.type,
        opType: OpType.Create,
        entityType: 'PROJECT',
        entityId: 'p_flat',
        payload: {
          id: 'p_flat',
          title: 'Flat Project',
          taskIds: [],
        },
        clientId: REMOTE_ID,
        vectorClock: { [REMOTE_ID]: 1 },
        timestamp: 10,
        schemaVersion: 1,
      };

      const flatTagOp: Operation = {
        id: 'op-flat-tag',
        actionType: addTag.type,
        opType: OpType.Create,
        entityType: 'TAG',
        entityId: 't_flat',
        payload: {
          id: 't_flat',
          title: 'Flat Tag',
          taskIds: [],
        },
        clientId: REMOTE_ID,
        vectorClock: { [REMOTE_ID]: 2 },
        timestamp: 20,
        schemaVersion: 1,
      };

      server.ops = [
        { serverSeq: 1, op: flatProjectOp, receivedAt: 10 },
        { serverSeq: 2, op: flatTagOp, receivedAt: 20 },
      ];

      const res = await engine.resync('flat-payload-resync');
      assert.equal(res.downloaded, 2);
      assert.equal(res.applied, 2);

      const projects = (
        store.state[PROJECT_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      const tags = (
        store.state[TAG_FEATURE_NAME] as unknown as {
          entities: Record<string, { title: string }>;
        }
      ).entities;
      assert.equal(projects['p_flat']?.title, 'Flat Project');
      assert.equal(tags['t_flat']?.title, 'Flat Tag');
    });
  });
});
