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
  lastSyncAt?: number;
}

export class FileSeqStorage implements SuperSyncStorage {
  private readonly _filePath: string;
  private _cache: Record<string, number> | null = null;
  private _lastSyncAt: number | null | undefined = undefined;

  constructor(dataDir: string) {
    this._filePath = join(dataDir, SYNC_STATE_FILE);
  }

  getLastSyncAt(): number | null {
    if (this._lastSyncAt !== undefined) {
      return this._lastSyncAt;
    }
    const full = this._readFile();
    this._lastSyncAt =
      typeof full.lastSyncAt === 'number' && Number.isFinite(full.lastSyncAt)
        ? full.lastSyncAt
        : null;
    return this._lastSyncAt;
  }

  setLastSyncAt(value: number): void {
    this._lastSyncAt = value;
    const full = this._readFile();
    full.lastSyncAt = value;
    this._writeFile(full);
  }

  getLastServerSeq(key: string): number | null {
    const all = this._read();
    const value = all[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  setLastServerSeq(key: string, value: number): void {
    const all = this._read();
    all[key] = value;
    const full = this._readFile();
    full.lastServerSeqByKey = all;
    this._writeFile(full);
  }

  removeLastServerSeq(key: string): void {
    const all = this._read();
    if (key in all) {
      delete all[key];
      const full = this._readFile();
      full.lastServerSeqByKey = all;
      this._writeFile(full);
    }
  }

  private _readFile(): SyncStateFile {
    try {
      if (existsSync(this._filePath)) {
        const parsed = JSON.parse(
          readFileSync(this._filePath, 'utf8'),
        ) as Partial<SyncStateFile>;
        return {
          lastServerSeqByKey:
            parsed.lastServerSeqByKey && typeof parsed.lastServerSeqByKey === 'object'
              ? { ...parsed.lastServerSeqByKey }
              : {},
          lastSyncAt:
            typeof parsed.lastSyncAt === 'number' && Number.isFinite(parsed.lastSyncAt)
              ? parsed.lastSyncAt
              : undefined,
        };
      }
    } catch (error) {
      console.warn('[sync] Could not read sync-state.json; starting fresh', error);
    }
    return { lastServerSeqByKey: {} };
  }

  private _read(): Record<string, number> {
    if (this._cache) {
      return { ...this._cache };
    }
    const file = this._readFile();
    this._cache = file.lastServerSeqByKey;
    if (this._lastSyncAt === undefined) {
      this._lastSyncAt = file.lastSyncAt ?? null;
    }
    return { ...this._cache };
  }

  private _writeFile(payload: SyncStateFile): void {
    this._cache = { ...payload.lastServerSeqByKey };
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
