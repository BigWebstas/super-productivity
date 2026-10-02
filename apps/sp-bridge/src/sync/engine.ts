/**
 * The bridge's SuperSync cycle: download → resolve → apply → upload.
 *
 * Mirrors the app's `OperationLogSyncService` order (download first, then
 * upload) and its conflict semantics, reusing the pure engine from
 * `@sp/sync-core` (clocks, LWW planning/partitioning, upload-seq planning)
 * and the app's own vocabulary (`ActionType`, LWW action mapping, payload
 * keys). What is deliberately NOT reused is the app's DI-bound orchestration
 * (`ConflictResolutionService`, `RemoteOpsProcessingService`): those need a
 * Store, snacks and banners. The orchestration here is the part that is
 * genuinely agent-shaped — single-threaded, append-only log, no UI.
 *
 * Crash-equivalence rules (same as the app's):
 * - the server cursor (`lastServerSeq`) advances only after downloaded ops are
 *   durable in the log AND reduced into state;
 * - undecryptable ops hold the cursor (redelivery + id dedupe make retry safe);
 * - local pending ops are never deleted: LWW losers stay in history and every
 *   client converges deterministically from the same op set.
 *
 * LWW convergence note: the app synthesizes a compensating `localWinOp` and
 * rejects its originals; the agent cannot drop rows from its append-only log,
 * so local-wins keeps the original pending ops (they upload and dominate by
 * the same deterministic timestamp rule everywhere) and skips the losing
 * remote op.
 */
import {
  compareVectorClocks,
  convertLocalDeleteRemoteUpdatesToLww,
  mergeVectorClocks,
  partitionLwwResolutions,
  planLwwConflictResolutions,
  VectorClockComparison,
  type EntityConflictLike,
  type Operation as CoreOperation,
} from '@sp/sync-core';
import type { SuperSyncProvider } from '@sp/sync-providers/super-sync';
import type {
  OpUploadResponse,
  ServerSyncOperation,
  SyncOperation,
} from '@sp/sync-providers/provider-types';
import { ActionType } from '../../../../src/app/op-log/core/action-types.enum';
import {
  OpType,
  type EntityType,
  type LwwUpdatePayload,
  type Operation,
} from '../../../../src/app/op-log/core/operation.types';
import { bulkApplyOperations } from '../../../../src/app/op-log/apply/bulk-hydration.action';
import { runWithBulkReplayFailureCollector } from '../../../../src/app/op-log/apply/bulk-replay-failure-collector';
import {
  getEntityConfig,
  isLwwPayloadIdCanonical,
  isSingletonEntityId,
} from '../../../../src/app/op-log/core/entity-registry';
import { getPayloadKey } from '../../../../src/app/op-log/core/entity-registry';
import { toLwwUpdateActionType } from '../../../../src/app/op-log/core/lww-update-action-types';
import { getOpEntityIds } from '../../../../src/app/op-log/util/get-op-entity-ids.util';
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import type {
  Task,
  TaskWithSubTasks,
} from '../../../../src/app/features/tasks/task.model';
import { toEntityKey } from '../../../../src/app/op-log/util/entity-key.util';
import {
  isAdapterEntity,
  isArrayEntity,
  isMapEntity,
  isSingletonEntity,
} from '../../../../src/app/op-log/core/entity-registry';
import {
  CURRENT_SCHEMA_VERSION,
  PROJECT_DELETE_WINS_SCHEMA_VERSION,
  SUPER_SYNC_ERROR_CODES,
} from '@sp/shared-schema';
import { extractActionPayload } from '@sp/sync-core';
import type { FileTaskArchive } from '../archive/archive-store';
import type { AgentStore } from '../store/agent-store';
import { createInitialAgentState, type AgentState } from '../store/agent-state';
import type { OpLogStore } from '../oplog/op-log-store';
import { decryptDownloadedOperations, encryptOperationsForUpload } from './crypto';
import { createOperationId } from '../oplog/operation-factory';
import { incrementVectorClock } from '../../../../src/app/core/util/vector-clock';
import {
  classifySyncError,
  nextRetryDelayMs,
  TOKEN_EXPIRY_WARN_MS,
  type SyncErrorCode,
} from './sync-errors';

const DOWNLOAD_PAGE_SIZE = 500;
const MAX_DOWNLOAD_ITERATIONS = 1000;
const MAX_OPS_PER_UPLOAD_REQUEST = 25;
const LOCAL_CHANGE_DEBOUNCE_MS = 5_000;

const toEntityKeyString = (entityType: string, entityId: string): string =>
  toEntityKey(entityType as never, entityId);

const isArchiveAction = (op: Operation): boolean =>
  op.actionType === ActionType.TASK_SHARED_MOVE_TO_ARCHIVE;

/**
 * Delete-wins for marked project deletes (mirrors the app's
 * `isProjectDeleteWinsOperation`, including the fail-closed guards: unknown
 * schema, unauthenticated marker, or retargeted entityId all fall back to
 * timestamp LWW instead of dropping a victim's edit).
 */
const isDeleteWinsAction = (op: Operation): boolean => {
  if (
    !(op.schemaVersion >= PROJECT_DELETE_WINS_SCHEMA_VERSION) ||
    op.actionType !== ActionType.TASK_SHARED_DELETE_PROJECT ||
    op.opType !== OpType.Delete ||
    !op.payload
  ) {
    return false;
  }
  const actionPayload = extractActionPayload(op.payload) as Record<string, unknown>;
  return (
    actionPayload['isProjectDeleteWins'] === true &&
    op.entityId === actionPayload['projectId']
  );
};

/**
 * Checks whether an entity has been deleted or archived in retained local history.
 */
