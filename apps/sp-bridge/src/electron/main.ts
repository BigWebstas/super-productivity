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

import { agentLogPath, readLogTail } from '../platform/agent-log-file';

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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startAgent, type StartedAgent } from '../main';
import { loadSyncConfig, redactSyncConfig } from '../sync/sync-config';
import type {
  RendererAppInfo,
  RendererSettings,
  RendererStatus,
  RendererSyncResult,
  SettingsSaveInput,
} from './preload';

let tray: Tray | null = null;
let statusWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let logWindow: BrowserWindow | null = null;
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

const getHtmlPath = (filename: string): string => {
  const inDir = join(__dirname, filename);
  if (existsSync(inDir)) return inDir;
  const inSrc = join(__dirname, '../../src/electron', filename);
  if (existsSync(inSrc)) return inSrc;
  return inDir;
};

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
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  settingsWindow.loadFile(getHtmlPath('settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
};

const showLogWindow = (): void => {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.focus();
    return;
  }
  logWindow = new BrowserWindow({
    width: 760,
    height: 480,
    title: 'SP Bridge Log',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  logWindow.loadFile(getHtmlPath('log.html'));
  logWindow.on('closed', () => {
    logWindow = null;
  });
};

const showStatusWindow = (): void => {
  if (!agent) {
    return;
  }
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.focus();
    return;
  }
  statusWindow = new BrowserWindow({
    width: 560,
    height: 420,
    title: 'SP Bridge',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  statusWindow.loadFile(getHtmlPath('status.html'));
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
      { label: 'View log', click: showLogWindow },
      { type: 'separator' },
      {
        label: 'Sync now',
        click: () => {
          if (agent) {
            void agent.triggerSync().catch((err: unknown) => {
              console.warn('[bridge] Tray sync failed', err);
            });
          }
        },
      },
      {
        label: 'Resync from server',
        click: () => {
          if (agent) {
            void agent.resync().catch((err: unknown) => {
              console.warn('[bridge] Tray resync failed', err);
            });
          }
        },
      },
      { type: 'separator' },
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
 * Minimal application menu: the default Electron menu would offer window and
 * help entries that make no sense for a tray-first background app, so only
 * File (settings, quit), Sync (sync now, resync from server) and View (the three windows,
 * devtools for diagnostics) are kept. The log viewer lives under View.
 */
const buildAppMenu = (): void => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Settings…', click: showSettingsWindow },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Sync',
        submenu: [
          {
            label: 'Sync now',
            accelerator: 'CmdOrCtrl+Shift+S',
            click: () => {
              if (agent) {
                void agent.triggerSync().catch((err: unknown) => {
                  console.warn('[bridge] Menu sync failed', err);
                });
              }
            },
          },
          {
            label: 'Resync from server',
            click: () => {
              if (agent) {
                void agent.resync().catch((err: unknown) => {
                  console.warn('[bridge] Menu resync failed', err);
                });
              }
            },
          },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Status', click: showStatusWindow },
          { label: 'Log', accelerator: 'CmdOrCtrl+L', click: showLogWindow },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
        ],
      },
    ]),
  );
};

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

ipcMain.handle('sp-bridge:open-log', () => {
  showLogWindow();
});

ipcMain.handle('sp-bridge:read-log', (): string[] => readLogTail(300));

ipcMain.handle(
  'sp-bridge:sync',
  async (): Promise<
    { ok: true; result: RendererSyncResult } | { ok: false; error: string }
  > => {
    if (!agent) {
      return { ok: false, error: 'Agent is not running' };
    }
    try {
      const res = await agent.triggerSync();
      return {
        ok: true,
        result: {
          downloaded: res.downloaded,
          applied: res.applied,
          uploaded: res.uploaded,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

ipcMain.handle(
  'sp-bridge:resync',
  async (): Promise<
    { ok: true; result: RendererSyncResult } | { ok: false; error: string }
  > => {
    if (!agent) {
      return { ok: false, error: 'Agent is not running' };
    }
    try {
      const res = await agent.resync();
      return {
        ok: true,
        result: {
          downloaded: res.downloaded,
          applied: res.applied,
          uploaded: res.uploaded,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

ipcMain.handle('sp-bridge:get-info', (): RendererAppInfo => {
  const address = agent?.server.address();
  return {
    restUrl: address ? `http://${address.host}:${address.port}` : '',
    token: agent?.server.token ?? '',
    dataDir: agent?.dataDir ?? '',
  };
});

ipcMain.handle('sp-bridge:copy-text', (_event, text: string) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('sp-bridge:get-status', (): RendererStatus => {
  const engine = agent?.sync;
  const status = engine?.status();
  const state = agent?.store.state as unknown as {
    projects?: { ids?: string[]; entities?: Record<string, unknown> };
    project?: { ids?: string[]; entities?: Record<string, unknown> };
    tag?: { ids?: string[]; entities?: Record<string, unknown> };
    tags?: { ids?: string[]; entities?: Record<string, unknown> };
    tasks?: { ids?: string[]; entities?: Record<string, unknown> };
    task?: { ids?: string[]; entities?: Record<string, unknown> };
  };
  const taskMap = (state?.tasks?.entities || state?.task?.entities || {}) as Record<
    string,
    { projectId?: string | null; tagIds?: string[] }
  >;
  const projSet = new Set(
    Object.keys(state?.projects?.entities || state?.project?.entities || {}),
  );
  const tagSet = new Set(
    Object.keys(state?.tag?.entities || state?.tags?.entities || {}),
  );
  for (const t of Object.values(taskMap)) {
    if (t.projectId && t.projectId !== 'INBOX' && t.projectId !== 'INBOX_PROJECT') {
      projSet.add(t.projectId);
    }
    if (Array.isArray(t.tagIds)) {
      for (const tid of t.tagIds) {
        if (tid && tid !== 'TODAY') {
          tagSet.add(tid);
        }
      }
    }
  }
  const projectCount = projSet.size;
  const tagCount = tagSet.size;
  const taskCount = Object.keys(taskMap).length;

  return {
    lastSyncAt: status?.lastSyncAt ?? null,
    lastErrorCode: status?.lastErrorCode ?? null,
    pendingUpload: status?.pendingUpload ?? agent?.opLog.pendingUpload().length ?? 0,
    syncEnabled: !!engine,
    projectCount,
    taskCount,
    tagCount,
  };
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
  buildAppMenu();
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
