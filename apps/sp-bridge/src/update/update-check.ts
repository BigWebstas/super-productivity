/**
 * Finds and downloads newer SP Bridge installers from GitHub Releases.
 *
 * Mirrors the app's own update check (`src/app/core/update-check`): a bare
 * unauthenticated GET of public release metadata, no identifiers sent. Unlike
 * the app it also downloads, because the bridge ships through exactly one
 * package format (the NSIS installer CI publishes), so there is one install
 * path to support.
 *
 * Electron-free on purpose: the shell (`src/electron/updater.ts`) owns timing,
 * the tray and running the installer; everything decidable without Electron
 * lives here so the spec runner can exercise it.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isNewerVersion } from '../../../../src/app/util/is-newer-version';

/** The fork CI publishes bridge releases to (see sp-bridge-windows.yml). */
export const RELEASES_API_URL =
  'https://api.github.com/repos/BigWebstas/super-productivity/releases?per_page=30';

/** Bridge releases share the repo with the app's, so they carry their own tag prefix. */
const TAG_REGEX = /^sp-bridge-v(\d+\.\d+\.\d+)$/;
const SHA256_DIGEST_REGEX = /^sha256:([0-9a-f]{64})$/;

export interface GithubReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** `sha256:<hex>`; GitHub computes it on upload. */
  digest?: string | null;
}

export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  html_url: string;
  assets: GithubReleaseAsset[];
}

export interface AvailableUpdate {
  version: string;
  releaseUrl: string;
  assetName: string;
  downloadUrl: string;
  size: number;
  sha256: string;
}

/**
 * The newest bridge release strictly newer than `currentVersion` that has a
 * Windows installer with a GitHub-computed SHA-256, or `undefined`.
 *
 * A release without a digest is skipped rather than trusted: the digest is the
 * only integrity check between the download and running it.
 */
export const pickUpdate = (
  releases: readonly GithubRelease[],
  currentVersion: string,
): AvailableUpdate | undefined => {
  let best: AvailableUpdate | undefined;
  for (const release of releases) {
    const version = TAG_REGEX.exec(release.tag_name)?.[1];
    if (release.draft || !version || !isNewerVersion(version, currentVersion)) {
      continue;
    }
    if (best && !isNewerVersion(version, best.version)) {
      continue;
    }
    const asset = release.assets.find((a) => a.name.toLowerCase().endsWith('.exe'));
    const sha256 = asset?.digest
      ? SHA256_DIGEST_REGEX.exec(asset.digest)?.[1]
      : undefined;
    if (!asset || !sha256) {
      continue;
    }
    best = {
      version,
      releaseUrl: release.html_url,
      assetName: asset.name,
      downloadUrl: asset.browser_download_url,
      size: asset.size,
      sha256,
    };
  }
  return best;
};

const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export const fetchAvailableUpdate = async (
  currentVersion: string,
  fetchFn: typeof fetch = fetch,
): Promise<AvailableUpdate | undefined> => {
  const response = await fetchFn(RELEASES_API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Release check failed: HTTP ${response.status}`);
  }
  const releases = (await response.json()) as unknown;
  if (!Array.isArray(releases)) {
    throw new Error('Release check failed: malformed response');
  }
  return pickUpdate(releases as GithubRelease[], currentVersion);
};

/**
 * Downloads the installer to `destPath`, hashing as it streams. The file only
 * appears at `destPath` once size and SHA-256 both match; a mismatch or a
 * broken connection leaves nothing behind that could be run.
 */
export const downloadUpdate = async (
  update: AvailableUpdate,
  destPath: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> => {
  const partialPath = `${destPath}.partial`;
  try {
    const response = await fetchFn(update.downloadUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Update download failed: HTTP ${response.status}`);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          bytes += chunk.length;
          if (bytes > update.size) {
            callback(new Error('Update download is larger than the release says'));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(partialPath),
    );
    if (bytes !== update.size) {
      throw new Error(`Update download truncated (${bytes} of ${update.size} bytes)`);
    }
    if (hash.digest('hex') !== update.sha256) {
      throw new Error('Update download failed its SHA-256 check');
    }
    renameSync(partialPath, destPath);
  } finally {
    rmSync(partialPath, { force: true });
  }
};
