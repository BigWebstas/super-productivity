/**
 * The agent's state: the subset of Super Productivity's `RootState` that the
 * REST API and the supported entity types actually touch.
 *
 * Why a subset: the full RootState carries UI slices (layout, menuTree,
 * boards, app-state chrome) that a headless agent never renders. They are
 * still declared here where a reducer or meta-reducer reads them, because a
 * missing slice is a `TypeError` at reduce time, not a no-op.
 *
 * Slice KEYS must come from the app's exported feature-name constants. They are
 * not the singular entity names: the task slice is `tasks` and the project
 * slice is `projects`, while the entity types are `TASK` and `PROJECT`.
 */
import {
  initialTaskState,
  taskReducer,
  TASK_FEATURE_NAME,
} from '../../../../src/app/features/tasks/store/task.reducer';
import {
  initialProjectState,
  projectReducer,
  PROJECT_FEATURE_NAME,
} from '../../../../src/app/features/project/store/project.reducer';
import {
  initialTagState,
  tagReducer,
  TAG_FEATURE_NAME,
} from '../../../../src/app/features/tag/store/tag.reducer';
import {
  plannerInitialState,
  plannerReducer,
  plannerFeatureKey,
} from '../../../../src/app/features/planner/store/planner.reducer';
import {
  appStateInitialState,
  appStateReducer,
  appStateFeatureKey,
} from '../../../../src/app/root-store/app-state/app-state.reducer';
import {
  initialGlobalConfigState,
  globalConfigReducer,
  CONFIG_FEATURE_NAME,
} from '../../../../src/app/features/config/store/global-config.reducer';
import {
  initialTimeTrackingState,
  timeTrackingReducer,
  TIME_TRACKING_FEATURE_KEY,
} from '../../../../src/app/features/time-tracking/store/time-tracking.reducer';
import {
  initialNoteState,
  noteReducer,
  NOTE_FEATURE_NAME,
} from '../../../../src/app/features/note/store/note.reducer';
import type { Action } from '@ngrx/store';
import type { TaskState } from '../../../../src/app/features/tasks/task.model';
import type { ProjectState } from '../../../../src/app/features/project/project.model';
import type { TagState } from '../../../../src/app/features/tag/tag.model';
import type { PlannerState } from '../../../../src/app/features/planner/store/planner.reducer';
import type { GlobalConfigState } from '../../../../src/app/features/config/global-config.model';
import type { TimeTrackingState } from '../../../../src/app/features/time-tracking/time-tracking.model';
import type { NoteState } from '../../../../src/app/features/note/note.model';
import type { AppState } from '../../../../src/app/root-store/app-state/app-state.reducer';

export interface AgentState {
  [TASK_FEATURE_NAME]: TaskState;
  [PROJECT_FEATURE_NAME]: ProjectState;
  [TAG_FEATURE_NAME]: TagState;
  [plannerFeatureKey]: PlannerState;
  [appStateFeatureKey]: AppState;
  [CONFIG_FEATURE_NAME]: GlobalConfigState;
  [TIME_TRACKING_FEATURE_KEY]: TimeTrackingState;
  [NOTE_FEATURE_NAME]: NoteState;
}

export type AgentAction = Action;

/**
 * A fresh state with the app's own defaults — including the Inbox project and
 * the My Day tag, which the CRUD meta-reducers assume exist (a task added to
 * a project that is not in state is silently not linked to it).
 */
export const createInitialAgentState = (): AgentState =>
  ({
    [TASK_FEATURE_NAME]: initialTaskState,
    [PROJECT_FEATURE_NAME]: initialProjectState,
    [TAG_FEATURE_NAME]: initialTagState,
    [plannerFeatureKey]: plannerInitialState,
    [appStateFeatureKey]: appStateInitialState,
    [CONFIG_FEATURE_NAME]: initialGlobalConfigState,
    [TIME_TRACKING_FEATURE_KEY]: initialTimeTrackingState,
    [NOTE_FEATURE_NAME]: initialNoteState,
  }) as unknown as AgentState;

/**
 * The base (innermost) reducer: fans one action out to every feature reducer.
 *
 * Every slice is passed through its real reducer unconditionally, which is what
 * NgRx's `ActionReducerMap` composition would do. A feature reducer that does
 * not handle the action returns its own input unchanged, so this is safe for
 * actions only some slices care about.
 */
export const createFeatureReducer = (): ((
  state: AgentState | undefined,
  action: AgentAction,
) => AgentState) => {
  return (state: AgentState | undefined, action: AgentAction): AgentState => {
    if (!state) {
      return state as unknown as AgentState;
    }
    return {
      ...state,
      [TASK_FEATURE_NAME]: taskReducer(state[TASK_FEATURE_NAME], action),
      [PROJECT_FEATURE_NAME]: projectReducer(state[PROJECT_FEATURE_NAME], action),
      [TAG_FEATURE_NAME]: tagReducer(state[TAG_FEATURE_NAME], action),
      [plannerFeatureKey]: plannerReducer(state[plannerFeatureKey], action),
      [CONFIG_FEATURE_NAME]: globalConfigReducer(state[CONFIG_FEATURE_NAME], action),
      [TIME_TRACKING_FEATURE_KEY]: timeTrackingReducer(
        state[TIME_TRACKING_FEATURE_KEY],
        action,
      ),
      [NOTE_FEATURE_NAME]: noteReducer(state[NOTE_FEATURE_NAME], action),
    } as unknown as AgentState;
  };
};
