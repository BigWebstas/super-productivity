/**
 * Route table for the local REST API.
 *
 * A port of `LocalRestApiHandlerService`, with the NgRx services replaced by
 * the agent's store. The service-layer calls it makes (`taskService.add`,
 * `taskService.update`, …) become dispatches of the SAME action creators the
 * services dispatch, so every mutation produces the same persistent action — and
 * therefore the same sync operation — as it does in the desktop app.
 *
 * Preserved deliberately, because they are behavioural contract rather than
 * incidental detail:
 *  - the `ok` / `data` / `error` envelope and the exact status codes;
 *  - the writable-field allow-list and the rejected relational fields
 *    (`parentId`, `subTaskIds`), which protect invariants that cannot be
 *    maintained by writing the value directly;
 *  - deadline mutual-exclusivity and the "a changed deadline clears its stale
 *    reminder" rule;
 *  - id lookups that compare `task.id === taskId`, so a prototype property name
 *    like `constructor` cannot resolve to a truthy non-task.
 */
import { randomUUID } from 'node:crypto';
import type { AgentStore } from '../store/agent-store';
import type { AgentState } from '../store/agent-state';
import { WorkContextType } from '../../../../src/app/features/work-context/work-context.model';
import { TASK_FEATURE_NAME } from '../../../../src/app/features/tasks/store/task.reducer';
import { PROJECT_FEATURE_NAME } from '../../../../src/app/features/project/store/project.reducer';
import { TAG_FEATURE_NAME } from '../../../../src/app/features/tag/store/tag.reducer';
import {
  setCurrentTask,
  unsetCurrentTask,
  addSubTask,
} from '../../../../src/app/features/tasks/store/task.actions';
import type { TaskWithSubTasks } from '../../../../src/app/features/tasks/task.model';
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import { INBOX_PROJECT } from '../../../../src/app/features/project/project.const';
import { DEFAULT_TASK } from '../../../../src/app/features/tasks/task.model';
import { isValidDBDateStr } from '../../../../src/app/util/get-db-date-str';
import { TODAY_TAG } from '../../../../src/app/features/tag/tag.const';
import type { Task } from '../../../../src/app/features/tasks/task.model';
import {
  cancelFocusSession,
  pauseFocusSession,
  startBreak,
  startFocusSession,
  unPauseFocusSession,
} from '../../../../src/app/features/focus-mode/store/focus-mode.actions';
import { FOCUS_MODE_DEFAULTS } from '../../../../src/app/features/focus-mode/focus-mode.model';
import {
  selectCurrentCycle,
  selectIsBreakTimeUp,
  selectIsInOvertime,
  selectIsLongBreak,
  selectIsRunning,
  selectIsSessionCompleted,
  selectMode,
  selectTimeRemaining,
  selectTimer,
} from '../../../../src/app/features/focus-mode/store/focus-mode.selectors';
import type { RestRequest, RestResponse, RouteHandler } from './server';
import { errorBody, successBody } from './server';
import type { FileTaskArchive } from '../archive/archive-store';
import type { SyncCycleResult, SyncEngineStatus } from '../sync/engine';
import { SyncBusyError, SyncNotConfiguredError } from '../sync/engine';
import type { RedactedSyncConfig } from '../sync/sync-config';
import { SyncConfigValidationError } from '../sync/sync-config';

/** Fields a caller may set. Everything else is rejected to protect invariants. */
const ALLOWED_TASK_FIELDS = new Set<string>([
  'title',
  'notes',
  'isDone',
  'timeEstimate',
  'timeSpent',
  'projectId',
  'tagIds',
  'dueDay',
  'dueWithTime',
  'plannedAt',
  'deadlineDay',
  'deadlineWithTime',
  'deadlineRemindAt',
]);

/**
 * Relational fields callers try to set but that must be rejected: writing them
 * as plain values corrupts parent<->child links and tag-ordering lists.
 * Subtask creation is available via `POST /tasks` with `parentId`.
 */
const REJECTED_TASK_FIELDS = ['parentId', 'subTaskIds'] as const;

