/**
 * Electron main process for the agent.
 *
 * The agent itself is plain Node (`src/main.ts`) and stays that way — this file
 * is only the desktop shell: a tray icon, a status window, and a clean quit.
 * Keeping the split means the REST API can still be run on a server or in CI
 * with `node dist/main.js`, with no Electron anywhere in the picture.
 *
 * Deliberately thin. SuperSync is not wired up yet, so the window says so
 * rather than showing a settings form that does nothing.
 */
// Import order here is load-bearing and must not be "tidied" — it mirrors
// src/entry.ts, and both are required for the bundle to load at all:
//
//  1. `../platform/headless-globals-install` — app modules read `window` at
//     module-evaluation time (`app.constants.ts` runs `!!window.SUPAndroid` at
//     module scope), so the globals must exist before any of them is evaluated.
//     ES semantics hoist imports above statements, so an inline
//     `installHeadlessGlobals()` call would still run too late; it has to be a
//     separate module imported first.
//
//  2. `@angular/compiler` — `@ngrx/store` and `@angular/core` ship partially
//     compiled and fall back to the JIT compiler. A bundle is never AOT-linked,
//     so without it the first `@ngrx/store` import throws "needs to be compiled
//     using the JIT compiler".
//
// Getting this wrong fails SILENTLY and expensively: the throw happens while
// the bundle is being required, above app.whenReady() and outside the
// try/catch in it. The process dies with no tray, no window, no error dialog
// and no data directory — the app simply never appears to launch.
//  0. `../platform/agent-log-file` — FIRST, before anything that can throw, so
//     that a failure while evaluating the modules below is written to
//     bridge.log instead of vanishing into a Windows GUI process with no console.
//     Without it this app is undebuggable: it dies above app.whenReady() and
//     leaves no window, tray, dialog or data dir behind.
import '../platform/agent-log-file';
import '../platform/headless-globals-install';
import '@angular/compiler';

import { agentLogPath } from '../platform/agent-log-file';

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} from 'electron';
import { join } from 'node:path';
import { startAgent, type StartedAgent } from '../main';
import { loadSyncConfig, redactSyncConfig } from '../sync/sync-config';
import type { RendererSettings, SettingsSaveInput } from './preload';

let tray: Tray | null = null;
let statusWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let agent: StartedAgent | null = null;

const preloadPath = (): string => join(__dirname, 'preload.js');

const getOpenAtLogin = (): boolean => {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
};

const getRendererSettings = (): RendererSettings => {
  if (!agent) {
    throw new Error('Agent is not running');
  }
  const redacted = redactSyncConfig(loadSyncConfig(agent.dataDir));
  return {
    baseUrl: redacted.baseUrl ?? '',
    accessTokenSet: redacted.accessTokenSet,
    encryptKeySet: redacted.encryptKeySet,
    isEncryptionEnabled: redacted.isEncryptionEnabled,
    expiresAt: redacted.expiresAt,
    syncIntervalMs: redacted.syncIntervalMs,
    syncOnLocalChange: redacted.syncOnLocalChange,
    openAtLogin: getOpenAtLogin(),
  };
};

