/**
 * Root reducer: the app's real feature reducers under the app's real, ordered
 * meta-reducer registry.
 *
 * The registry (`META_REDUCERS`) is imported from Super Productivity rather
 * than re-declared. Its ordering is load-bearing in ways the source documents
 * at length (capture before mutation, `sectionShared` before `taskSharedCrud`
 * because it reads pre-CRUD state, `actionLoggerReducer` last). Re-typing the
 * list here would silently drift the first time the app reorders it, and a
 * drifted order corrupts state and produces ops other clients misapply.
 *
 * ONE substitution: the app's `operationCaptureMetaReducer` is swapped for the
 * agent's own. The app's version increments a pending counter on an
 * Angular-injected `OperationCaptureService` that an NgRx effect later drains;
 * the agent has no effects and no DI, so it captures directly in
 * `AgentStore`. Everything else — including the position in the chain, which
 * the registry's own dev-mode validator asserts — is preserved.
 */
import type { ActionReducer } from '@ngrx/store';
import { META_REDUCERS } from '../../../../src/app/root-store/meta/meta-reducer-registry';
import { operationCaptureMetaReducer } from '../../../../src/app/op-log/capture/operation-capture.meta-reducer';
import { isPersistentAction } from '../../../../src/app/op-log/core/persistent-action.interface';
import type { PersistentAction } from '../../../../src/app/op-log/core/persistent-action.interface';
import { createFeatureReducer, type AgentAction, type AgentState } from './agent-state';

/** Receives every persistent local action, in dispatch order. */
export type CaptureSink = (action: PersistentAction) => void;

/**
 * The agent's capture meta-reducer.
 *
 * Same contract as the app's, minus the counter: persistent actions that did
 * not come from sync are forwarded to the sink so the store can turn them into
 * operations. Remote actions (`meta.isRemote`) are skipped — replaying a
 * remote op must never re-emit it, or two clients would ping-pong the same
 * change forever.
 *
 * Runs at the app's capture position (index 1) so its slot in the chain —
 * and therefore the ordering constraints the registry documents — is
 * preserved. It forwards the action object after the inner reducers run; that
 * is equivalent to capturing before, because no meta-reducer mutates the
 * action itself, and post-reduce capture means a reducer throw never emits an
 * operation for state that was not produced (mirroring the app's failure-guard
 * guarantee).
 */
export const createCaptureMetaReducer =
  (sink: CaptureSink) =>
  (
    reducer: ActionReducer<AgentState, AgentAction>,
  ): ActionReducer<AgentState, AgentAction> =>
  (state: AgentState | undefined, action: AgentAction): AgentState => {
    const afterState = reducer(state, action);
    if (isPersistentAction(action) && !(action as PersistentAction).meta.isRemote) {
      sink(action as PersistentAction);
    }
    return afterState;
  };

/**
 * Composes the root reducer.
 *
 * `META_REDUCERS` is outermost-first, so it is folded in order on top of the
 * feature reducer — the same shape NgRx builds from `metaReducers`.
 *
 * Note `reduceRight`, not `reduce`. NgRx composes with
 * `compose(...metaReducers, reducerFactory)`, which is
 * `rest.reduceRight((composed, fn) => fn(composed), last(arg))` — so the FIRST
 * registry entry ends up OUTERMOST, exactly as the registry documents. A
 * left-to-right `reduce` builds the chain inside-out, which still reduces and
 * still looks right by inspection, but leaves the CRUD meta-reducer OUTSIDE
 * `bulkOperationsMetaReducer` — so the actions bulk replay converts and reduces
 * never reach the cross-entity reducers, and a replay silently rebuilds an
 * incomplete state.
 */
export const createRootReducer = (
  sink: CaptureSink,
): ((state: AgentState | undefined, action: AgentAction) => AgentState) => {
  const withCapture = createCaptureMetaReducer(sink);

  return META_REDUCERS.reduceRight<
    (state: AgentState | undefined, action: AgentAction) => AgentState
  >((reducer, metaReducer) => {
    // Swap the app's capture reducer for the agent's, keeping its slot.
    const effective =
      metaReducer === operationCaptureMetaReducer ? withCapture : metaReducer;
    return effective(reducer as never) as (
      state: AgentState | undefined,
      action: AgentAction,
    ) => AgentState;
  }, createFeatureReducer());
};
