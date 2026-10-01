/**
 * Advances the focus timer while it runs.
 *
 * The desktop drives `tick` from an NgRx effect on a 1s interval; the bridge
 * has no effects, so this minimal loop dispatches the same real `tick`
 * action. `tick` is non-persistent, so it never touches the op log — focus
 * state is device-local chrome, like layout, and must never sync.
 *
 * Completion mirrors the app's `detectSessionCompletion$` predicate exactly
 * (work timer stopped with elapsed >= duration, non-Flowtime, overtime off):
 * the tick reducer already stopped the timer, and here the loop dispatches
 * the real `completeFocusSession` plus, in Pomodoro mode, the real
 * `incrementCycle` (mirroring that effect, which listens in Pomodoro only).
 * Everything else that completion fans out to on desktop — sounds, dialogs,
 * break auto-start, tracking pauses, timeSpent flushes — is effect-driven UI
 * and deliberately stays out. In particular a completed session does NOT
 * write timeSpent to the task; see the README.
 */
import {
  completeFocusSession,
  incrementCycle,
  tick,
} from '../../../../src/app/features/focus-mode/store/focus-mode.actions';
import { FocusModeMode } from '../../../../src/app/features/focus-mode/focus-mode.model';
import type { AgentStore } from '../store/agent-store';
import { FOCUS_MODE_FEATURE_KEY } from '../../../../src/app/features/focus-mode/store/focus-mode.reducer';
import type { FocusModeState } from '../../../../src/app/features/focus-mode/focus-mode.model';

const TICK_MS = 1000;

export class FocusTicker {
  private _timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly _store: AgentStore) {}

  start(): void {
    if (this._timer) {
      return;
    }
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._timer.unref?.();
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Single step, exposed so tests don't wait on wall-clock intervals. */
  step(): void {
    this._tick();
  }

  private _tick(): void {
    const focus = this._store.state[FOCUS_MODE_FEATURE_KEY] as FocusModeState | undefined;
    if (!focus || !focus.timer.isRunning) {
      return;
    }
    this._store.dispatch(tick());
    const after = (this._store.state[FOCUS_MODE_FEATURE_KEY] as FocusModeState).timer;
    // Same predicate as detectSessionCompletion$: the tick reducer stopped a
    // work timer at duration. completeFocusSession resets to idle, so this
    // fires exactly once per session.
    if (
      after.purpose === 'work' &&
      !after.isRunning &&
      after.elapsed >= after.duration &&
      focus.mode !== FocusModeMode.Flowtime &&
      !focus._isOvertimeEnabled
    ) {
      this._store.dispatch(completeFocusSession({ isManual: false }));
      if (focus.mode === FocusModeMode.Pomodoro) {
        this._store.dispatch(incrementCycle());
      }
    }
  }
}
