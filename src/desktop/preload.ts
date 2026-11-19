import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, UpdateStatus } from '../shared/contracts';
import type { DeploymentEvent } from '../shared/deployment';

const desktop: DesktopApi = {
  deployment: {
    importDevices: () => ipcRenderer.invoke('deployment-import-devices'),
    importScript: () => ipcRenderer.invoke('deployment-import-script'),
    releaseScript: id => ipcRenderer.invoke('deployment-release-script', id),
    addKey: (alias, passphrase) => ipcRenderer.invoke('deployment-add-key', alias, passphrase),
    download: kind => ipcRenderer.invoke('deployment-download', kind),
    test: concurrency => ipcRenderer.invoke('deployment-test', concurrency),
    trust: (id, fingerprint) => ipcRenderer.invoke('deployment-trust', id, fingerprint),
    run: plan => ipcRenderer.invoke('deployment-run', plan),
    cancel: () => ipcRenderer.invoke('deployment-cancel'),
    reset: () => ipcRenderer.invoke('deployment-reset'),
    history: () => ipcRenderer.invoke('deployment-history'),
    reveal: id => ipcRenderer.invoke('deployment-reveal', id),
    onEvent: listener => {
      const forward = (_event: Electron.IpcRendererEvent, event: DeploymentEvent) => listener(event);
      ipcRenderer.on('deployment-event', forward);
      return () => { ipcRenderer.removeListener('deployment-event', forward); };
    },
  },
  pickFile: () => ipcRenderer.invoke('pick-file'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  release: id => ipcRenderer.invoke('release', id),
  run: request => ipcRenderer.invoke('run', request),
  page: offset => ipcRenderer.invoke('page', offset),
  routePage: (offset, filter) => ipcRenderer.invoke('route-page', offset, filter),
  clearResults: () => ipcRenderer.invoke('clear-results'),
  cancel: () => ipcRenderer.invoke('cancel'),
  brands: () => ipcRenderer.invoke('brands'),
  knowledge: brand => ipcRenderer.invoke('knowledge', brand),
  chooseRule: (brand, id) => ipcRenderer.invoke('choose-rule', brand, id),
  chooseRuleBatch: (brand, id, preference) => ipcRenderer.invoke('choose-rule-batch', brand, id, preference),
  updateStatus: () => ipcRenderer.invoke('update-status'),
  configureUpdate: value => ipcRenderer.invoke('update-configure', value),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  downloadUpdate: () => ipcRenderer.invoke('update-download'),
  pauseUpdate: () => ipcRenderer.invoke('update-pause'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdateStatus: listener => {
    const forward = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
    ipcRenderer.on('update-event', forward);
    return () => { ipcRenderer.removeListener('update-event', forward); };
  },
  history: () => ipcRenderer.invoke('history'),
  settings: () => ipcRenderer.invoke('settings'),
  saveSettings: (settings, keyChange) => ipcRenderer.invoke('settings-save', settings, keyChange),
  previewAi: request => ipcRenderer.invoke('ai-preview', request),
  aiPreviewBatch: (id, index) => ipcRenderer.invoke('ai-preview-batch', id, index),
  sendAi: id => ipcRenderer.invoke('ai-send', id),
  onProgress: listener => {
    const forward = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on('progress', forward);
    return () => { ipcRenderer.removeListener('progress', forward); };
  },
};
contextBridge.exposeInMainWorld('nettools', desktop);
