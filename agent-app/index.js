#!/usr/bin/env node

/**
 * Gridmolt Agent — Idea-Centric Autonomous Agent
 *
 * Three modes, driven by idea states:
 *   BRAINSTORM  — Research ecosystem, read code, create new ideas
 *   DISCUSSION  — Discuss and upvote ideas with other agents
 *   IMPLEMENTATION — Build code for an idea (delegates to coding agent in Docker)
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OpenAI = require('openai');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// =============================================================================
// Config
// =============================================================================

const agentNameVal = process.env.AGENT_NAME || 'Agent';

const config = {
    name: agentNameVal,
    persona: process.env.AGENT_PERSONA || 'a curious and productive software developer',
    interests: (process.env.AGENT_INTERESTS || 'python,cli,web,tools').split(',').map(s => s.trim()),
    giteaUrl: process.env.GITEA_URL || 'http://localhost:3009',
    socialUrl: process.env.SOCIAL_URL || 'http://localhost:3000',
    model: process.env.MODEL || 'gpt-5-nano',
    apiKey: process.env.OPENAI_API_KEY,
    workDir: process.env.WORK_DIR || path.join(os.homedir(), '.gridmolt', agentNameVal.replace(/[^a-zA-Z0-9_-]/g, '_'), 'workspace'),
    dataDir: process.env.DATA_DIR || path.join(os.homedir(), '.gridmolt', agentNameVal.replace(/[^a-zA-Z0-9_-]/g, '_'), 'data'),
    provider: process.env.PROVIDER || 'openai',
    cycleInterval: parseInt(process.env.CYCLE_INTERVAL || '30000'),
    tractionThreshold: parseInt(process.env.TRACTION_THRESHOLD || '1'),
    maxBrainstormCycles: parseInt(process.env.MAX_BRAINSTORM_CYCLES || '3'),
    maxDiscussionCycles: parseInt(process.env.MAX_DISCUSSION_CYCLES || '6'),
    buildTimeout: parseInt(process.env.BUILD_TIMEOUT || '600000'),
    verbose: process.env.VERBOSE === '1' || process.env.VERBOSE === 'true',
};

// Create dirs immediately for logging
fs.mkdirSync(config.workDir, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });

// =============================================================================
// State
// =============================================================================

let mcp = null;
let openai = null;
let agentId = 'unknown';

let state = {
    mode: 'BRAINSTORM',
    cyclesInMode: 0,
    interests: config.interests,
    persona: config.persona,
    memory: [],
    recentImplementations: [],
    activeIdeaId: null,
    cycleCount: 0,
};

function loadState() {
    const p = path.join(config.dataDir, 'state.json');
    if (fs.existsSync(p)) {
        try {
            const saved = JSON.parse(fs.readFileSync(p, 'utf-8'));
            // Never restore interests from saved state — always use env var.
            // Interest evolution was disabled; stale saved interests override user config.
            delete saved.interests;
            delete saved.persona; // Let env var override
            state = { ...state, ...saved };
        } catch { }
    }
}

function saveState() {
    state.agentId = agentId;
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(path.join(config.dataDir, 'state.json'), JSON.stringify(state, null, 2));
    if (process.send) process.send({ channel: 'state', data: state });
}

// =============================================================================
// Logging
// =============================================================================

function log(msg, type = 'info') {
    const time = new Date().toISOString().slice(11, 19);
    const icons = { info: '   ', mode: '🔄', tool: '🔧', ai: '🤖', ok: '✅', err: '❌', idea: '💡', verbose: '📋', warn: '⚠️' };
    const logStr = `[${time}] ${icons[type] || ''} ${msg}`;
    console.log(logStr);
    try {
        fs.appendFileSync(path.join(config.dataDir, 'agent.log'), logStr + '\n');
    } catch { }
}

function vlog(msg) {
    if (!config.verbose) return;
    log(msg, 'verbose');
}

function section(title) {
    const sep = '═'.repeat(60);
    const logStr = `\n${sep}\n  ${title}\n${sep}`;
    console.log(logStr);
    if (config.verbose) {
        try { fs.appendFileSync(path.join(config.dataDir, 'agent.log'), logStr + '\n'); } catch { }
    }
}

// =============================================================================
// MCP Client
// =============================================================================

async function initMCP() {
    const mcpPath = path.resolve(__dirname, '../mcp-server/index.js');
    if (!fs.existsSync(mcpPath)) throw new Error(`MCP server not found: ${mcpPath}`);

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [mcpPath, '--gitea', config.giteaUrl, '--social', config.socialUrl, '--data', config.dataDir],
        env: { ELECTRON_RUN_AS_NODE: '1' },
    });

    mcp = new Client({ name: 'gridmolt-agent', version: '1.0.0' }, {});
    await mcp.connect(transport);
    log('MCP connected');
}

async function callTool(name, args = {}) {
    log(`${name}(${JSON.stringify(args).slice(0, 100)})`, 'tool');
    vlog(`[TOOL INPUT] ${name}: ${JSON.stringify(args, null, 2)}`);
    try {
        const result = await mcp.callTool({ name, arguments: args });
        const data = JSON.parse(result.content[0].text);
        if (data.error) { log(`  → Error: ${data.error}`, 'err'); return data; }
        log(`  → OK`, 'ok');
        vlog(`[TOOL OUTPUT] ${name}: ${JSON.stringify(data, null, 2)}`);
        return data;
    } catch (e) { log(`  → FAIL: ${e.message}`, 'err'); throw e; }
}

// =============================================================================
// LLM
// =============================================================================

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callLLMWithRetry(payload, maxRetries = 4) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await openai.chat.completions.create(payload);
        } catch (e) {
            const status = e.status || e.response?.status;
            // 429 = Too Many Requests / Rate Limited. 5xx = Server Errors.
            if (attempt < maxRetries && (status === 429 || status >= 500)) {
                // Exponential backoff with jitter: 2s, 4s, 8s...
                const baseDelay = Math.pow(2, attempt) * 1000;
                const jitter = Math.random() * 1000;
                const delayMs = baseDelay + jitter;
                
                log(`API rate limited/error (${status}). Retrying in ${Math.round(delayMs/1000)}s (Attempt ${attempt}/${maxRetries})...`, 'warn');
                await sleep(delayMs);
                continue;
            }
            throw e;
        }
    }
}

async function ask(systemPrompt, userPrompt, tools = null, maxTokens = 15000, toolChoice = null) {
    if (process.send) process.send({ channel: 'prompt', data: { systemPrompt, userPrompt } });
    log(`Calling LLM (${config.model})...`, 'ai');
    vlog(`[LLM SYSTEM] ${systemPrompt}`);
    vlog(`[LLM USER] ${userPrompt}`);
    if (tools) vlog(`[LLM TOOLS] ${tools.map(t => t.function.name).join(', ')}`);
    try {
        const payload = {
            model: config.model,
            max_completion_tokens: maxTokens,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        };
        if (tools && tools.length > 0) {
            payload.tools = tools;
            if (toolChoice) payload.tool_choice = toolChoice;
        }

        const response = await callLLMWithRetry(payload);

        if (response.choices[0]?.message?.tool_calls) {
            const calls = response.choices[0].message.tool_calls;
            log(`LLM tool calls: ${calls.length}`, 'ok');
            for (const c of calls) {
                vlog(`[LLM CALL] ${c.function.name}(${c.function.arguments})`);
            }
            return calls;
        }

        const content = response.choices[0]?.message?.content;
        if (!content) {
            log('LLM returned empty.', 'err');
            return null;
        }
        log(`LLM text: ${content.length} chars`, 'ok');
        vlog(`[LLM RESPONSE] ${content}`);
        return content;
    } catch (e) {
        log(`LLM error: ${e.response?.data?.error?.message || e.message}`, 'err');
        return null;
    }
}

/**
 * Multi-turn reasoning loop. Sends messages to the LLM, executes tool calls,
 * feeds results back, and repeats until the LLM stops calling tools or we hit
 * maxTurns. The system+user prefix is prompt-cached from turn 2 onward.
 *
 * onToolCall(name, args) → result object. Return null to skip.
 * Returns when: LLM emits text/no tools, maxTurns reached, or onToolCall
 * signals early exit by setting the returned { stop: true } flag.
 */
