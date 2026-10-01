/**
 * The agent's store: a minimal synchronous store over Super Productivity's real
 * reducers, plus the capture hook that turns local persistent actions into sync
 * operations.
 *
 * There is no NgRx `Store` here on purpose. The agent needs three things from a
 * store — dispatch, read, observe — and the reducers themselves are pure
 * functions, so a ~100-line store replaces the framework's runtime (and its
 * Angular DI) without changing a single reduce.
 *
 * Capture is pull-based rather than push-based: `drainCaptured()` hands the
 * store's captured actions to the caller as a batch. The op-log then persists
 * them before they are reported as applied, so a crash can never leave state
 * that no operation represents (the "phantom change" the app guards against
 * with its pending counter).
 */
import type { PersistentAction } from '../../../../src/app/op-log/core/persistent-action.interface';
import { buildOperation } from '../oplog/operation-factory';
import {
  createInitialAgentState,
  type AgentAction,
  type AgentState,
} from './agent-state';
import { createRootReducer } from './root-reducer';
import { incrementVectorClock } from '../../../../src/app/core/util/vector-clock';
import { generateClientId } from '../../../../src/app/core/util/generate-client-id';
import type { Operation } from '../../../../src/app/op-log/core/operation.types';

export type StateListener = (state: AgentState) => void;

export class AgentStore {
  private _state: AgentState;
  private readonly _reducer: (
    state: AgentState | undefined,
    action: AgentAction,
  ) => AgentState;
  private _captured: PersistentAction[] = [];
  private readonly _listeners = new Set<StateListener>();
  /**
   * Receives every operation the store produces.
   *
   * This is the ONLY way operations reach durable storage, and it is
   * deliberately not the caller's job: a dispatch that returns operations
   * nobody persists is a "phantom change" — state that exists with no
   * operation behind it, which is unrecoverable divergence once another device
   * syncs. Registering the sink once at construction makes it impossible for a
   * new dispatch site (a route, a future timer, a plugin) to forget.
   *
   * The sink MUST be synchronous and throw on failure (never reject later):
   * `dispatch` calls it before notifying observers, so a throw prevents both
   * the 201 and the notification for state that is not durable.
   */
  private _operationSink: (ops: Operation[]) => void = () => undefined;
  private _clientId: string;
  private _vectorClock: Record<string, number>;

  constructor(
    clientId?: string,
    initialState?: AgentState,
    initialVectorClock?: Record<string, number>,
  ) {
    this._clientId = clientId ?? generateClientId();
    // Seeded from durable storage when available. Hydration also folds the
    // clocks in from the operations themselves, so this is belt-and-braces —
    // but it is what keeps the clock correct for a client whose log is
    // currently empty, where hydration has nothing to recover it from.
    this._vectorClock = initialVectorClock
      ? { ...initialVectorClock }
      : { [this._clientId]: 0 };
    if (!(this._clientId in this._vectorClock)) {
      this._vectorClock[this._clientId] = 0;
    }
    this._reducer = createRootReducer((action) => this._captured.push(action));
    this._state = initialState ?? createInitialAgentState();
  }

  get clientId(): string {
    return this._clientId;
  }

  get state(): AgentState {
    return this._state;
  }

  get vectorClock(): Record<string, number> {
    return { ...this._vectorClock };
  }

  subscribe(listener: StateListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * Registers the durable sink for produced operations.
   *
   * Returns a function that reverts to a no-op, so a test (or a shutdown path)
   * can detach it. Must be called before any state-changing dispatch.
   */
  onOperations(sink: (ops: Operation[]) => void): () => void {
    this._operationSink = sink;
    return () => {
      this._operationSink = () => undefined;
    };
  }

  /**
   * Applies an action to state.
   *
   * Returns the operations the action produced. They have already been handed to
   * the sink; an empty array means the action was not persistent (or was a
   * replayed remote op) and needs no operation.
   */
  dispatch(action: AgentAction): Operation[] {
    this._captured = [];
    this._state = this._reducer(this._state, action);

    const ops = this._captured.map((captured) => {
      // `incrementVectorClock` returns a new clock; the store must adopt it.
      // Not persisting it here is the subtle version of this bug: every
      // operation would carry the same counter, so the server would see them
      // as concurrent with each other and the client would never catch up.
      const nextClock = incrementVectorClock(this._vectorClock, this._clientId);
      this._vectorClock = nextClock;
      return buildOperation({
        action: captured,
        clientId: this._clientId,
        vectorClock: nextClock,
        timestamp: Date.now(),
      });
    });

    if (ops.length) {
      // Synchronous by contract: the sink must throw on failure rather than
      // reject later, so a non-durable change surfaces as a thrown dispatch
      // (→ HTTP 500) instead of a 201 for state with no operation behind it.
      // Notified only after the sink accepts, so observers never see state
      // that failed to persist.
      this._operationSink(ops);
    }
    this._notify();
    return ops;
  }

  /**
   * Replaces state wholesale and folds remote vector clocks into ours.
   *
   * Used when replaying downloaded operations: the ops are already captured on
   * the server side, so they must NOT be re-emitted, and the resulting clock
   * must include every client that contributed, or the next local operation
   * would be written with a clock that looks concurrent to work already applied.
   */
  applyRemoteState(
    state: AgentState,
    remoteVectorClocks: Record<string, number>[],
  ): void {
    this._state = state;
    for (const clock of remoteVectorClocks) {
      for (const [clientId, counter] of Object.entries(clock)) {
        const current = this._vectorClock[clientId] ?? 0;
        if (counter > current) {
          this._vectorClock[clientId] = counter;
        }
      }
    }
    this._notify();
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      listener(this._state);
    }
  }
}
