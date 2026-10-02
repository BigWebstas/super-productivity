/**
 * Tag Reducer
 *
 * IMPORTANT: TODAY_TAG is a "Virtual Tag"
 * -----------------------------------------
 * TODAY_TAG (ID: 'TODAY') is handled specially:
 * - Should NEVER be in task.tagIds - membership is determined by task.dueDay
 * - TODAY_TAG.taskIds only stores ordering for the today list
 * - Move handlers below work uniformly for ALL tags including TODAY
 *
 * This pattern keeps move operations (drag/drop, Ctrl+↑/↓) simple.
 * See: ARCHITECTURE-DECISIONS.md Decision #2
 */
import { createEntityAdapter, EntityAdapter, Update } from '@ngrx/entity';
import { Tag, TagState } from '../tag.model';
import { createFeatureSelector, createReducer, createSelector, on } from '@ngrx/store';
import { DEFAULT_TAG, TODAY_TAG } from '../tag.const';
import { WorkContextType } from '../../work-context/work-context.model';
import {
  moveTaskDownInTodayList,
  moveTaskInTodayList,
  moveTaskToBottomInTodayList,
  moveTaskToTopInTodayList,
  moveTaskUpInTodayList,
} from '../../work-context/store/work-context-meta.actions';
import { moveItemAfterAnchor } from '../../work-context/store/work-context-meta.helper';
import {
  arrayMoveLeftUntil,
  arrayMoveRightUntil,
  arrayMoveToEnd,
  arrayMoveToStart,
} from '../../../util/array-move';
import { loadAllData } from '../../../root-store/meta/load-all-data.action';
import {
  addTag,
  deleteTag,
  deleteTags,
  updateAdvancedConfigForTag,
  updateTag,
  updateTagOrder,
} from './tag.actions';
import { Log } from '../../../core/log';

export const TAG_FEATURE_NAME = 'tag';
const WORK_CONTEXT_TYPE: WorkContextType = WorkContextType.TAG;

export const tagAdapter: EntityAdapter<Tag> = createEntityAdapter<Tag>();
export const selectTagFeatureState = createFeatureSelector<TagState>(TAG_FEATURE_NAME);
export const { selectIds, selectEntities, selectAll, selectTotal } =
  tagAdapter.getSelectors();
export const selectAllTags = createSelector(selectTagFeatureState, selectAll);
export const selectAllTagIds = createSelector(selectTagFeatureState, selectIds);

export const selectAllTagsWithoutMyDay = createSelector(
  selectAllTags,
  (tags: Tag[]): Tag[] => tags.filter((tag) => tag.id !== TODAY_TAG.id),
);

/**
 * @deprecated Use `selectTodayTaskIds` from work-context.selectors.ts instead.
 *
 * This selector returns raw stored taskIds which may be stale or incomplete.
 * `selectTodayTaskIds` computes membership from task.dueDay (virtual tag pattern)
 * and is self-healing.
 * Exception: cleanup code that removes stale raw TODAY_TAG ids needs this stored order.
 *
 * See: ARCHITECTURE-DECISIONS.md Decision #2
 */
export const selectTodayTagTaskIds = createSelector(
  selectTagFeatureState,
  (state: TagState): string[] => {
    return state.entities[TODAY_TAG.id]!.taskIds as string[];
  },
);

/**
 * Helper function to compute ordered task IDs for a tag using board-style hybrid pattern.
 *
 * This pattern makes `task.tagIds` the single source of truth for tag membership,
 * while `tag.taskIds` is used only for ordering. This provides:
 *
 * 1. **Atomic consistency**: Membership determined by task.tagIds (single source of truth)
 * 2. **Order preservation**: User-specified order from tag.taskIds
 * 3. **Self-healing**:
 *    - Stale taskIds in tag.taskIds → gracefully filtered out
 *    - Tasks with tagId not in tag.taskIds → auto-added at end
 *
 * @param tagId - The ID of the tag to get tasks for
 * @param tag - The tag entity (or undefined if not found)
 * @param taskEntities - Map of task entities
 * @returns Ordered array of task IDs
 */