async function reasoningLoop({ systemPrompt, userPrompt, tools, maxTurns = 4, maxTokens = 4000, onToolCall }) {
    if (process.send) process.send({ channel: 'prompt', data: { systemPrompt, userPrompt } });
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    for (let turn = 1; turn <= maxTurns; turn++) {
        log(`Reasoning turn ${turn}/${maxTurns} (${config.model})...`, 'ai');
        try {
            const payload = {
                model: config.model,
                max_completion_tokens: maxTokens,
                messages,
            };
            if (tools && tools.length > 0) {
                payload.tools = tools;
                // First turn: force a tool call. Later turns: let the LLM decide.
                payload.tool_choice = turn === 1 ? 'required' : 'auto';
            }

            const response = await callLLMWithRetry(payload);
            const msg = response.choices[0]?.message;
            if (!msg) { log('LLM returned empty.', 'err'); break; }

            // Append the assistant message to history
            messages.push(msg);

            // No tool calls → LLM is done
            if (!msg.tool_calls || msg.tool_calls.length === 0) {
                if (msg.content) {
                    log(`LLM finished with text (${msg.content.length} chars)`, 'ok');
                    vlog(`[LLM TEXT] ${msg.content}`);
                }
                break;
            }

            // Execute each tool call and feed results back
            let shouldStop = false;
            for (const tc of msg.tool_calls) {
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch { }
                vlog(`[TURN ${turn}] ${tc.function.name}(${JSON.stringify(args)})`);

                let result = { error: 'Tool not handled' };
                try {
                    const out = await onToolCall(tc.function.name, args);
                    if (out && out.stop) { shouldStop = true; result = out.result || out; }
                    else if (out) { result = out; }
                } catch (e) {
                    result = { error: e.message };
                    log(`Tool error: ${e.message}`, 'err');
                }

                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify(result),
                });
            }

            if (shouldStop) {
                log('Early exit: mode transition triggered', 'mode');
                break;
            }
        } catch (e) {
            log(`LLM error: ${e.response?.data?.error?.message || e.message}`, 'err');
            break;
        }
    }

    return messages;
}

function parseJSON(text) {
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
}

// =============================================================================
// MODE 1: BRAINSTORM
// =============================================================================

async function getDynamicPrompts() {
    let dynamicPrompts = { brainstorm: {}, discussion: {} };
    try {
        const promptsRes = await fetch(`${config.socialUrl}/api/config/prompts`);
        if (promptsRes.ok) {
            dynamicPrompts = await promptsRes.json();
            // Sync server-controlled network params
            if (dynamicPrompts.network) {
                if (dynamicPrompts.network.tractionThreshold) config.tractionThreshold = dynamicPrompts.network.tractionThreshold;
            }
        }
    } catch (e) { log('Failed to fetch dynamic prompts, using defaults.', 'err'); }

    if (!dynamicPrompts.brainstorm.system) {
        // Fallback defaults
        dynamicPrompts.brainstorm.system = `You are {agentId}, an autonomous AI developer.\nPersona: {persona}\nInterests: {interests}\n\nYou are in BRAINSTORM mode. Research the ecosystem and propose a novel, useful idea.\n\nRULES:\n- Look at what exists and find GAPS\n- Review the ### Published Packages to see what community tools already exist.\n- Propose exactly ONE novel idea by calling the create_idea tool. DO NOT output plain text.\n- Think about real, useful applications — NOT trivial utilities\n- Your idea should be specific and actionable\n- Do NOT append a 'Tags:' list at the bottom of your description text\n- Do NOT include project timelines, roadmaps, or MVP planning. Focus only on what to build and why.`;
        dynamicPrompts.brainstorm.user = `## Current Ecosystem\n### Published Packages:\n{packages}\n\n### Repos ({repoCount}):\n{repos}\n\n### Ideas ({ideaCount}):\n{ideas}\n\n### Memory:\n{memory}{hint}\n\n## Task\nWhat useful software is MISSING? Consider your interests: {interests} and AVOID Saturated Domains. Call the create_idea tool right now.`;
        dynamicPrompts.discussion.system = `You are {agentId}, an autonomous AI developer.\nPersona: {persona}\nInterests: {interests}\n\nYou are in DISCUSSION mode. Review proposed ideas, discuss them, upvote promising ones, and CLAIM ideas that are ready to build.\n\nRULES:\n- If an idea is interesting but needs refinement, use discuss_idea\n- If an idea is strong, use upvote_idea\n- If an idea has upvotes and good discussion, CLAIM it with claim_idea to start building\n- IMPORTANT: You should gently prioritize claiming ideas that are currently UNCLAIMED and have a high number of PUBLISH VOTES (🚀)\n- Do NOT include project timelines, roadmaps, or MVP planning in your comments.\n- You MUST call at least one of these action tools. Do NOT output plain text.`;
        dynamicPrompts.discussion.user = `## Relevant Ideas\n{ideas}\n\n### Memory:\n{memory}\n\n## Task\nReview the ideas above. First, discuss or upvote the most promising idea from ANOTHER agent based on recent comments. If an idea has high consensus (🚀 publishes) and is completely ready to build, you may use claim_idea to escalate it to the build phase. Avoid claiming already-claimed implementations unless explicitly necessary!`;
    }
    return dynamicPrompts;
}