const hasLocalDeleteOrArchive = (
  ops: readonly Operation[],
  entityType: string,
  entityId: string,
): boolean => {
  return ops.some((op) => {
    if (op.entityType !== entityType && !(entityType === 'TASK' && isArchiveAction(op))) {
      return false;
    }
    const ids = getOpEntityIds(op);
    if (!ids.includes(entityId)) {
      return false;
    }
    return (
      op.opType === OpType.Delete ||
      isArchiveAction(op) ||
      op.actionType === ActionType.TASK_SHARED_DELETE_PROJECT
    );
  });
};

export interface SyncCycleResult {
  downloaded: number;
  applied: number;
  rejectedRemote: number;
  conflicts: number;
  localWins: number;
  remoteWins: number;
  uploaded: number;
  latestServerSeq: number;
}

export interface SyncEngineStatus {
  enabled: boolean;
  running: boolean;
  lastSyncAt: number | null;
  lastResult: SyncCycleResult | null;
  lastError: string | null;
  lastErrorCode: SyncErrorCode | null;
  /** Set on the first auth failure, cleared on the next success. Never cleared by retries. */
  authFailedSince: number | null;
  consecutiveFailures: number;
  nextRetryAt: number | null;
  tokenExpiresAt: number | null;
  tokenExpiringSoon: boolean;
  pendingUpload: number;
}

import type { FileSeqStorage } from './seq-storage';

interface EngineDeps {
  store: AgentStore;
  opLog: OpLogStore;
  provider: SuperSyncProvider;
  archive: FileTaskArchive;
  seqStorage?: FileSeqStorage;
}

export class SyncEngine {
  private _running = false;
  /** Bumped on config change; a stale cycle aborts instead of writing. */
  private _epoch = 0;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _debounced: ReturnType<typeof setTimeout> | null = null;
  private _syncOnLocalChange = true;
  lastSyncAt: number | null = null;
  lastResult: SyncCycleResult | null = null;
  lastError: string | null = null;
  lastErrorCode: SyncErrorCode | null = null;
  authFailedSince: number | null = null;
  consecutiveFailures = 0;
  nextRetryAt: number | null = null;
  private _lastTokenFingerprint: string | null = null;
  private _tokenExpiresAt: number | null = null;

  constructor(private readonly _deps: EngineDeps) {
    this.lastSyncAt = _deps.seqStorage?.getLastSyncAt() ?? null;
  }

  get isRunning(): boolean {
    return this._running;
  }

  /** Starts the timer loop and (optionally) the post-change trigger. */
  start(intervalMs: number, syncOnLocalChange: boolean): void {
    this.stop();
    this._syncOnLocalChange = syncOnLocalChange;
    this._epoch++;
    if (intervalMs > 0) {
      this._timer = setInterval(() => {
        void (async () => {
          // Backoff suppresses doomed retries, but a provisioning event
          // (new token in sync.json) must break through immediately: the
          // file read is cheap, the wait is not.
          if (this._isBackedOff(Date.now()) && !(await this._credentialsChanged())) {
            return;
          }
          await this.syncNow('interval').catch(() => undefined);
        })();
      }, intervalMs);
      this._timer.unref?.();
    }
  }

  /** True while failure backoff suppresses automatic cycles (manual runs always go). */
  isBackedOff(now: number = Date.now()): boolean {
    return this._isBackedOff(now);
  }

  private _isBackedOff(now: number): boolean {
    return (
      this.consecutiveFailures > 0 && this.nextRetryAt !== null && now < this.nextRetryAt
    );
  }

