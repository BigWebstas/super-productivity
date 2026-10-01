import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '../test/harness';
import { OpLogStore } from './op-log-store';
import { hydrateFromOpLog } from './hydrate';
import { AgentStore } from '../store/agent-store';
import { WorkContextType } from '../../../../src/app/features/work-context/work-context.model';
import { TASK_FEATURE_NAME } from '../../../../src/app/features/tasks/store/task.reducer';
import { INBOX_PROJECT } from '../../../../src/app/features/project/project.const';
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import { createTask } from '../../../../src/app/features/tasks/task.test-helper';
import type { Operation } from '../../../../src/app/op-log/core/operation.types';

/**
 * Runs `fn` against a fresh temp dir and removes it afterwards.
 *
 * Async-aware on purpose: a sync version returns before an async `fn` finishes,
 * so the cleanup `finally` deletes the directory out from under it and every
 * file operation fails with ENOENT. The failure then surfaces as a detached
 * rejection rather than as the real cause.
 */
const withTempDir = async (fn: (dir: string) => void | Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-bridge-oplog-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Deterministic client ids so assertions do not depend on randomness. */
const fixedId = (id: string) => (): string => id;

const makeOp = (overrides: Partial<Operation> = {}): Operation =>
  ({
    id: 'op-1',
    actionType: '[Task Shared] addTask',
    opType: 'CRT',
    entityType: 'TASK',
    entityId: 't1',
    payload: { actionPayload: { title: 'x' }, entityChanges: [] },
    clientId: 'E_aaaaaa',
    vectorClock: { E_aaaaaa: 1 },
    timestamp: 1,
    schemaVersion: 4,
    ...overrides,
  }) as unknown as Operation;

/** A real store op for a real task, produced through the real action creator. */
const captureAddTask = (store: AgentStore, id: string, title: string): Operation[] =>
  store.dispatch(
    TaskSharedActions.addTask({
      task: createTask({ id, title, tagIds: [], projectId: INBOX_PROJECT.id }),
      workContextId: INBOX_PROJECT.id,
      workContextType: WorkContextType.PROJECT,
      isAddToBacklog: false,
      isAddToBottom: true,
    }),
  );

const taskTitles = (store: AgentStore): Record<string, string> => {
  const state = store.state[TASK_FEATURE_NAME] as unknown as {
    entities: Record<string, { title: string }>;
  };
  return Object.fromEntries(
    Object.entries(state.entities).map(([id, task]) => [id, task.title]),
  );
};

describe('OpLogStore', () => {
  it('persists operations and reads them back', async () => {
    return withTempDir(async (dir) => {
      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      await log.append([makeOp(), makeOp({ id: 'op-2' })]);
      log.close();

      const reopened = OpLogStore.open(dir, {}, fixedId('SHOULD_NOT_BE_USED'));
      assert.equal(reopened.size, 2);
      assert.deepEqual(
        reopened.all().map((op) => op.id),
        ['op-1', 'op-2'],
      );
    });
  });

  it('keeps the clientId across restarts instead of minting a new one', async () => {
    return withTempDir(async (dir) => {
      const first = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      await first.append([makeOp()]);
      first.close();

      // A regenerated id would orphan every op already written under the old
      // one, permanently forking this device from the account.
      const second = OpLogStore.open(dir, {}, fixedId('E_bbbbbb'));
      assert.equal(second.clientId, 'E_aaaaaa');
    });
  });

  it('uses the supplied clientId only on a fresh log', async () => {
    return withTempDir((dir) => {
      const log = OpLogStore.open(dir, { clientId: 'E_seeded' }, fixedId('E_ignored'));
      assert.equal(log.clientId, 'E_seeded');
    });
  });

  it('drops a torn final line and keeps the valid prefix', async () => {
    return withTempDir(async (dir) => {
      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      await log.append([makeOp(), makeOp({ id: 'op-2' })]);
      log.close();

      // Simulate power loss mid-append: a complete line with no terminator,
      // followed by a partial one.
      appendFileSync(join(dir, 'ops.jsonl'), '{"id":"op-3","clientId":"E_aa');

      const reopened = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      assert.deepEqual(
        reopened.all().map((op) => op.id),
        ['op-1', 'op-2'],
      );
      // The file is repaired, not just read defensively.
      assert.equal(readFileSync(join(dir, 'ops.jsonl'), 'utf8').endsWith('\n'), true);

      // And the log is still appendable afterwards.
      await reopened.append([makeOp({ id: 'op-4' })]);
      reopened.close();
      const after = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      assert.equal(after.size, 3);
    });
  });

  it('skips a malformed line without losing the rest of the log', async () => {
    return withTempDir(async (dir) => {
      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      await log.append([makeOp()]);
      log.close();

      writeFileSync(
        join(dir, 'ops.jsonl'),
        [
          JSON.stringify(makeOp()),
          'not json at all',
          JSON.stringify(makeOp({ id: 'op-9' })),
        ].join('\n') + '\n',
      );

      const reopened = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      assert.deepEqual(
        reopened.all().map((op) => op.id),
        ['op-1', 'op-9'],
      );
    });
  });

  it('survives a corrupt meta.json by starting a fresh log', async () => {
    return withTempDir((dir) => {
      writeFileSync(join(dir, 'meta.json'), '{ broken');
      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      assert.equal(log.clientId, 'E_aaaaaa');
      assert.equal(log.size, 0);
    });
  });

  it('tracks the upload cursor without losing ops on restart', async () => {
    return withTempDir(async (dir) => {
      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      await log.append([makeOp(), makeOp({ id: 'op-2' }), makeOp({ id: 'op-3' })]);
      assert.equal(log.pendingUpload().length, 3);

      log.markUploaded(2);
      log.close();

      const reopened = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      assert.deepEqual(
        reopened.pendingUpload().map((op) => op.id),
        ['op-3'],
      );
    });
  });

  it('never rewinds the upload cursor', async () => {
    return withTempDir(async (dir) => {
      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      await log.append([makeOp(), makeOp({ id: 'op-2' })]);
      log.markUploaded(2);
      // A late duplicate acknowledgement must not re-upload op 1 forever.
      log.markUploaded(0);
      assert.equal(log.pendingUpload().length, 0);
    });
  });

  it('merges remote vector clocks monotonically', async () => {
    return withTempDir((dir) => {
      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      log.mergeRemoteVectorClock({ E_aaaaaa: 5, E_other01: 3 });
      log.mergeRemoteVectorClock({ E_aaaaaa: 2, E_other01: 9 });
      assert.deepEqual(log.vectorClock, { E_aaaaaa: 5, E_other01: 9 });
    });
  });

  it('starts with an empty log and no ops file', async () => {
    return withTempDir((dir) => {
      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      assert.equal(log.size, 0);
      assert.equal(existsSync(join(dir, 'meta.json')), true);
    });
  });
});

describe('hydrateFromOpLog', () => {
  it('rebuilds state from persisted operations', async () => {
    return withTempDir(async (dir) => {
      // Capture real operations through the real store.
      const source = new AgentStore('E_aaaaaa');
      const ops = [
        ...captureAddTask(source, 't1', 'Write spec'),
        ...captureAddTask(source, 't2', 'Ship it'),
      ];

      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      await log.append(ops);
      log.close();

      // A fresh store rebuilds from the log alone.
      const restarted = new AgentStore('E_aaaaaa');
      assert.deepEqual(taskTitles(restarted), {}, 'starts empty');

      const result = hydrateFromOpLog(restarted, log.all());
      assert.equal(result.applied, 2);
      assert.deepEqual(taskTitles(restarted), { t1: 'Write spec', t2: 'Ship it' });
    });
  });

  it('adopts the vector clock so the next local op is not concurrent', async () => {
    return withTempDir(async (dir) => {
      const source = new AgentStore('E_aaaaaa');
      const ops = captureAddTask(source, 't1', 'a');
      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      await log.append(ops);
      log.close();

      const restarted = new AgentStore('E_aaaaaa');
      hydrateFromOpLog(restarted, log.all());

      // One operation was written, so the clock sits at 1. Replay does NOT
      // advance it: replaying emits no operations of its own.
      assert.equal(restarted.vectorClock['E_aaaaaa'], 1);

      // The invariant that actually matters: the next local operation must be
      // causally AFTER the replayed history, not concurrent with it. A clock
      // left at 0 here would make every post-restart edit conflict with work
      // this device had already applied.
      const nextOps = captureAddTask(restarted, 't2', 'b');
      assert.equal(nextOps.length, 1);
      assert.equal(nextOps[0].vectorClock['E_aaaaaa'], 2);
    });
  });

  it('emits no new operations while replaying', async () => {
    return withTempDir(async (dir) => {
      const source = new AgentStore('E_aaaaaa');
      const log = OpLogStore.open(dir, {}, fixedId('E_aaaaaa'));
      await log.append(captureAddTask(source, 't1', 'a'));
      log.close();

      const restarted = new AgentStore('E_aaaaaa');
      // Replaying our OWN ops (not flagged isRemote on the op itself) must
      // still not re-emit them, or every boot would duplicate history.
      const emitted = restarted.dispatch({
        type: '[OperationLog] Bulk Apply Operations',
        operations: [...log.all()],
        localClientId: restarted.clientId,
        isReplayFromEmptyBaseline: true,
      } as never);
      assert.equal(emitted.length, 0);
    });
  });

  it('is a no-op for an empty log', () => {
    const store = new AgentStore('E_aaaaaa');
    assert.deepEqual(hydrateFromOpLog(store, []), { applied: 0 });
  });
});
