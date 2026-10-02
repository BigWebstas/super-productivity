/**
 * Keeps the store's `appState.todayStr` on the user's logical day.
 *
 * The app does this with effects (`AppStateEffects` on a timer, and
 * `GlobalConfigEffects` when "start of next day" changes). The bridge has no
 * effects, so without this the date is frozen at process start: after
 * midnight `addTask` would order a dueDay=today task into the wrong Today and
 * `?tagId=TODAY` would list yesterday. Same inputs as the app — the synced
 * `misc.startOfNextDay*` config through the app's own normalizer and diff util
 * — so both sides agree on what "today" is.
 *
 * `setTodayString` is not persistent, so dispatching it emits no sync op.
 */
import { AppStateActions } from '../../../../src/app/root-store/app-state/app-state.actions';
import { appStateFeatureKey } from '../../../../src/app/root-store/app-state/app-state.reducer';
import { CONFIG_FEATURE_NAME } from '../../../../src/app/features/config/store/global-config.reducer';
import { normalizeStartOfNextDayConfig } from '../../../../src/app/features/config/normalize-start-of-next-day-config';
import { getStartOfNextDayDiffMs } from '../../../../src/app/util/start-of-next-day.util';
import { getDbDateStr } from '../../../../src/app/util/get-db-date-str';
import type { AgentStore } from './agent-store';

export interface LogicalDay {
  todayStr: string;
  startOfNextDayDiffMs: number;
}

/** Brings `appState` up to date and returns the current logical day. */
export const syncLogicalDay = (
  store: AgentStore,
  now: number = Date.now(),
): LogicalDay => {
  const misc = normalizeStartOfNextDayConfig(store.state[CONFIG_FEATURE_NAME].misc);
  const startOfNextDayDiffMs = getStartOfNextDayDiffMs(
    misc.startOfNextDayTime,
    misc.startOfNextDay,
  );
  const todayStr = getDbDateStr(new Date(now - startOfNextDayDiffMs));
  const current = store.state[appStateFeatureKey];
  if (
    current.todayStr !== todayStr ||
    current.startOfNextDayDiffMs !== startOfNextDayDiffMs
  ) {
    store.dispatch(AppStateActions.setTodayString({ todayStr, startOfNextDayDiffMs }));
  }
  return { todayStr, startOfNextDayDiffMs };
};
