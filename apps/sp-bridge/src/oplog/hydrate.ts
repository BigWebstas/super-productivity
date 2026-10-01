/**
 * Rebuilds state from the durable operation log at boot.
 *
 * This dispatches the app's own `bulkApplyOperations` action, which the
 * `bulkOperationsMetaReducer` (already in the agent's meta-reducer chain)
 * unwraps: it converts each operation with the app's `convertOpToAction` and
 * runs it through the full reducer chain in a single pass. So hydration
 * inherits the app's exact replay semantics — legacy payload fix-ups, LWW
 * cleared-field restoration, entity-id canonicalisation, per-op failure
 * isolation — instead of a hand-written replayer that would drift from them.
 *
 * The log is replayed onto DEFAULT state with `isReplayFromEmptyBaseline`,
 * because at this point the log is the whole history: there is no snapshot
 * beneath it. The flag matters — it is what makes a client's own leading genesis
 * op replay as full state rather than as an inert no-op.
 */
import { bulkApplyOperations } from '../../../../src/app/op-log/apply/bulk-hydration.action';
import type { Operation } from '../../../../src/app/op-log/core/operation.types';
import type { AgentStore } from '../store/agent-store';

export interface HydrateResult {
  applied: number;
}

/**
 * Applies every operation in the log to the store.
 *
 * Returns once the reducer pass is done. Operations are applied in log order,
 * which is creation order (ids are uuidv7), so replay is deterministic.
 */
export const hydrateFromOpLog = (
  store: AgentStore,
  ops: readonly Operation[],
): HydrateResult => {
  if (!ops.length) {
    return { applied: 0 };
  }

  const before = store.state;
  store.dispatch(
    bulkApplyOperations({
      operations: [...ops],
      localClientId: store.clientId,
      isReplayFromEmptyBaseline: true,
    }),
  );

  // Fold every contributing client's clock into the store, so the first local
  // operation written after a restart is causally after this history rather
  // than concurrent with it.
  store.applyRemoteState(
    store.state,
    ops.map((op) => op.vectorClock),
  );

  if (store.state === before) {
    // Not an error: a log of only genesis/inert ops legitimately reduces to the
    // same object. Logged so an empty hydration is distinguishable from a
    // silent no-op failure.
    console.warn('[hydrate] Replaying the op log produced no state change');
  }

  return { applied: ops.length };
};
