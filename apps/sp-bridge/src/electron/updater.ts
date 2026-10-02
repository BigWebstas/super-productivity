/**
 * Desktop half of the auto-updater: when to check, where the installer goes,
 * and handing over to it. Release selection and the verified download live in
 * `../update/update-check.ts`.
 *
 * Flow: check shortly after start and then periodically; a newer release is
 * downloaded in the background and verified; the user is told and installs it
 * from the tray (or the notification). Installing never happens unasked — the
 * bridge serves a REST API other tools depend on, so a restart is the user's
 * call.
 */
import { app, Notification } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  downloadUpdate,
  fetchAvailableUpdate,
  type AvailableUpdate,
} from '../update/update-check';

const FIRST_CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'downloading'; version: string }
  | { kind: 'ready'; version: string; installerPath: string }
  | { kind: 'error'; message: string };

/** Packaged Windows builds only: dev runs and other platforms have no NSIS installer to run. */
export const isAutoUpdateSupported = (): boolean =>
  app.isPackaged && process.platform === 'win32';

export class BridgeUpdater {
  private _state: UpdateState = { kind: 'idle' };
  private _timers: NodeJS.Timeout[] = [];

  constructor(private readonly _onChange: (state: UpdateState) => void) {}

  get state(): UpdateState {
    return this._state;
  }

  start(): void {
    this._timers.push(
      setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS),
      setInterval(() => void this.check(), CHECK_INTERVAL_MS),
    );
  }

  stop(): void {
    this._timers.forEach((timer) => clearTimeout(timer));
    this._timers = [];
  }

  /** Checks and, when newer, downloads. Safe to call repeatedly. */
  async check(): Promise<void> {
    if (this._state.kind === 'checking' || this._state.kind === 'downloading') {
      return;
    }
    const readyVersion = this._state.kind === 'ready' ? this._state.version : undefined;
    this._set({ kind: 'checking' });
    try {
      const update = await fetchAvailableUpdate(readyVersion ?? app.getVersion());
      if (!update) {
        this._restoreAfterCheck(readyVersion);
        console.log(`[update] up to date (${readyVersion ?? app.getVersion()})`);
        return;
      }
      await this._download(update);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[update] check failed', { message });
      this._set({ kind: 'error', message });
    }
  }

  /** Runs the downloaded installer silently and quits; it restarts the bridge when done. */
  install(): void {
    if (this._state.kind !== 'ready') {
      return;
    }
    console.log(`[update] installing ${this._state.version}`);
    // electron-builder NSIS flags: /S silent, --updated marks an update run,
    // --force-run relaunches the app after a silent install.
    spawn(this._state.installerPath, ['/S', '--updated', '--force-run'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    app.quit();
  }

  private async _download(update: AvailableUpdate): Promise<void> {
    this._set({ kind: 'downloading', version: update.version });
    const dir = join(app.getPath('temp'), 'sp-bridge-update');
    mkdirSync(dir, { recursive: true });
    // Named from the validated version, never from the remote asset name.
    const installerPath = join(dir, `sp-bridge-setup-${update.version}.exe`);
    if (!existsSync(installerPath)) {
      console.log(`[update] downloading ${update.version}`);
      await downloadUpdate(update, installerPath);
    }
    this._set({ kind: 'ready', version: update.version, installerPath });
    console.log(`[update] ${update.version} ready to install`);
    const notification = new Notification({
      title: 'SP Bridge update ready',
      body: `Version ${update.version} is downloaded. Click to restart and install.`,
    });
    notification.on('click', () => this.install());
    notification.show();
  }

  private _restoreAfterCheck(readyVersion: string | undefined): void {
    // A check finding nothing newer than an already-downloaded update must not
    // forget that update.
    if (readyVersion) {
      const installerPath = join(
        app.getPath('temp'),
        'sp-bridge-update',
        `sp-bridge-setup-${readyVersion}.exe`,
      );
      this._set({ kind: 'ready', version: readyVersion, installerPath });
    } else {
      this._set({ kind: 'idle' });
    }
  }

  private _set(state: UpdateState): void {
    this._state = state;
    this._onChange(state);
  }
}
