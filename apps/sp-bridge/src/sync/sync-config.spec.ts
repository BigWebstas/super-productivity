import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '../test/harness';
import {
  loadSyncConfig,
  redactSyncConfig,
  saveSyncConfig,
  validateSyncConfigPatch,
  SyncConfigValidationError,
} from './sync-config';

describe('validateSyncConfigPatch', () => {
  it('accepts a well-formed patch', () => {
    const patch = validateSyncConfigPatch({
      baseUrl: 'https://example.com',
      accessToken: 'tok',
      syncIntervalMs: 5000,
      syncOnLocalChange: false,
    });
    assert.equal(patch.baseUrl, 'https://example.com');
    assert.equal(patch.accessToken, 'tok');
  });

  it('rejects unknown fields instead of ignoring typos', () => {
    assert.throws(
      () => validateSyncConfigPatch({ accesToken: 'tok' }),
      (error: unknown) =>
        error instanceof SyncConfigValidationError &&
        /Unknown config field\(s\): accesToken/.test(error.message),
    );
  });

  it('rejects non-objects and mistyped fields', () => {
    for (const body of [null, [], 'x', 42]) {
      assert.throws(() => validateSyncConfigPatch(body), SyncConfigValidationError);
    }
    assert.throws(
      () => validateSyncConfigPatch({ syncIntervalMs: 'hourly' }),
      /syncIntervalMs must be a number/,
    );
    assert.throws(
      () => validateSyncConfigPatch({ isEncryptionEnabled: 'yes' }),
      /isEncryptionEnabled must be a boolean/,
    );
  });

  it('rejects encryptKey together with masterPassword', () => {
    assert.throws(
      () => validateSyncConfigPatch({ encryptKey: 'k', masterPassword: 'p' }),
      /mutually exclusive/,
    );
  });
});

describe('sync-config redaction', () => {
  it('never exposes secrets', () => {
    const redacted = redactSyncConfig({
      baseUrl: 'https://example.com',
      accessToken: 'tok',
      refreshToken: 'ref',
      encryptKey: 'key',
      isEncryptionEnabled: true,
    });
    assert.equal('accessToken' in redacted, false);
    assert.equal('refreshToken' in redacted, false);
    assert.equal('encryptKey' in redacted, false);
    assert.equal('masterPassword' in redacted, false);
    assert.equal(redacted.accessTokenSet, true);
    assert.equal(redacted.encryptKeySet, true);
    assert.equal(redacted.baseUrl, 'https://example.com');
  });

  it('names the token account with a masked email and never the token itself', () => {
    const payload = Buffer.from(
      JSON.stringify({ userId: 12, email: 'jwebstas@example.com', tokenVersion: 0 }),
    ).toString('base64url');
    const redacted = redactSyncConfig({ accessToken: `hdr.${payload}.sig` });
    assert.equal(redacted.account, 'user #12 (jw***@example.com)');
  });

  it('omits the account for a token that is not a JWT', () => {
    assert.equal(redactSyncConfig({ accessToken: 'opaque' }).account, undefined);
    assert.equal(redactSyncConfig({ accessToken: 'a.!!!.c' }).account, undefined);
    assert.equal(redactSyncConfig({}).account, undefined);
  });

  it('promotes a saved masterPassword to encryptKey without persisting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-bridge-cfg-'));
    try {
      const saved = saveSyncConfig(dir, { masterPassword: 'pw-0001' });
      assert.equal(saved.encryptKey, 'pw-0001');
      assert.equal(saved.isEncryptionEnabled, true);
      const raw = readFileSync(join(dir, 'sync.json'), 'utf8');
      assert.equal(raw.includes('masterPassword'), false);
      assert.equal(raw.includes('pw-0001'), true);
      // Env still overlays the file.
      process.env.SP_BRIDGE_SYNC_INTERVAL_MS = '7000';
      try {
        assert.equal(loadSyncConfig(dir).syncIntervalMs, 7000);
      } finally {
        delete process.env.SP_BRIDGE_SYNC_INTERVAL_MS;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
