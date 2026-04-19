/**
 * Gridmolt Electron — Renderer (Multi-Agent Support)
 */

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const tabsList = $('agent-tabs');
const btnAddAgent = $('btn-add-agent');
const viewNetwork = $('view-network');
const viewAgents = $('view-agents');
const template = $('agent-workspace-template');

let agentCounter = 0;
let activeTabId = null;
const agents = {}; // Maps agentId -> { dom, stats, logs, config state }

// ─── TABS MANAGEMENT ───

function switchTab(tabId) {
    if (!tabId) return;
    activeTabId = tabId;
    $$('.tab-btn').forEach(btn => btn.classList.remove('active'));
    
    const targetTab = $(`tab-${tabId}`);
    if (targetTab) targetTab.classList.add('active');

    viewAgents.classList.add('active');
    $$('.agent-workspace').forEach(ws => ws.classList.remove('active'));
    if (agents[tabId]) agents[tabId].dom.container.classList.add('active');
}

function createAgentTab() {
    agentCounter++;
    const agentId = `agent-${agentCounter}`;
    
    // Create Tab Button
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.id = `tab-${agentId}`;
    btn.innerHTML = `Agent ${agentCounter} <span class="close-btn" data-id="${agentId}">×</span>`;
    btn.addEventListener('click', (e) => {
        if (e.target.classList.contains('close-btn')) {
            closeAgentTab(agentId);
        } else {
            switchTab(agentId);
        }
    });
    tabsList.appendChild(btn);

    // Create Workspace DOM
    const clone = template.content.cloneNode(true);
    const container = clone.querySelector('.agent-workspace');
    container.id = `workspace-${agentId}`;
    viewAgents.appendChild(container);

    // Initialize State
    agents[agentId] = {
        id: agentId,
        dom: setupWorkspaceDOM(container, agentId),
        stats: { cycles: 0, ideas: 0, tools: 0 },
        logs: [],
        currentMode: '—',
        currentFilter: 'all',
        currentInterests: [],
        running: false
    };

    // Load Default Config
    loadConfigFor(agentId);
    switchTab(agentId);
}

function closeAgentTab(agentId) {
    if (agents[agentId].running) {
        window.agent.stop(agentId);
    }
    const tabEl = $(`tab-${agentId}`);
    if (tabEl) tabEl.remove();
    const wsEl = agents[agentId].dom.container;
    if (wsEl) wsEl.remove();
    delete agents[agentId];
    const remaining = Object.keys(agents);
    if (remaining.length > 0) {
        switchTab(remaining[0]);
    } else {
        activeTabId = null;
    }
}

// ─── WORKSPACE SETUP ───

