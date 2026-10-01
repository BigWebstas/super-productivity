/**
 * Preload bridge for the desktop shell's windows.
 *
 * Runs with Electron privileges and exposes a minimal, promise-based settings
 * API to the otherwise unprivileged renderer (no Node, no ipcRenderer
 * handle). Only ever carries the REDACTED config — secrets stay in the main
 * process and are blank-on-the-wire in both directions (blank means
 * "unchanged" on save).
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface RendererSettings {
  baseUrl: string;
  accessTokenSet: boolean;
  encryptKeySet: boolean;
  isEncryptionEnabled?: boolean;
  expiresAt?: number;
  syncIntervalMs?: number;
  syncOnLocalChange?: boolean;
  openAtLogin: boolean;
}

export interface SettingsSaveInput {
  baseUrl?: string;
  accessToken?: string;
  masterPassword?: string;
  syncIntervalMs?: number;
  syncOnLocalChange?: boolean;
  openAtLogin?: boolean;
}

export interface RendererSyncResult {
  downloaded: number;
  applied: number;
  uploaded: number;
}

export interface RendererBridgeApi {
  getSettings: () => Promise<{ ok: true; settings: RendererSettings }>;
  saveSettings: (
    input: SettingsSaveInput,
  ) => Promise<{ ok: true; settings: RendererSettings } | { ok: false; error: string }>;
  openSettings: () => Promise<void>;
  openLog: () => Promise<void>;
  readLog: () => Promise<string[]>;
  triggerSync: () => Promise<
    { ok: true; result: RendererSyncResult } | { ok: false; error: string }
  >;
  resync: () => Promise<
    { ok: true; result: RendererSyncResult } | { ok: false; error: string }
  >;
}

const api: RendererBridgeApi = {
  getSettings: () => ipcRenderer.invoke('sp-bridge:get-settings'),
  saveSettings: (input: SettingsSaveInput) =>
    ipcRenderer.invoke('sp-bridge:save-settings', input),
  openSettings: () => ipcRenderer.invoke('sp-bridge:open-settings'),
  openLog: () => ipcRenderer.invoke('sp-bridge:open-log'),
  readLog: () => ipcRenderer.invoke('sp-bridge:read-log'),
  triggerSync: () => ipcRenderer.invoke('sp-bridge:sync'),
  resync: () => ipcRenderer.invoke('sp-bridge:resync'),
};

contextBridge.exposeInMainWorld('spBridge', api);
