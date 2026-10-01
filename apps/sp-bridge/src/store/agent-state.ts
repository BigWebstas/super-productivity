/**
 * The agent's state: every Super Productivity feature slice that the sync
 * system can address, plus the UI-chrome slices reducers assume exist.
 *
 * Why full coverage: a missing slice is silent divergence, not an error. The
 * LWW meta-reducer bails (`return reducer(state, action)`) when
 * `rootState[featureName]` is undefined, and the section guard skips cleanup —
 * so a remote op for an uncovered entity replays as a no-op while every other
 * client applies it. The registry (`ENTITY_CONFIGS`) is the checklist: every
 * configured `featureName` must have a slice here.
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
import {
  initialSimpleCounterState,
  simpleCounterReducer,
  SIMPLE_COUNTER_FEATURE_NAME,
} from '../../../../src/app/features/simple-counter/store/simple-counter.reducer';
import {
  initialTaskRepeatCfgState,
  taskRepeatCfgReducer,
} from '../../../../src/app/features/task-repeat-cfg/store/task-repeat-cfg.reducer';
import { TASK_REPEAT_CFG_FEATURE_NAME } from '../../../../src/app/features/task-repeat-cfg/store/task-repeat-cfg.selectors';
import {
  initialMetricState,
  metricReducer,
  METRIC_FEATURE_NAME,
} from '../../../../src/app/features/metric/store/metric.reducer';
import {
  issueProviderInitialState,
  issueProviderReducer,
  ISSUE_PROVIDER_FEATURE_KEY,
} from '../../../../src/app/features/issue/store/issue-provider.reducer';
import {
  initialSectionState,
  sectionReducer,
  SECTION_FEATURE_NAME,
} from '../../../../src/app/features/section/store/section.reducer';
import {
  menuTreeInitialState,
  menuTreeReducer,
  menuTreeFeatureKey,
} from '../../../../src/app/features/menu-tree/store/menu-tree.reducer';
import {
  initialContextState,
  workContextReducer,
} from '../../../../src/app/features/work-context/store/work-context.reducer';
import { WORK_CONTEXT_FEATURE_NAME } from '../../../../src/app/features/work-context/store/work-context.selectors';
import {
  initialBoardsState,
  boardsReducer,
  BOARDS_FEATURE_NAME,
} from '../../../../src/app/features/boards/store/boards.reducer';
import {
  initialReminderState,
  reminderReducer,
  REMINDER_FEATURE_NAME,
} from '../../../../src/app/features/reminder/store/reminder.reducer';
import {
  pluginUserDataReducer,
  PLUGIN_USER_DATA_FEATURE_NAME,
} from '../../../../src/app/plugins/store/plugin-user-data.reducer';
import {
  pluginMetadataReducer,
  PLUGIN_METADATA_FEATURE_NAME,
} from '../../../../src/app/plugins/store/plugin-metadata.reducer';
import {
  initialPluginUserDataState,
  initialPluginMetaDataState,
  type PluginMetaDataState,
  type PluginUserDataState,
} from '../../../../src/app/plugins/plugin-persistence.model';
import {
  INITIAL_LAYOUT_STATE,
  layoutReducer,
  LAYOUT_FEATURE_NAME,
} from '../../../../src/app/core-ui/layout/store/layout.reducer';
import type { Action } from '@ngrx/store';
import type { TaskState } from '../../../../src/app/features/tasks/task.model';
import type { ProjectState } from '../../../../src/app/features/project/project.model';
import type { TagState } from '../../../../src/app/features/tag/tag.model';
import type { PlannerState } from '../../../../src/app/features/planner/store/planner.reducer';
import type { GlobalConfigState } from '../../../../src/app/features/config/global-config.model';
import type { TimeTrackingState } from '../../../../src/app/features/time-tracking/time-tracking.model';
import type { NoteState } from '../../../../src/app/features/note/note.model';
import type { AppState } from '../../../../src/app/root-store/app-state/app-state.reducer';
import type { SimpleCounterState } from '../../../../src/app/features/simple-counter/simple-counter.model';
import type { TaskRepeatCfgState } from '../../../../src/app/features/task-repeat-cfg/task-repeat-cfg.model';
import type { MetricState } from '../../../../src/app/features/metric/metric.model';
import type { IssueProviderState } from '../../../../src/app/features/issue/issue.model';
import type { SectionState } from '../../../../src/app/features/section/section.model';
import type { MenuTreeState } from '../../../../src/app/features/menu-tree/store/menu-tree.model';
import type { WorkContextState } from '../../../../src/app/features/work-context/work-context.model';
import type { BoardsState } from '../../../../src/app/features/boards/store/boards.reducer';
import type { ReminderState } from '../../../../src/app/features/reminder/store/reminder.reducer';
import type { LayoutState } from '../../../../src/app/core-ui/layout/store/layout.reducer';

export interface AgentState {
  [TASK_FEATURE_NAME]: TaskState;
  [PROJECT_FEATURE_NAME]: ProjectState;
  [TAG_FEATURE_NAME]: TagState;
  [plannerFeatureKey]: PlannerState;
  [appStateFeatureKey]: AppState;
  [CONFIG_FEATURE_NAME]: GlobalConfigState;
  [TIME_TRACKING_FEATURE_KEY]: TimeTrackingState;
  [NOTE_FEATURE_NAME]: NoteState;
  [SIMPLE_COUNTER_FEATURE_NAME]: SimpleCounterState;
  [TASK_REPEAT_CFG_FEATURE_NAME]: TaskRepeatCfgState;
  [METRIC_FEATURE_NAME]: MetricState;
  [ISSUE_PROVIDER_FEATURE_KEY]: IssueProviderState;
  [SECTION_FEATURE_NAME]: SectionState;
  [menuTreeFeatureKey]: MenuTreeState;
  [WORK_CONTEXT_FEATURE_NAME]: WorkContextState;
  [BOARDS_FEATURE_NAME]: BoardsState;
  [REMINDER_FEATURE_NAME]: ReminderState;
  [PLUGIN_USER_DATA_FEATURE_NAME]: PluginUserDataState;
  [PLUGIN_METADATA_FEATURE_NAME]: PluginMetaDataState;
  [LAYOUT_FEATURE_NAME]: LayoutState;
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
    [SIMPLE_COUNTER_FEATURE_NAME]: initialSimpleCounterState,
    [TASK_REPEAT_CFG_FEATURE_NAME]: initialTaskRepeatCfgState,
    [METRIC_FEATURE_NAME]: initialMetricState,
    [ISSUE_PROVIDER_FEATURE_KEY]: issueProviderInitialState,
    [SECTION_FEATURE_NAME]: initialSectionState,
    [menuTreeFeatureKey]: menuTreeInitialState,
    [WORK_CONTEXT_FEATURE_NAME]: initialContextState,
    [BOARDS_FEATURE_NAME]: initialBoardsState,
    [REMINDER_FEATURE_NAME]: initialReminderState,
    [PLUGIN_USER_DATA_FEATURE_NAME]: initialPluginUserDataState,
    [PLUGIN_METADATA_FEATURE_NAME]: initialPluginMetaDataState,
    [LAYOUT_FEATURE_NAME]: INITIAL_LAYOUT_STATE,
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
      [appStateFeatureKey]: appStateReducer(state[appStateFeatureKey], action),
      [CONFIG_FEATURE_NAME]: globalConfigReducer(state[CONFIG_FEATURE_NAME], action),
      [TIME_TRACKING_FEATURE_KEY]: timeTrackingReducer(
        state[TIME_TRACKING_FEATURE_KEY],
        action,
      ),
      [NOTE_FEATURE_NAME]: noteReducer(state[NOTE_FEATURE_NAME], action),
      [SIMPLE_COUNTER_FEATURE_NAME]: simpleCounterReducer(
        state[SIMPLE_COUNTER_FEATURE_NAME],
        action,
      ),
      [TASK_REPEAT_CFG_FEATURE_NAME]: taskRepeatCfgReducer(
        state[TASK_REPEAT_CFG_FEATURE_NAME],
        action,
      ),
      [METRIC_FEATURE_NAME]: metricReducer(state[METRIC_FEATURE_NAME], action),
      [ISSUE_PROVIDER_FEATURE_KEY]: issueProviderReducer(
        state[ISSUE_PROVIDER_FEATURE_KEY],
        action,
      ),
      [SECTION_FEATURE_NAME]: sectionReducer(state[SECTION_FEATURE_NAME], action),
      [menuTreeFeatureKey]: menuTreeReducer(state[menuTreeFeatureKey], action),
      [WORK_CONTEXT_FEATURE_NAME]: workContextReducer(
        state[WORK_CONTEXT_FEATURE_NAME],
        action,
      ),
      [BOARDS_FEATURE_NAME]: boardsReducer(state[BOARDS_FEATURE_NAME], action),
      [REMINDER_FEATURE_NAME]: reminderReducer(state[REMINDER_FEATURE_NAME], action),
      [PLUGIN_USER_DATA_FEATURE_NAME]: pluginUserDataReducer(
        state[PLUGIN_USER_DATA_FEATURE_NAME],
        action,
      ),
      [PLUGIN_METADATA_FEATURE_NAME]: pluginMetadataReducer(
        state[PLUGIN_METADATA_FEATURE_NAME],
        action,
      ),
      [LAYOUT_FEATURE_NAME]: layoutReducer(state[LAYOUT_FEATURE_NAME], action),
    } as unknown as AgentState;
  };
};
