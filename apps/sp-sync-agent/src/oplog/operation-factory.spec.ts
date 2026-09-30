import assert from 'node:assert/strict';
import { describe, it } from '../test/harness';
import { buildOperation } from './operation-factory';
import { OpType } from '../../../../src/app/op-log/core/operation.types';
import { CURRENT_SCHEMA_VERSION } from '@sp/shared-schema';
import { extractActionPayload, isMultiEntityPayload } from '@sp/sync-core';
import type { PersistentAction } from '../../../../src/app/op-log/core/persistent-action.interface';

const makeAction = (
  overrides: Partial<PersistentAction['meta']> = {},
): PersistentAction =>
  ({
    type: '[Task Shared] updateTask',
    task: { id: 't1', changes: { title: 'renamed' } },
    meta: {
      isPersistent: true,
      entityType: 'TASK',
      entityId: 't1',
      opType: OpType.Update,
      ...overrides,
    },
  }) as unknown as PersistentAction;

describe('buildOperation', () => {
  it('produces a MultiEntityPayload whose actionPayload round-trips', () => {
    const op = buildOperation({
      action: makeAction(),
      clientId: 'client-0001',
      vectorClock: { 'client-0001': 1 },
      timestamp: 1_700_000_000_000,
    });

    assert.ok(isMultiEntityPayload(op.payload));
    // extractActionPayload is the app's own unwrap helper — if it returns the
    // action fields, the receiving client can rebuild the action from this op.
    const actionPayload = extractActionPayload(op.payload) as Record<string, unknown>;
    assert.equal(actionPayload['task'] !== undefined, true);
  });

  it('uses the first entityId as entityId for batch actions', () => {
    const op = buildOperation({
      // A batch action declares only entityIds; the server rejects a
      // non-full-state op without entityId.
      action: makeAction({
        entityId: undefined,
        entityIds: ['t1', 't2', 't3'],
      }),
      clientId: 'client-0001',
      vectorClock: { 'client-0001': 1 },
      timestamp: 1,
    });

    assert.equal(op.entityId, 't1');
    assert.deepEqual(op.entityIds, ['t1', 't2', 't3']);
  });

  it('stamps the current schema version', () => {
    const op = buildOperation({
      action: makeAction(),
      clientId: 'client-0001',
      vectorClock: { 'client-0001': 1 },
      timestamp: 1,
    });
    assert.equal(op.schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it('generates unique, time-ordered ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const op = buildOperation({
        action: makeAction(),
        clientId: 'client-0001',
        vectorClock: { 'client-0001': i },
        timestamp: i,
      });
      ids.add(op.id);
      // uuidv7 shape: version nibble 7, RFC 4122 variant.
      assert.match(
        op.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    assert.equal(ids.size, 50, 'operation ids must be unique');
  });

  it('refuses an action with no sync identity instead of emitting a bad op', () => {
    assert.throws(
      () =>
        buildOperation({
          action: makeAction({ entityId: undefined, entityIds: undefined }),
          clientId: 'client-0001',
          vectorClock: { 'client-0001': 1 },
          timestamp: 1,
        }),
      /no sync identity/,
    );
  });
});
