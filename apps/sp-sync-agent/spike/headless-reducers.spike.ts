/**
 * FEASIBILITY SPIKE — not shipped code.
 *
 * Question this answers: can a plain Node process (no Angular, no NgRx Store,
 * no browser) drive Super Productivity's REAL reducers and meta-reducers, so
 * that operations exchanged with a SuperSync server are byte-compatible with
 * the desktop app?
 *
 * If this fails, the "full interop with the real app" approach collapses and
 * the agent would have to reimplement the domain semantics by hand.
 */
import assert from 'node:assert/strict';

import {
  initialTaskState,
  taskReducer,
  TASK_FEATURE_NAME,
} from '../../../src/app/features/tasks/store/task.reducer';
import {
  initialProjectState,
  projectReducer,
  PROJECT_FEATURE_NAME,
} from '../../../src/app/features/project/store/project.reducer';
import {
  initialTagState,
  tagReducer,
  TAG_FEATURE_NAME,
} from '../../../src/app/features/tag/store/tag.reducer';

import { taskSharedCrudMetaReducer } from '../../../src/app/root-store/meta/task-shared-meta-reducers/task-shared-crud.reducer';
import { taskSharedLifecycleMetaReducer } from '../../../src/app/root-store/meta/task-shared-meta-reducers/task-shared-lifecycle.reducer';
import {
  plannerInitialState,
  plannerFeatureKey,
} from '../../../src/app/features/planner/store/planner.reducer';
import {
  appStateInitialState,
  appStateFeatureKey,
} from '../../../src/app/root-store/app-state/app-state.reducer';
import { TaskSharedActions } from '../../../src/app/root-store/meta/task-shared.actions';
import { ActionType } from '../../../src/app/op-log/core/action-types.enum';
import { createTask } from '../../../src/app/features/tasks/task.test-helper';
import { INBOX_PROJECT } from '../../../src/app/features/project/project.const';
import { WorkContextType } from '../../../src/app/features/work-context/work-context.model';

type State = Record<string, unknown>;

/**
 * The slices `handleAddTask` actually reads. Deliberately NOT the app's full
 * RootState: the agent only needs the domain slices the REST API and the
 * supported entity types touch, not layout/menuTree/boards.
 *
 * Keys MUST come from the app's exported feature-name constants — they are
 * `tasks` / `projects` / `tag`, not the singular names the entity types use.
 */
const makeInitialState = (): State => ({
  [TASK_FEATURE_NAME]: initialTaskState,
  [PROJECT_FEATURE_NAME]: initialProjectState,
  [TAG_FEATURE_NAME]: initialTagState,
  [plannerFeatureKey]: plannerInitialState,
  [appStateFeatureKey]: appStateInitialState,
});

const results: string[] = [];

const check = (name: string, fn: () => void): void => {
  try {
    fn();
    results.push(`  PASS  ${name}`);
  } catch (error) {
    const stack = (error as Error).stack ?? '';
    const frame = stack
      .split('\n')
      .find((l) => l.includes('/src/app/') && !l.includes('headless-reducers.spike'));
    results.push(
      `  FAIL  ${name}\n        ${(error as Error).message}\n        ${frame?.trim() ?? ''}`,
    );
    process.exitCode = 1;
  }
};

check('reduces addTask into the task slice', () => {
  // `tagIds` is set explicitly because `createTask` (a test helper) omits it,
  // while the real `createNewTaskWithDefaults` always sets `tagIds: []`.
  const task = createTask({
    id: 'spike-task-1',
    title: 'Spike task',
    tagIds: [],
    projectId: INBOX_PROJECT.id,
  });
  const action = TaskSharedActions.addTask({
    task,
    workContextId: INBOX_PROJECT.id,
    workContextType: WorkContextType.PROJECT,
    isAddToBacklog: false,
    isAddToBottom: true,
  });

  // The action creator must already carry the sync metadata — this is what
  // makes ops interop-compatible without the agent re-deriving it.
  assert.equal(action.type, ActionType.TASK_SHARED_ADD);
  assert.equal(action.meta.isPersistent, true);
  assert.equal(action.meta.entityType, 'TASK');
  assert.equal(action.meta.entityId, task.id);
  assert.equal(action.meta.opType, 'CRT');

  // Composition order matters: the shared meta-reducer computes the
  // cross-entity updates and hands the UPDATED state to the inner (feature)
  // reducer. An inner reducer that ignores its argument silently drops them.
  const initial = makeInitialState();
  const inner = (s: unknown): State => {
    const st = s as State;
    return {
      ...st,
      [TASK_FEATURE_NAME]: taskReducer(st[TASK_FEATURE_NAME] as never, action as never),
    };
  };
  // A meta-reducer takes only the inner reducer; the action arrives per call.
  const afterMeta = taskSharedCrudMetaReducer(inner as never)(
    initial,
    action as never,
  ) as State;

  const taskState = afterMeta[TASK_FEATURE_NAME] as {
    entities: Record<string, { title: string }>;
  };
  assert.equal(taskState.entities[task.id]?.title, 'Spike task');
});

check('project and tag reducers run headlessly', () => {
  const state = makeInitialState();
  assert.ok(
    projectReducer(state[PROJECT_FEATURE_NAME] as never, { type: '@@init' } as never),
  );
  assert.ok(tagReducer(state[TAG_FEATURE_NAME] as never, { type: '@@init' } as never));
});

check('lifecycle meta-reducer is a pure function', () => {
  assert.equal(typeof taskSharedLifecycleMetaReducer, 'function');
});

check('ActionType strings are the immutable sync vocabulary', () => {
  assert.equal(ActionType.TASK_SHARED_ADD, '[Task Shared] addTask');
  assert.equal(ActionType.TASK_SHARED_UPDATE, '[Task Shared] updateTask');
  assert.equal(ActionType.TASK_SHARED_DELETE, '[Task Shared] deleteTask');
});

// eslint-disable-next-line no-console
console.log('spike: headless reducer feasibility\n' + results.join('\n'));
