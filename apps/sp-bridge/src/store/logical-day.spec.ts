import assert from 'node:assert/strict';
import { describe, it } from '../test/harness';
import { AgentStore } from './agent-store';
import { syncLogicalDay } from './logical-day';
import { appStateFeatureKey } from '../../../../src/app/root-store/app-state/app-state.reducer';
import { updateGlobalConfigSection } from '../../../../src/app/features/config/store/global-config.actions';

const at = (iso: string): number => new Date(iso).getTime();

describe('syncLogicalDay', () => {
  it('rolls appState over to the new day without emitting a sync op', () => {
    const store = new AgentStore('B_test01');
    const ops: unknown[] = [];
    store.onOperations((emitted) => ops.push(...emitted));

    syncLogicalDay(store, at('2026-10-02T12:00:00'));
    assert.equal(store.state[appStateFeatureKey].todayStr, '2026-10-02');
    syncLogicalDay(store, at('2026-10-03T00:30:00'));
    assert.equal(store.state[appStateFeatureKey].todayStr, '2026-10-03');
    assert.equal(ops.length, 0);
  });

  it('honours the synced "start of next day" setting', () => {
    const store = new AgentStore('B_test01');
    store.dispatch(
      updateGlobalConfigSection({
        sectionKey: 'misc',
        sectionCfg: { startOfNextDay: 4, startOfNextDayTime: '04:00' },
      }),
    );
    // 02:00 is still "yesterday" when the day starts at 04:00.
    assert.equal(syncLogicalDay(store, at('2026-10-03T02:00:00')).todayStr, '2026-10-02');
    assert.equal(syncLogicalDay(store, at('2026-10-03T05:00:00')).todayStr, '2026-10-03');
  });
});
