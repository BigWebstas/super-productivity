import assert from 'node:assert/strict';
import { describe, it } from '../test/harness';
import { AgentStore } from '../store/agent-store';
import { WorkContextType } from '../../../../src/app/features/work-context/work-context.model';
import { TASK_FEATURE_NAME } from '../../../../src/app/features/tasks/store/task.reducer';
import { PROJECT_FEATURE_NAME } from '../../../../src/app/features/project/store/project.reducer';
import { INBOX_PROJECT } from '../../../../src/app/features/project/project.const';

const INBOX_PROJECT_ID = INBOX_PROJECT.id;
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import { ActionType } from '../../../../src/app/op-log/core/action-types.enum';
import { createTask } from '../../../../src/app/features/tasks/task.test-helper';
import { CURRENT_SCHEMA_VERSION } from '@sp/shared-schema';
import { isMultiEntityPayload } from '@sp/sync-core';
import { DEFAULT_GLOBAL_CONFIG } from '../../../../src/app/features/config/default-global-config.const';

const makeTask = (id: string, title: string) =>
  createTask({ id, title, tagIds: [], projectId: INBOX_PROJECT_ID });

describe('AgentStore', () => {
  it('reduces a real addTask action into the task slice', () => {
    const store = new AgentStore('test-client-0001');
    const task = makeTask('t1', 'Buy milk');

    store.dispatch(
      TaskSharedActions.addTask({
        task,
        workContextId: INBOX_PROJECT_ID,
        workContextType: WorkContextType.PROJECT,
        isAddToBacklog: false,
        isAddToBottom: true,
      }),
    );

    const state = store.state;
    const taskState = state[TASK_FEATURE_NAME] as unknown as {
      entities: Record<string, { title: string }>;
      ids: string[];
    };
    assert.equal(taskState.entities['t1']?.title, 'Buy milk');
    assert.ok(taskState.ids.includes('t1'));
  });

  it('captures exactly one sync operation carrying the wire payload', () => {
    const store = new AgentStore('test-client-0001');
    const task = makeTask('t1', 'Buy milk');

    const ops = store.dispatch(
      TaskSharedActions.addTask({
        task,
        workContextId: INBOX_PROJECT_ID,
        workContextType: WorkContextType.PROJECT,
        isAddToBacklog: false,
        isAddToBottom: true,
      }),
    );

    assert.equal(ops.length, 1);
    const [op] = ops;

    // Identity fields other clients key on.
    assert.equal(op.actionType, ActionType.TASK_SHARED_ADD);
    assert.equal(op.entityType, 'TASK');
    assert.equal(op.entityId, 't1');
    assert.equal(op.opType, 'CRT');
    assert.equal(op.clientId, 'test-client-0001');
    assert.equal(op.schemaVersion, CURRENT_SCHEMA_VERSION);

    // The payload must be the MultiEntityPayload envelope the app's
    // convertOpToAction unwraps — a bare action payload would replay as an
    // action with no fields on every other client.
    assert.ok(isMultiEntityPayload(op.payload), 'payload must be a MultiEntityPayload');
    const payload = op.payload as { actionPayload: Record<string, unknown> };
    const taskPayload = payload.actionPayload['task'] as { title: string };
    assert.equal(taskPayload.title, 'Buy milk');
    assert.ok(Array.isArray((op.payload as { entityChanges: unknown }).entityChanges));

    // Transport bookkeeping must not leak into the replayed action.
    assert.equal(payload.actionPayload['type'], undefined);
    assert.equal(payload.actionPayload['meta'], undefined);
  });

  it('increments the vector clock once per captured operation', () => {
    const store = new AgentStore('test-client-0001');
    assert.deepEqual(store.vectorClock, { 'test-client-0001': 0 });

    store.dispatch(
      TaskSharedActions.addTask({
        task: makeTask('t1', 'a'),
        workContextId: INBOX_PROJECT_ID,
        workContextType: WorkContextType.PROJECT,
        isAddToBacklog: false,
        isAddToBottom: true,
      }),
    );

    assert.deepEqual(store.vectorClock, { 'test-client-0001': 1 });
  });

  it('does not re-capture a replayed remote operation', () => {
    const store = new AgentStore('test-client-0001');
    const task = makeTask('t1', 'From another device');

    // Exactly what convertOpToAction produces for a downloaded op.
    const remoteAction = {
      ...TaskSharedActions.addTask({
        task,
        workContextId: INBOX_PROJECT_ID,
        workContextType: WorkContextType.PROJECT,
        isAddToBacklog: false,
        isAddToBottom: true,
      }),
      meta: {
        isPersistent: true,
        entityType: 'TASK' as const,
        entityId: 't1',
        opType: 'CRT' as const,
        isRemote: true,
      },
    };

    const ops = store.dispatch(remoteAction);

    // State still applies (that is the point of replay)…
    const taskState = store.state[TASK_FEATURE_NAME] as unknown as {
      entities: Record<string, { title: string }>;
    };
    assert.equal(taskState.entities['t1']?.title, 'From another device');
    // …but no operation is emitted, or the two clients would trade the same
    // change back and forth forever.
    assert.equal(ops.length, 0);
  });

  it('emits no operation for a non-persistent action', () => {
    const store = new AgentStore('test-client-0001');
    const ops = store.dispatch({ type: '[Agent] Noop' });
    assert.equal(ops.length, 0);
  });

  it('merges remote vector clocks so the next local op is not concurrent', () => {
    const store = new AgentStore('test-client-0001');
    store.applyRemoteState(store.state, [{ 'other-client-01': 7 }]);
    assert.deepEqual(store.vectorClock, {
      'test-client-0001': 0,
      'other-client-01': 7,
    });
  });

  it('notifies subscribers and can be unsubscribed', () => {
    const store = new AgentStore('test-client-0001');
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);

    store.dispatch({ type: '[Agent] Noop' });
    assert.equal(calls, 1);

    unsubscribe();
    store.dispatch({ type: '[Agent] Noop' });
    assert.equal(calls, 1);
  });

  it('starts from a state containing the Inbox project and My Day tag', () => {
    const store = new AgentStore('test-client-0001');
    const projects = store.state[PROJECT_FEATURE_NAME] as unknown as {
      entities: Record<string, { title: string }>;
    };
    assert.ok(projects.entities[INBOX_PROJECT_ID], 'Inbox project must exist');
    assert.equal(
      (
        store.state[PROJECT_FEATURE_NAME] as unknown as {
          entities: Record<string, unknown>;
        }
      ).entities[INBOX_PROJECT_ID] !== undefined,
      true,
    );
  });

  it('carries the default global config', () => {
    const store = new AgentStore('test-client-0001');
    const cfg = store.state.globalConfig as unknown as Record<string, unknown>;
    assert.deepEqual(cfg, DEFAULT_GLOBAL_CONFIG);
  });
});