  private _recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.nextRetryAt = null;
    this.authFailedSince = null;
  }

  private _recordFailure(error: unknown): void {
    this.consecutiveFailures++;
    this.nextRetryAt = Date.now() + nextRetryDelayMs(this.consecutiveFailures);
    this.lastErrorCode = classifySyncError(error);
    this.lastError = error instanceof Error ? error.message : String(error);
    if (this.lastErrorCode === 'auth_failed' && this.authFailedSince === null) {
      this.authFailedSince = Date.now();
      console.error(
        '[sync] Authentication failed - sync is halted until a valid accessToken ' +
          'is provisioned in sync.json (see README "Sync configuration"). ' +
          'Automatic retries back off; a manual POST /sync/trigger always runs.',
      );
    }
  }

  stop(): void {
    this._epoch++;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._debounced) {
      clearTimeout(this._debounced);
      this._debounced = null;
    }
  }

  /** Called by the op-log sink after local ops land; debounces a cycle. */
  notifyLocalChange(): void {
    if (!this._syncOnLocalChange || this._debounced) {
      return;
    }
    this._debounced = setTimeout(() => {
      this._debounced = null;
      void this.syncNow('local-change').catch(() => undefined);
    }, LOCAL_CHANGE_DEBOUNCE_MS);
    this._debounced.unref?.();
  }

  /** Forces re-read of credentials next cycle (config changed underneath). */
  bumpEpoch(): void {
    this._epoch++;
    this._deps.provider.invalidateCredentialCache();
  }

  private _assertEpoch(epoch: number): void {
    if (epoch !== this._epoch) {
      throw new SyncEpochChangedError();
    }
  }

  /**
   * Runs one download → resolve → apply → upload cycle.
   *
   * Single-flight: a concurrent call waits for the running one instead of
   * interleaving two cursors over the same log.
   */
  async syncNow(
    reason: string,
    options?: { forceFromSeq0?: boolean },
  ): Promise<SyncCycleResult> {
    if (this._running) {
      // Single-flight without a queue: the running cycle already covers
      // everything pending now; the timer/debounce schedules the next one.
      throw new SyncBusyError();
    }
    const epoch = this._epoch;
    this._running = true;
    try {
      const result = options?.forceFromSeq0
        ? await this._resyncCycle(reason, epoch)
        : await this._cycle(reason, epoch);
      this.lastSyncAt = Date.now();
      this._deps.seqStorage?.setLastSyncAt(this.lastSyncAt);
      this.lastResult = result;
      this.lastError = null;
      this.lastErrorCode = null;
      this._recordSuccess();
      return result;
    } catch (error) {
      if (
        !(error instanceof SyncBusyError) &&
        !(error instanceof SyncEpochChangedError)
      ) {
        this._recordFailure(error);
      }
      throw error;
    } finally {
      this._running = false;
    }
  }

  /**
   * Resyncs projects and tasks from the server by downloading from seq 0,
   * resetting the store to clean initial state, replaying the complete server history,
   * and preserving any un-uploaded local changes.
   */
  async resync(reason: string = 'manual-resync'): Promise<SyncCycleResult> {
    return this.syncNow(reason, { forceFromSeq0: true });
  }

  /**
   * True when the loaded credentials differ from the previous cycle's.
   * Rotation path: the provider caches its server-seq key per token, so a
   * swapped token with a warm cache would read the old token's cursor slot
   * (full redownload) and write progress back to it (lost). Invalidating on
   * change keeps exactly one cursor per account.
   */
  private async _credentialsChanged(): Promise<boolean> {
    const port = this._deps.provider.privateCfg;
    if (!port || typeof port.load !== 'function') {
      return false;
    }
    const cfg = await port.load().catch(() => null);
    const fingerprint = `${cfg?.baseUrl ?? ''}|${cfg?.accessToken ?? ''}`;
    if (this._lastTokenFingerprint === null) {
      this._lastTokenFingerprint = fingerprint;
      return false;
    }
    if (fingerprint !== this._lastTokenFingerprint) {
      this._lastTokenFingerprint = fingerprint;
      this._deps.provider.invalidateCredentialCache();
      console.log('[sync] Credentials changed - caches invalidated');
      return true;
    }
    return false;
  }

  private async _resyncCycle(reason: string, epoch: number): Promise<SyncCycleResult> {
    const { store, opLog, provider } = this._deps;
    const result: SyncCycleResult = {
      downloaded: 0,
      applied: 0,
      rejectedRemote: 0,
      conflicts: 0,
      localWins: 0,
      remoteWins: 0,
      uploaded: 0,
      latestServerSeq: 0,
    };

    await this._credentialsChanged();
    this._assertEpoch(epoch);
    const cfgForExpiry =
      typeof provider.privateCfg?.load === 'function'
        ? await provider.privateCfg.load().catch(() => null)
        : null;
    this._tokenExpiresAt = cfgForExpiry?.expiresAt ?? null;
    if (!(await provider.isReady())) {
      console.log('[sync] Not configured yet — skipping resync cycle');
      return result;
    }
    const encryptKey = (await provider.getEncryptKey?.()) ?? undefined;
    const encryptionEnabled = (await provider.isEncryptionEnabled?.()) ?? false;
    if (provider.isEncryptionMandatory && !encryptKey) {
      throw new Error(
        '[sync] Encryption is mandatory for SuperSync but no key is configured',
      );
    }
    this._assertEpoch(epoch);

    // 1. Snapshot pending local operations to preserve un-uploaded work
    const pendingLocal = [...opLog.pendingUpload()];

    // 2. Download all operations from the server starting at sequence 0
    let sinceSeq = 0;
    let latestSeq = 0;
    const downloaded: ServerSyncOperation[] = [];
    for (let i = 0; i < MAX_DOWNLOAD_ITERATIONS; i++) {
      this._assertEpoch(epoch);
      const response = await provider.downloadOps(
        sinceSeq,
        undefined,
        DOWNLOAD_PAGE_SIZE,
      );
      latestSeq = Math.max(latestSeq, response.latestSeq);
      if (response.ops.length === 0) {
        if (response.hasMore) {
          throw new Error('[sync] Empty page with hasMore=true - aborting');
        }
        break;
      }
      downloaded.push(...response.ops);
      if (!response.hasMore) {
        break;
      }
      sinceSeq = Math.max(...response.ops.map((o) => o.serverSeq));
      if (i === MAX_DOWNLOAD_ITERATIONS - 1) {
        throw new Error('[sync] Download did not terminate - aborting');
      }
    }
    result.downloaded = downloaded.length;
    result.latestServerSeq = latestSeq;
    console.log(
      `[sync] Resync downloaded ${downloaded.length} ops (latestServerSeq=${latestSeq})`,
    );

    // 3. Decrypt downloaded operations
    let decrypted: Operation[] = [];
    if (downloaded.length) {
      const serverOps = downloaded.map((srv) => srv.op);
      const { ops: decryptedOps, failedOpIds } = await decryptDownloadedOperations(
        serverOps,
        encryptKey,
      );
      if (failedOpIds.length) {
        throw new Error(
          `[sync] ${failedOpIds.length} downloaded op(s) could not be decrypted - holding cursor`,
        );
      }
      if (encryptionEnabled) {
        const plaintext = decryptedOps.filter(
          (op) => !(op as unknown as SyncOperation).isPayloadEncrypted,
        );
        if (plaintext.length) {
          throw new Error(
            `[sync] ${plaintext.length} plaintext op(s) on an encrypted account - refusing`,
          );
        }
      }
      decrypted = decryptedOps;
      console.log(
        `[sync] Decrypted ${decrypted.length} ops for resync replay. First 5:`,
        decrypted
          .slice(0, 5)
          .map((o) => ({ id: o.id, opType: o.opType, actionType: o.actionType })),
      );
    }
    this._assertEpoch(epoch);

    // 4. Reset store to clean initial state and replay complete server history
    store.reset(createInitialAgentState(), { [store.clientId]: 0 });
    if (decrypted.length) {
      this._mirrorArchiveSideEffects(decrypted);
      runWithBulkReplayFailureCollector(
        (failure) => {
          console.error('[sync] Reducer failure during resync replay:', {
            opId: failure.op.id,
            actionType: failure.op.actionType,
            opType: failure.op.opType,
            entityType: failure.op.entityType,
            error: failure.error.message,
            stack: failure.error.stack,
          });
        },
        () => {
          store.dispatch(
            bulkApplyOperations({
              operations: [...decrypted],
              localClientId: store.clientId,
              isReplayFromEmptyBaseline: true,
            }) as never,
          );
        },
      );
    }
    result.applied = decrypted.length;

    // 5. Re-apply any preserved local pending ops not yet accepted by the server
    const serverOpIds = new Set(decrypted.map((op) => op.id));
    const unacceptedPending = pendingLocal.filter((op) => !serverOpIds.has(op.id));
    if (unacceptedPending.length) {
      this._mirrorArchiveSideEffects(unacceptedPending);
      runWithBulkReplayFailureCollector(
        (failure) => {
          console.error('[sync] Reducer failure during pending ops replay:', {
            opId: failure.op.id,
            actionType: failure.op.actionType,
            error: failure.error.message,
          });
        },
        () => {
          store.dispatch(
            bulkApplyOperations({
              operations: [...unacceptedPending],
              localClientId: store.clientId,
              isReplayFromEmptyBaseline: false,
            }) as never,
          );
        },
      );
    }

    const state = store.state as unknown as {
      projects?: { ids?: string[]; entities?: Record<string, unknown> };
      project?: { ids?: string[]; entities?: Record<string, unknown> };
      tag?: { ids?: string[]; entities?: Record<string, unknown> };
      tags?: { ids?: string[]; entities?: Record<string, unknown> };
      tasks?: { ids?: string[]; entities?: Record<string, unknown> };
      task?: { ids?: string[]; entities?: Record<string, unknown> };
    };
    const projCount =
      Object.keys(state?.projects?.entities || state?.project?.entities || {}).length ||
      (state?.projects?.ids?.length ?? state?.project?.ids?.length ?? 0);
    const tagCount =
      Object.keys(state?.tag?.entities || state?.tags?.entities || {}).length ||
      (state?.tag?.ids?.length ?? state?.tags?.ids?.length ?? 0);
    const taskCount =
      Object.keys(state?.tasks?.entities || state?.task?.entities || {}).length ||
      (state?.tasks?.ids?.length ?? state?.task?.ids?.length ?? 0);
    console.log(
      `[sync] Resync replay complete. Store entity counts: ` +
        `projects=${projCount}, ` +
        `tags=${tagCount}, ` +
        `tasks=${taskCount}`,
    );

    // 6. Fold all contributing vector clocks into store
    const allClocks = [
      ...decrypted.map((op) => op.vectorClock),
      ...unacceptedPending.map((op) => op.vectorClock),
    ];
    store.applyRemoteState(store.state, allClocks);

    // 7. Atomically reset durable op log with complete server history + pending local ops
    const finalOps = [...decrypted, ...unacceptedPending];
    opLog.resetWithOps(
      finalOps,
      unacceptedPending.map((op) => op.id),
    );
    opLog.recordLocalClock(store.vectorClock);

    // 8. Update server cursor
    await provider.setLastServerSeq(latestSeq);

    // 9. Upload any preserved local pending ops
    let conflictRejections = await this._uploadPhase(epoch, result, encryptKey);
    if (conflictRejections > 0) {
      console.log('[sync] Resolving rejected ops after resync');
      await this._downloadPhase(epoch, result, encryptKey, encryptionEnabled);
      conflictRejections = await this._uploadPhase(epoch, result, encryptKey);
      if (conflictRejections > 0) {
        console.warn(
          '[sync] Ops still rejected after resync resolve round; retrying next cycle',
          { count: conflictRejections },
        );
      }
    }

    return result;
  }

  private async _cycle(reason: string, epoch: number): Promise<SyncCycleResult> {
    const { provider } = this._deps;
    const result: SyncCycleResult = {
      downloaded: 0,
      applied: 0,
      rejectedRemote: 0,
      conflicts: 0,
      localWins: 0,
      remoteWins: 0,
      uploaded: 0,
      latestServerSeq: 0,
    };

    await this._credentialsChanged();
    this._assertEpoch(epoch);
    const cfgForExpiry =
      typeof provider.privateCfg?.load === 'function'
        ? await provider.privateCfg.load().catch(() => null)
        : null;
    this._tokenExpiresAt = cfgForExpiry?.expiresAt ?? null;
    if (!(await provider.isReady())) {
      console.log('[sync] Not configured yet — skipping cycle');
      return result;
    }
    const encryptKey = (await provider.getEncryptKey?.()) ?? undefined;
    const encryptionEnabled = (await provider.isEncryptionEnabled?.()) ?? false;
    if (provider.isEncryptionMandatory && !encryptKey) {
      throw new Error(
        '[sync] Encryption is mandatory for SuperSync but no key is configured',
      );
    }
    this._assertEpoch(epoch);

    // Download, resolve, apply, then upload. A rejection with a conflict
    // code means the other side landed between our download and our upload,
    // so one bounded extra round re-downloads and resolves instead of
    // leaving the loser pending forever (a rejected op would otherwise be
    // re-uploaded - and re-rejected - on every future cycle).
    let conflictRejections = 0;
    await this._downloadPhase(epoch, result, encryptKey, encryptionEnabled);
    conflictRejections = await this._uploadPhase(epoch, result, encryptKey);
    if (conflictRejections > 0) {
      console.log('[sync] Resolving rejected ops with an extra round');
      await this._downloadPhase(epoch, result, encryptKey, encryptionEnabled);
      conflictRejections = await this._uploadPhase(epoch, result, encryptKey);
      if (conflictRejections > 0) {
        console.warn(
          '[sync] Ops still rejected after a resolve round; retrying next cycle',
          {
            count: conflictRejections,
          },
        );
      }
    }

    return result;
  }

  private async _downloadPhase(
    epoch: number,
    result: SyncCycleResult,
    encryptKey: string | undefined,
    encryptionEnabled: boolean,
  ): Promise<void> {
    const { store, opLog, provider } = this._deps;
    let sinceSeq = await provider.getLastServerSeq();
    let latestSeq = sinceSeq;
    let hasResetForGap = false;
    const downloaded: ServerSyncOperation[] = [];
    for (let i = 0; i < MAX_DOWNLOAD_ITERATIONS; i++) {
      this._assertEpoch(epoch);
      const response = await provider.downloadOps(
        sinceSeq,
        store.clientId,
        DOWNLOAD_PAGE_SIZE,
      );
      latestSeq = Math.max(latestSeq, response.latestSeq);
      if (response.gapDetected && !hasResetForGap) {
        console.log('[sync] Gap detected - resetting cursor and re-downloading');
        sinceSeq = 0;
        hasResetForGap = true;
        downloaded.length = 0;
        continue;
      }
      if (response.ops.length === 0) {
        if (response.hasMore) {
          throw new Error('[sync] Empty page with hasMore=true - aborting');
        }
        break;
      }
      downloaded.push(...response.ops);
      result.downloaded += response.ops.length;
      if (!response.hasMore) {
        break;
      }
      sinceSeq = Math.max(...response.ops.map((o) => o.serverSeq));
      if (i === MAX_DOWNLOAD_ITERATIONS - 1) {
        throw new Error('[sync] Download did not terminate - aborting');
      }
    }
    result.latestServerSeq = latestSeq;

    if (downloaded.length) {
      const ops = downloaded.map((srv) => srv.op);
      const { ops: decrypted, failedOpIds } = await decryptDownloadedOperations(
        ops,
        encryptKey,
      );
      if (failedOpIds.length) {
        // Hold the cursor: redelivery + id dedupe makes the retry safe.
        throw new Error(
          `[sync] ${failedOpIds.length} downloaded op(s) could not be decrypted - holding cursor`,
        );
      }
      if (encryptionEnabled) {
        const plaintext = decrypted.filter(
          (op) => !(op as unknown as SyncOperation).isPayloadEncrypted,
        );
        if (plaintext.length) {
          throw new Error(
            `[sync] ${plaintext.length} plaintext op(s) on an encrypted account - refusing`,
          );
        }
      }
      this._assertEpoch(epoch);
      const applied = this._applyRemoteOps(decrypted, epoch, result);
      result.applied += applied;
      this._assertEpoch(epoch);
      await provider.setLastServerSeq(latestSeq);
      opLog.mergeRemoteVectorClock(
        decrypted.reduce((acc, op) => mergeVectorClocks(acc, op.vectorClock), {}),
      );
    } else if (latestSeq > sinceSeq) {
      await provider.setLastServerSeq(latestSeq);
    }
  }

  /**
   * Uploads pending local ops, chunked. Returns the number of rejections
   * carrying a conflict code (the caller runs a bounded resolve round).
   * Accepted and duplicate ops leave the pending set; anything else stays
   * pending for retry and is logged loudly.
   */
  private async _uploadPhase(
    epoch: number,
    result: SyncCycleResult,
    encryptKey: string | undefined,
  ): Promise<number> {
    const { store, opLog, provider } = this._deps;
    const pending = opLog.pendingUpload();
    if (pending.length && encryptKey === undefined && provider.isEncryptionMandatory) {
      throw new Error('[sync] Cannot upload without an encryption key');
    }
    let conflictRejections = 0;
    const uploadPiggyback: ServerSyncOperation[] = [];
    for (let i = 0; i < pending.length; i += MAX_OPS_PER_UPLOAD_REQUEST) {
      this._assertEpoch(epoch);
      const chunk = pending.slice(i, i + MAX_OPS_PER_UPLOAD_REQUEST);
      const syncOps = (
        encryptKey ? await encryptOperationsForUpload(chunk, encryptKey) : chunk
      ) as SyncOperation[];
      const lastKnownServerSeq = await provider.getLastServerSeq();
      const response: OpUploadResponse = await provider.uploadOps(
        syncOps,
        store.clientId,
        lastKnownServerSeq,
      );
      // Accepted and already-have-it both mean the server never needs this op
      // again: only conflict and error codes stay pending.
      const doneIds = response.results
        .filter(
          (r) => r.accepted || r.errorCode === SUPER_SYNC_ERROR_CODES.DUPLICATE_OPERATION,
        )
        .map((r) => r.opId);
      opLog.dropPendingLocalOps(doneIds);
      result.uploaded += response.results.filter((r) => r.accepted).length;
      for (const rejected of response.results.filter((res) => !res.accepted)) {
        if (
          rejected.errorCode === SUPER_SYNC_ERROR_CODES.CONFLICT_CONCURRENT ||
          rejected.errorCode === SUPER_SYNC_ERROR_CODES.CONFLICT_SUPERSEDED
        ) {
          conflictRejections++;
        }
        console.warn('[sync] Server rejected op', {
          opId: rejected.opId,
          errorCode: rejected.errorCode,
        });
      }
      if (response.newOps?.length) {
        uploadPiggyback.push(...response.newOps);
      }
    }

    // Piggybacked remote ops ride the upload response; apply them through the
    // same pipeline before the cycle is reported complete.
    if (uploadPiggyback.length) {
      const ops = uploadPiggyback.map((srv) => srv.op);
      const { ops: decrypted, failedOpIds } = await decryptDownloadedOperations(
        ops,
        encryptKey,
      );
      if (!failedOpIds.length) {
        this._assertEpoch(epoch);
        result.applied += this._applyRemoteOps(decrypted, epoch, result);
        result.downloaded += ops.length;
      } else {
        console.warn('[sync] Holding piggybacked ops for next cycle', {
          count: failedOpIds.length,
        });
      }
    }
    return conflictRejections;
  }

  /**
   * Dedupe → detect → LWW → durable append → reduce → merge clocks.
   * Returns the applied count. The caller advances the server cursor after.
   */
  private _applyRemoteOps(
    ops: Operation[],
    epoch: number,
    result: SyncCycleResult,
  ): number {
    const { store, opLog } = this._deps;
    const knownIds = new Set(opLog.all().map((op) => op.id));
    const fresh = ops.filter((op) => !knownIds.has(op.id));
    // Own echoed ops (gap-reset redelivery) apply as no-ops through dedupe of
    // effect: they are already in the log, so the id filter above drops them.
    if (!fresh.length) {
      return 0;
    }

    const pendingByEntityMap = groupByEntity(opLog.pendingUpload());
    const frontierMap = frontierByEntity(opLog.all());
    const conflicts: BridgeConflict[] = [];
    const nonConflicting: Operation[] = [];

    for (const remoteOp of fresh) {
      const entityIds = getOpEntityIds(remoteOp);
      let superseded = false;
      let conflicted = false;
      for (const entityId of entityIds) {
        const key = toEntityKeyString(remoteOp.entityType, entityId);
        const frontier = frontierMap.get(key) ?? {};
        const comparison = compareVectorClocks(frontier, remoteOp.vectorClock);
        if (
          comparison === VectorClockComparison.GREATER_THAN ||
          comparison === VectorClockComparison.EQUAL
        ) {
          superseded = true;
          break;
        }
        const pending = (pendingByEntityMap.get(key) ?? []).filter(
          (local) =>
            compareVectorClocks(local.vectorClock, remoteOp.vectorClock) ===
            VectorClockComparison.CONCURRENT,
        );
        if (pending.length) {
          conflicts.push({
            entityType: remoteOp.entityType,
            entityId,
            localOps: pending,
            remoteOps: [remoteOp],
          });
          conflicted = true;
        } else if (comparison === VectorClockComparison.CONCURRENT) {
          // No pending ops but concurrent with history: the entity may have
          // been archived/deleted by applied ops (delete wins), or this is a
          // crossing that needs LWW against retained history (#9073).
          const current = readEntityState(store.state, remoteOp.entityType, entityId);
          if (current === undefined || current === null) {
            if (hasLocalDeleteOrArchive(opLog.all(), remoteOp.entityType, entityId)) {
              superseded = true;
              break;
            }
          }
          const retained = (frontierByEntityOps(opLog.all()).get(key) ?? []).filter(
            (local) =>
              compareVectorClocks(local.vectorClock, remoteOp.vectorClock) ===
              VectorClockComparison.CONCURRENT,
          );
          if (retained.length === 0) {
            break;
          }
          conflicts.push({
            entityType: remoteOp.entityType,
            entityId,
            localOps: retained,
            remoteOps: [remoteOp],
          });
          conflicted = true;
        }
      }
      if (superseded) {
        result.rejectedRemote++;
      } else if (!conflicted) {
        nonConflicting.push(remoteOp);
      }
    }

    const toApply: Operation[] = [...nonConflicting];
    let synthesized: Operation[] = [];
    if (conflicts.length) {
      result.conflicts += conflicts.length;
      const plans = planLwwConflictResolutions(
        conflicts as unknown as EntityConflictLike<CoreOperation>[],
        {
          isArchiveAction: (op) => isArchiveAction(op as unknown as Operation),
          isDeleteWinsAction: (op) => isDeleteWinsAction(op as unknown as Operation),
          toEntityKey: toEntityKeyString,
        },
      );
      // Local winners synthesize a dominating LWW update (same wire shape as
      // the app's createLWWUpdateOp): the originals are superseded and leave
      // the pending set, the synthesis uploads in their place. A synthesis
      // that cannot be built (entity vanished) falls back to the remote side.
      const resolutions: {
        conflict: EntityConflictLike<CoreOperation>;
        winner: 'local' | 'remote';
        localWinOp?: CoreOperation;
      }[] = [];
      for (const plan of plans) {
        if (plan.winner !== 'local') {
          resolutions.push({ conflict: plan.conflict, winner: plan.winner });
          continue;
        }
        const synthesis = this._synthesizeLwwUpdate(
          plan.conflict as unknown as BridgeConflict,
        );
        if (synthesis === (NULL_VEHICLE as unknown as Operation)) {
          // Pure crossing: keep the local win, apply nothing, build nothing.
          resolutions.push({ conflict: plan.conflict, winner: 'local' });
        } else if (synthesis) {
          resolutions.push({
            conflict: plan.conflict,
            winner: 'local',
            localWinOp: synthesis as unknown as CoreOperation,
          });
        } else {
          console.warn('[sync] Local win cannot be built; falling back to remote', {
            entityType: plan.conflict.entityType,
            entityId: plan.conflict.entityId,
          });
          resolutions.push({ conflict: plan.conflict, winner: 'remote' });
        }
      }
      const partitions = partitionLwwResolutions(resolutions, {
        // Local-delete vs remote-update crossings resolve through the same
        // delete-to-LWW conversion the app uses, so both sides agree whether
        // the entity comes back.
        processRemoteWinnerOps: (conflict) =>
          convertLocalDeleteRemoteUpdatesToLww(conflict, {
            payloadKey: (entityType) =>
              getPayloadKey(entityType as EntityType) ?? entityType,
            toLwwUpdateActionType: (entityType) =>
              toLwwUpdateActionType(entityType as EntityType),
          }),
      });
      result.remoteWins += partitions.remoteWinsCount;
      result.localWins += partitions.localWinsCount;
      toApply.push(...(partitions.remoteWinsOps as unknown as Operation[]));
      synthesized = (partitions.newLocalWinOps as unknown as Operation[]).filter(
        (op) => op !== (NULL_VEHICLE as unknown as Operation),
      );
      toApply.push(...synthesized);
      result.rejectedRemote += partitions.remoteOpsToReject.length;
      // Losers leave the upload stream (history keeps them): re-uploading a
      // lost op just earns another rejection. Noted here; the synthesized
      // winners are noted after the append below (noteLocalOps refuses ids
      // with no durable op behind them).
      opLog.dropPendingLocalOps(partitions.localOpsToReject);
    }

    if (!toApply.length) {
      return 0;
    }
    // Durable first: every applied op lands in the log before it reduces, so a
    // crash replays rather than loses it. Bulk dispatch emits no new ops
    // (remote replay never re-captures — pinned by agent-store.spec).
    opLog.appendSync(toApply);
    this._mirrorArchiveSideEffects(toApply);
    // Synthesized winners enter the upload stream now that they are durable
    // (noteLocalOps refuses ids with no durable op behind them).
    opLog.noteLocalOps(synthesized.map((op) => op.id));
    this._assertEpoch(epoch);
    runWithBulkReplayFailureCollector(
      (failure) => {
        console.error('[sync] Reducer failure during remote ops apply:', {
          opId: failure.op.id,
          actionType: failure.op.actionType,
          error: failure.error.message,
        });
      },
      () => {
        store.dispatch(
          bulkApplyOperations({
            operations: [...toApply],
            localClientId: store.clientId,
            isReplayFromEmptyBaseline: false,
          }) as never,
        );
      },
    );
    // Fold every contributing clock into the store's own: without this the
    // next LOCAL op carries a clock that omits history already applied, reads
    // as concurrent on the server, and is rejected (the hydrate path does the
    // same via applyRemoteState — pinned by the op-log-store hydrate tests).
    store.applyRemoteState(
      store.state,
      toApply.map((op) => op.vectorClock),
    );
    opLog.recordLocalClock(store.vectorClock);
    return toApply.length;
  }

  /**
   * File-side half of remote archive ops, mirroring the app's
   * `ArchiveOperationHandler` (which runs after reducers for remote actions):
   * archived tasks land in `archive.json`, restored ones leave it, and updates
   * to archived copies merge in. Local ops need nothing here - the REST layer
   * writes the file around its own dispatches, exactly like ArchiveService.
   */
  private _mirrorArchiveSideEffects(ops: Operation[]): void {
    const { archive } = this._deps;
    for (const op of ops) {
      const actionPayload = extractActionPayload(op.payload) as
        | Record<string, unknown>
        | undefined;
      if (!actionPayload || typeof actionPayload !== 'object') {
        continue;
      }
      if (op.actionType === TaskSharedActions.moveToArchive.type) {
        const tasks = actionPayload['tasks'] as TaskWithSubTasks[] | undefined;
        if (Array.isArray(tasks)) {
          archive.putTasks(tasks);
        }
      } else if (op.actionType === TaskSharedActions.restoreTask.type) {
        const task = actionPayload['task'] as Task | undefined;
        const subTasks = actionPayload['subTasks'] as Task[] | undefined;
        if (task?.id) {
          archive.deleteTasks([
            task.id,
            ...(Array.isArray(subTasks) ? subTasks.map((t) => t.id) : []),
          ]);
        }
      } else if (op.actionType === TaskSharedActions.updateTask.type) {
        const task = actionPayload['task'] as
          | { id: string; changes: Record<string, unknown> }
          | undefined;
        if (task?.id && task.changes && typeof task.changes === 'object') {
          archive.patchArchived(task.id, task.changes);
        }
      } else if (op.actionType === TaskSharedActions.updateTasks.type) {
        const updates = actionPayload['tasks'] as
          | { id: string; changes: Record<string, unknown> }[]
          | undefined;
        if (Array.isArray(updates)) {
          for (const update of updates) {
            if (update?.id && update.changes && typeof update.changes === 'object') {
              archive.patchArchived(update.id, update.changes);
            }
          }
        }
      }
    }
  }

  /**
   * Builds the vehicle that carries a local win to the server, mirroring the
   * app's three local-win kinds:
   *
   * - live entity: a dominating LWW update over the current snapshot (the
   *   app's `createLWWUpdateOp`, replace mode, canonical top-level id);
   * - entity gone with a pending local delete/archive for it: a re-emission
   *   of that op with a merged dominating clock (the app's replacement
   *   delete). Re-uploading the ORIGINAL would just earn another rejection,
   *   and dropping it would lose the delete everywhere;
   * - entity gone with nothing pending (pure crossing of already-uploaded
   *   history): no vehicle — skipping the remote op IS the resolution.
   *
   * Returns null only when no win can be constructed, and the caller then
   * takes the remote side instead of broadcasting a resurrect.
   */
  private _synthesizeLwwUpdate(conflict: BridgeConflict): Operation | null {
    const { store, opLog } = this._deps;
    const { entityType, entityId, localOps, remoteOps } = conflict;
    const entityState = readEntityState(store.state, entityType, entityId);
    if (entityState === undefined || entityState === null) {
      const pendingIds = new Set(opLog.pendingUpload().map((op) => op.id));
      const pendingWinner = [...localOps]
        .filter((op) => pendingIds.has(op.id))
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      if (!pendingWinner) {
        // Pure crossing: the retained history already converged elsewhere.
        // Tell the caller there is nothing to build AND nothing to apply.
        return NULL_VEHICLE as unknown as Operation;
      }
      let mergedClock: Record<string, number> = {};
      for (const op of [...localOps, ...remoteOps]) {
        mergedClock = mergeVectorClocks(mergedClock, op.vectorClock);
      }
      return {
        id: createOperationId(),
        actionType: pendingWinner.actionType,
        opType: pendingWinner.opType,
        entityType: pendingWinner.entityType,
        entityId: pendingWinner.entityId,
        entityIds: pendingWinner.entityIds,
        payload: pendingWinner.payload,
        clientId: store.clientId,
        vectorClock: incrementVectorClock(mergedClock, store.clientId),
        timestamp: pendingWinner.timestamp,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      };
    }
    const basePayload =
      typeof entityState === 'object' ? (entityState as Record<string, unknown>) : {};
    const actionPayload = { ...basePayload };
    if (isLwwPayloadIdCanonical(entityType) || !isSingletonEntityId(entityId)) {
      actionPayload['id'] = entityId;
    } else {
      delete actionPayload['id'];
    }
    const payload: LwwUpdatePayload = {
      actionPayload,
      entityChanges: [],
      lwwUpdateMode: 'replace',
    };
    let mergedClock: Record<string, number> = {};
    for (const op of [...localOps, ...remoteOps]) {
      mergedClock = mergeVectorClocks(mergedClock, op.vectorClock);
    }
    const vectorClock = incrementVectorClock(mergedClock, store.clientId);
    return {
      id: createOperationId(),
      actionType: toLwwUpdateActionType(entityType as EntityType),
      opType: OpType.Update,
      entityType: entityType as EntityType,
      entityId,
      payload,
      clientId: store.clientId,
      vectorClock,
      timestamp: Date.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };
  }

  status(): SyncEngineStatus {
    const now = Date.now();
    return {
      enabled: false,
      running: this._running,
      lastSyncAt: this.lastSyncAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      lastErrorCode: this.lastErrorCode,
      authFailedSince: this.authFailedSince,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryAt: this.nextRetryAt,
      tokenExpiresAt: this._tokenExpiresAt,
      tokenExpiringSoon:
        this._tokenExpiresAt !== null &&
        this._tokenExpiresAt - now < TOKEN_EXPIRY_WARN_MS,
      pendingUpload: this._deps.opLog.pendingUpload().length,
    };
  }
}