/**
 * Two copies of the agent would fight over the op log and the REST port: the
 * second would fail to bind, and both would append to the same JSONL. The lock
 * makes the second one quit instead.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // `app.quit()` is asynchronous: without exiting here the second instance
  // would keep running module scope, register `whenReady(startAgent)` and fight
  // the first instance over the REST port and `ops.jsonl`.
  app.quit();
  process.exit(0);
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const STATUS_HTML = (
  restUrl: string,
  token: string,
  dataDir: string,
  syncSummary: string,
): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
    <title>SP Bridge</title>
    <style>
      body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 20px; }
      h1 { font-size: 16px; margin: 0 0 4px; }
      p.sub { margin: 0 0 18px; color: #666; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; }
      dt { color: #666; }
      dd { margin: 0; font-family: ui-monospace, monospace; word-break: break-all; }
      .warn { margin-top: 18px; padding: 10px; background: #fff4e5; border-radius: 4px; }
      .okmsg { margin-top: 18px; padding: 10px; background: #e8f5e9; border-radius: 4px; }
      button { margin-top: 6px; }
    </style>
  </head>
  <body>
    <h1>SP Bridge</h1>
    <p class="sub">Serving the Super Productivity local REST API.</p>
    <dl>
      <dt>API</dt><dd>${escapeHtml(restUrl)}</dd>
      <dt>Token</dt><dd>${escapeHtml(token)}</dd>
      <dt>Data</dt><dd>${escapeHtml(dataDir)}</dd>
    </dl>
    ${syncSummary}
    <button id="copy">Copy API URL and token</button>
    <button id="settings">Settings</button>
    <script>
      const text = ${JSON.stringify(`${restUrl}\n${token}`)};
      document.getElementById('copy').addEventListener('click', () => {
        navigator.clipboard.writeText(text);
        document.getElementById('copy').textContent = 'Copied';
      });
      document.getElementById('settings').addEventListener('click', () => {
        if (window.spBridge) {
          window.spBridge.openSettings();
        }
      });
    </script>
  </body>
</html>`;

const SETTINGS_HTML = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
    <title>SP Bridge Settings</title>
    <style>
      body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 20px; max-width: 520px; }
      h1 { font-size: 16px; margin: 0 0 12px; }
      label { display: block; margin: 10px 0 2px; color: #444; }
      input[type=text], input[type=password], input[type=number] { width: 100%; box-sizing: border-box; padding: 6px; }
      .row { margin: 10px 0; }
      .hint { color: #666; font-size: 12px; }
      #error { color: #a00; margin-top: 10px; min-height: 1.2em; }
      #saved { color: #060; margin-top: 10px; min-height: 1.2em; }
    </style>
  </head>
  <body>
    <h1>SP Bridge Settings</h1>
    <label for="baseUrl">SuperSync server URL</label>
    <input id="baseUrl" type="text" placeholder="default: https://sync.super-productivity.com" />
    <label for="accessToken">Access token</label>
    <input id="accessToken" type="password" placeholder="(unchanged when blank)" autocomplete="off" />
    <label for="masterPassword">Master password (encryption)</label>
    <input id="masterPassword" type="password" placeholder="(unchanged when blank)" autocomplete="off" />
    <div class="hint">Set once: it is stored as the encryption key, never as a password.</div>
    <label for="syncIntervalMs">Sync interval (ms, 0 = manual only)</label>
    <input id="syncIntervalMs" type="number" min="0" step="1000" placeholder="60000" />
    <div class="row"><label><input id="syncOnLocalChange" type="checkbox" /> Sync shortly after local changes</label></div>
    <div class="row"><label><input id="openAtLogin" type="checkbox" /> Start SP Bridge when I log in</label></div>
    <button id="save">Save</button>
    <div id="error"></div>
    <div id="saved"></div>
    <script>
      const $ = (id) => document.getElementById(id);
      const fail = (message) => { $('error').textContent = message; $('saved').textContent = ''; };
      const api = window.spBridge;
      if (!api) {
        fail('Settings bridge is unavailable in this window.');
      } else {
        api.getSettings().then(({ settings }) => {
          $('baseUrl').value = settings.baseUrl || '';
          $('syncIntervalMs').value =
            settings.syncIntervalMs === undefined || settings.syncIntervalMs === null
              ? ''
              : String(settings.syncIntervalMs);
          $('syncOnLocalChange').checked = settings.syncOnLocalChange !== false;
          $('openAtLogin').checked = settings.openAtLogin === true;
        }).catch((error) => fail(String((error && error.message) || error)));
        $('save').addEventListener('click', () => {
          fail('');
          const intervalRaw = $('syncIntervalMs').value.trim();
          const input = {
            baseUrl: $('baseUrl').value.trim() || undefined,
            accessToken: $('accessToken').value || undefined,
            masterPassword: $('masterPassword').value || undefined,
            syncIntervalMs: intervalRaw === '' ? undefined : Number(intervalRaw),
            syncOnLocalChange: $('syncOnLocalChange').checked,
            openAtLogin: $('openAtLogin').checked,
          };
          if (input.syncIntervalMs !== undefined && !Number.isFinite(input.syncIntervalMs)) {
            fail('Sync interval must be a number.');
            return;
          }
          api.saveSettings(input).then((result) => {
            if (result.ok) {
              $('saved').textContent = 'Saved. Sync engine recycled.';
              $('accessToken').value = '';
              $('masterPassword').value = '';
            } else {
              fail(result.error);
            }
          }).catch((error) => fail(String((error && error.message) || error)));
        });
      }
    </script>
  </body>
</html>`;

const showSettingsWindow = (): void => {
  if (!agent) {
    return;
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 640,
    title: 'SP Bridge Settings',
    webPreferences: {
      // No Node in the renderer; the preload exposes exactly the settings API.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  settingsWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(SETTINGS_HTML())}`,
  );
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
};

/**
 * Live sync summary for the status window. Reads the engine at open time, so
 * the window never shows a stale build banner: unconfigured bridges get the
 * setup pointer, healthy ones get last-sync/pending, and failed ones get the
 * classified reason plus where to look.
 */
const syncSummaryHtml = (): string => {
  const engine = agent?.sync;
  if (!engine) {
    return `<p class="warn">SuperSync is not configured. Open Settings to add
      a server URL and access token.</p>`;
  }
  const status = engine.status();
  const lastSync =
    status.lastSyncAt === null ? 'never' : new Date(status.lastSyncAt).toLocaleString();
  const state = status.lastErrorCode
    ? `last error: ${escapeHtml(status.lastErrorCode)}`
    : 'healthy';
  const tone = status.lastErrorCode ? 'warn' : 'okmsg';
  return `<p class="${tone}">SuperSync enabled. Last sync: ${escapeHtml(lastSync)};
    pending upload: ${status.pendingUpload}; ${state}.</p>`;
};

