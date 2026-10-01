/**
 * Durable, file-backed operation log.
 *
 * The app persists its log in IndexedDB through a Web Lock. The agent has
 * neither, and does not need either: it is a single process, single user, and
 * a single writer. What it does need is the same durability guarantee the app's
 * IndexedDB adapter provides — an operation must reach the disk before the
 * state change it represents is reported as applied, or a crash leaves state
 * that no operation represents (the "phantom change" the app guards with its
 * pending counter).
 *
 * Format: newline-delimited JSON, append-only.
 *  - `ops.jsonl`  one serialized Operation per line
 *  - `meta.json`  clientId, vector clock, and the upload cursor
 *
 * Two properties this format buys, and one it costs:
 *  - Appends are O(1) and need no read-modify-write, so a batch costs one fsync.
 *  - A torn final line (power loss mid-append) is detectable and is dropped on
 *    read, leaving a consistent prefix rather than a corrupt log.
 *  - The cost is that the log is never rewritten. Compaction (snapshot +
 *    truncate) is deliberately NOT implemented here: the app's own compaction
 *    service is snapshot-aware and its snapshots are full-state, so a
 *    hand-rolled version would produce snapshots the app cannot consume. Until
 *    that exists the log grows monotonically, which is correct but not
 *    space-efficient. See the roadmap in the README.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Operation } from '../../../../src/app/op-log/core/operation.types';
import { isValidClientIdFormat } from '../../../../src/app/core/util/generate-client-id';

const OPS_FILE = 'ops.jsonl';
const META_FILE = 'meta.json';

interface PersistedMeta {
  clientId: string;
  vectorClock: Record<string, number>;
  /**
   * Ids of locally-produced ops the server has not accepted yet, in log
   * order. A SET (not a prefix cursor) because the log interleaves local ops
   * with downloaded remote ops, which must never enter the upload stream —
   * re-uploading another client's op fails with INVALID_CLIENT_ID and, worse,
   * a rejected local op would wedge every op behind it under a prefix cursor.
   */
  pendingLocalOpIds: string[];
}

export interface OpLogOpenOptions {
  /**
   * Used only when no clientId is on disk yet. Exposed so tests are
   * deterministic; production passes nothing and gets a generated id.
   */
  clientId?: string;
}

const isOperation = (value: unknown): value is Operation =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Operation).id === 'string' &&
  typeof (value as Operation).clientId === 'string' &&
  !!(value as Operation).vectorClock;

export class OpLogStore {
  private readonly _opsPath: string;
  private readonly _metaPath: string;
  private _meta: PersistedMeta;
  private _ops: Operation[] = [];
  /** Kept open in append mode so a batch is one write, not one per op. */
  private _appendFd: number | null = null;

  private constructor(dataDir: string, meta: PersistedMeta, ops: Operation[]) {
    this._opsPath = join(dataDir, OPS_FILE);
    this._metaPath = join(dataDir, META_FILE);
    this._meta = meta;
    this._ops = ops;
  }

  /**
   * Opens (or creates) the log in `dataDir`.
   *
   * A clientId found on disk is always kept, even if it fails
   * `isValidClientIdFormat`. The id is a persisted, non-regenerable vector-clock
   * key: replacing it would orphan every operation already written under it and
   * permanently fork this device's history away from the account. The app makes
   * the same call for the same reason (#7732).
   */
  static open(
    dataDir: string,
    options: OpLogOpenOptions = {},
    generateClientId: () => string,
  ): OpLogStore {
    mkdirSync(dataDir, { recursive: true });
    const metaPath = join(dataDir, META_FILE);
    const opsPath = join(dataDir, OPS_FILE);

    const meta = OpLogStore._readMeta(metaPath, options.clientId, generateClientId);
    const ops = OpLogStore._readOps(opsPath);
    const store = new OpLogStore(dataDir, meta, ops);
    // Stale pending ids (log truncated by hand, torn write) can never upload;
    // drop them rather than retrying ghosts forever.
    store._reconcilePending();
    store._writeMeta();
    return store;
  }