/**
 * One entity's concurrent local/remote op pair, in app-op form. Cast to the
 * core's `EntityConflictLike` at the planning boundary (the core carries
 * `actionType` as an opaque string; the app narrows it to `ActionType`).
 */
interface BridgeConflict {
  entityType: string;
  entityId: string;
  localOps: Operation[];
  remoteOps: Operation[];
}

/**
 * `_synthesizeLwwUpdate` returns this instead of an op when the resolution is
 * "skip the remote, build nothing" (pure crossing). It must never reach the
 * log or the wire: the caller filters it back out.
 */
const NULL_VEHICLE = { __nullVehicle: true } as const;

export class SyncBusyError extends Error {
  override readonly name = 'SyncBusyError';
}

export class SyncNotConfiguredError extends Error {
  override readonly name = 'SyncNotConfiguredError';
}

export class SyncEpochChangedError extends Error {
  override readonly name = 'SyncEpochChangedError';
}

const groupByEntity = (ops: readonly Operation[]): Map<string, Operation[]> => {
  const map = new Map<string, Operation[]>();
  for (const op of ops) {
    for (const entityId of getOpEntityIds(op)) {
      const key = toEntityKeyString(op.entityType, entityId);
      const list = map.get(key) ?? [];
      list.push(op);
      map.set(key, list);
    }
  }
  return map;
};