async function runBrainstorm(landscape) {
    section('BRAINSTORM MODE');
    const { ideas, repos, packages } = landscape;
    const dynamicPrompts = await getDynamicPrompts();

    const saturatedSet = new Set(landscape.network_hint?.saturated_tags || []);
    let activeInterests = state.interests.filter(i => !saturatedSet.has(i.toLowerCase()));
    if (activeInterests.length === 0) {
        activeInterests = landscape.network_hint?.suggested_domains?.slice(0, 3) || ['developer-tools', 'cli'];
    }

    const systemPrompt = dynamicPrompts.brainstorm.system
        .replace('{agentId}', state.displayName || agentId)
        .replace('{persona}', config.persona)
        .replace('{interests}', activeInterests.join(', '));

    const hint = landscape.network_hint ? `\n\n### Network Ecosystem Hint:\nSaturated Domains (AVOID THESE): ${landscape.network_hint.saturated_tags.join(', ')}\nSuggested Domains (EXPLORE THESE): ${landscape.network_hint.suggested_domains.join(', ')}` : '';

    function buildEcosystemStr(ls) {
        const ideas = ls.ideas || [];
        const repos = ls.repos || [];
        // Map stars
        const unified = ideas.map(i => {
            let stars = 0;
            if (i.repo) {
                const rInfo = repos.find(r => r.name === `community/${i.repo}` || r.name === i.repo);
                if (rInfo) stars = rInfo.stars;
            }
            return { ...i, stars };
        });
        unified.sort(() => 0.5 - Math.random());
        return unified.slice(0, 20).map(i => {
            const isMe = i.author_id === agentId;
            let str = `- [#${i.id}] [${i.status}] **${i.title}** (by @${isMe ? (state.displayName || 'YOU') + ' (YOU)' : (i.author_name || 'anonymous')})`;
            if (i.status === 'PUBLISHED') str += ` (repo: ${i.repo || 'unknown'} | 🟩 ${i.usage_count || 0} Usages | ⭐ ${i.stars} Stars)`;
            else if (i.status === 'ACTIVE') str += ` (repo: ${i.repo || 'unknown'} | 🔺 ${i.upvotes || 0} Upvotes | ${i.claimed_by ? `🔒 CLAIMED By ${i.claimed_by}` : '🔓 UNCLAIMED'} | ⭐ ${i.stars} Stars)`;
            else str += ` (🔺 ${i.upvotes || 0} Upvotes | 🚀 ${i.publish_vote_count || 0} Publishes | ${i.claimed_by ? `🔒 CLAIMED By ${i.claimed_by}` : '🔓 UNCLAIMED'})`;
            str += `\n  Description: ${i.description ? i.description.substring(0, 1500) + (i.description.length > 1500 ? '...' : '') : '(no desc)'}`;
            if (i.recent_comments && i.recent_comments.length > 0) {
                str += '\n' + i.recent_comments.map(c => `    ↳ [@${c.author_name || c.author_id}]: "${c.content}"`).join('\n');
            }
            return str;
        }).join('\n') || '(ecosystem empty)';
    }

    const ecosystemText = buildEcosystemStr(landscape);

    const userPrompt = dynamicPrompts.brainstorm.user
        .replace('{ecosystem}', ecosystemText)
        .replace('{memory}', state.memory.slice(-5).join('\n') || '(empty)')
        .replace('{hint}', hint)
        .replace('{interests}', activeInterests.join(', '));

    const mcpToolsRaw = await mcp.listTools();
    const allowedTools = ['create_idea'];
    const tools = mcpToolsRaw.tools.filter(t => allowedTools.includes(t.name)).map(t => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
    }));

    const toolChoice = { type: "function", function: { name: "create_idea" } };
    const toolCalls = await ask(systemPrompt, userPrompt, tools, 15000, toolChoice);

    // Rescue: if LLM returned text instead of tool calls, try to extract an idea from it
    if (toolCalls && typeof toolCalls === 'string' && toolCalls.length > 100) {
        log('LLM returned text instead of tool calls — attempting to rescue as idea...', 'warn');
        const title = toolCalls.split('\n').find(l => l.trim().length > 10)?.trim().replace(/^#+\s*/, '').replace(/^(Idea:|Title:)\s*/i, '').slice(0, 120);
        if (title) {
            try {
                const result = await callTool('create_idea', { title, description: toolCalls.slice(0, 2000), tags: state.interests.slice(0, 3) });
                if (result.created) {
                    await callTool('discuss_idea', { idea_id: result.idea_id, content: `[UPDATE] I just completed a build cycle for this idea! I pushed my changes to the repository.` });

                    // Synchronously trigger Native MCP push immediately after build completes!
                    try {
                        await callTool('push_code', {
                            dir: 'repo',
                            repo_name: result.repo,
                            commit_message: `build(agent): ${agentId} iteration`
                        });
                        log(`Code pushed securely via MCP Native Execution!`, 'ok');
                    } catch (pe) {
                        log(`MCP Push failed: ${pe.message}`, 'err');
                    }

                    if (fs.existsSync(path.join('repo', 'READY_TO_PUBLISH'))) {
                        log(`READY_TO_PUBLISH flag detected! Triggering vote via MCP.`, 'ok');
                        await callTool('vote_publish', { idea_id: result.idea_id });
                    }

                    // If this pass was forced, automatically kill node
                    if (process.env.FORCE_IDEA_ID) {
                        log(`Force run completed. Exiting.`, 'ok');
                        process.exit(0);
                    }
                    addMemory(`Created idea #${result.idea_id}: ${title} (rescued from text)`);
                    state.mode = 'DISCUSSION'; state.cyclesInMode = 0;
                    log(`Rescued idea: ${title}`, 'ok');
                    return;
                }
            } catch (e) { log(`Rescue failed: ${e.message}`, 'err'); }
        }
        addMemory('LLM wrote text but failed to use tools');
        return;
    }

    if (!toolCalls || !Array.isArray(toolCalls)) { addMemory('Failed to decide, will try again'); return; }

    for (const call of toolCalls) {
        log(`Executing dynamically: ${call.function.name}`, 'tool');
        let args = {};
        try { args = JSON.parse(call.function.arguments); } catch (e) { }
        try {
            const result = await callTool(call.function.name, args);
            if (call.function.name === 'create_idea') {
                if (result.created) {
                    addMemory(`Created idea #${result.idea_id}: ${args.title}`);
                    state.mode = 'DISCUSSION'; state.cyclesInMode = 0;
                    log('→ Switching to DISCUSSION', 'mode');
                } else if (result.error) {
                    addMemory(`Failed to create idea "${args.title}": ${result.error}. I MUST use completely different tags next time.`);
                }
            } else if (call.function.name === 'read_code' || call.function.name === 'get_repo_overview') {
                addMemory(`Read repo docs: ${args.repo}`);
            } else if (call.function.name === 'explore') {
                addMemory(`Explored tags: ${args.interests}`);
            }
        } catch (e) {
            log(`Tool failure: ${e.message}`, 'err');
        }
    }
}

// =============================================================================
// MODE 2: DISCUSSION
// =============================================================================

async function runDiscussion(landscape) {
    section('DISCUSSION MODE');
    const { ideas } = landscape;
    const relevant = (ideas || []).filter(i =>
        (i.status === 'PROPOSED' || i.status === 'DISCUSSING' || i.status === 'ACTIVE')
    );

    if (relevant.length === 0) {
        log('No ideas to discuss, back to BRAINSTORM', 'mode');
        state.mode = 'BRAINSTORM'; state.cyclesInMode = 0; return;
    }

    const dynamicPrompts = await getDynamicPrompts();

    const systemPrompt = dynamicPrompts.discussion.system
        .replace('{agentId}', state.displayName || agentId)
        .replace('{persona}', config.persona)
        .replace('{interests}', state.interests.join(', '));

    function buildEcosystemStr(ls) {
        const ideas = ls.ideas || [];
        const repos = ls.repos || [];
        const unified = ideas.map(i => {
            let stars = 0;
            if (i.repo) {
                const rInfo = repos.find(r => r.name === `community/${i.repo}` || r.name === i.repo);
                if (rInfo) stars = rInfo.stars;
            }
            return { ...i, stars };
        });
        unified.sort(() => 0.5 - Math.random());
        return unified.slice(0, 20).map(i => {
            const isMe = i.author_id === agentId;
            let str = `- [#${i.id}] [${i.status}] **${i.title}** (by @${isMe ? (state.displayName || 'YOU') + ' (YOU)' : (i.author_name || 'anonymous')})`;
            if (i.status === 'PUBLISHED') str += ` (repo: ${i.repo || 'unknown'} | 🟩 ${i.usage_count || 0} Usages | ⭐ ${i.stars} Stars)`;
            else if (i.status === 'ACTIVE') str += ` (repo: ${i.repo || 'unknown'} | ⭐ ${i.stars} Stars)`;
            else str += ` (🔺 ${i.upvotes || 0} Upvotes${i.upvoted_by_me ? ' - Voted by YOU' : ''})`;
            str += `\n  Description: ${i.description ? i.description.substring(0, 1500) + (i.description.length > 1500 ? '...' : '') : '(no desc)'}`;
            if (i.recent_comments && i.recent_comments.length > 0) {
                str += '\n' + i.recent_comments.map(c => `    ↳ [@${c.author_name || c.author_id}]: "${c.content}"`).join('\n');
            }
            return str;
        }).join('\n') || '(ecosystem empty)';
    }

    const userPrompt = dynamicPrompts.discussion.user
        .replace('{ecosystem}', buildEcosystemStr({ ideas: relevant, repos: landscape.repos }))
        .replace('{memory}', state.memory.slice(-5).join('\n') || '(empty)');

    const mcpToolsRaw = await mcp.listTools();
    const allowedTools = ['discuss_idea', 'upvote_idea', 'claim_idea', 'get_idea'];
    const tools = mcpToolsRaw.tools.filter(t => allowedTools.includes(t.name)).map(t => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
    }));

    await reasoningLoop({
        systemPrompt,
        userPrompt,
        tools,
        maxTurns: 4,
        maxTokens: 4000,
        onToolCall: async (name, args) => {
            // Block further actions once we've claimed an idea
            if (state.mode === 'IMPLEMENTATION' && state.activeIdeaId) {
                log(`Skipping ${name}: already claimed idea #${state.activeIdeaId}`, 'info');
                return { stop: true, result: { skipped: true, reason: 'already claimed' } };
            }

            log(`Executing: ${name}(${JSON.stringify(args)})`, 'tool');
            const result = await callTool(name, args);

            if (name === 'discuss_idea' && !result.error) addMemory(`Discussed idea #${args.idea_id}`);
            if (name === 'upvote_idea' && !result.error) addMemory(`Upvoted idea #${args.idea_id}`);
            if (name === 'claim_idea' && result.claimed) {
                state.mode = 'IMPLEMENTATION';
                state.activeIdeaId = args.idea_id;
                state.cyclesInMode = 0;
                log('→ Switching to IMPLEMENTATION', 'mode');
                return { stop: true, result };
            }

            return result;
        },
    });
}

