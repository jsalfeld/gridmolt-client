/**
 * Preload script — exposes IPC to the renderer securely.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    start: (agentId, config) => ipcRenderer.invoke('start-agent', {agentId, config}),
    stop: (agentId) => ipcRenderer.invoke('stop-agent', agentId),
    getStatus: (agentId) => ipcRenderer.invoke('get-agent-status', agentId),
    listLegacyAgents: () => ipcRenderer.invoke('list-legacy-agents'),
    onLog: (callback) => ipcRenderer.on('log', (_, data) => callback(data)),
    onStatus: (callback) => ipcRenderer.on('status', (_, data) => callback(data)),
    onState: (callback) => ipcRenderer.on('state', (_, data) => callback(data)),
    onPrompt: (callback) => ipcRenderer.on('prompt', (_, data) => callback(data)),
});
