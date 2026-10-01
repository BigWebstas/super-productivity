/**
 * File-backed archive for tasks moved out of active state.
 *
 * Mirrors the app's `TaskArchiveService` contract the REST routes depend on
 * (`load`, `hasTask`, `getById`, subtask expansion) with a deliberately
 * smaller format: a single `archive.json` holding flat task entities. The app
 * splits young/old, migrates time-tracking, and flushes daily — all local
 * housekeeping around data the SYNC OPS already carry. Reimplementing that
 * here would be parallel-implementation drift over bytes no other client ever
 * reads; the op log stays the source of truth and this file is only ever this
 * bridge's own projection of it.
 *
 * Sanitizing and flattening reuse the app's own pure helpers, so a malformed
 * remote payload is dropped exactly the way the app drops it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Task,
  TaskWithSubTasks,
} from '../../../../src/app/features/tasks/task.model';
import { sanitizeTasksForArchiving } from '../../../../src/app/features/archive/archive.service';
import { flattenTasks } from '../../../../src/app/features/tasks/store/task.selectors';

const ARCHIVE_FILE = 'archive.json';

interface ArchiveFile {
  ids: string[];
  entities: Record<string, Task>;
}

export class FileTaskArchive {
  private readonly _filePath: string;
  private _cache: ArchiveFile | null = null;

  constructor(dataDir: string) {
    this._filePath = join(dataDir, ARCHIVE_FILE);
  }

  /** All archived tasks, oldest-archived first. */
  load(): ArchiveFile {
    if (this._cache) {
      return { ids: [...this._cache.ids], entities: { ...this._cache.entities } };
    }
    let parsed: Partial<ArchiveFile> = {};
    try {
      if (existsSync(this._filePath)) {
        parsed = JSON.parse(readFileSync(this._filePath, 'utf8')) as Partial<ArchiveFile>;
      }
    } catch (error) {
      console.warn('[archive] Could not read archive.json; starting empty', error);
    }
    const entities =
      parsed.entities && typeof parsed.entities === 'object' ? parsed.entities : {};
    const ids = Array.isArray(parsed.ids)
      ? parsed.ids.filter((id): id is string => typeof id === 'string' && !!entities[id])
      : Object.keys(entities);
    this._cache = { ids, entities: { ...entities } };
    return { ids: [...ids], entities: { ...entities } };
  }

  hasTask(taskId: string): boolean {
    return !!this.load().entities[taskId];
  }

  getById(taskId: string): Task | undefined {
    const task = this.load().entities[taskId];
    return task?.id === taskId ? task : undefined;
  }

  /**
   * Writes tasks (with embedded subtasks) to the archive, flattened to one
   * entity per id. Malformed entries are dropped by the app's own sanitizer.
   */
  putTasks(tasks: TaskWithSubTasks[]): void {
    const sanitized = sanitizeTasksForArchiving(tasks, 'bridge-archive');
    const flat = flattenTasks(sanitized);
    if (!flat.length) {
      return;
    }
    const current = this.load();
    const entities = { ...current.entities };
    const ids = [...current.ids];
    for (const task of flat) {
      const { subTasks: _subTasks, ...entity } = task as Task & {
        subTasks?: Task[];
      };
      void _subTasks;
      entities[task.id] = entity as Task;
      if (!ids.includes(task.id)) {
        ids.push(task.id);
      }
    }
    this._write({ ids, entities });
  }

  /** Merges field changes into archived copies (remote updateTask path). */
  patchArchived(taskId: string, changes: Record<string, unknown>): boolean {
    const current = this.load();
    const existing = current.entities[taskId];
    if (!existing || existing.id !== taskId) {
      return false;
    }
    const entities = {
      ...current.entities,
      [taskId]: { ...existing, ...changes },
    };
    this._write({ ids: current.ids, entities });
    return true;
  }

  deleteTasks(taskIds: readonly string[]): void {
    if (!taskIds.length) {
      return;
    }
    const current = this.load();
    const drop = new Set(taskIds);
    const entities = { ...current.entities };
    for (const id of drop) {
      delete entities[id];
    }
    this._write({ ids: current.ids.filter((id) => !drop.has(id)), entities });
  }

  private _write(next: ArchiveFile): void {
    this._cache = { ids: [...next.ids], entities: { ...next.entities } };
    mkdirSync(join(this._filePath, '..'), { recursive: true });
    const tmpPath = `${this._filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(next), 'utf8');
    renameSync(tmpPath, this._filePath);
  }
}