// =============================================================================
// MODE 3: IMPLEMENTATION
// =============================================================================

async function runImplementation(idea) {
    section(`IMPLEMENTATION MODE: ${idea.title}`);
    const ideaId = idea.id;
    const repoSlug = idea.title.split(':')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 3).join('-');
    const repoName = `idea${ideaId}-${repoSlug}`;
    const fullRepo = `community/${repoName}`;

    log('Claiming idea...', 'tool');
    const claimResult = await callTool('claim_idea', { idea_id: ideaId });
    if (claimResult.error) {
        log(`Claim failed: ${claimResult.error}`, 'err');
        state.activeIdeaId = null; state.mode = 'BRAINSTORM'; state.cyclesInMode = 0; return;
    }

    // Fetch full idea with comments
    let fullIdea = idea;
    try {
        const ideaRes = await callTool('get_idea', { idea_id: ideaId });
        if (!ideaRes.error) fullIdea = ideaRes;
    } catch (e) { log(`Failed to fetch full idea details: ${e.message}`, 'err'); }

    let isNewRepo = false;
    if (!idea.repo) {
        log(`Creating repo: ${repoName}`, 'tool');
        const createResult = await callTool('create_repo', { idea_id: ideaId, name: repoSlug, description: fullIdea.title || `Idea #${ideaId}` });
        if (!createResult.error) {
            isNewRepo = true;
            await callTool('link_repo', { idea_id: ideaId, repo: createResult.repo || fullRepo });
        }
    }
    const actualRepo = idea.repo || fullRepo;

    const taskPrompt = buildTaskPrompt(fullIdea, actualRepo, isNewRepo);

    // Cooldown: prevent the same agent from immediately reclaiming this idea
    state.recentImplementations = state.recentImplementations || [];
    state.recentImplementations.push(ideaId);
    if (state.recentImplementations.length > 5) state.recentImplementations.shift();

    try {
        log('Spawning coding agent...', 'mode');
        await spawnCodingAgent(actualRepo, taskPrompt, ideaId);
        log('Build completed!', 'ok');

        let diffText = '';
        try {
            const diffPath = path.join(config.workDir, actualRepo.replace('/', '-'), 'diff.txt');
            diffText = fs.readFileSync(diffPath, 'utf-8');
        } catch { }

        let report = `[UPDATE] I just completed a build cycle for this idea! I pushed my changes to the \`${actualRepo}\` repository.`;
        if (diffText.trim().length > 10) {
            log('Generating Handoff Report from git diff...', 'ai');
            const discussionContext = (fullIdea.comments || []).slice(-8).map(c => `- ${c.author_id}: ${c.content}`).join('\n') || '(no discussion yet)';
            const reportPrompt = `You are a Principal Engineer reviewing code written by a sub-agent. 
Here is the original idea description:
${fullIdea.description}

Here is the community discussion on this idea:
${discussionContext}

Here is the git diff of the changes the sub-agent just made:
${diffText.slice(0, 4000)}

Write a concise PROGRESS UPDATE for the community. Use exactly this format:
### What was Built
(1-2 sentences summarizing changes)
### Current State & Bugs
(1-2 sentences on what appears to still be missing or broken based on the idea and comments)
### Next Steps
(1-2 sentences instructing the next developer on what feature to tackle next)

Do not include any other text or markdown wrappers.`;
            const reportResponse = await ask(`You are ${state.displayName || agentId}, a Principal Engineer in the Gridmolt network.`, reportPrompt, null, 1500);
            if (reportResponse && reportResponse.includes('### What was Built')) {
                report = `[UPDATE]\n\n${reportResponse}`;
            }
        }

        addMemory(`Built code for idea #${ideaId}: ${idea.title}`);

        // Broadcast success to the Social Hub
        await callTool('discuss_idea', { idea_id: ideaId, content: report });

        // Synchronously trigger Native MCP push immediately after build completes!
        try {
            const pushResult = await callTool('push_code', {
                dir: path.join(config.workDir, actualRepo.replace('/', '-'), 'repo'),
                repo_name: actualRepo,
                commit_message: `build(agent): ${agentId} iteration`
            });
            if (pushResult && pushResult.error) {
                log(`MCP Push failed: ${pushResult.error}`, 'err');
            } else {
                log(`Code pushed securely via MCP Native Execution!`, 'ok');
            }
        } catch (pe) {
            log(`MCP Push exception: ${pe.message}`, 'err');
        }

        const repoWorkDir = path.join(config.workDir, actualRepo.replace('/', '-'), 'repo');
        const publishFlag = path.join(repoWorkDir, 'READY_TO_PUBLISH');
        if (fs.existsSync(publishFlag)) {
            log('🚀 READY_TO_PUBLISH DETECTED! Triggering Publish Vote...', 'ok');
            addMemory(`Voted to publish idea #${ideaId}: ${idea.title}`);
            try {
                const pubRes = await callTool('vote_publish', { idea_id: ideaId });
                log(`Publish Vote Result: ${JSON.stringify(pubRes)}`, 'ok');
            } catch (err) {
                log(`Publish Vote Failed: ${err.message}`, 'err');
            }
        }

    } catch (e) {
        log(`Build failed: ${e.message.split('\n')[0]}`, 'err');
        const shortMsg = e.message.split('\n')[0].slice(0, 100);
        addMemory(`Build failed for idea #${ideaId}: ${shortMsg}`);
        try {
            const safeMsg = e.message.slice(0, 1800).replace(/[-A-Za-z0-9+/=]{50,}/g, '[REDACTED]');
            await callTool('discuss_idea', { idea_id: ideaId, content: `[FAILED] I tried to build this but the cycle failed:\n\n\`\`\`text\n${safeMsg}\n\`\`\`\n\nI am releasing my claim so another agent can try.` });
        } catch (err) { }
    }

    await callTool('release_claim', { idea_id: ideaId });
    state.activeIdeaId = null; state.mode = 'BRAINSTORM'; state.cyclesInMode = 0;
}

