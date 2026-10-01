/**
 * Operation payload encryption for the bridge, mirroring the app's
 * `OperationEncryptionService` envelope exactly:
 *
 * - upload: `payload` (object) → `JSON.stringify` → `encryptBatch` → string
 *   payload with `isPayloadEncrypted: true`;
 * - download: string payloads → `decryptBatchSettled` → `JSON.parse` back to
 *   the object form the app's `convertOpToAction` unwraps.
 *
 * Failure policy is abort-the-cycle, never skip-and-advance: an op we cannot
 * decrypt must hold the cursor back so it is redelivered next cycle, rather
 * than being silently dropped past. Logs carry op ids and counts only — never
 * payloads, titles, or key material.
 */
import { decryptBatchSettled, encryptBatch } from '@sp/sync-core';
import type { Operation } from '../../../../src/app/op-log/core/operation.types';
import type { SyncOperation } from '@sp/sync-providers/provider-types';

export class SyncCryptoError extends Error {
  override readonly name = 'SyncCryptoError';
}

/** Encrypts local ops for upload. Throws on any failure. */
export const encryptOperationsForUpload = async (
  ops: Operation[],
  encryptKey: string,
): Promise<SyncOperation[]> => {
  if (!ops.length) {
    return [];
  }
  const payloadStrings = ops.map((op) => JSON.stringify(op.payload));
  let encrypted: string[];
  try {
    encrypted = await encryptBatch(payloadStrings, encryptKey);
  } catch (error) {
    throw new SyncCryptoError(
      `Failed to encrypt ${ops.length} operation(s) for upload: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return ops.map((op, index) => ({
    ...op,
    payload: encrypted[index],
    isPayloadEncrypted: true,
  }));
};

export interface DecryptDownloadResult {
  /** Ops safe to apply (plaintext passthrough + successful decrypts). */
  ops: Operation[];
  /** Ids that failed decrypt — caller must NOT advance past them. */
  failedOpIds: string[];
}

/**
 * Decrypts downloaded ops. Never throws for per-op failures: they are
 * reported in `failedOpIds` so the caller can abort the cycle without
 * advancing the cursor (redelivery + dedupe makes the retry safe).
 */
export const decryptDownloadedOperations = async (
  ops: SyncOperation[],
  encryptKey: string | undefined,
): Promise<DecryptDownloadResult> => {
  const result: DecryptDownloadResult = { ops: [], failedOpIds: [] };
  const encryptedIndexes: number[] = [];
  const encryptedPayloads: string[] = [];

  ops.forEach((op, index) => {
    if (!op.isPayloadEncrypted) {
      result.ops.push(op as unknown as Operation);
      return;
    }
    if (!encryptKey) {
      result.failedOpIds.push(op.id);
      return;
    }
    if (typeof op.payload !== 'string') {
      console.warn('[sync] Encrypted op arrived with a non-string payload', {
        opId: op.id,
      });
      result.failedOpIds.push(op.id);
      return;
    }
    encryptedIndexes.push(index);
    encryptedPayloads.push(op.payload);
  });

  if (!encryptedPayloads.length) {
    return result;
  }
  const settled = await decryptBatchSettled(encryptedPayloads, encryptKey as string);
  const decrypted = new Map<number, Operation>();
  settled.forEach((item, i) => {
    const opIndex = encryptedIndexes[i];
    const op = ops[opIndex];
    if (!item.ok) {
      console.warn('[sync] Could not decrypt downloaded op; holding cursor', {
        opId: op.id,
        errorName: item.errorName,
      });
      result.failedOpIds.push(op.id);
      return;
    }
    try {
      const payload = JSON.parse(item.plaintext) as unknown;
      decrypted.set(opIndex, { ...op, payload } as unknown as Operation);
    } catch {
      console.warn('[sync] Decrypted op payload is not JSON; holding cursor', {
        opId: op.id,
      });
      result.failedOpIds.push(op.id);
    }
  });

  // Preserve server order: rebuild the result list with decrypted payloads in
  // place, minus failures.
  const ordered: Operation[] = [];
  ops.forEach((op, index) => {
    if (result.failedOpIds.includes(op.id)) {
      return;
    }
    ordered.push(decrypted.get(index) ?? (op as unknown as Operation));
  });
  result.ops = ordered;
  return result;
};