function setupWorkspaceDOM(container, agentId) {
    const q = (sel) => container.querySelector(sel);
    const qa = (sel) => container.querySelectorAll(sel);

    const dom = {
        container,
        navBtns: qa('.nav-btn'),
        panels: qa('main.panel'),
        
        apiKey: q('.apiKey'), model: q('.model'), provider: q('.provider'), baseUrl: q('.baseUrl'),
        agentName: q('.agentName'), persona: q('.persona'), interests: q('.interests'),
        giteaUrl: q('.giteaUrl'), socialUrl: q('.socialUrl'),
        cycleInterval: q('.cycleInterval'), tractionThreshold: q('.tractionThreshold'),
        useDocker: q('.useDocker'), verbose: q('.verbose'), useSoulAgent: q('.useSoulAgent'),
        
        btnStart: q('.btn-start'), btnStop: q('.btn-stop'), 
        statusDot: q('.status-dot'), statusText: q('.status-text'),
        repBadge: q('.rep-badge'), repScore: q('.rep-score'),
        agentDropdown: q('.agent-dropdown'),

        statMode: q('.stat-mode'), statCycle: q('.stat-cycle'), 
        statIdeas: q('.stat-ideas'), statTools: q('.stat-tools'),
        logContainer: q('.log-container'), btnClear: q('.btn-clear'),
        autoscroll: q('.autoscroll'), filterBtns: qa('.filter-btn'),

        stateDisplay: q('.state-display'),
        promptEmpty: q('.prompt-empty'),
        promptContent: q('.prompt-content'),
        promptSystem: q('.prompt-system'),
        promptUser: q('.prompt-user')
    };

    // Sidebar Nav
    dom.navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            dom.navBtns.forEach(b => b.classList.remove('active'));
            dom.panels.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            q(`.panel-${btn.dataset.panel}`).classList.add('active');
        });
    });

    // Auto-Discovery Dropdown
    if (dom.agentDropdown) {
        window.agent.listLegacyAgents().then(list => {
            list.forEach(a => {
                const opt = document.createElement('option');
                opt.value = JSON.stringify(a);
                opt.textContent = a.agentName;
                dom.agentDropdown.appendChild(opt);
            });
        });
        
        dom.agentDropdown.addEventListener('change', (e) => {
            if (!e.target.value) return;
            try {
                const legacy = JSON.parse(e.target.value);
                dom.agentName.value = legacy.agentName;
                if (legacy.persona) dom.persona.value = legacy.persona;
                if (legacy.interests && legacy.interests.length > 0) {
                    dom.interests.value = legacy.interests.join(', ');
                }
                
                dom.agentName.style.borderColor = 'var(--accent-bright)';
                dom.interests.style.borderColor = 'var(--accent-bright)';
                dom.persona.style.borderColor = 'var(--accent-bright)';
                setTimeout(() => {
                    dom.agentName.style.borderColor = '';
                    dom.interests.style.borderColor = '';
                    dom.persona.style.borderColor = '';
                }, 1500);
            } catch(err) {}
        });
    }

    // Start / Stop hooks
    dom.btnStart.addEventListener('click', async () => {
        const config = {
            apiKey: dom.apiKey.value, model: dom.model.value, provider: dom.provider.value,
            baseUrl: dom.baseUrl.value, agentName: dom.agentName.value, persona: dom.persona.value,
            interests: dom.interests.value, giteaUrl: dom.giteaUrl.value, socialUrl: dom.socialUrl.value,
            cycleInterval: parseInt(dom.cycleInterval.value) || 30000,
            tractionThreshold: parseInt(dom.tractionThreshold.value) || 1,
            useDocker: dom.useDocker.checked,
            verbose: dom.verbose.checked,
            useSoulAgent: dom.useSoulAgent.checked,
        };

        const isLocal = ['ollama', 'vllm', 'custom'].includes(config.provider);
        if (!config.apiKey && !isLocal) {
            dom.apiKey.focus();
            dom.apiKey.style.borderColor = 'var(--red)';
            setTimeout(() => dom.apiKey.style.borderColor = '', 2000);
            return;
        }

        agents[agentId].currentInterests = (config.interests || '').split(',').map(i=>i.trim()).filter(Boolean);
        
        const res = await window.agent.start(agentId, config);
        if (res.error) {
            addLog(agentId, res.error, 'error');
            return;
        }

        dom.navBtns.forEach(b => b.classList.remove('active'));
        dom.panels.forEach(p => p.classList.remove('active'));
        q('[data-panel="monitor"]').classList.add('active');
        q('.panel-monitor').classList.add('active');
    });

    dom.btnStop.addEventListener('click', async () => {
        await window.agent.stop(agentId);
    });

    // Filters
    dom.filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            dom.filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            agents[agentId].currentFilter = btn.dataset.filter;
            for (const line of agents[agentId].logs) {
                if (agents[agentId].currentFilter === 'all') {
                    line.style.display = '';
                } else {
                    line.style.display = line.dataset.type === agents[agentId].currentFilter ? '' : 'none';
                }
            }
        });
    });

    dom.btnClear.addEventListener('click', () => {
        dom.logContainer.innerHTML = '<div class="log-empty"><p>Log cleared.</p></div>';
        agents[agentId].logs = [];
        agents[agentId].stats = { cycles: 0, ideas: 0, tools: 0 };
        dom.statCycle.textContent = '0'; dom.statIdeas.textContent = '0'; dom.statTools.textContent = '0';
        dom.statMode.textContent = '—';
    });

    return dom;
}

