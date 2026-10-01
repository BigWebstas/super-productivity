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

export const createBridgeSyncProvider = (dataDir: string): SuperSyncProvider => {
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
    storage: new FileSeqStorage(dataDir),
    responseValidators,
    // Host owns the SP-specific fallback; the package never assumes it.
    defaultBaseUrl: SUPER_SYNC_DEFAULT_BASE_URL,
    // Omitted on purpose: the version tells the server which clients predate a
    // repair-semantics change, and the bridge is not the desktop app. Absent
    // means "unknown", which the server already handles.
  };
  return new SuperSyncProvider(deps);
};