export const computeOrderedTaskIdsForTag = (
  tagId: string,
  tag: Tag | undefined,
  taskEntities: Record<
    string,
    { id: string; tagIds: string[]; parentId?: string | null } | undefined
  >,
): string[] => {
  if (!tag) {
    return [];
  }

  const storedOrder = tag.taskIds;

  // Find all tasks that have this tag in their tagIds (membership source of truth)
  // Include all tasks (including subtasks) that have this tag in their tagIds
  const tasksWithTag: string[] = [];
  for (const taskId of Object.keys(taskEntities)) {
    const task = taskEntities[taskId];
    if (task && task.tagIds?.includes(tagId)) {
      tasksWithTag.push(taskId);
    }
  }

  if (tasksWithTag.length === 0) {
    return [];
  }

  // Filter out subtasks whose parent also has this tag
  // (subtasks should only appear nested under their parent, not as separate top-level items)
  const tasksWithTagSet = new Set(tasksWithTag);
  const topLevelTasksWithTag = tasksWithTag.filter((taskId) => {
    const task = taskEntities[taskId];
    return !task?.parentId || !tasksWithTagSet.has(task.parentId);
  });

  if (topLevelTasksWithTag.length === 0) {
    return [];
  }

  // Order tasks according to stored order, with unordered tasks appended at end
  // PERF: Use Map for O(1) lookup instead of indexOf which is O(n) per task
  const orderedTasks: (string | undefined)[] = [];
  const unorderedTasks: string[] = [];
  const topLevelTasksSet = new Set(topLevelTasksWithTag);
  const storedOrderMap = new Map(storedOrder.map((id, idx) => [id, idx]));

  for (const taskId of topLevelTasksWithTag) {
    const orderIndex = storedOrderMap.get(taskId);
    if (orderIndex !== undefined) {
      orderedTasks[orderIndex] = taskId;
    } else {
      // Task has tagId but not in stored order - auto-add at end
      unorderedTasks.push(taskId);
    }
  }

  // Filter out undefined slots (stale IDs in stored order) and append unordered
  return [
    ...orderedTasks.filter(
      (id): id is string => id !== undefined && topLevelTasksSet.has(id),
    ),
    ...unorderedTasks,
  ];
};

export const selectTagById = createSelector(
  selectTagFeatureState,
  (state: TagState, props: { id: string }): Tag => {
    const tag = state.entities[props.id];
    if (!tag) {
      throw new Error('No tag ' + props.id);
    }
    return tag;
  },
);

export const selectTagsByIds = createSelector(
  selectTagFeatureState,
  (state: TagState, props: { ids: string[]; isAllowNull: boolean }): Tag[] =>
    props.isAllowNull
      ? (props.ids.map((id) => state.entities[id]).filter((tag) => !!tag) as Tag[])
      : props.ids.map((id) => {
          const tag = state.entities[id];
          if (!tag) {
            throw new Error('No tag ' + id);
          }
          return tag;
        }),
);

// export const selectTodayTag = createSelector(
//   selectTagFeatureState,
//   (s): Tag => s.entities[TODAY_TAG.id] as Tag,
// );

// TODO also add no list tag
const _addMyDayTagIfNecessary = (state: TagState): TagState => {
  const ids = Array.isArray(state?.ids) ? (state.ids as string[]) : [];
  const entities = state?.entities || {};
  if (!ids.includes(TODAY_TAG.id)) {
    return {
      ...state,
      ids: [TODAY_TAG.id, ...ids],
      entities: {
        ...entities,
        [TODAY_TAG.id]: TODAY_TAG,
      },
    };
  }

  return state;
};

export const initialTagState: TagState = _addMyDayTagIfNecessary(
  tagAdapter.getInitialState({
    // additional entity state properties
  }),
);

