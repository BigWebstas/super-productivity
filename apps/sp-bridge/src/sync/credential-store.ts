/**
 * File-backed `SyncCredentialStorePort` over the bridge's `sync.json`.
 *
 * The provider reads credentials through this port (`load`) and writes back
 * rotations through it (`setComplete`/`updatePartial`/`upsertPartial`). The
 * bridge keeps `sync.json` as the single source of truth: env vars overlay at
 * load time but are never written back, so a rotated token persists to the
 * file while the env-provided base URL keeps working.
 */
import type { SyncCredentialStorePort } from '@sp/sync-providers/credential-store';
import type {
  PROVIDER_ID_SUPER_SYNC,
  SuperSyncPrivateCfg,
} from '@sp/sync-providers/super-sync';
import { loadSyncConfig, saveSyncConfig } from './sync-config';

export class FileCredentialStore implements SyncCredentialStorePort<
  typeof PROVIDER_ID_SUPER_SYNC,
  SuperSyncPrivateCfg
> {
  constructor(private readonly _dataDir: string) {}

  async load(): Promise<SuperSyncPrivateCfg | null> {
    const cfg = loadSyncConfig(this._dataDir);
    if (!cfg.accessToken) {
      return null;
    }
    return {
      accessToken: cfg.accessToken,
      baseUrl: cfg.baseUrl,
      refreshToken: cfg.refreshToken,
      expiresAt: cfg.expiresAt,
      encryptKey: cfg.encryptKey,
      isEncryptionEnabled: cfg.isEncryptionEnabled,
    };
  }

  async setComplete(privateCfg: SuperSyncPrivateCfg): Promise<void> {
    saveSyncConfig(this._dataDir, {
      accessToken: privateCfg.accessToken,
      baseUrl: privateCfg.baseUrl,
      refreshToken: privateCfg.refreshToken,
      expiresAt: privateCfg.expiresAt,
      encryptKey: privateCfg.encryptKey,
      isEncryptionEnabled: privateCfg.isEncryptionEnabled,
    });
  }

  async updatePartial(updates: Partial<SuperSyncPrivateCfg>): Promise<void> {
    const current = (await this.load()) ?? { accessToken: '' };
    await this.setComplete({ ...current, ...updates });
  }

  async upsertPartial(updates: Partial<SuperSyncPrivateCfg>): Promise<void> {
    await this.updatePartial(updates);
  }

  async clear(): Promise<void> {
    saveSyncConfig(this._dataDir, {
      accessToken: undefined,
      refreshToken: undefined,
      expiresAt: undefined,
    });
  }
}