const frontierByEntity = (
  ops: readonly Operation[],
): Map<string, Record<string, number>> => {
  const map = new Map<string, Record<string, number>>();
  for (const op of ops) {
    for (const entityId of getOpEntityIds(op)) {
      const key = toEntityKeyString(op.entityType, entityId);
      map.set(key, mergeVectorClocks(map.get(key) ?? {}, op.vectorClock));
    }
  }
  return map;
};

const frontierByEntityOps = (ops: readonly Operation[]): Map<string, Operation[]> =>
  groupByEntity(ops);

/**
 * Reads one entity's current state through the app's registry, mirroring the
 * app's `getCurrentEntityState` patterns (adapter selectById, singleton whole
 * state, map key, array find-by-id). Selectors are pure memoized functions —
 * callable headless with the agent state, which carries every feature slice.
 */
const readEntityState = (
  state: AgentState,
  entityType: string,
  entityId: string,
): unknown => {
  const config = getEntityConfig(entityType as never) as
    | {
        storagePattern?: string;
        selectById?: (state: unknown, props: { id: string }) => unknown;
        selectState?: (state: unknown) => unknown;
        mapKey?: string;
        arrayKey?: string | null;
      }
    | undefined;
  if (!config) {
    return undefined;
  }
  try {
    if (isAdapterEntity(config as never) && config.selectById) {
      if (entityType === 'ISSUE_PROVIDER') {
        const factory = config.selectById as unknown as (
          id: string,
          key: null,
        ) => (state: unknown) => unknown;
        return factory(entityId, null)(state);
      }
      return config.selectById(state, { id: entityId });
    }
    if (isSingletonEntity(config as never) && config.selectState) {
      return config.selectState(state);
    }
    if (isMapEntity(config as never) && config.selectState && config.mapKey) {
      const feature = config.selectState(state) as Record<string, unknown> | undefined;
      return (feature?.[config.mapKey] as Record<string, unknown>)?.[entityId];
    }
    if (isArrayEntity(config as never) && config.selectState) {
      const feature = config.selectState(state);
      if (config.arrayKey === null) {
        return (feature as Array<{ id: string }> | undefined)?.find(
          (item) => item.id === entityId,
        );
      }
      if (config.arrayKey) {
        const arr = (feature as Record<string, unknown> | undefined)?.[config.arrayKey];
        return (arr as Array<{ id: string }> | undefined)?.find(
          (item) => item.id === entityId,
        );
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};
