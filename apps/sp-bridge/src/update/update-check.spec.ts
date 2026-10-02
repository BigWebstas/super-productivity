import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '../test/harness';
import {
  downloadUpdate,
  fetchAvailableUpdate,
  pickUpdate,
  type AvailableUpdate,
  type GithubRelease,
} from './update-check';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const release = (
  tag: string,
  overrides: Partial<GithubRelease> = {},
  digest: string | null = `sha256:${'a'.repeat(64)}`,
): GithubRelease => ({
  tag_name: tag,
  draft: false,
  html_url: `https://example.test/${tag}`,
  assets: [
    {
      name: `SP.Bridge.Setup.${tag}.exe`,
      size: 10,
      browser_download_url: `https://example.test/${tag}.exe`,
      digest,
    },
  ],
  ...overrides,
});

describe('pickUpdate', () => {
  it('picks the newest bridge release newer than the running version', () => {
    const update = pickUpdate(
      [
        release('sp-bridge-v0.1.5'),
        release('sp-bridge-v0.1.9'),
        release('sp-bridge-v0.1.7'),
      ],
      '0.1.6',
    );
    assert.equal(update?.version, '0.1.9');
    assert.equal(update?.sha256, 'a'.repeat(64));
  });

  it('ignores app releases, drafts, older versions and the running version', () => {
    const update = pickUpdate(
      [
        release('v18.0.0'),
        release('sp-bridge-v0.2.0', { draft: true }),
        release('sp-bridge-v0.1.6'),
        release('sp-bridge-v0.1.2'),
      ],
      '0.1.6',
    );
    assert.equal(update, undefined);
  });

  it('skips a release whose installer has no SHA-256 digest', () => {
    assert.equal(pickUpdate([release('sp-bridge-v0.2.0', {}, null)], '0.1.0'), undefined);
    assert.equal(
      pickUpdate([release('sp-bridge-v0.2.0', {}, 'sha512:abc')], '0.1.0'),
      undefined,
    );
  });

  it('skips a release without an installer asset', () => {
    assert.equal(
      pickUpdate([release('sp-bridge-v0.2.0', { assets: [] })], '0.1.0'),
      undefined,
    );
  });
});

describe('fetchAvailableUpdate', () => {
  it('rejects a non-OK response instead of reporting "no update"', async () => {
    const fetchFn = (async () =>
      new Response('rate limited', { status: 403 })) as typeof fetch;
    await assert.rejects(() => fetchAvailableUpdate('0.1.0', fetchFn), /HTTP 403/);
  });

  it('parses the release list', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify([release('sp-bridge-v0.3.0')]))) as typeof fetch;
    assert.equal((await fetchAvailableUpdate('0.1.0', fetchFn))?.version, '0.3.0');
  });
});

describe('downloadUpdate', () => {
  const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-bridge-update-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const payload = Buffer.from('installer-bytes');
  const updateFor = (overrides: Partial<AvailableUpdate> = {}): AvailableUpdate => ({
    version: '0.2.0',
    releaseUrl: 'https://example.test/r',
    assetName: 'setup.exe',
    downloadUrl: 'https://example.test/setup.exe',
    size: payload.length,
    sha256: sha256(payload),
    ...overrides,
  });
  const serve = (body: Buffer): typeof fetch =>
    (async () => new Response(new Uint8Array(body))) as typeof fetch;

  it('writes the installer when size and SHA-256 match', async () =>
    withDir(async (dir) => {
      const dest = join(dir, 'setup.exe');
      await downloadUpdate(updateFor(), dest, serve(payload));
      assert.deepEqual(readFileSync(dest), payload);
      assert.equal(existsSync(`${dest}.partial`), false);
    }));

  it('leaves nothing runnable when the SHA-256 does not match', async () =>
    withDir(async (dir) => {
      const dest = join(dir, 'setup.exe');
      await assert.rejects(
        () => downloadUpdate(updateFor({ sha256: 'b'.repeat(64) }), dest, serve(payload)),
        /SHA-256/,
      );
      assert.equal(existsSync(dest), false);
      assert.equal(existsSync(`${dest}.partial`), false);
    }));

  it('rejects a download larger or smaller than the release says', async () =>
    withDir(async (dir) => {
      const dest = join(dir, 'setup.exe');
      await assert.rejects(
        () =>
          downloadUpdate(updateFor({ size: payload.length - 1 }), dest, serve(payload)),
        /larger/,
      );
      await assert.rejects(
        () =>
          downloadUpdate(updateFor({ size: payload.length + 1 }), dest, serve(payload)),
        /truncated/,
      );
      assert.equal(existsSync(dest), false);
    }));
});
