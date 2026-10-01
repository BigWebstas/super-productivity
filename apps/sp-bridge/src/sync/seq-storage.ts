/**
 * File-backed `SuperSyncStorage` for the provider's `lastServerSeq` cursor.
 *
 * Lives in `sync-state.json` beside the op log — not in `meta.json`, which
 * belongs to the op log's own bookkeeping (client id, vector clock, upload
 * cursor). Write-through cache: the provider calls these a handful of times
 * per cycle, so memory serves reads and every write fsyncs through an atomic
 * temp + rename.
 */
import {
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SuperSyncStorage } from '@sp/sync-providers/super-sync';

const SYNC_STATE_FILE = 'sync-state.json';

interface SyncStateFile {
  lastServerSeqByKey: Record<string, number>;
}

export class FileSeqStorage implements SuperSyncStorage {
  private readonly _filePath: string;
  private _cache: Record<string, number> | null = null;

  constructor(dataDir: string) {
    this._filePath = join(dataDir, SYNC_STATE_FILE);
  }

  getLastServerSeq(key: string): number | null {
    const all = this._read();
    const value = all[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  setLastServerSeq(key: string, value: number): void {
    const all = this._read();
    all[key] = value;
    this._write(all);
  }

  removeLastServerSeq(key: string): void {
    const all = this._read();
    if (key in all) {
      delete all[key];
      this._write(all);
    }
  }

  private _read(): Record<string, number> {
    if (this._cache) {
      return { ...this._cache };
    }
    let parsed: Partial<SyncStateFile> = {};
    try {
      if (existsSync(this._filePath)) {
        parsed = JSON.parse(
          readFileSync(this._filePath, 'utf8'),
        ) as Partial<SyncStateFile>;
      }
    } catch (error) {
      console.warn('[sync] Could not read sync-state.json; starting fresh', error);
    }
    this._cache =
      parsed.lastServerSeqByKey && typeof parsed.lastServerSeqByKey === 'object'
        ? { ...parsed.lastServerSeqByKey }
        : {};
    return { ...this._cache };
  }

  private _write(all: Record<string, number>): void {
    this._cache = { ...all };
    const payload: SyncStateFile = { lastServerSeqByKey: all };
    mkdirSync(join(this._filePath, '..'), { recursive: true });
    const tmpPath = `${this._filePath}.${process.pid}.tmp`;
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, this._filePath);
  }
}
