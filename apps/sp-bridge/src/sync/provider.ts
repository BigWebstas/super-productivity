/**
 * Bridge-side factory wiring concrete Node adapters into the package's
 * SuperSync provider. Mirrors the app's `createSuperSyncProvider` with
 * host-appropriate ports: plain `fetch` (Node 20+), an all-false platform
 * (so the provider never takes the native-HTTP path), file-backed credential
 * and seq storage, and the app's own response validators (pure functions over
 * `@sp/shared-schema`, no DI).
 */
import { NOOP_SYNC_LOGGER } from '@sp/sync-core';
import {
  SUPER_SYNC_DEFAULT_BASE_URL,
  SuperSyncProvider,
  type SuperSyncDeps,
} from '@sp/sync-providers/super-sync';
import {
  validateDeleteAllDataResponse,
  validateDevicesResponse,
  validateOpDownloadResponse,
  validateOpUploadResponse,
  validateReplaceTokenResponse,
  validateRestorePointsResponse,
  validateRestoreSnapshotResponse,
  validateSnapshotUploadResponse,
} from '../../../../src/app/op-log/sync-providers/super-sync/response-validators';
import { FileCredentialStore } from './credential-store';
import { FileSeqStorage } from './seq-storage';

export const createBridgeSyncProvider = (
  dataDir: string,
  seqStorage?: FileSeqStorage,
  appVersion?: string,
): SuperSyncProvider => {
  const responseValidators: SuperSyncDeps['responseValidators'] = {
    validateOpUpload: validateOpUploadResponse,
    validateOpDownload: validateOpDownloadResponse,
    validateSnapshotUpload: validateSnapshotUploadResponse,
    validateRestorePoints: validateRestorePointsResponse,
    validateRestoreSnapshot: validateRestoreSnapshotResponse,
    validateDeleteAllData: validateDeleteAllDataResponse,
    validateDevices: validateDevicesResponse,
    validateReplaceToken: validateReplaceTokenResponse,
  };

  const deps: SuperSyncDeps = {
    logger: NOOP_SYNC_LOGGER,
    platformInfo: {
      isNativePlatform: false,
      isAndroidWebView: false,
      isIosNative: false,
      isElectron: false,
    },
    webFetch: () => fetch,
    credentialStore: new FileCredentialStore(dataDir),
    nativeHttpExecutor: () => {
      // Unreachable: `isNativePlatform` is false, so the provider always takes
      // the `fetch` path. A throw (not a silent stub) keeps that invariant loud
      // if the platform flags ever change.
      throw new Error('[sync] Native HTTP executor is not available in the bridge');
    },
    storage: seqStorage ?? new FileSeqStorage(dataDir),
    responseValidators,
    // Host owns the SP-specific fallback; the package never assumes it.
    defaultBaseUrl: SUPER_SYNC_DEFAULT_BASE_URL,
    // Sent on every request, like the app: a future server version floor
    // counts a request without it as an old client. Absent only when the host
    // cannot supply one (headless tests).
    appVersion,
  };
  return new SuperSyncProvider(deps);
};