// ─── LOGGING & STATE ───

function addLog(agentId, text, type = 'info') {
    const agent = agents[agentId];
    if (!agent) return;
    const dom = agent.dom;

    if (text.includes('CYCLE') && text.includes('Mode:')) {
        agent.stats.cycles++;
        dom.statCycle.textContent = agent.stats.cycles;
        const modeMatch = text.match(/Mode:\s*(\w+)/);
        if (modeMatch) { agent.currentMode = modeMatch[1]; dom.statMode.textContent = agent.currentMode; }
    }
    if (text.includes('Created idea #') || text.includes('Rescued idea:')) {
        agent.stats.ideas++; dom.statIdeas.textContent = agent.stats.ideas;
    }
    if (type === 'tool' || text.includes('🔧')) {
        agent.stats.tools++; dom.statTools.textContent = agent.stats.tools;
    }
    if (text.includes('BRAINSTORM MODE')) { agent.currentMode = 'BRAINSTORM'; dom.statMode.textContent = agent.currentMode; }
    if (text.includes('DISCUSSION MODE')) { agent.currentMode = 'DISCUSSION'; dom.statMode.textContent = agent.currentMode; }
    if (text.includes('IMPLEMENTATION MODE')) { agent.currentMode = 'IMPLEMENTATION'; dom.statMode.textContent = agent.currentMode; }

    if (text.includes('Interests evolved:')) {
        const parts = text.split('→');
        if (parts.length > 1) { agent.currentInterests = parts[1].split(',').map(i=>i.trim()).filter(Boolean); }
    }

    if (text.includes('Publish successful!') || text.includes('Consensus Published idea')) {
        if (window.confetti) window.confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
    }

    const lineEl = document.createElement('div');
    lineEl.className = `log-line ${type}`;
    lineEl.textContent = text;
    lineEl.dataset.type = type;

    if (agent.currentFilter !== 'all' && type !== agent.currentFilter) lineEl.style.display = 'none';

    const empty = dom.logContainer.querySelector('.log-empty');
    if (empty) empty.remove();

    dom.logContainer.appendChild(lineEl);
    agent.logs.push(lineEl);

    if (agent.logs.length > 5000) agent.logs.shift().remove();
    if (dom.autoscroll.checked) dom.logContainer.scrollTop = dom.logContainer.scrollHeight;
}

// ─── IPC EVENTS ───

window.agent.onLog(({ agentId, text, type }) => addLog(agentId, text, type));

window.agent.onStatus(({ agentId, running, agentName }) => {
    const agent = agents[agentId];
    if (!agent) return;
    agent.running = running;
    const dom = agent.dom;

    if (running) {
        dom.statusDot.className = 'status-dot online';
        dom.statusText.textContent = agentName || 'Running';
        dom.btnStart.classList.add('hidden');
        dom.btnStop.classList.remove('hidden');
        $(`tab-${agentId}`).childNodes[0].nodeValue = agentName || `Agent ${agentId.split('-')[1]} `;
        agent.agentUUID = agentName; 
    } else {
        dom.statusDot.className = 'status-dot offline';
        dom.statusText.textContent = 'Offline';
        dom.btnStop.classList.add('hidden');
        dom.btnStart.classList.remove('hidden');
        $(`tab-${agentId}`).childNodes[0].nodeValue = `Agent ${agentId.split('-')[1]} `;
    }
});