const showStatusWindow = (): void => {
  if (!agent) {
    return;
  }
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.focus();
    return;
  }
  const address = agent.server.address();
  const restUrl = `http://${address?.host}:${address?.port}`;
  statusWindow = new BrowserWindow({
    width: 560,
    height: 420,
    title: 'SP Bridge',
    webPreferences: {
      // The window only renders a local string; no remote content, no Node.
      // The preload exposes exactly the settings opener for the button above.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  statusWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      STATUS_HTML(restUrl, agent.server.token, agent.dataDir, syncSummaryHtml()),
    )}`,
  );
  statusWindow.on('closed', () => {
    statusWindow = null;
  });
};

const buildTray = (): void => {
  // 16x16 keeps the tray light; the same file also serves as the installer icon
  // at 256x256 (electron-builder scales, and Windows scales tray icons anyway).
  const iconPath = join(__dirname, 'icon.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('SP Bridge');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show status', click: showStatusWindow },
      { label: 'Settings…', click: showSettingsWindow },
      {
        label: 'Copy API URL + token',
        click: () => {
          if (!agent) {
            return;
          }
          const address = agent.server.address();
          clipboard.writeText(
            `http://${address?.host}:${address?.port}\n${agent.server.token}`,
          );
        },
      },
      {
        label: 'Open data folder',
        click: () => {
          if (agent) {
            void shell.openPath(agent.dataDir);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showStatusWindow);
};

app.on('second-instance', showStatusWindow);

/**
 * Settings IPC: the renderer's whole world is `window.spBridge` (see
 * preload.ts). Secrets never cross it — reads are redacted, writes take
 * blank-means-unchanged, and validation errors come back as data, not
 * throws, so the form can show them inline.
 */
ipcMain.handle('sp-bridge:get-settings', () => {
  try {
    return { ok: true as const, settings: getRendererSettings() };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle(
  'sp-bridge:save-settings',
  (
    _event,
    input: SettingsSaveInput,
  ): { ok: true; settings: RendererSettings } | { ok: false; error: string } => {
    if (!agent) {
      return { ok: false, error: 'Agent is not running' };
    }
    try {
      const patch: Record<string, unknown> = {};
      if (input.baseUrl !== undefined) patch['baseUrl'] = input.baseUrl;
      if (input.accessToken) patch['accessToken'] = input.accessToken;
      if (input.masterPassword) patch['masterPassword'] = input.masterPassword;
      if (input.syncIntervalMs !== undefined)
        patch['syncIntervalMs'] = input.syncIntervalMs;
      if (input.syncOnLocalChange !== undefined)
        patch['syncOnLocalChange'] = input.syncOnLocalChange;
      agent.updateSyncConfig(patch);
      try {
        app.setLoginItemSettings({ openAtLogin: input.openAtLogin === true });
      } catch (error) {
        console.warn('[bridge] Could not update login item settings', error);
      }
      return { ok: true, settings: getRendererSettings() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

ipcMain.handle('sp-bridge:open-settings', () => {
  showSettingsWindow();
});

// Anything that escapes the try/catch below used to be invisible: no window, no
// tray, no dialog, no log. The console is teed to bridge.log (imported first
// above), so recording it here is enough to make the failure diagnosable.
process.on('uncaughtException', (error: Error) => {
  console.error('[bridge] Uncaught exception:', error);
  dialogError(error);
  app.quit();
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[bridge] Unhandled promise rejection:', reason);
});

app.whenReady().then(async () => {
  try {
    agent = await startAgent();
  } catch (error) {
    // Surface it instead of dying silently: a background app that fails to
    // start with no window and no tray is indistinguishable from one that is
    // simply not running.
    dialogError(error);
    app.quit();
    return;
  }
  buildTray();
  showStatusWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      showStatusWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Tray-only: closing the window must not quit the agent, or the REST API
  // would go away with it.
});

app.on('before-quit', (event) => {
  tray?.destroy();
  tray = null;
  const stopping = agent;
  agent = null;
  if (stopping) {
    // `server.close()` is async (keep-alive sockets); quitting immediately
    // would abandon it mid-close and leave the op-log fd unflushed on a bad
    // day. Hold the quit until stop settles, then exit for real (`app.exit`
    // does not re-fire `before-quit`, so this cannot loop).
    event.preventDefault();
    void stopping.stop().finally(() => app.exit(0));
  }
});

const dialogError = (error: unknown): void => {
  const logPath = agentLogPath();
  dialog.showErrorBox(
    'SP Bridge failed to start',
    [
      error instanceof Error ? error.message : String(error),
      logPath ? `\n\nA log was written to:\n${logPath}` : '',
    ].join(''),
  );
};