const _normalizeTagState = (incoming: unknown): TagState | undefined => {
  if (!incoming) return undefined;
  if (Array.isArray(incoming)) {
    const valid = incoming
      .map((item) =>
        item &&
        typeof item === 'object' &&
        'tag' in item &&
        typeof (item as { tag?: unknown }).tag === 'object'
          ? (item as { tag: unknown }).tag
          : item,
      )
      .filter(
        (t): t is Tag =>
          !!t && typeof t === 'object' && typeof (t as Tag).id === 'string',
      );
    return tagAdapter.setAll(valid, initialTagState);
  }
  if (typeof incoming === 'object') {
    const inc = incoming as Record<string, unknown>;
    if (inc.entities && typeof inc.entities === 'object') {
      const rawEntities = inc.entities as Record<string, unknown>;
      const entities: Record<string, Tag> = {};
      for (const [id, val] of Object.entries(rawEntities)) {
        if (!val || typeof val !== 'object') continue;
        const unwrapped =
          'tag' in val && val.tag && typeof val.tag === 'object'
            ? (val.tag as Tag)
            : (val as Tag);
        entities[id] = unwrapped;
      }
      const entityKeys = Object.keys(entities);
      const ids = Array.isArray(inc.ids)
        ? Array.from(new Set([...(inc.ids as string[]), ...entityKeys]))
        : entityKeys;
      return { ...inc, ids, entities } as TagState;
    }
    const values = Object.values(inc)
      .map((item) =>
        item &&
        typeof item === 'object' &&
        'tag' in item &&
        typeof (item as { tag?: unknown }).tag === 'object'
          ? (item as { tag: unknown }).tag
          : item,
      )
      .filter(
        (t): t is Tag =>
          !!t && typeof t === 'object' && typeof (t as Tag).id === 'string',
      );
    if (values.length > 0) {
      return tagAdapter.setAll(values, initialTagState);
    }
  }
  return undefined;
};

