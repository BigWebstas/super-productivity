import assert from 'node:assert/strict';
import { describe, it } from '../test/harness';
import { AgentStore } from '../store/agent-store';
import { FocusTicker } from './focus-ticker';
import {
  setFocusModeMode,
  startBreak,
  startFocusSession,
} from '../../../../src/app/features/focus-mode/store/focus-mode.actions';
import { FocusModeMode } from '../../../../src/app/features/focus-mode/focus-mode.model';
import { FOCUS_MODE_FEATURE_KEY } from '../../../../src/app/features/focus-mode/store/focus-mode.reducer';
import type { FocusModeState } from '../../../../src/app/features/focus-mode/focus-mode.model';

const timerOf = (store: AgentStore): FocusModeState['timer'] =>
  (store.state[FOCUS_MODE_FEATURE_KEY] as FocusModeState).timer;

const cycleOf = (store: AgentStore): number =>
  (store.state[FOCUS_MODE_FEATURE_KEY] as FocusModeState).currentCycle;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('FocusTicker', () => {
  it('is a no-op while idle', () => {
    const store = new AgentStore('E_aaaaaa');
    const ticker = new FocusTicker(store);
    ticker.step();
    assert.equal(timerOf(store).purpose, null);
  });

  it('advances elapsed while running', async () => {
    const store = new AgentStore('E_aaaaaa');
    const ticker = new FocusTicker(store);
    store.dispatch(startFocusSession({ duration: 60_000 }));
    await sleep(120);
    ticker.step();
    const elapsed = timerOf(store).elapsed;
    assert.ok(elapsed >= 100 && elapsed < 60_000, `elapsed=${elapsed}`);
    assert.equal(timerOf(store).isRunning, true);
  });

  it('completes a work session and increments the pomodoro cycle', async () => {
    const store = new AgentStore('E_aaaaaa');
    const ticker = new FocusTicker(store);
    store.dispatch(setFocusModeMode({ mode: FocusModeMode.Pomodoro }));
    const before = cycleOf(store);
    store.dispatch(startFocusSession({ duration: 100 }));
    await sleep(250);
    ticker.step();
    assert.equal(timerOf(store).purpose, null);
    assert.equal(timerOf(store).isRunning, false);
    assert.equal(cycleOf(store), before + 1);
  });

  it('lets a break expire without completing a session', async () => {
    const store = new AgentStore('E_aaaaaa');
    const ticker = new FocusTicker(store);
    const before = cycleOf(store);
    store.dispatch(startBreak({ duration: 100 }));
    await sleep(250);
    ticker.step();
    assert.equal(timerOf(store).purpose, 'break');
    assert.equal(timerOf(store).isRunning, false);
    assert.equal(cycleOf(store), before);
  });

  it('stops ticking after cancel', async () => {
    const store = new AgentStore('E_aaaaaa');
    const ticker = new FocusTicker(store);
    ticker.start();
    store.dispatch(startFocusSession({ duration: 60_000 }));
    ticker.stop();
    await sleep(1100);
    // No tick ran while stopped: elapsed stays at dispatch time (0).
    assert.equal(timerOf(store).elapsed, 0);
  });
});
