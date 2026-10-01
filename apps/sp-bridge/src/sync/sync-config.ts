/**
 * SuperSync connection config: file-backed with environment overrides.
 *
 * The file lives next to the op log as `sync.json` in the data directory.
 * Every field is optional; anything absent is treated as "not configured" and
 * sync stays disabled rather than failing. `SP_BRIDGE_SYNC_*` environment
 * variables override the file so containers can provision without writing it.
 *
 * Secrets (`accessToken`, `encryptKey`, `masterPassword`) are never logged —
 * only their presence is reported. The file is written atomically (temp +
 * rename) with `0600` attempted on POSIX; on Windows the profile ACL applies,
 * exactly like the REST access token.
 *
 * `masterPassword` is transient: on load it is promoted to `encryptKey` and
 * persisted, then dropped from memory. The stored `encryptKey` has the same
 * opaque-string semantics as the app's `SuperSyncPrivateCfg.encryptKey`
 * (it is the secret `sync-core` encrypts with, not derived bytes).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SYNC_CONFIG_FILE = 'sync.json';

export interface BridgeSyncConfig {
  /** Server base URL. Falls back to the hosted default when absent. */
  baseUrl?: string;
  /** JWT access token. Without it sync is disabled. */
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Opaque encryption secret (same semantics as the app's `encryptKey`). */
  encryptKey?: string;
  /**
   * Transient only, never persisted: promoted to `encryptKey` on load.
   * Prefer `SP_BRIDGE_SYNC_MASTER_PASSWORD` so it never touches disk.
   */
  masterPassword?: string;
  isEncryptionEnabled?: boolean;
  /** Ms between automatic syncs. `0` disables the timer (manual trigger only). */
  syncIntervalMs?: number;
  /** Sync shortly after local changes land. On by default. */
  syncOnLocalChange?: boolean;
}

export const DEFAULT_SYNC_INTERVAL_MS = 60_000;

const readEnv = (): Partial<BridgeSyncConfig> => {
  const env = process.env;
  const cfg: Partial<BridgeSyncConfig> = {};
  if (env.SP_BRIDGE_SYNC_BASE_URL) cfg.baseUrl = env.SP_BRIDGE_SYNC_BASE_URL;
  if (env.SP_BRIDGE_SYNC_ACCESS_TOKEN) cfg.accessToken = env.SP_BRIDGE_SYNC_ACCESS_TOKEN;
  if (env.SP_BRIDGE_SYNC_REFRESH_TOKEN)
    cfg.refreshToken = env.SP_BRIDGE_SYNC_REFRESH_TOKEN;
  if (env.SP_BRIDGE_SYNC_MASTER_PASSWORD)
    cfg.masterPassword = env.SP_BRIDGE_SYNC_MASTER_PASSWORD;
  if (env.SP_BRIDGE_SYNC_ENCRYPT_KEY) cfg.encryptKey = env.SP_BRIDGE_SYNC_ENCRYPT_KEY;
  if (env.SP_BRIDGE_SYNC_INTERVAL_MS !== undefined) {
    const n = Number.parseInt(env.SP_BRIDGE_SYNC_INTERVAL_MS, 10);
    if (Number.isFinite(n)) cfg.syncIntervalMs = n;
  }
  return cfg;
};

const configPath = (dataDir: string): string => join(dataDir, SYNC_CONFIG_FILE);

const readFileConfig = (dataDir: string): Partial<BridgeSyncConfig> => {
  const path = configPath(dataDir);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgeSyncConfig>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn('[sync] Could not read sync.json; treating sync as unconfigured', error);
    return {};
  }
};

const writeFileConfig = (dataDir: string, cfg: Partial<BridgeSyncConfig>): void => {
  mkdirSync(dataDir, { recursive: true });
  const path = configPath(dataDir);
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmpPath, path);
};

/**
 * Loads and normalizes the sync config. Promotes `masterPassword` (file or
 * env) to a persisted `encryptKey` once, so the password itself is never
 * written to disk and later loads use the key directly.
 */
export const loadSyncConfig = (dataDir: string): BridgeSyncConfig => {
  const fileCfg = readFileConfig(dataDir);
  const merged: Partial<BridgeSyncConfig> = { ...fileCfg, ...readEnv() };
  if (merged.masterPassword && !merged.encryptKey) {
    merged.encryptKey = merged.masterPassword;
    merged.isEncryptionEnabled = true;
  }
  delete merged.masterPassword;

  if (merged.encryptKey && fileCfg.encryptKey !== merged.encryptKey) {
    try {
      writeFileConfig(dataDir, {
        ...fileCfg,
        encryptKey: merged.encryptKey,
        isEncryptionEnabled: true,
      });
    } catch (error) {
      console.warn('[sync] Could not persist promoted encryptKey', error);
    }
  }
  return merged;
};

/** True when a sync cycle has credentials to work with. */
export const isSyncConfigured = (cfg: BridgeSyncConfig): boolean => !!cfg.accessToken;