const DEADLINE_FIELDS = ['deadlineDay', 'deadlineWithTime', 'deadlineRemindAt'] as const;

/** Inherited from the parent by the reducer, so setting them would lie. */
const SUBTASK_INHERITED_FIELDS = ['projectId', 'tagIds'] as const;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const error = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
): RestResponse => ({
  status,
  body: errorBody(code, message),
});

const ok = (status: number, data: unknown): RestResponse => ({
  status,
  body: successBody(data),
});

const taskEntities = (state: AgentState): Record<string, Task> =>
  (state[TASK_FEATURE_NAME] as unknown as { entities: Record<string, Task> }).entities;

/**
 * Looks a task up by id.
 *
 * The `id === taskId` comparison is not redundant: an entity-map lookup resolves
 * inherited `Object.prototype` keys, so `GET /tasks/constructor` would otherwise
 * return a truthy non-task.
 */
const getTaskById = (state: AgentState, taskId: string): Task | undefined => {
  const task = taskEntities(state)[taskId];
  return task?.id === taskId ? task : undefined;
};

const getSubTaskIds = (task: Task): string[] =>
  Array.isArray(task.subTaskIds) ? task.subTaskIds : [];

const withSubTasks = (state: AgentState, task: Task): Task & { subTasks?: Task[] } => {
  const subTasks = getSubTaskIds(task)
    .map((id) => getTaskById(state, id))
    .filter((t): t is Task => !!t);
  return subTasks.length ? { ...task, subTasks } : task;
};