function buildTaskPrompt(idea, repo, isNew) {
    const repoName = repo.split('/').pop();
    const comments = (idea.comments || []).slice(-8).map(c => `- ${c.author_id}: ${c.content}`).join('\n') || '(no discussion)';

    return isNew ? `# Build: ${idea.title}

## What To Build
${idea.description}

## Community Discussion
${comments}

## Requirements
LANGUAGE: Choose the best language for this project — JavaScript/Node.js or Python. Use whichever fits the problem best. If using Python and \`pyproject.toml\`, you MUST include a standard \`[build-system]\` block (e.g. \`requires = ["setuptools"]\`) or \`pip install -e .\` will violently crash.
COMPOUNDING (do this first!): Before building standalone utilities or components, use the \`search_packages\` tool to check if the community has already built it. If you find a useful package, install it (\`npm install @community/package-name\` for JS, or \`pip install\` for Python).
INTERNET ACCESS: You have full internet access! You MUST leverage massive external industry-standard packages (e.g. \`pip install transformers pytorch pandas fastapi\`, \`npm install react express\`). DO NOT recode complex logic from scratch! If an advanced capability exists out there, INSTALL it and use it!
ENTERPRISE ARCHITECTURE: You MUST build a COMPLETE, PRODUCTION-READY architecture! Do NOT build a basic "MVP" (Minimum Viable Product). Do NOT use mock data if real logic can be coded! If the project requires a database, wire up proper SQLite or PostgreSQL logic. Build comprehensive, heavy, useful applications! Include: README.md, robust source code, and rigorous tests.
CRITICAL: You MUST create an executable \`test.sh\` script in the root directory that cleanly runs your tests (e.g., \`npm test\` for JS or \`pytest\` for Python). For Python projects, your \`test.sh\` MUST ALSO successfully run \`python3 -m build\` to securely verify that your packaging metadata and directory structures compile perfectly without crashing! The orchestrator will run \`bash test.sh\` to verify your code before allowing you to publish.
CRITICAL: You MUST create an \`AGENTS.md\` file in the root directory. This file must explain the architecture, tech stack, testing commands, and rules of this repository so future AI agents know how to contribute without breaking it.
QUALITY GATE: You MUST write at least one basic test. Run the tests locally. If they fail, fix the code. Do not finish until all tests are green.

## Sprint Notice
You are part of an agent SWARM. You do NOT have to build everything in one session. Focus on building a solid, well-tested chunk of functionality. It is perfectly acceptable to finish your session after completing one major feature and let the next agent continue.

## Publishing Check
CRITICAL FINAL STEP: Compare the entire state of the repository against the Original Idea Description above. If—and ONLY if—every requirement is fully built, polished, and all tests pass perfectly, you MUST:
For JavaScript: Ensure \`package.json\` has a \`name\` prefixed with \`@community/\` (e.g., \`@community/${repoName}\`) and a \`version\` field.
For Python: Ensure \`pyproject.toml\` or \`setup.py\` exists and its package name EXACTLY matches \`${repoName}\` (or \`${repoName.replace(/-/g, '_')}\`).
CRITICAL: You MUST write a beautifully comprehensive \`README.md\` file detailing what your code does, and explicitly hook it into your \`package.json\` or \`pyproject.toml\` (e.g., \`readme = "README.md"\` or \`long_description\`) so the public package registry has a marketing description!
Finally: Create an empty file named \`READY_TO_PUBLISH\` in the root directory to signal completion. You do not need to write anything inside it.
If any requirements are still missing, do NOT create this file. The next agent in the swarm will pick up where you left off.


## When Done
Do NOT run git commands. The build system handles commits, testing, and publishing automatically.`
        : `# Improve: ${idea.title}

## What To Improve
${idea.description}

## Community Discussion
${comments}

## Requirements
LANGUAGE: Continue in the language already used in this repo. If starting fresh, choose the best fit — JavaScript/Node.js or Python. If using Python and \`pyproject.toml\`, you MUST include a standard \`[build-system]\` block (e.g. \`requires = ["setuptools"]\`) or \`pip install -e .\` will violently crash.
COMPOUNDING: If you need new functionality, use the \`search_packages\` tool first. If another agent already built what you need, install it (\`npm install @community/package-name\` for JS, or \`pip install\` for Python).
INTERNET ACCESS: You have full internet access! You MUST leverage massive external industry-standard packages (e.g. \`pip install transformers pytorch pandas fastapi\`, \`npm install react express\`). DO NOT recode complex logic from scratch! If an advanced capability exists out there, INSTALL it and use it! CRITICAL: If you install a package, you MUST add it to your \`package.json\` or \`pyproject.toml\` \`dependencies\` array so it installs correctly!
ENTERPRISE ARCHITECTURE: You MUST build a COMPLETE, PRODUCTION-READY architecture! Do NOT build a basic "MVP" (Minimum Viable Product). Do NOT use mock data if real logic can be coded! If the project requires a database, wire up proper SQLite or PostgreSQL logic. Build comprehensive, heavy, useful applications!
AGENTS.md: Check if an \`AGENTS.md\` file exists in the root directory. If it exists, read it and strictly follow all architectural and testing rules defined there. If it does NOT exist, create one documenting the architecture, tech stack, testing commands, and contribution rules. If you make fundamental structural changes, update \`AGENTS.md\` to reflect them.
CRITICAL: Ensure the \`test.sh\` script cleanly runs your tests. For Python projects, your \`test.sh\` MUST ALSO successfully run \`python3 -m build\` to securely verify that your packaging metadata and directory structures compile perfectly without crashing! The orchestrator will run \`bash test.sh\` to verify your code before allowing you to publish.
QUALITY GATE: After making your changes, run the testing commands specified in \`AGENTS.md\` (if it existed) or \`test.sh\`. If tests fail, fix your code. Do not finish until all tests are green.

## Sprint Notice
You are part of an agent SWARM. You do NOT have to build everything in one session. Focus on building a solid, well-tested chunk of functionality. It is perfectly acceptable to finish your session after completing one major feature and let the next agent continue.

## Publishing Check
CRITICAL FINAL STEP: Compare the entire state of the repository against the Original Idea Description above. If—and ONLY if—every requirement is fully built, polished, and all tests pass perfectly, you MUST:
For JavaScript: Ensure \`package.json\` has a \`name\` field and a \`version\` field.
For Python: Ensure \`pyproject.toml\` or \`setup.py\` exists.
CRITICAL: You MUST write a beautifully comprehensive \`README.md\` file detailing what your code does, and explicitly hook it into your \`package.json\` or \`pyproject.toml\` (e.g., \`readme = "README.md"\` or \`long_description\`) so the public package registry has a marketing description!
Finally: Create an empty file named \`READY_TO_PUBLISH\` in the root directory to signal completion. You do not need to write anything inside it.
If any requirements are still missing, do NOT create this file. The next agent in the swarm will pick up where you left off.


## When Done
Do NOT run git commands. The build system handles commits, testing, and publishing automatically.`;
}

// Resolve the docker binary. GUI-launched macOS apps inherit a minimal PATH
// from launchd that does NOT include /usr/local/bin, so a bare "docker" call
// fails even when Docker Desktop is installed and running. Probe common
// locations and cache the first one that works.
let _cachedDockerBin = null;
function resolveDockerBin() {
    if (_cachedDockerBin) return _cachedDockerBin;
    const { spawnSync } = require('child_process');
    const candidates = [
        'docker', // PATH (fast path if it already works)
        '/usr/local/bin/docker',                                  // Docker Desktop symlink (Intel + Apple Silicon)
        '/Applications/Docker.app/Contents/Resources/bin/docker', // actual binary
        '/opt/homebrew/bin/docker',                               // Homebrew on Apple Silicon
        '/usr/bin/docker',                                        // Linux default
    ];
    for (const bin of candidates) {
        const res = spawnSync(bin, ['--version'], { stdio: 'ignore' });
        if (!res.error && res.status === 0) {
            _cachedDockerBin = bin;
            return bin;
        }
    }
    return null;
}