/**
 * The config as served over the REST API: presence flags instead of secrets.
 * A leaked status response must never contain a token or key.
 */
export interface RedactedSyncConfig {
  baseUrl?: string;
  accessTokenSet: boolean;
  refreshTokenSet: boolean;
  encryptKeySet: boolean;
  isEncryptionEnabled?: boolean;
  expiresAt?: number;
  syncIntervalMs?: number;
  syncOnLocalChange?: boolean;
}

export const redactSyncConfig = (cfg: BridgeSyncConfig): RedactedSyncConfig => ({
  baseUrl: cfg.baseUrl,
  accessTokenSet: !!cfg.accessToken,
  refreshTokenSet: !!cfg.refreshToken,
  encryptKeySet: !!cfg.encryptKey,
  isEncryptionEnabled: cfg.isEncryptionEnabled,
  expiresAt: cfg.expiresAt,
  syncIntervalMs: cfg.syncIntervalMs,
  syncOnLocalChange: cfg.syncOnLocalChange,
});

export class SyncConfigValidationError extends Error {
  override readonly name = 'SyncConfigValidationError';
}

const CONFIG_FIELD_NAMES = [
  'baseUrl',
  'accessToken',
  'refreshToken',
  'expiresAt',
  'encryptKey',
  'masterPassword',
  'isEncryptionEnabled',
  'syncIntervalMs',
  'syncOnLocalChange',
] as const;

type ConfigFieldName = (typeof CONFIG_FIELD_NAMES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates a `POST /sync/config` body. Unknown fields are rejected (a typo
 * like `accesToken` must fail loudly, never silently disable sync), and an
 * empty-string `accessToken` clears the token. Throws
 * `SyncConfigValidationError` on any problem.
 */
export const validateSyncConfigPatch = (body: unknown): Partial<BridgeSyncConfig> => {
  if (!isRecord(body)) {
    throw new SyncConfigValidationError('Config body must be a JSON object');
  }
  const unknownFields = Object.keys(body).filter(
    (key): key is string => !(CONFIG_FIELD_NAMES as readonly string[]).includes(key),
  );
  if (unknownFields.length) {
    throw new SyncConfigValidationError(
      `Unknown config field(s): ${unknownFields.join(', ')}`,
    );
  }
  const patch: Partial<BridgeSyncConfig> = {};
  const field = (name: ConfigFieldName): unknown =>
    (body as Record<string, unknown>)[name];

  if ('baseUrl' in body) {
    if (typeof field('baseUrl') !== 'string') {
      throw new SyncConfigValidationError('baseUrl must be a string');
    }
    patch.baseUrl = field('baseUrl') as string;
  }
  for (const name of [
    'accessToken',
    'refreshToken',
    'encryptKey',
    'masterPassword',
  ] as const) {
    if (name in body && typeof field(name) !== 'string') {
      throw new SyncConfigValidationError(`${name} must be a string`);
    }
  }
  if ('accessToken' in body) patch.accessToken = field('accessToken') as string;
  if ('refreshToken' in body) patch.refreshToken = field('refreshToken') as string;
  if ('encryptKey' in body) patch.encryptKey = field('encryptKey') as string;
  if ('masterPassword' in body) patch.masterPassword = field('masterPassword') as string;
  if ('expiresAt' in body) {
    if (typeof field('expiresAt') !== 'number') {
      throw new SyncConfigValidationError('expiresAt must be a number');
    }
    patch.expiresAt = field('expiresAt') as number;
  }
  if ('isEncryptionEnabled' in body) {
    if (typeof field('isEncryptionEnabled') !== 'boolean') {
      throw new SyncConfigValidationError('isEncryptionEnabled must be a boolean');
    }
    patch.isEncryptionEnabled = field('isEncryptionEnabled') as boolean;
  }
  if ('syncIntervalMs' in body) {
    if (typeof field('syncIntervalMs') !== 'number') {
      throw new SyncConfigValidationError('syncIntervalMs must be a number');
    }
    patch.syncIntervalMs = field('syncIntervalMs') as number;
  }
  if ('syncOnLocalChange' in body) {
    if (typeof field('syncOnLocalChange') !== 'boolean') {
      throw new SyncConfigValidationError('syncOnLocalChange must be a boolean');
    }
    patch.syncOnLocalChange = field('syncOnLocalChange') as boolean;
  }
  if (patch.encryptKey && patch.masterPassword) {
    throw new SyncConfigValidationError(
      'encryptKey and masterPassword are mutually exclusive',
    );
  }
  return patch;
};

/** Persists user-supplied fields (REST route, provisioning scripts). */
export const saveSyncConfig = (
  dataDir: string,
  cfg: Partial<BridgeSyncConfig>,
): BridgeSyncConfig => {
  const next = { ...readFileConfig(dataDir), ...cfg };
  if (next.masterPassword && !next.encryptKey) {
    next.encryptKey = next.masterPassword;
    next.isEncryptionEnabled = true;
  }
  delete next.masterPassword;
  writeFileConfig(dataDir, next);
  return loadSyncConfig(dataDir);
};