/** Local YYYY-MM-DD for a timestamp, matching the app's logical-today basis. */
const toLocalDateStr = (timestamp: number): string => {
  const d = new Date(timestamp);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

/** Mirrors the app's `createNewTaskWithDefaults` for the agent's single context. */
const createTaskWithDefaults = (title: string, additional: Partial<Task>): Task =>
  ({
    ...DEFAULT_TASK,
    created: Date.now(),
    title,
    id: randomUUID(),
    projectId: INBOX_PROJECT.id,
    tagIds: [],
    ...additional,
  }) as Task;

/** Value-level type checks for the writable fields. */
const hasInvalidFieldValue = (fields: Json): string | undefined => {
  const stringOrNull = (v: unknown): boolean =>
    v === null || v === undefined || typeof v === 'string';
  const numberOrNull = (v: unknown): boolean =>
    v === null || v === undefined || typeof v === 'number';
  if ('title' in fields && typeof fields.title !== 'string')
    return 'title must be a string';
  if ('notes' in fields && typeof fields.notes !== 'string')
    return 'notes must be a string';
  if ('isDone' in fields && typeof fields.isDone !== 'boolean')
    return 'isDone must be a boolean';
  for (const key of ['timeEstimate', 'timeSpent', 'plannedAt'] as const) {
    if (key in fields && typeof fields[key] !== 'number')
      return `${key} must be a number`;
  }
  if ('projectId' in fields && typeof fields.projectId !== 'string')
    return 'projectId must be a string';
  if (
    'tagIds' in fields &&
    (!Array.isArray(fields.tagIds) || fields.tagIds.some((id) => typeof id !== 'string'))
  ) {
    return 'tagIds must be an array of strings';
  }
  for (const key of ['dueDay', 'deadlineDay'] as const) {
    if (key in fields && !stringOrNull(fields[key]))
      return `${key} must be a string or null`;
    if (typeof fields[key] === 'string' && !isValidDBDateStr(fields[key])) {
      return `${key} must be a valid YYYY-MM-DD date`;
    }
  }
  for (const key of ['dueWithTime', 'deadlineWithTime', 'deadlineRemindAt'] as const) {
    if (key in fields && !numberOrNull(fields[key]))
      return `${key} must be a number or null`;
    if (typeof fields[key] === 'number' && fields[key] <= 0) {
      return `${key} must be a positive timestamp`;
    }
  }
  return undefined;
};

const pickAllowedFields = (body: Json): Json => {
  const result: Json = {};
  for (const key of Object.keys(body)) {
    if (ALLOWED_TASK_FIELDS.has(key)) {
      result[key] = body[key];
    }
  }
  return result;
};

export interface RouterDeps {
  store: AgentStore;
  archive: FileTaskArchive;
  sync?: {
    status: () => SyncEngineStatus | { enabled: false };
    trigger: (options?: { forceFromSeq0?: boolean }) => Promise<SyncCycleResult>;
    resync?: () => Promise<SyncCycleResult>;
  } | null;
  syncConfig?: {
    get: () => RedactedSyncConfig;
    update: (patch: unknown) => RedactedSyncConfig;
  } | null;
}

export const createRouteHandler = ({
  store,
  sync = null,
  syncConfig = null,
  archive,
}: RouterDeps): RouteHandler => {
  const dispatch = (action: unknown): void => {
    store.dispatch(action as never);
  };

  const handleListTasks = (request: RestRequest): RestResponse => {
    const state = store.state;
    const query = request.query;
    const getParam = (key: string): string | undefined => {
      const value = query[key];
      return Array.isArray(value) ? value[0] : value;
    };

    const rawSource = getParam('source') ?? 'active';
    if (!(['active', 'archived', 'all'] as const).includes(rawSource as 'active')) {
      return error(
        400,
        'INVALID_INPUT',
        `Unknown source "${rawSource}" — expected active, archived or all`,
      );
    }
    const source = rawSource as 'active' | 'archived' | 'all';
    const archivedTasks = Object.values(archive.load().entities);
    const base: Task[] =
      source === 'archived'
        ? archivedTasks
        : source === 'all'
          ? [...Object.values(taskEntities(state)), ...archivedTasks]
          : Object.values(taskEntities(state));

    let filtered = base;
    const queryText = getParam('query');
    if (queryText) {
      const needle = queryText.toLowerCase();
      filtered = filtered.filter((t) => t.title.toLowerCase().includes(needle));
    }
    const projectId = getParam('projectId');
    if (projectId) {
      filtered = filtered.filter((t) => t.projectId === projectId);
    }
    const todayLocalStr = toLocalDateStr(Date.now());
    const tagId = getParam('tagId');
    if (tagId) {
      filtered =
        tagId === TODAY_TAG.id
          ? // TODAY is virtual: membership comes from the due date, never from
            // task.tagIds (ARCHITECTURE-DECISIONS.md #2). Both date and
            // timestamp forms count, compared in LOCAL time like the app's
            // logical today — a UTC date would shift the set by a day for
            // half the planet.
            filtered.filter((t) => {
              if (t.dueDay === todayLocalStr) {
                return true;
              }
              return (
                typeof t.dueWithTime === 'number' &&
                toLocalDateStr(t.dueWithTime) === todayLocalStr
              );
            })
          : filtered.filter((t) => (t.tagIds ?? []).includes(tagId));
    }
    if ((getParam('includeDone') ?? 'false').toLowerCase() !== 'true') {
      filtered = filtered.filter((t) => !t.isDone);
    }
    return ok(200, filtered);
  };

  const handleCreateTask = (request: RestRequest): RestResponse => {
    const body = request.body;
    if (!isRecord(body) || typeof body.title !== 'string' || !body.title.trim()) {
      return error(400, 'INVALID_INPUT', 'Task title must be a non-empty string');
    }
    if ('subTaskIds' in body) {
      return error(
        400,
        'UNSUPPORTED_FIELD',
        'subTaskIds cannot be set on task creation — create the parent first, then create each child with POST /tasks using parentId',
      );
    }

    const title = body.title.trim();
    const fields = pickAllowedFields(body);
    // `title` is authoritative from the trimmed value above. Left in `fields`
    // it would be re-applied by the `...additional` spread in
    // createTaskWithDefaults and silently restore the untrimmed string.
    delete fields.title;
    const invalid = hasInvalidFieldValue(fields);
    if (invalid) {
      return error(400, 'INVALID_INPUT', invalid);
    }
    if (fields.deadlineDay != null && fields.deadlineWithTime != null) {
      return error(
        400,
        'INVALID_INPUT',
        'deadlineDay and deadlineWithTime cannot both be set',
      );
    }
    if (
      fields.deadlineRemindAt != null &&
      fields.deadlineDay == null &&
      fields.deadlineWithTime == null
    ) {
      return error(400, 'INVALID_INPUT', 'deadlineRemindAt requires a deadline');
    }

    const deadlineFields: Json = {};
    for (const field of DEADLINE_FIELDS) {
      if (hasOwn(fields, field)) {
        deadlineFields[field] = fields[field];
        delete fields[field];
      }
    }

    if ('parentId' in body) {
      if (typeof body.parentId !== 'string' || !body.parentId) {
        return error(400, 'INVALID_INPUT', 'parentId must be a non-empty string');
      }
      const inherited = SUBTASK_INHERITED_FIELDS.find((field) => field in body);
      if (inherited) {
        return error(
          400,
          'UNSUPPORTED_FIELD',
          `${inherited} cannot be set when creating a subtask — it's inherited from the parent`,
        );
      }
      const parent = getTaskById(store.state, body.parentId);
      if (!parent) {
        return error(404, 'PARENT_NOT_FOUND', `Parent task ${body.parentId} not found`);
      }
      if (parent.parentId) {
        return error(
          400,
          'INVALID_PARENT',
          'Cannot nest subtasks: parent task is itself a subtask',
        );
      }
      const subTask = createTaskWithDefaults(title, fields as Partial<Task>);
      dispatch(addSubTask({ task: subTask, parentId: parent.id }));
      const created = getTaskById(store.state, subTask.id);
      return created
        ? ok(201, created)
        : error(500, 'INTERNAL_ERROR', 'Subtask was not created');
    }

    // The work context must agree with the task's project: `addTask` links the
    // task into the context's ordering, so INBOX context + another projectId
    // would create a task no list owns. PATCH already validates the target
    // project; creation must too, or orphan tasks sync to every device.
    const projectId =
      typeof fields.projectId === 'string' && fields.projectId.trim()
        ? (fields.projectId as string)
        : INBOX_PROJECT.id;
    const projects =
      (
        store.state[PROJECT_FEATURE_NAME] as unknown as {
          entities?: Record<string, { isArchived?: boolean }>;
        }
      )?.entities || {};
    const targetProject = projects[projectId];
    if (!targetProject || targetProject.isArchived) {
      return error(404, 'PROJECT_NOT_FOUND', 'Destination project not found or archived');
    }
    const task = createTaskWithDefaults(title, {
      ...fields,
      projectId,
    } as Partial<Task>);
    dispatch(
      TaskSharedActions.addTask({
        task,
        workContextId: projectId,
        workContextType: WorkContextType.PROJECT,
        isAddToBacklog: false,
        isAddToBottom: true,
      }),
    );
    const created = getTaskById(store.state, task.id);
    return created
      ? ok(201, created)
      : error(500, 'INTERNAL_ERROR', 'Task was not created');
  };

  const handlePatchTask = (taskId: string, request: RestRequest): RestResponse => {
    const body = request.body;
    if (!isRecord(body)) {
      return error(400, 'INVALID_INPUT', 'PATCH body must be a JSON object');
    }
    const rejected = REJECTED_TASK_FIELDS.find((field) => field in body);
    if (rejected) {
      return error(
        400,
        'UNSUPPORTED_FIELD',
        `${rejected} cannot be set via PATCH — re-parenting is not supported by this API`,
      );
    }

    const existing = getTaskById(store.state, taskId);
    if (!existing) {
      return error(404, 'TASK_NOT_FOUND', 'Task not found');
    }

    const changes = pickAllowedFields(body);
    const invalid = hasInvalidFieldValue(changes);
    if (invalid) {
      return error(400, 'INVALID_INPUT', invalid);
    }
    if (changes.deadlineDay != null && changes.deadlineWithTime != null) {
      return error(
        400,
        'INVALID_INPUT',
        'deadlineDay and deadlineWithTime cannot both be set',
      );
    }

    const isProjectChange =
      'projectId' in changes && changes.projectId !== existing.projectId;
    if (isProjectChange) {
      const target = changes.projectId;
      if (typeof target !== 'string' || !target.trim()) {
        return error(400, 'INVALID_INPUT', 'projectId must be a non-empty string');
      }
      if (existing.parentId) {
        return error(
          400,
          'UNSUPPORTED_FIELD',
          'projectId cannot be changed directly on a subtask — move its parent task instead',
        );
      }
      const projects =
        (
          store.state[PROJECT_FEATURE_NAME] as unknown as {
            entities?: Record<string, { isArchived?: boolean }>;
          }
        )?.entities || {};
      const target_ = projects[target];
      if (!target_ || target_.isArchived) {
        return error(
          404,
          'PROJECT_NOT_FOUND',
          'Destination project not found or archived',
        );
      }
    }

    // Deadline fields go through their own action: the deadline meta-reducer
    // maintains invariants (mutual exclusivity, reminder clearing, auto-plan)
    // that a plain field write would bypass.
    const deadlineFields: Json = {};
    for (const field of DEADLINE_FIELDS) {
      if (hasOwn(changes, field)) {
        deadlineFields[field] = changes[field];
        delete changes[field];
      }
    }

    if (Object.keys(changes).length > 0) {
      dispatch(
        TaskSharedActions.updateTask({
          task: { id: taskId, changes: changes as never },
        }),
      );
    }

    if (
      hasOwn(deadlineFields, 'deadlineDay') ||
      hasOwn(deadlineFields, 'deadlineWithTime')
    ) {
      const day = deadlineFields.deadlineDay;
      const time = deadlineFields.deadlineWithTime;
      if (day == null && time == null) {
        dispatch(TaskSharedActions.removeDeadline({ taskId, isSkipSnack: true }));
      } else {
        dispatch(
          TaskSharedActions.setDeadline({
            taskId,
            // Narrowed, not cast: `deadlineFields` is an untyped bag, so a
            // caller sending `{"deadlineDay": 42}` must be turned away by the
            // value checks above rather than reaching the reducer as `{}`.
            ...(typeof day === 'string' ? { deadlineDay: day } : {}),
            ...(typeof time === 'number' ? { deadlineWithTime: time } : {}),
            isSkipSnack: true,
          }),
        );
      }
    }
    if (hasOwn(deadlineFields, 'deadlineRemindAt')) {
      const remindAt = deadlineFields.deadlineRemindAt;
      if (remindAt == null) {
        dispatch(TaskSharedActions.clearDeadlineReminder({ taskId }));
      } else if (typeof remindAt === 'number') {
        dispatch(
          TaskSharedActions.setDeadline({
            taskId,
            deadlineRemindAt: remindAt,
            isSkipSnack: true,
          }),
        );
      }
    }

    const updated = getTaskById(store.state, taskId);
    return updated
      ? ok(200, updated)
      : error(500, 'INTERNAL_ERROR', 'Task disappeared after update');
  };

  const handleArchiveTask = (taskId: string): RestResponse => {
    const task = getTaskById(store.state, taskId);
    if (!task) {
      return error(404, 'TASK_NOT_FOUND', 'Task not found');
    }
    // File first, mirroring ArchiveService-before-dispatch: receivers rebuild
    // their archive from the op payload, so the bytes must exist before the
    // op does. A boxed dispatch rolls the write back below.
    // `subTasks: []` is load-bearing, not tidiness: the lifecycle reducer maps
    // over it unconditionally, and the action creator requires the full task
    // payload for sync reliability.
    const base = withSubTasks(store.state, task);
    const withKids = { ...base, subTasks: base.subTasks ?? [] } as TaskWithSubTasks;
    archive.putTasks([withKids]);
    const ops = store.dispatch(
      TaskSharedActions.moveToArchive({ tasks: [withKids] }) as never,
    );
    if (!ops.length) {
      archive.deleteTasks([taskId, ...getSubTaskIds(task)]);
      return error(500, 'INTERNAL_ERROR', 'Task was not archived');
    }
    return ok(200, { id: taskId, archived: true });
  };

  const handleRestoreTask = (taskId: string): RestResponse => {
    const archived = archive.getById(taskId);
    if (!archived) {
      return error(404, 'TASK_NOT_FOUND', 'Task not found in archive');
    }
    const subTasks = getSubTaskIds(archived)
      .map((id) => archive.getById(id))
      .filter((t): t is Task => !!t);
    // Dispatch first here (mirroring TaskService.restoreTask): the file
    // delete only happens for state that actually came back.
    const ops = store.dispatch(
      TaskSharedActions.restoreTask({ task: archived, subTasks }) as never,
    );
    if (!ops.length) {
      return error(500, 'INTERNAL_ERROR', 'Task was not restored');
    }
    archive.deleteTasks([taskId, ...subTasks.map((t) => t.id)]);
    const restored = getTaskById(store.state, taskId);
    return restored
      ? ok(200, restored)
      : error(500, 'INTERNAL_ERROR', 'Task disappeared after restore');
  };

  const handleTaskRoutes = (
    method: string,
    segments: string[],
    request: RestRequest,
  ): RestResponse | null => {
    const taskId = segments[1] as string;
    // Archive/restore resolve against different stores than the active-task
    // routes below, so they run before the active lookup (a restore target is
    // never active, and would 404 there unconditionally).
    if (segments.length === 3 && segments[2] === 'archive' && method === 'POST') {
      return handleArchiveTask(taskId);
    }
    if (segments.length === 3 && segments[2] === 'restore' && method === 'POST') {
      return handleRestoreTask(taskId);
    }
    const task = getTaskById(store.state, taskId);
    if (!task) {
      return error(404, 'TASK_NOT_FOUND', 'Task not found');
    }

    if (segments.length === 2) {
      if (method === 'GET') {
        return ok(200, task);
      }
      if (method === 'PATCH') {
        return handlePatchTask(taskId, request);
      }
      if (method === 'DELETE') {
        // withSubTasks attaches the children so a parent delete removes the
        // whole family, matching the app's deleteTask semantics.
        dispatch(
          TaskSharedActions.deleteTask({
            task: withSubTasks(store.state, task) as never,
          }),
        );
        return ok(200, { deleted: true, id: taskId });
      }
    }

    if (segments.length === 3 && segments[2] === 'start' && method === 'POST') {
      dispatch(setCurrentTask({ id: taskId }));
      return ok(200, { currentTaskId: taskId });
    }

    return null;
  };

  return async (request: RestRequest): Promise<RestResponse> => {
    const { method, path } = request;

    if (method === 'GET' && path === '/sync/status') {
      return sync ? ok(200, sync.status()) : ok(200, { enabled: false as const });
    }

    if (method === 'GET' && path === '/sync/config') {
      // Reads the file, never secrets: safe to serve even unconfigured.
      if (!syncConfig) {
        return error(409, 'SYNC_NOT_CONFIGURED', 'Sync configuration is unavailable');
      }
      return ok(200, syncConfig.get());
    }

    if (method === 'POST' && path === '/sync/config') {
      // This is how an unconfigured bridge gets its first token, so it must
      // not require a running engine — applying the patch starts one.
      if (!syncConfig) {
        return error(409, 'SYNC_NOT_CONFIGURED', 'Sync configuration is unavailable');
      }
      try {
        return ok(200, syncConfig.update(request.body));
      } catch (updateError) {
        if (updateError instanceof SyncConfigValidationError) {
          return error(400, 'INVALID_INPUT', updateError.message);
        }
        throw updateError;
      }
    }

    if (method === 'POST' && path === '/sync/trigger') {
      if (!sync) {
        return error(
          409,
          'SYNC_NOT_CONFIGURED',
          'SuperSync is not configured — add an accessToken to sync.json',
        );
      }
      try {
        const body = isRecord(request.body) ? request.body : undefined;
        const forceFromSeq0 =
          body?.['forceFromSeq0'] === true || body?.['resync'] === true;
        return ok(200, await sync.trigger({ forceFromSeq0 }));
      } catch (triggerError) {
        if (triggerError instanceof SyncBusyError) {
          return error(429, 'SYNC_BUSY', 'A sync cycle is already running');
        }
        if (triggerError instanceof SyncNotConfiguredError) {
          return error(
            409,
            'SYNC_NOT_CONFIGURED',
            'SuperSync is not configured — add an accessToken to sync.json',
          );
        }
        throw triggerError;
      }
    }

    if (method === 'POST' && path === '/sync/resync') {
      if (!sync) {
        return error(
          409,
          'SYNC_NOT_CONFIGURED',
          'SuperSync is not configured — add an accessToken to sync.json',
        );
      }
      try {
        const resyncFn = sync.resync
          ? () => sync.resync!()
          : () => sync.trigger({ forceFromSeq0: true });
        return ok(200, await resyncFn());
      } catch (triggerError) {
        if (triggerError instanceof SyncBusyError) {
          return error(429, 'SYNC_BUSY', 'A sync cycle is already running');
        }
        if (triggerError instanceof SyncNotConfiguredError) {
          return error(
            409,
            'SYNC_NOT_CONFIGURED',
            'SuperSync is not configured — add an accessToken to sync.json',
          );
        }
        throw triggerError;
      }
    }

    if (method === 'GET' && path === '/status') {
      const state = store.state;
      const taskState = state[TASK_FEATURE_NAME] as unknown as {
        currentTaskId: string | null;
      };
      const currentTaskId = taskState.currentTaskId ?? null;
      const currentTask = currentTaskId
        ? (getTaskById(state, currentTaskId) ?? null)
        : null;
      return ok(200, {
        currentTask,
        currentTaskId,
        taskCount: Object.keys(taskEntities(state)).length,
      });
    }

    if (method === 'GET' && path === '/focus') {
      // Same shape as the desktop handler. Focus state is device-local
      // chrome (never synced), so this reads the live slice directly.
      const focusState = store.state;
      const timer = selectTimer(focusState);
      return ok(200, {
        mode: selectMode(focusState),
        cycle: selectCurrentCycle(focusState),
        isSessionDone: selectIsSessionCompleted(focusState),
        timer:
          timer.purpose === null
            ? null
            : {
                purpose: timer.purpose,
                status: selectIsRunning(focusState)
                  ? 'running'
                  : selectIsBreakTimeUp(focusState)
                    ? 'done'
                    : 'paused',
                isOvertime: selectIsInOvertime(focusState),
                isLongBreak: selectIsLongBreak(focusState),
                elapsedMs: timer.elapsed,
                remainingMs: selectTimeRemaining(focusState),
                durationMs: timer.duration,
              },
      });
    }

    if (method === 'POST' && path === '/focus/start') {
      // Bridge extension (the desktop API is read-only here): without a way
      // to start a session the timer could never run headless.
      if (!isRecord(request.body)) {
        return error(400, 'INVALID_INPUT', 'Request body must be a JSON object');
      }
      const { durationMs, taskId } = request.body as {
        durationMs?: unknown;
        taskId?: unknown;
      };
      if (
        durationMs !== undefined &&
        (typeof durationMs !== 'number' || durationMs <= 0)
      ) {
        return error(400, 'INVALID_INPUT', 'durationMs must be a positive number');
      }
      if (taskId !== undefined && typeof taskId !== 'string') {
        return error(400, 'INVALID_INPUT', 'taskId must be a string');
      }
      if (typeof taskId === 'string' && !getTaskById(store.state, taskId)) {
        return error(404, 'TASK_NOT_FOUND', 'Task not found');
      }
      if (typeof taskId === 'string') {
        dispatch(setCurrentTask({ id: taskId }));
      }
      dispatch(
        startFocusSession({
          duration: typeof durationMs === 'number' ? durationMs : undefined,
        }),
      );
      return ok(200, { started: true, taskId: taskId ?? null });
    }

    if (method === 'POST' && path === '/focus/pause') {
      dispatch(pauseFocusSession({}));
      return ok(200, { paused: true });
    }

    if (method === 'POST' && path === '/focus/resume') {
      dispatch(unPauseFocusSession());
      return ok(200, { running: true });
    }

    if (method === 'POST' && path === '/focus/stop') {
      dispatch(cancelFocusSession());
      return ok(200, { stopped: true });
    }

    if (method === 'POST' && path === '/focus/break/start') {
      if (!isRecord(request.body)) {
        return error(400, 'INVALID_INPUT', 'Request body must be a JSON object');
      }
      const { durationMs, isLongBreak } = request.body as {
        durationMs?: unknown;
        isLongBreak?: unknown;
      };
      if (
        durationMs !== undefined &&
        (typeof durationMs !== 'number' || durationMs <= 0)
      ) {
        return error(400, 'INVALID_INPUT', 'durationMs must be a positive number');
      }
      if (isLongBreak !== undefined && typeof isLongBreak !== 'boolean') {
        return error(400, 'INVALID_INPUT', 'isLongBreak must be a boolean');
      }
      dispatch(
        startBreak({
          duration:
            typeof durationMs === 'number'
              ? durationMs
              : isLongBreak === true
                ? FOCUS_MODE_DEFAULTS.LONG_BREAK_DURATION
                : FOCUS_MODE_DEFAULTS.SHORT_BREAK_DURATION,
          isLongBreak: isLongBreak === true,
        }),
      );
      return ok(200, { started: true });
    }

    if (method === 'GET' && path === '/task-control/current') {
      const state = store.state;
      const taskState = state[TASK_FEATURE_NAME] as unknown as {
        currentTaskId: string | null;
      };
      const currentTaskId = taskState.currentTaskId ?? null;
      return ok(200, currentTaskId ? (getTaskById(state, currentTaskId) ?? null) : null);
    }

    if (method === 'POST' && path === '/task-control/current') {
      if (!isRecord(request.body)) {
        return error(
          400,
          'INVALID_INPUT',
          'Request body must be a JSON object with taskId',
        );
      }
      const taskId = request.body.taskId;
      if (taskId === null) {
        dispatch(unsetCurrentTask());
        return ok(200, { currentTaskId: null });
      }
      if (typeof taskId !== 'string') {
        return error(400, 'INVALID_INPUT', 'taskId must be a string or null');
      }
      if (!getTaskById(store.state, taskId)) {
        return error(404, 'TASK_NOT_FOUND', 'Task not found');
      }
      dispatch(setCurrentTask({ id: taskId }));
      return ok(200, { currentTaskId: taskId });
    }

    if (method === 'POST' && path === '/task-control/stop') {
      dispatch(unsetCurrentTask());
      return ok(200, { currentTaskId: null });
    }

    if (method === 'GET' && path === '/tasks') {
      return handleListTasks(request);
    }
    if (method === 'POST' && path === '/tasks') {
      return handleCreateTask(request);
    }

    const segments = path.split('/').filter(Boolean);
    if (segments[0] === 'tasks' && segments[1] && segments.length >= 2) {
      const result = handleTaskRoutes(method, segments, request);
      if (result) {
        return result;
      }
    }

    if (method === 'GET' && path === '/projects') {
      const query = request.query.query;
      const needle = (Array.isArray(query) ? query[0] : query)?.toLowerCase();
      let projects = Object.values(
        (
          store.state[PROJECT_FEATURE_NAME] as unknown as {
            entities?: Record<string, { title?: string }>;
          }
        )?.entities || {},
      ).filter((p): p is { title: string } => !!p && typeof p.title === 'string');
      if (needle) {
        projects = projects.filter((p) => p.title.toLowerCase().includes(needle));
      }
      return ok(200, projects);
    }

    if (method === 'GET' && path === '/tags') {
      const query = request.query.query;
      const needle = (Array.isArray(query) ? query[0] : query)?.toLowerCase();
      let tags = Object.values(
        (
          store.state[TAG_FEATURE_NAME] as unknown as {
            entities?: Record<string, { title?: string }>;
          }
        )?.entities || {},
      ).filter((t): t is { title: string } => !!t && typeof t.title === 'string');
      if (needle) {
        tags = tags.filter((t) => t.title.toLowerCase().includes(needle));
      }
      return ok(200, tags);
    }

    return error(404, 'NOT_FOUND', 'Route not found');
  };
};
