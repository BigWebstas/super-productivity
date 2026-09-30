/**
 * Turns a captured persistent action into a sync `Operation`.
 *
 * This mirrors the object literal built in the app's
 * `operation-log.effects.ts` (the persist path) field for field. Field names
 * and the payload envelope are the sync wire format: `MultiEntityPayload`
 * wrapping `actionPayload`, which the app's `convertOpToAction` unwraps on the
 * receiving side. Any drift here produces ops other clients silently misapply,
 * so the shape is asserted in `operation-factory.spec.ts` rather than trusted.
 */
import type {
  Operation,
  MultiEntityPayload,
  EntityChange,
} from '../../../../src/app/op-log/core/operation.types';
import { OpType } from '../../../../src/app/op-log/core/operation.types';
import type { ActionType } from '../../../../src/app/op-log/core/action-types.enum';
import type { PersistentAction } from '../../../../src/app/op-log/core/persistent-action.interface';
import { CURRENT_SCHEMA_VERSION } from '@sp/shared-schema';

/**
 * Operation id. Super Productivity uses uuidv7 (time-ordered) so that ids sort
 * in creation order, which keeps an append-only log readable. Node's
 * `crypto.randomUUID` is v4; a v7-shaped id is generated here to preserve the
 * ordering property without pulling in a uuid dependency.
 */
const createOperationId = (): string => {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  // version 7
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // variant
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
};

export interface BuildOperationParams {
  action: PersistentAction;
  clientId: string;
  vectorClock: Record<string, number>;
  timestamp: number;
  /**
   * `entityChanges` is a pure function of the action and is `[]` for every
   * action except the time-tracking ones. The field is always present because
   * `isMultiEntityPayload` requires it on the wire.
   */
  entityChanges?: EntityChange[];
}

/**
 * Builds the operation for a captured action.
 *
 * `entityId` is `meta.entityId`, falling back to the first declared
 * `meta.entityIds` entry: the server rejects a non-full-state op without an
 * `entityId`, and batch actions (e.g. mass delete) only declare `entityIds`.
 */
export const buildOperation = ({
  action,
  clientId,
  vectorClock,
  timestamp,
  entityChanges = [],
}: BuildOperationParams): Operation => {
  const entityIds =
    action.meta.entityIds ?? (action.meta.entityId ? [action.meta.entityId] : undefined);
  const entityId = action.meta.entityId ?? entityIds?.[0];

  if (!entityId) {
    throw new Error(
      `buildOperation: persistent action ${action.type} declares neither ` +
        `meta.entityId nor meta.entityIds, so it has no sync identity.`,
    );
  }

  // Everything except the sync bookkeeping is the action payload. `type` and
  // `meta` are dropped: they are transport-level, and `meta` in particular must
  // not be replayed from a remote (untrusted) op as if it were local.
  const { type: _type, meta: _meta, ...actionPayload } = action;

  const payload: MultiEntityPayload = {
    actionPayload: actionPayload as Record<string, unknown>,
    entityChanges,
  };

  return {
    id: createOperationId(),
    actionType: action.type as ActionType,
    opType: action.meta.opType as OpType,
    entityType: action.meta.entityType,
    entityId,
    entityIds,
    payload,
    clientId,
    vectorClock,
    timestamp,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
};