// Docker Desktop on macOS only exposes a whitelist of paths to containers
// (user home, /Volumes, /tmp, /private). When Gridmolt is launched from a
// packaged .app, the bundled mcp-server lives under /Applications/...app/
// Contents/Resources/mcp-server — which is NOT shareable — so -v bind
// mounts fail with "mounts denied". Fix: copy the directory once into
// ~/.gridmolt/mcp-server-staged/ and mount from there.
let _cachedStagedMcpPath = null;
function ensureMcpServerStaged() {
    if (_cachedStagedMcpPath) return _cachedStagedMcpPath;
    const source = path.resolve(__dirname, '../mcp-server');
    const homeStage = path.join(os.homedir(), '.gridmolt', 'mcp-server-staged');

    // If the source already lives in a shareable location (dev checkout in
    // the user's home, or on Linux where there is no whitelist), just use it.
    const sourceIsShareable = source.startsWith(os.homedir()) ||
        source.startsWith('/tmp/') || source.startsWith('/private/') ||
        process.platform !== 'darwin';
    if (sourceIsShareable) {
        _cachedStagedMcpPath = source;
        return source;
    }

    // Stage/refresh: copy if missing or if source is newer than the stage.
    let needsCopy = !fs.existsSync(path.join(homeStage, 'index.js'));
    if (!needsCopy) {
        try {
            const srcMtime = fs.statSync(path.join(source, 'index.js')).mtimeMs;
            const stageMtime = fs.statSync(path.join(homeStage, 'index.js')).mtimeMs;
            if (srcMtime > stageMtime) needsCopy = true;
        } catch { needsCopy = true; }
    }
    if (needsCopy) {
        log(`Staging mcp-server into ${homeStage} (Docker Desktop cannot mount /Applications)`, 'info');
        try { fs.rmSync(homeStage, { recursive: true, force: true }); } catch { }
        fs.mkdirSync(path.dirname(homeStage), { recursive: true });
        fs.cpSync(source, homeStage, { recursive: true });
    }
    _cachedStagedMcpPath = homeStage;
    return homeStage;
}

// Verify docker is installed, reachable, and the gridmolt-builder image exists.
// Auto-builds the image on first run. Throws a human-friendly error otherwise.
async function ensureDockerReady() {
    const { spawnSync, spawn: cpSpawn } = require('child_process');

    // 1. Find the docker binary (handles macOS GUI PATH bug).
    const dockerBin = resolveDockerBin();
    if (!dockerBin) {
        throw new Error(
            'Docker is not installed or not in PATH. Gridmolt sandboxes LLM-generated build code inside a container for security. ' +
            'Install Docker Desktop from https://www.docker.com/products/docker-desktop and start it, then retry.'
        );
    }

    // 2. Is the daemon reachable?
    const daemonProbe = spawnSync(dockerBin, ['info'], { stdio: 'ignore' });
    if (daemonProbe.status !== 0) {
        throw new Error('Docker is installed but the daemon is not running. Start Docker Desktop and retry.');
    }

    // 3. Does the gridmolt-builder image exist? If not, build it.
    const imageProbe = spawnSync(dockerBin, ['image', 'inspect', 'gridmolt-builder'], { stdio: 'ignore' });
    if (imageProbe.status !== 0) {
        const dockerfile = path.resolve(__dirname, '..', 'sandbox', 'Dockerfile.builder');
        if (!fs.existsSync(dockerfile)) {
            throw new Error(`gridmolt-builder image missing and Dockerfile.builder not found at ${dockerfile}`);
        }
        log('gridmolt-builder image not found — building it now (first-run only, ~2 min)...', 'info');
        await new Promise((resolve, reject) => {
            const buildProc = cpSpawn(dockerBin, ['build', '-t', 'gridmolt-builder', '-f', dockerfile, path.dirname(dockerfile)], { stdio: ['ignore', 'pipe', 'pipe'] });
            buildProc.stdout.on('data', d => log(d.toString().trim().slice(0, 150)));
            buildProc.stderr.on('data', d => log(d.toString().trim().slice(0, 150)));
            buildProc.on('exit', code => {
                if (code === 0) { log('gridmolt-builder image built', 'ok'); resolve(); }
                else reject(new Error(`docker build failed with exit code ${code}`));
            });
            buildProc.on('error', reject);
        });
    }
}

const activeContainers = new Set();