export const tagReducer = createReducer<TagState>(
  initialTagState,

  // META ACTIONS
  // ------------
  on(loadAllData, (oldState, { appDataComplete }) => {
    const raw = appDataComplete.tag ?? (appDataComplete as { tags?: TagState }).tags;
    const incoming = _normalizeTagState(raw);
    return _addMyDayTagIfNecessary(incoming ? incoming : oldState);
  }),

  // NOTE: transferTask is now handled in planner-shared.reducer.ts
  // NOTE: planTaskForDay is handled in planner-shared.reducer.ts (meta-reducer with offset-aware todayStr)
  // NOTE: moveBeforeTask is handled in planner-shared.reducer.ts (meta-reducer)

  // REGULAR ACTIONS
  // --------------------
  // Move handlers work uniformly for ALL tags, including TODAY_TAG.
  // This is why we keep TODAY_TAG.taskIds separate from planner.days -
  // it allows drag/drop and keyboard shortcuts (Ctrl+↑/↓) to use the same
  // code path for today as for any other tag. See: ARCHITECTURE-DECISIONS.md Decision #2
  on(
    moveTaskInTodayList,
    (
      state: TagState,
      { taskId, afterTaskId, target, workContextType, workContextId },
    ) => {
      if (workContextType !== WORK_CONTEXT_TYPE) {
        return state;
      }
      const tag = state.entities[workContextId];
      if (!tag) {
        throw new Error('No tag');
      }
      const taskIdsBefore = tag.taskIds;
      // When moving to DONE section with null anchor, append to end
      // Otherwise use standard anchor-based positioning
      const taskIds =
        afterTaskId === null && target === 'DONE'
          ? [...taskIdsBefore.filter((id) => id !== taskId), taskId]
          : moveItemAfterAnchor(taskId, afterTaskId, taskIdsBefore);
      return tagAdapter.updateOne(
        {
          id: workContextId,
          changes: {
            taskIds,
          },
        },
        state,
      );
    },
  ),

  on(
    moveTaskUpInTodayList,
    (
      state: TagState,
      { taskId, workContextId, workContextType, doneTaskIds: undoneTaskIds },
    ) => {
      if (workContextType !== WORK_CONTEXT_TYPE) {
        return state;
      }
      // Use Set for O(1) lookup instead of O(n) .includes() in callback
      const undoneTaskIdSet = new Set(undoneTaskIds);
      return tagAdapter.updateOne(
        {
          id: workContextId,
          changes: {
            taskIds: arrayMoveLeftUntil(
              (state.entities[workContextId] as Tag).taskIds,
              taskId,
              (id) => !undoneTaskIdSet.has(id),
            ),
          },
        },
        state,
      );
    },
  ),

  on(
    moveTaskDownInTodayList,
    (
      state: TagState,
      { taskId, workContextId, workContextType, doneTaskIds: undoneTaskIds },
    ) => {
      if (workContextType !== WORK_CONTEXT_TYPE) {
        return state;
      }
      // Use Set for O(1) lookup instead of O(n) .includes() in callback
      const undoneTaskIdSet = new Set(undoneTaskIds);
      return tagAdapter.updateOne(
        {
          id: workContextId,
          changes: {
            taskIds: arrayMoveRightUntil(
              (state.entities[workContextId] as Tag).taskIds,
              taskId,
              (id) => !undoneTaskIdSet.has(id),
            ),
          },
        },
        state,
      );
    },
  ),

  on(moveTaskToTopInTodayList, (state, { taskId, workContextType, workContextId }) => {
    return workContextType === WORK_CONTEXT_TYPE
      ? tagAdapter.updateOne(
          {
            id: workContextId,
            changes: {
              taskIds: arrayMoveToStart(
                (state.entities[workContextId] as Tag).taskIds,
                taskId,
              ),
            },
          },
          state,
        )
      : state;
  }),

  on(moveTaskToBottomInTodayList, (state, { taskId, workContextType, workContextId }) => {
    return workContextType === WORK_CONTEXT_TYPE
      ? tagAdapter.updateOne(
          {
            id: workContextId,
            changes: {
              taskIds: arrayMoveToEnd(
                (state.entities[workContextId] as Tag).taskIds,
                taskId,
              ),
            },
          },
          state,
        )
      : state;
  }),

  // INTERNAL
  // --------
  on(addTag, (state: TagState, action) => {
    const raw =
      action.tag ??
      ('id' in action && typeof (action as { id?: unknown }).id === 'string'
        ? (action as unknown as Tag)
        : undefined);
    const tag =
      raw &&
      typeof raw === 'object' &&
      'tag' in raw &&
      typeof (raw as { tag?: unknown }).tag === 'object'
        ? (raw as { tag: Tag }).tag
        : raw;
    if (!tag) return state;
    if (state.entities[tag.id]) {
      return tagAdapter.updateOne({ id: tag.id, changes: tag }, state);
    }
    return tagAdapter.addOne(tag, state);
  }),

  on(updateTag, (state: TagState, action) => {
    let tag = action.tag;
    if (
      tag &&
      typeof tag === 'object' &&
      'tag' in tag &&
      typeof (tag as { tag?: unknown }).tag === 'object'
    ) {
      tag = (tag as { tag: Update<Tag> }).tag;
    }
    if (!tag) {
      if ('id' in action && 'changes' in action) {
        tag = action as unknown as Update<Tag>;
      } else if ('id' in action && typeof (action as { id?: unknown }).id === 'string') {
        const { id, ...changes } = action as unknown as {
          id: string;
          [key: string]: unknown;
        };
        tag = { id, changes: changes as Partial<Tag> };
      }
    }
    if (!tag) return state;
    if (!state.entities[tag.id]) {
      const fullTag: Tag = {
        ...DEFAULT_TAG,
        ...tag.changes,
        id: tag.id as string,
      };
      return tagAdapter.addOne(fullTag, state);
    }
    return tagAdapter.updateOne(tag, state);
  }),

  on(deleteTag, (state: TagState, { id }) => tagAdapter.removeOne(id, state)),

  on(deleteTags, (state: TagState, { ids }) => tagAdapter.removeMany(ids, state)),

  on(updateTagOrder, (state: TagState, { ids }) => {
    if (ids.length !== state.ids.length) {
      Log.log({
        currentTagCount: state.ids.length,
        nextTagCount: ids.length,
      });
      throw new Error('Tag length should not change on re-order');
    }

    return {
      ...state,
      ids,
    };
  }),

  on(updateAdvancedConfigForTag, (state: TagState, { tagId, sectionKey, data }) => {
    const tagToUpdate = state.entities[tagId] as Tag;
    return tagAdapter.updateOne(
      {
        id: tagId,
        changes: {
          advancedCfg: {
            ...tagToUpdate.advancedCfg,
            [sectionKey]: {
              ...tagToUpdate.advancedCfg[sectionKey],
              ...data,
            },
          },
        },
      },
      state,
    );
  }),

  // addTagToTask no longer creates tags - use TagActions.addTag first if needed

  // TASK STUFF
  // ---------
);