window.agent.onState(({ agentId, mode, interests, cycleCount, memory, agentId: uuid }) => {
    const agent = agents[agentId];
    if (!agent) return;
    const dom = agent.dom;

    agent.agentUUID = uuid || agent.agentUUID;
    agent.currentMode = mode || agent.currentMode;
    agent.currentInterests = interests || agent.currentInterests;
    dom.statMode.textContent = agent.currentMode;

    const memoryHtml = (memory || []).slice().reverse().map(m => `<div class="memory-item">${m}</div>`).join('');
    
    dom.stateDisplay.innerHTML = `
    <div class="state-card">
      <h3>Current Mode</h3>
      <pre style="color: var(--accent-bright); font-size: 18px; font-weight: 700;">${agent.currentMode}</pre>
    </div>
    <div class="state-card">
      <h3>Interests</h3>
      <div>${agent.currentInterests.map(i => `<span class="tag">${i}</span>`).join('')}</div>
    </div>
    <div class="state-card">
      <h3>Stats</h3>
      <pre>Cycles:     ${cycleCount || agent.stats.cycles}
Ideas:      ${agent.stats.ideas}
Tool Calls: ${agent.stats.tools}</pre>
    </div>
    <div class="state-card" style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
      <h3>Memory Timeline</h3>
      <div style="flex:1; overflow-y: auto;">
         ${memoryHtml || '<span class="tag" style="opacity:0.5;">Amnesia</span>'}
      </div>
    </div>`;
});

window.agent.onPrompt(({ agentId, systemPrompt, userPrompt }) => {
    const agent = agents[agentId];
    if (!agent) return;
    const dom = agent.dom;
    dom.promptEmpty.style.display = 'none';
    dom.promptContent.style.display = 'block';
    dom.promptSystem.textContent = systemPrompt || '';
    dom.promptUser.textContent = userPrompt || '';
});

// ─── INIT & NETWORK ───

async function loadConfigFor(agentId) {
    const config = await window.agent.getConfig();
    const dom = agents[agentId].dom;
    dom.apiKey.value = config.apiKey || '';
    dom.model.value = config.model || 'gpt-5-nano';
    dom.provider.value = config.provider || 'openai';
    dom.baseUrl.value = config.baseUrl || '';
    dom.agentName.value = config.agentName || '';
    dom.persona.value = config.persona || 'a curious and productive software developer';
    dom.interests.value = config.interests || 'python,cli,tools,web';
    dom.giteaUrl.value = config.giteaUrl || 'http://localhost:3009';
    dom.socialUrl.value = config.socialUrl || 'http://localhost:3000';
    dom.cycleInterval.value = config.cycleInterval || 30000;
    dom.tractionThreshold.value = config.tractionThreshold || 1;
    dom.useDocker.checked = config.useDocker !== false;
    dom.verbose.checked = config.verbose === true;
    dom.useSoulAgent.checked = config.useSoulAgent === true;
}

const escapeHtml = (unsafe) => (unsafe || '').toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

async function fetchNetworkData() {
    const socialUrl = Object.values(agents)[0]?.dom?.socialUrl?.value || 'http://localhost:3000';
    try {
        // Removed leaderboard and feed endpoints since the global network UI tab no longer exists.

        for (const agentId of Object.keys(agents)) {
            const agent = agents[agentId];
            if (agent.agentUUID) {
                const repRes = await fetch(`${socialUrl}/api/reputation/${encodeURIComponent(agent.agentUUID)}`);
                if (repRes.ok) {
                    const rep = await repRes.json();
                    const currentRep = parseInt(agent.dom.repScore.textContent);
                    if (rep.reputation > currentRep) {
                        agent.dom.repScore.style.color = '#fff';
                        setTimeout(()=> agent.dom.repScore.style.color = '', 500);
                        if (window.confetti && currentRep > 0) window.confetti({ particleCount: 100, spread: 60, origin: { y: 0.7 } });
                    }
                    agent.dom.repScore.textContent = rep.reputation;
                    agent.dom.repBadge.classList.remove('hidden');
                }
            }
        }
    } catch (e) {}
}

btnAddAgent.addEventListener('click', createAgentTab);

setInterval(fetchNetworkData, 5000);
fetchNetworkData();
createAgentTab(); // Auto-start with 1 agent tab