async function spawnCodingAgent(repo, taskPrompt, ideaId) {
    return new Promise(async (resolve, reject) => {
        try { await ensureDockerReady(); }
        catch (e) { return reject(e); }

        const workDir = path.join(config.workDir, repo.replace('/', '-'));
        
        // Garbage Collection: Keep only the 3 most recently accessed workspaces
        if (fs.existsSync(config.workDir)) {
            const dirs = fs.readdirSync(config.workDir)
                .map(d => path.join(config.workDir, d))
                .filter(d => fs.statSync(d).isDirectory())
                .map(d => ({ path: d, mtime: fs.statSync(d).mtime.getTime() }))
                .sort((a, b) => b.mtime - a.mtime);
            
            if (dirs.length >= 3) {
                dirs.slice(2).forEach(d => {
                    log(`Garbage collection: removing old workspace ${path.basename(d.path)}`, 'warn');
                    try { fs.rmSync(d.path, { recursive: true, force: true }); } catch (e) { }
                });
            }
        }

        fs.mkdirSync(workDir, { recursive: true });
        fs.writeFileSync(path.join(workDir, 'TASK.md'), taskPrompt);

        const mcpConfig = {
            mcp: {
                "gridmolt-mcp": {
                    type: "local",
                    command: [
                        "node",
                        "/mcp-server/index.js",
                        "--gitea", config.giteaUrl,
                        "--social", config.socialUrl,
                        "--data", "/agent-data",
                        "--tools", "search_packages,view_package_docs"
                    ]
                }
            }
        };
        fs.writeFileSync(path.join(workDir, 'opencode.json'), JSON.stringify(mcpConfig, null, 2));

        // Read agent credentials for git clone URL construction
        const credPath = path.join(config.dataDir, 'credentials.json');
        let creds = {};
        if (fs.existsSync(credPath)) {
            try { creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')); } catch { }
        }
        const repoName = repo.split('/').pop();
        const cloneUrl = `${config.giteaUrl}/community/${repoName}.git`
            .replace('http://', `http://${creds.username || 'agent'}:${creds.token || ''}@`)
            .replace('https://', `https://${creds.username || 'agent'}:${creds.token || ''}@`);
        const commitUsername = creds.username || 'agent';
        const commitDisplayName = creds.displayName || config.name || 'Agent';

        const script = `set -e
cd /workspace
CLONE_URL="${cloneUrl}"
if [ -d "repo" ]; then
  echo "Repo exists, pulling latest..."
  cd repo
  # Ensure remote is set (may be missing from previous interrupted run)
  git remote remove origin 2>/dev/null || true
  git remote add origin "$CLONE_URL"
  git pull origin main || echo "Pull failed, continuing with local state"
else
  git clone "$CLONE_URL" repo 2>/dev/null || { mkdir -p repo && cd repo && git init && git checkout -b main; }
  cd repo
fi


git config user.email "${commitUsername}@gridmolt.local"
git config user.name "${commitDisplayName}"
# Ensure we're on main branch
git checkout main 2>/dev/null || git checkout -b main
# Install dependencies (detect language)
if [ -f package.json ]; then npm install 2>/dev/null || true; fi
if [ -f requirements.txt ]; then pip install -r requirements.txt || true; fi
if [ -f pyproject.toml ]; then pip install -e . || true; fi

# Clean up any ghost flags from previous sprints
rm -f READY_TO_PUBLISH publish.sh


echo "Configuring MCP..."
mkdir -p ~/.opencode ~/.config/opencode
cp ../opencode.json ~/.opencode/opencode.json 2>/dev/null || true
cp ../opencode.json ~/.config/opencode/opencode.json 2>/dev/null || true

# Strip remote so OpenCode cannot push (orchestrator owns the push)
git remote remove origin 2>/dev/null || true

MAX_RETRIES=1
RETRY_COUNT=0
TEST_OUTPUT=""

while [ $RETRY_COUNT -le $MAX_RETRIES ]; do
  if [ $RETRY_COUNT -eq 0 ]; then
    echo "Running OpenCode with model ${config.provider}/${config.model}..."
    PROMPT="$(cat ../TASK.md)"
  else
    echo "--- LAUNCHING OPENCODE RETRY $RETRY_COUNT ---"
    PROMPT="[URGENT] Your previous build failed the CI testing validation gate! Please read the test output below and fix the failing code. Do not stop until 'bash test.sh' passes cleanly:\n\nTEST OUTPUT:\n$TEST_OUTPUT\n\nORIGINAL TASK:\n$(cat ../TASK.md)"
  fi
  
  if ! opencode run "$PROMPT" --model "${config.provider}/${config.model}"; then
    echo "OpenCode engine failed entirely. Aborting."
    git remote add origin "$CLONE_URL" 2>/dev/null || true
    exit 1
  fi
  
  echo "--- VALIDATION GATE ---"
  if [ ! -f "test.sh" ]; then
    TEST_OUTPUT="ERROR: No test.sh script found. You MUST create an executable test.sh script in the root directory to verify your code."
    echo "CI FAILED: test.sh missing."
    RETRY_COUNT=$((RETRY_COUNT+1))
    continue
  fi
  
  # Run the test script and capture both stdout and stderr
  set +e
  TEST_OUTPUT=$(bash test.sh 2>&1)
  TEST_EXIT_CODE=$?
  set -e
  
  if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "--- VALIDATION SUCCESS ---"
    break
  else
    echo "CI FAILED: test.sh returned non-zero code $TEST_EXIT_CODE."
    RETRY_COUNT=$((RETRY_COUNT+1))
    if [ $RETRY_COUNT -gt $MAX_RETRIES ]; then
      echo "Max test retries reached."
      exit 1
    fi
  fi
done

# Ensure node_modules and secrets are not committed
if [ ! -f .gitignore ] || ! grep -q "node_modules" .gitignore; then
  printf "node_modules/\\n.npmrc\\n.env\\n.env.*\\n__tests__/\\ncoverage/\\n.nyc_output/\\ndist/\\nbuild/\\n.cache/\\n*.log\\n.DS_Store\\ntmp/\\n.tmp/\\n__pycache__/\\n*.pyc\\n.venv/\\nvenv/\\n*.egg-info/\\n.pytest_cache/\\nREADY_TO_PUBLISH\\n" >> .gitignore
fi

if [ -f "READY_TO_PUBLISH" ]; then
  echo "READY_TO_PUBLISH flag detected."
else
  echo "Agent finished sprint without concluding the project."
fi

echo "=== BUILD COMPLETE ==="`;

        const envArgs = [
            '--env', `OPENAI_API_KEY=${config.apiKey || 'dummy-key'}`,
            '--env', 'CI=1',
            '--env', 'TERM=dumb',
            '--env', 'PIP_BREAK_SYSTEM_PACKAGES=1',
        ];
        if (config.baseUrl) {
            envArgs.push('--env', `OPENAI_BASE_URL=${config.baseUrl}`);
        } else if (config.provider === 'openrouter') {
            envArgs.push('--env', `OPENAI_BASE_URL=https://openrouter.ai/api/v1`);
        } else if (config.provider === 'ollama') {
            envArgs.push('--env', `OPENAI_BASE_URL=http://127.0.0.1:11434/v1`);
        } else if (process.env.OPENAI_BASE_URL) {
            envArgs.push('--env', `OPENAI_BASE_URL=${process.env.OPENAI_BASE_URL}`);
        }

        const mcpServerPath = ensureMcpServerStaged();

        // Hardened sandbox. The container runs LLM-generated shell + arbitrary
        // npm/pip install lifecycle scripts, so we want defense in depth:
        //   - default bridge net (NOT --network host): can reach the internet
        //     for git clone / npm / pip / OpenAI, but CANNOT reach host's
        //     127.0.0.1 services.
        //   - cap-drop=ALL: no Linux capabilities.
        //   - no-new-privileges: setuid binaries can't escalate.
        //   - memory/cpu/pids limits: fork-bomb / runaway-process protection.
        const dockerBin = resolveDockerBin() || 'docker';
        const containerName = `gridmolt-builder-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        activeContainers.add(containerName);

        const proc = require('child_process').spawn(dockerBin, [
            'run', '--rm', '--name', containerName,
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--memory=1g',
            '--cpus=0.5',
            '--pids-limit=512',
            ...envArgs,
            '-v', `${workDir}:/workspace`,
            '-v', `${mcpServerPath}:/mcp-server`,
            '-v', `${config.dataDir}/credentials.json:/agent-data/credentials.json:ro`,
            '-w', '/workspace',
            'gridmolt-builder', 'bash', '-c', script,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let output = '';
        proc.stdout.on('data', d => { output += d.toString(); log(d.toString().trim().slice(0, 150)); });
        proc.stderr.on('data', d => log(d.toString().trim().slice(0, 150)));

        const timeout = setTimeout(() => {
            try { proc.kill(); } catch { } reject(new Error('Build timeout (Agent infinite loop detected)'));
        }, config.buildTimeout || 600000);

        proc.on('exit', code => {
            clearTimeout(timeout);
            activeContainers.delete(containerName);
            code === 0 || output.includes('BUILD COMPLETE') ? resolve(output) : reject(new Error(`Exit code ${code}`));
        });
    });
}

// =============================================================================
// Mode Decision Logic
// =============================================================================

async function decideNextMode(landscape) {
    const { ideas } = landscape;
    vlog(`[DECIDE] Current: ${state.mode} (cycle ${state.cyclesInMode}), ideas: ${(ideas||[]).length}, activeIdeaId: ${state.activeIdeaId}`);

    // P1: Continue active implementation
    if (state.activeIdeaId) {
        let active = (ideas || []).find(i => i.id === state.activeIdeaId);
        // The explore landscape is filtered/limited (interests, 20-item cap),
        // so the claimed idea may be absent even though it still exists.
        // Fetch it directly before giving up.
        if (!active) {
            vlog(`[DECIDE] P1: activeIdeaId #${state.activeIdeaId} not in landscape, fetching directly`);
            try {
                const fetched = await callTool('get_idea', { idea_id: state.activeIdeaId });
                if (fetched && !fetched.error && fetched.id && fetched.status !== 'PUBLISHED') {
                    active = fetched;
                }
            } catch (e) { vlog(`[DECIDE] get_idea failed: ${e.message}`); }
        }
        if (active) { vlog(`[DECIDE] P1: continuing active idea #${state.activeIdeaId}`); return { mode: 'IMPLEMENTATION', idea: active }; }
        vlog(`[DECIDE] P1: activeIdeaId #${state.activeIdeaId} no longer exists, clearing`);
        state.activeIdeaId = null;
    }

    if (state.mode === 'IMPLEMENTATION' && !state.activeIdeaId) {
        vlog(`[DECIDE] No active idea to implement → Fallback to BRAINSTORM`);
        return { mode: 'BRAINSTORM' };
    }

    // P2: If stuck in same mode too long, nudge to the other
    if (state.mode === 'BRAINSTORM' && state.cyclesInMode >= config.maxBrainstormCycles) { vlog(`[DECIDE] P2: brainstorm limit → DISCUSSION`); return { mode: 'DISCUSSION' }; }
    if (state.mode === 'DISCUSSION' && state.cyclesInMode >= config.maxDiscussionCycles) { vlog(`[DECIDE] P2: discussion limit → BRAINSTORM`); return { mode: 'BRAINSTORM' }; }

    // Otherwise: stay in current mode, let LLM drive transitions via tool calls
    // (create_idea → DISCUSSION, claim_idea → IMPLEMENTATION, build done → BRAINSTORM)
    vlog(`[DECIDE] Staying in ${state.mode}`);
    return { mode: state.mode };
}

function matchesInterests(idea) {
    if (!state.interests?.length) return true;
    const tags = idea.tags || [];
    if (tags.length === 0) return true;
    return state.interests.some(i => tags.some(t =>
        t.toLowerCase().includes(i.toLowerCase()) || i.toLowerCase().includes(t.toLowerCase())
    ));
}

function addMemory(obs) {
    state.memory.push(`[${new Date().toISOString().slice(0, 16)}] ${obs}`);
    if (state.memory.length > 20) state.memory = state.memory.slice(-20);
    saveState();
}

// =============================================================================
// INTEREST EVOLUTION
// =============================================================================

async function reflectAndEvolve() {
    section('EVOLVE INTERESTS');
    const systemPrompt = `You are ${agentId}, an autonomous AI developer.
Your current interests: ${state.interests.join(', ')}

Review your recent memory and decide if your core interests should evolve.
If you have been discussing or building around specific topics, add them.
Drop interests you are no longer pursuing. Maximum 5 interests.

Recent memory:
${state.memory.slice(-10).join('\n') || '(empty)'}

Respond ONLY with JSON:
{ "new_interests": ["tag1", "tag2", "tag3"] }`;

    const response = await ask(systemPrompt, 'Update your interests based on your recent memory.', null, 5000);
    const decision = parseJSON(response);
    if (decision && decision.new_interests && Array.isArray(decision.new_interests)) {
        const newInterests = decision.new_interests.map(i => i.toLowerCase().trim()).slice(0, 5);
        if (newInterests.join(',') !== state.interests.join(',')) {
            log(`Interests evolved: ${state.interests.join(', ')} → ${newInterests.join(', ')}`, 'ok');
            state.interests = newInterests;
            await callTool('save_state', { key: 'interests', value: state.interests });
        } else {
            log('Interests remain unchanged.', 'info');
        }
    } else {
        log('Failed to parse new interests.', 'err');
    }
}

// =============================================================================
// Main Loop
// =============================================================================

async function cycle() {
    state.cycleCount++; state.cyclesInMode++;
    section(`CYCLE ${state.cycleCount} — Mode: ${state.mode} (${state.cyclesInMode} in mode)`);

    try {
        const res = await fetch(`${config.socialUrl}/api/config/public`);
        if (res.ok) {
            const liveConf = await res.json();
            if (liveConf.maxBrainstormCycles !== undefined) config.maxBrainstormCycles = liveConf.maxBrainstormCycles;
            if (liveConf.maxDiscussionCycles !== undefined) config.maxDiscussionCycles = liveConf.maxDiscussionCycles;
        }
    } catch (e) { vlog(`[CYCLE] Failed to fetch live config: ${e.message}`); }

    try {
        const landscape = await callTool('explore', { interests: state.interests.join(',') });
        if (landscape.error) { log(`Explore failed: ${landscape.error}`, 'err'); return; }

        const decision = await decideNextMode(landscape);
        if (decision.mode !== state.mode) {
            log(`Mode transition: ${state.mode} → ${decision.mode}`, 'mode');
            state.mode = decision.mode; state.cyclesInMode = 0;
        }

        switch (state.mode) {
            case 'BRAINSTORM': await runBrainstorm(landscape); break;
            case 'DISCUSSION': await runDiscussion(landscape); break;
            case 'IMPLEMENTATION':
                if (decision.idea) await runImplementation(decision.idea);
                else { state.mode = 'BRAINSTORM'; state.cyclesInMode = 0; }
                break;
        }

        // Interest evolution disabled — was causing convergence across all agents
        // if (state.cycleCount % 10 === 0) {
        //     await reflectAndEvolve();
        // }

        saveState();
    } catch (e) {
        log(`Cycle error: ${e.message}`, 'err');
        state.mode = 'BRAINSTORM'; state.cyclesInMode = 0; saveState();
    }
}

async function main() {
    section('Gridmolt Agent — Idea-Centric');
    log(`Name: ${config.name} | Persona: ${config.persona}`);
    log(`Interests: ${config.interests.join(', ')} | Model: ${config.model}`);
    if (!config.apiKey) { log('OPENAI_API_KEY not set!', 'err'); process.exit(1); }

    loadState();

    // === Test hook: force IMPLEMENTATION mode on a specific idea ===
    // Usage: FORCE_IDEA_ID=42 npm start (inside agent-app/)
    // Bypasses BRAINSTORM and DISCUSSION so you can exercise the full
    // claim → spawn coding agent → docker build → push → handoff path.
    if (process.env.FORCE_IDEA_ID) {
        const forced = parseInt(process.env.FORCE_IDEA_ID, 10);
        if (Number.isFinite(forced)) {
            state.mode = 'IMPLEMENTATION';
            state.activeIdeaId = forced;
            state.cyclesInMode = 0;
            log(`FORCE_IDEA_ID=${forced}: starting in IMPLEMENTATION mode`, 'mode');
        }
    }

    await initMCP();

    // Register locally using MCP
    const regResult = await callTool('register', { display_name: config.name });
    agentId = regResult.agentId || 'unknown';
    log(`Agent identity: ${agentId}`, 'ok');

    const openaiOptions = { apiKey: config.apiKey || 'dummy-key' };
    if (config.baseUrl) {
        openaiOptions.baseURL = config.baseUrl;
    } else if (config.provider === 'openrouter') {
        openaiOptions.baseURL = 'https://openrouter.ai/api/v1';
    } else if (config.provider === 'ollama') {
        openaiOptions.baseURL = 'http://127.0.0.1:11434/v1';
    } else if (process.env.OPENAI_BASE_URL) {
        openaiOptions.baseURL = process.env.OPENAI_BASE_URL;
    }
    openai = new OpenAI(openaiOptions);
    try {
        await callTool('save_state', { key: 'interests', value: state.interests });
        await callTool('save_state', { key: 'persona', value: config.persona });
    } catch { }

    section('AGENT READY');
    log(`${agentId} is online!`, 'ok');

    // Sequential loop — wait for each cycle to finish before starting the next
    while (true) {
        await cycle();
        await new Promise(r => setTimeout(r, config.cycleInterval));
    }
}

function cleanupContainers() {
    if (activeContainers.size > 0) {
        log(`\nCleaning up ${activeContainers.size} orphaned docker container(s)...`, 'warn');
        for (const name of activeContainers) {
            try { require('child_process').execSync(`docker rm -f ${name}`, { stdio: 'ignore' }); } catch { }
        }
    }
}

process.on('SIGINT', () => { cleanupContainers(); saveState(); process.exit(0); });
process.on('SIGTERM', () => { cleanupContainers(); saveState(); process.exit(0); });

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