  private static _readMeta(
    metaPath: string,
    fallbackClientId: string | undefined,
    generateClientId: () => string,
  ): PersistedMeta {
    if (existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(
          readFileSync(metaPath, 'utf8'),
        ) as Partial<PersistedMeta>;
        if (typeof parsed.clientId === 'string' && parsed.clientId.length > 0) {
          if (!isValidClientIdFormat(parsed.clientId)) {
            // Kept deliberately — see open(). Surfaced so an operator can spot
            // a hand-edited or truncated file, not silently "repaired".
            console.warn(
              `[op-log] Persisted clientId "${parsed.clientId}" is not in the expected ` +
                `format; keeping it anyway because replacing it would orphan this ` +
                `device's operation history.`,
            );
          }
          return {
            clientId: parsed.clientId,
            vectorClock: parsed.vectorClock ?? { [parsed.clientId]: 0 },
            pendingLocalOpIds: Array.isArray(parsed.pendingLocalOpIds)
              ? parsed.pendingLocalOpIds.filter((id) => typeof id === 'string')
              : [],
          };
        }
      } catch (error) {
        console.warn('[op-log] Could not read meta.json; starting a fresh log', error);
      }
    }
    const clientId = fallbackClientId ?? generateClientId();
    return { clientId, vectorClock: { [clientId]: 0 }, pendingLocalOpIds: [] };
  }

  /**
   * Reads the log, dropping a torn final line.
   *
   * A crash during append can leave a partial JSON object. Everything before it
   * is still a valid prefix, so the file is truncated back to the last complete
   * line rather than discarded: losing the whole log because the last write was
   * interrupted would be a far worse outcome than losing that one operation.
   */
  private static _readOps(opsPath: string): Operation[] {
    if (!existsSync(opsPath)) {
      return [];
    }
    // Work on raw bytes, not a decoded string: `truncateSync` takes a byte
    // offset, and a character offset from a utf8 string is wrong as soon as a
    // task title contains multi-byte characters (emoji, CJK). Newline (0x0A)
    // never appears inside a multi-byte UTF-8 sequence, so scanning bytes for
    // it is safe.
    const raw = readFileSync(opsPath);
    const ops: Operation[] = [];
    let validBytes = 0;
    let lineStart = 0;

    while (lineStart < raw.length) {
      const newlineIndex = raw.indexOf(0x0a, lineStart);
      if (newlineIndex === -1) {
        // Trailing bytes with no terminator: an interrupted append.
        break;
      }
      const line = raw.toString('utf8', lineStart, newlineIndex);
      if (line.trim()) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (isOperation(parsed)) {
            ops.push(parsed);
          } else {
            console.warn('[op-log] Skipping malformed operation line');
          }
        } catch {
          console.warn('[op-log] Skipping unparseable operation line');
        }
      }
      lineStart = newlineIndex + 1;
      validBytes = lineStart;
    }

    const fileSize = statSync(opsPath).size;
    if (validBytes < fileSize) {
      console.warn(
        `[op-log] Truncating ${fileSize - validBytes} trailing bytes from an ` +
          `interrupted append`,
      );
      truncateSync(opsPath, validBytes);
    }

    return ops;
  }

  get clientId(): string {
    return this._meta.clientId;
  }

  get vectorClock(): Record<string, number> {
    return { ...this._meta.vectorClock };
  }

  all(): readonly Operation[] {
    return this._ops;
  }

  get size(): number {
    return this._ops.length;
  }

  /**
   * Records this device's own clock after a local operation.
   *
   * The store owns the clock (it is what `incrementVectorClock` advances), so
   * without this the persisted clock stays at its boot value forever. It is
   * redundant while every operation is still in the log — hydration recovers the
   * clock from the operations themselves — but it is the only thing standing
   * between the agent and a reset clock the moment the log is ever truncated or
   * compacted, and a reset clock silently turns every later local edit into a
   * conflict with work this device already applied.
   */
  recordLocalClock(clock: Record<string, number>): void {
    const local = clock[this.clientId];
    if (
      typeof local !== 'number' ||
      local <= (this._meta.vectorClock[this.clientId] ?? 0)
    ) {
      return;
    }
    this._meta.vectorClock[this.clientId] = local;
    this._writeMeta();
  }

  /**
   * Records the clock observed from other clients so a restart does not make
   * this device's next operation look concurrent to work it already applied.
   */
  mergeRemoteVectorClock(clock: Record<string, number>): void {
    let changed = false;
    for (const [clientId, counter] of Object.entries(clock)) {
      if (counter > (this._meta.vectorClock[clientId] ?? 0)) {
        this._meta.vectorClock[clientId] = counter;
        changed = true;
      }
    }
    if (changed) {
      this._writeMeta();
    }
  }

  /**
   * Appends operations and returns only once they are on disk.
   *
   * Synchronous and throwing by contract (see `AgentStore.dispatch`): the
   * store's sink must fail loudly, not reject later, so a non-durable change
   * can never be reported as applied. `append` remains as an async wrapper for
   * existing callers and tests.
   */
  appendSync(ops: Operation[]): void {
    if (!ops.length) {
      return;
    }
    if (this._appendFd === null) {
      this._appendFd = openSync(this._opsPath, 'a');
    }
    const payload = ops.map((op) => `${JSON.stringify(op)}\n`).join('');
    writeSync(this._appendFd, payload);
    fsyncSync(this._appendFd);

    this._ops.push(...ops);
  }

  /**
   * Appends operations and returns only once they are on disk.
   *
   * Resolving after `fsyncSync` (not after `writeSync`) is the point: a caller
   * that continues on a resolved promise is entitled to treat the operation as
   * durable.
   */
  async append(ops: Operation[]): Promise<void> {
    this.appendSync(ops);
  }

  /** Locally-produced operations the server has not accepted yet, log order. */
  pendingUpload(): Operation[] {
    const pending = new Set(this._meta.pendingLocalOpIds);
    return this._ops.filter((op) => pending.has(op.id));
  }

  /**
   * Tracks locally-produced ops as pending upload. Called by the store sink
   * AFTER `appendSync`, back-to-back with no await between: the op must be
   * durable before it becomes visible to the uploader, or a crash leaves a
   * pending id with no durable op behind it. The residual crash window (power
   * loss between the two synchronous writes) can strand a durable op outside
   * the pending set - accepted as negligible, and guarded loudly below.
   */
  noteLocalOps(ids: string[]): void {
    if (!ids.length) {
      return;
    }
    const known = new Set(this._ops.map((op) => op.id));
    let changed = false;
    for (const id of ids) {
      if (!this._meta.pendingLocalOpIds.includes(id)) {
        if (!known.has(id)) {
          // A pending id with no durable op is the phantom the ordering above
          // exists to prevent. Refusing it here keeps the set honest; the
          // state change is already reduced, so this is logged loudly.
          console.error('[op-log] Refusing to track a non-durable op as pending', {
            opId: id,
          });
          continue;
        }
        this._meta.pendingLocalOpIds.push(id);
        changed = true;
      }
    }
    if (changed) {
      this._writeMeta();
    }
  }

  /**
   * Drops ops from the pending set: accepted by the server, or superseded by
   * conflict resolution (a losing local op stays in history but must never
   * upload again - re-uploading a loser just earns another rejection).
   */
  dropPendingLocalOps(ids: readonly string[]): void {
    if (!ids.length) {
      return;
    }
    const drop = new Set(ids);
    const before = this._meta.pendingLocalOpIds.length;
    this._meta.pendingLocalOpIds = this._meta.pendingLocalOpIds.filter(
      (id) => !drop.has(id),
    );
    if (this._meta.pendingLocalOpIds.length !== before) {
      this._writeMeta();
    }
  }

  /** Reconciles the pending set against the log (stale ids cannot upload). */
  private _reconcilePending(): void {
    const known = new Set(this._ops.map((op) => op.id));
    this._meta.pendingLocalOpIds = this._meta.pendingLocalOpIds.filter((id) =>
      known.has(id),
    );
  }

  close(): void {
    if (this._appendFd !== null) {
      closeSync(this._appendFd);
      this._appendFd = null;
    }
  }

  /**
   * Resets the operation log with a complete set of operations, updating
   * both ops.jsonl and meta.json atomically. Used during full resync from server.
   */
  resetWithOps(ops: Operation[], pendingLocalOpIds: string[] = []): void {
    if (this._appendFd !== null) {
      closeSync(this._appendFd);
      this._appendFd = null;
    }

    const payload = ops.length ? ops.map((op) => `${JSON.stringify(op)}\n`).join('') : '';
    const tmpOpsPath = `${this._opsPath}.tmp`;
    writeFileSync(tmpOpsPath, payload, 'utf8');
    renameSync(tmpOpsPath, this._opsPath);

    this._ops = [...ops];

    const mergedClock: Record<string, number> = { [this._meta.clientId]: 0 };
    for (const op of ops) {
      for (const [clientId, counter] of Object.entries(op.vectorClock)) {
        mergedClock[clientId] = Math.max(mergedClock[clientId] ?? 0, counter);
      }
    }
    this._meta.vectorClock = mergedClock;
    this._meta.pendingLocalOpIds = [...pendingLocalOpIds];
    this._reconcilePending();
    this._writeMeta();
  }

  /**
   * Writes meta.json atomically (temp file + rename).
   *
   * A half-written meta.json would be read back as "no clientId" on the next
   * boot, which mints a NEW client id and orphans the vector clock — the exact
   * identity loss the id is persisted to prevent. Rename is atomic, so a reader
   * sees either the old file or the new one.
   */
  private _writeMeta(): void {
    const tmpPath = `${this._metaPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this._meta, null, 2), 'utf8');
    renameSync(tmpPath, this._metaPath);
  }
}
