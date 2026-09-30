/**
 * Access token for the local REST API.
 *
 * Ported from `electron/local-rest-api.ts`, with the POSIX-specific parts
 * dropped. The original guards a 0600 file because on Linux/macOS any local
 * account could otherwise read the token; on Windows the equivalent is the ACL
 * the file inherits from the user profile, and `statSync` reports a synthesised
 * mode that says nothing about it — the original code short-circuits to "fine"
 * there for exactly that reason. So the agent keeps the same token *format*,
 * the same unbiased generation, and the same atomic write, and does not pretend
 * to enforce a mode Windows does not have.
 *
 * The token is deliberately NOT part of the synced state. It authenticates a
 * loopback server that exists on one machine; syncing it would push an
 * authentication secret into the op-log and out to every other device.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_LENGTH = 32;
/**
 * Largest multiple of the alphabet size that fits in a byte. Bytes at or above
 * it are discarded rather than folded in with `%`, which would make the first
 * `256 % 62` characters slightly more likely than the rest.
 */
const MAX_UNBIASED_BYTE = Math.floor(256 / TOKEN_ALPHABET.length) * TOKEN_ALPHABET.length;
/** Alphanumeric so it survives being pasted into a shell without quoting. */
const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9]{${TOKEN_LENGTH}}$`);

const generateToken = (): string => {
  let token = '';
  while (token.length < TOKEN_LENGTH) {
    for (const byte of randomBytes(TOKEN_LENGTH)) {
      if (byte >= MAX_UNBIASED_BYTE) {
        continue;
      }
      token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
      if (token.length === TOKEN_LENGTH) {
        break;
      }
    }
  }
  return token;
};

export class AccessTokenStore {
  private readonly _filePath: string;
  private _token: string | undefined;

  constructor(dataDir: string) {
    this._filePath = join(dataDir, 'local-rest-api-token');
  }

  /**
   * The active token, generating and persisting one on first use.
   *
   * A persisted token that does not match `TOKEN_PATTERN` is treated as absent:
   * a truncated or corrupted file must not silently become the live credential.
   */
  get(): string {
    if (this._token) {
      return this._token;
    }
    this._token = this._readPersisted() ?? this._create();
    return this._token;
  }

  /**
   * Mints a new token, revoking the previous one.
   *
   * Persists before swapping: regeneration is the revocation path, so the new
   * token must only go live once it is on disk. Swapping first would let a
   * failed write leave the OLD token on disk and bring it back on the next
   * launch, silently breaking the immediate-revocation guarantee.
   */
  regenerate(): string {
    const token = this._create();
    this._token = token;
    return token;
  }

  private _readPersisted(): string | undefined {
    try {
      const token = readFileSync(this._filePath, 'utf8').trim();
      if (!TOKEN_PATTERN.test(token)) {
        console.warn(
          '[access-token] Ignoring malformed token file — generating a new one',
        );
        return undefined;
      }
      return token;
    } catch {
      // No file yet, or unreadable. Both mean "mint a new one".
      return undefined;
    }
  }

  /**
   * Writes the token atomically: a temp file with a random name, then a rename.
   *
   * The random suffix matters beyond tidiness — a predictable temp name in a
   * directory another local account can write to is a pre-plantable symlink
   * target, and `'w'` would follow it. `'wx'` alone would then wedge on a
   * leftover temp from a hard kill, which the random name makes unreachable in
   * practice. The trade is that a hard kill inside the window can orphan a temp
   * file, which no later run reclaims.
   */
  private _create(): string {
    const token = generateToken();
    const tmpPath = `${this._filePath}.${randomBytes(8).toString('hex')}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmpPath, 'wx', 0o600);
      writeFileSync(fd, token, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmpPath, this._filePath);
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Already failing; nothing useful left to do with the descriptor.
        }
      }
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best effort.
      }
      // Thrown rather than swallowed: the caller must never end up serving a
      // token that is not durably stored, because it would die on next launch.
      throw error;
    }
    void dirname;
    return token;
  }
}
