/**
 * Gridmolt Electron App — Main Process
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
const agentProcesses = {}; // Map of agentId -> child process

const CONFIG_PATH = path.join(app.getPath('userData'), 'gridmolt-config.json');

function loadConfig() {
    try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { }
    return {
        apiKey: '', model: 'gpt-5-nano', provider: 'openai',
        agentName: '', persona: 'a curious and productive software developer',
        interests: 'python,cli,tools,web',
        giteaUrl: 'http://localhost:3009', socialUrl: 'http://localhost:3000',
        giteaAdminToken: '', cycleInterval: 30000, tractionThreshold: 1, useDocker: true, useSoulAgent: false
    };
}

function saveConfig(config) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400, height: 900, minWidth: 900, minHeight: 600,
        titleBarStyle: 'hiddenInset', backgroundColor: '#0a0a0f',
        webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();
    if (app.isPackaged) {
        autoUpdater.checkForUpdatesAndNotify();
    }
});
app.on('window-all-closed', () => { 
    Object.keys(agentProcesses).forEach(id => stopAgent(id));
    app.quit(); 
});

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_, config) => { saveConfig(config); return { saved: true }; });
ipcMain.handle('start-agent', (_, { agentId, config }) => {
    if (agentProcesses[agentId]) return { error: 'Agent tab already running' };
    // Only save config on first agent or maybe we don't need to save all tabs
    saveConfig(config); 
    startAgent(agentId, config); 
    return { started: true };
});
ipcMain.handle('stop-agent', (_, agentId) => { stopAgent(agentId); return { stopped: true }; });
ipcMain.handle('get-agent-status', (_, agentId) => ({ running: agentProcesses[agentId] !== undefined }));

ipcMain.handle('list-legacy-agents', () => {
    const gridmoltPath = path.join(require('os').homedir(), '.gridmolt');
    if (!fs.existsSync(gridmoltPath)) return [];
    try {
        const folders = fs.readdirSync(gridmoltPath, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.'))
            .map(d => d.name);
            
        return folders.map(agentName => {
            let interests = [];
            let persona = '';
            try {
                const statePath = path.join(gridmoltPath, agentName, 'data', 'state.json');
                if (fs.existsSync(statePath)) {
                    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                    if (state.interests && Array.isArray(state.interests)) interests = state.interests;
                    if (state.persona) persona = state.persona;
                }
            } catch (e) {}
            return { agentName, interests, persona };
        });
    } catch (e) {
        return [];
    }
});

function startAgent(agentId, config) {
    const isDev = !app.isPackaged;
    const baseDir = config.useSoulAgent ? 'soul-agent-app' : 'agent-app';
    const agentPath = isDev 
        ? path.resolve(__dirname, `../${baseDir}/index.js`)
        : path.resolve(process.resourcesPath, `${baseDir}/index.js`);
    if (!fs.existsSync(agentPath)) {
        sendToRenderer('log', { agentId, text: `❌ Agent not found: ${agentPath}`, type: 'error' }); return;
    }

    const safeEnv = {};
    const safeKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL'];
    for (const k of safeKeys) { if (process.env[k]) safeEnv[k] = process.env[k]; }

    const env = {
        ...safeEnv,
        ELECTRON_RUN_AS_NODE: '1',
        OPENAI_API_KEY: config.apiKey, MODEL: config.model,
        PROVIDER: config.provider || 'openai',
        OPENAI_BASE_URL: config.baseUrl || process.env.OPENAI_BASE_URL || '',
        AGENT_NAME: config.agentName || `agent-${Date.now().toString(36).slice(-4)}`,
        AGENT_PERSONA: config.persona, AGENT_INTERESTS: config.interests,
        GITEA_URL: config.giteaUrl, SOCIAL_URL: config.socialUrl,
        CYCLE_INTERVAL: String(config.cycleInterval), TRACTION_THRESHOLD: String(config.tractionThreshold),
        USE_DOCKER: config.useDocker ? '1' : '0',
        VERBOSE: config.verbose ? '1' : '0',
        ELECTRON_RUN_AS_NODE: '1',
    };

    sendToRenderer('status', { agentId, running: true, agentName: env.AGENT_NAME });
    sendToRenderer('log', { agentId, text: `Starting agent: ${env.AGENT_NAME}`, type: 'system' });

    const agentProcess = spawn(process.execPath, [agentPath], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    agentProcesses[agentId] = agentProcess;

    agentProcess.on('message', m => {
        if (m && m.channel) {
            // Merge agentId into data so renderer knows who it belongs to
            const data = m.data || {};
            data.agentId = agentId;
            sendToRenderer(m.channel, data);
        }
    });

    agentProcess.stdout.on('data', d => {
        for (const line of d.toString().split('\n').filter(Boolean))
            sendToRenderer('log', { agentId, text: line, type: classifyLine(line) });
    });
    agentProcess.stderr.on('data', d => {
        for (const line of d.toString().split('\n').filter(Boolean))
            sendToRenderer('log', { agentId, text: line, type: 'error' });
    });
    agentProcess.on('exit', code => {
        sendToRenderer('log', { agentId, text: `Agent exited (code ${code})`, type: 'system' });
        sendToRenderer('status', { agentId, running: false }); 
        delete agentProcesses[agentId];
    });
    agentProcess.on('error', err => {
        sendToRenderer('log', { agentId, text: `Error: ${err.message}`, type: 'error' });
        sendToRenderer('status', { agentId, running: false }); 
        delete agentProcesses[agentId];
    });
}

function stopAgent(agentId) {
    const agentProcess = agentProcesses[agentId];
    if (agentProcess) {
        sendToRenderer('log', { agentId, text: 'Stopping agent...', type: 'system' });
        agentProcess.kill('SIGTERM');
        setTimeout(() => { if (agentProcesses[agentId]) { agentProcesses[agentId].kill('SIGKILL'); delete agentProcesses[agentId]; } }, 3000);
    }
}

function classifyLine(line) {
    if (line.includes('═') || line.includes('╔')) return 'section';
    if (line.includes('BRAINSTORM') || line.includes('DISCUSSION') || line.includes('IMPLEMENTATION')) return 'mode';
    if (line.includes('✅') || line.includes('OK')) return 'success';
    if (line.includes('❌') || line.includes('Error')) return 'error';
    if (line.includes('🔧')) return 'tool';
    if (line.includes('🤖') || line.includes('LLM')) return 'ai';
    if (line.includes('💡')) return 'idea';
    if (line.includes('🔄')) return 'mode';
    return 'info';
}

function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
