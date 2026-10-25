import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientUpdateRequiredSPError } from '@sp/sync-providers/errors';
import { describe, it } from '../test/harness';
import { createBridgeSyncProvider } from './provider';
import { classifySyncError } from './sync-errors';
import { saveSyncConfig } from './sync-config';

const withStubbedFetch = async (
  respond: () => Response,
  run: (urls: string[], dir: string) => Promise<void>,
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-bridge-provider-'));
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return respond();
  }) as typeof fetch;
  try {
    saveSyncConfig(dir, { accessToken: 'tok-0001', baseUrl: 'http://sync.invalid' });
    await run(urls, dir);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
};

const refusal = (): Response =>
  new Response(JSON.stringify({ errorCode: 'CLIENT_UPDATE_REQUIRED' }), {
    status: 426,
    headers: { 'Content-Type': 'application/json' },
  });

describe('createBridgeSyncProvider', () => {
  it('sends the host app version on every request', async () => {
    await withStubbedFetch(refusal, async (urls, dir) => {
      const provider = createBridgeSyncProvider(dir, undefined, '0.1.42');
      await provider.downloadOps(0).catch(() => undefined);
      assert.equal(urls.length, 1);
      assert.ok(urls[0].includes('appVersion=0.1.42'), urls[0]);
    });
  });

  it('classifies a version refusal as update_required, not auth_failed', async () => {
    await withStubbedFetch(refusal, async (_urls, dir) => {
      const provider = createBridgeSyncProvider(dir, undefined, '0.1.42');
      const error = await provider.downloadOps(0).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(error instanceof ClientUpdateRequiredSPError);
      assert.equal(classifySyncError(error), 'update_required');
    });
  });
});
