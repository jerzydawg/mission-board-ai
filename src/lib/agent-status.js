import { readFileSync, existsSync } from 'fs';
import https from 'https';
import { join } from 'path';

const SESSIONS_PATH = '/root/.openclaw/agents/claude/sessions/sessions.json';
const RUNS_PATH = '/root/.openclaw/subagents/runs.json';
const AGENTS_CONFIG = '/root/mrdelegate/config/agents.json';

/**
 * Read real OpenClaw session data
 */
function readSessions() {
  try {
    if (!existsSync(SESSIONS_PATH)) return {};
    const raw = readFileSync(SESSIONS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read sessions:', err.message);
    return {};
  }
}

/**
 * Read subagent runs
 */
// Cached runs from CEO VPS
let _runsCache = null;
let _runsCacheTime = 0;
const RUNS_CACHE_TTL = 5000; // 5s cache

async function fetchRunsFromCEO() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'e85d2394-e115-4a5f-af10-2eccb1535a95.vultropenclaw.com',
      path: '/runs',
      method: 'GET',
      headers: { 'Authorization': 'Bearer c202922d1928fce6cc8bab6c7913cf48e56003e129ce7281' },
      timeout: 3000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ active: [], recent: [], counts: { active: 0, completed: 0 } }); }
      });
    });
    req.on('error', () => resolve({ active: [], recent: [], counts: { active: 0, completed: 0 } }));
    req.on('timeout', () => { req.destroy(); resolve({ active: [], recent: [], counts: { active: 0, completed: 0 } }); });
    req.end();
  });
}

function readRuns() {
  try {
    if (!existsSync(RUNS_PATH)) return { runs: {} };
    const raw = readFileSync(RUNS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return { runs: {} };
  }
}

/**
 * Read agent config
 */
function readAgentConfig() {
  try {
    if (!existsSync(AGENTS_CONFIG)) return { agents: [] };
    const raw = readFileSync(AGENTS_CONFIG, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read agent config:', err.message);
    return { agents: [] };
  }
}

/**
 * Get live agent status from OpenClaw sessions
 */
export function getLiveAgentStatus() {
  const sessions = readSessions();
  const runsData = readRuns();
  const config = readAgentConfig();
  
  const agents = [];
  const now = Date.now();

  // Process each session
  for (const [sessionKey, sessionData] of Object.entries(sessions)) {
    // Skip if not ACP session
    if (!sessionData.acp) continue;

    const agent = {
      id: sessionKey,
      sessionId: sessionData.sessionId,
      label: sessionData.label || 'Untitled Task',
      spawnedBy: sessionData.spawnedBy,
      lastActivity: sessionData.updatedAt,
      status: determineStatus(sessionData, now),
      acp: sessionData.acp
    };

    agents.push(agent);
  }

  // Process subagent runs
  const runs = [];
  for (const [runId, runData] of Object.entries(runsData.runs)) {
    runs.push({
      runId,
      task: runData.task,
      status: runData.outcome?.status || 'running',
      startedAt: runData.startedAt,
      endedAt: runData.endedAt,
      endedReason: runData.endedReason,
      sessionKey: runData.childSessionKey
    });
  }

  // Match config agents with sessions
  const enrichedAgents = config.agents.map(configAgent => {
    const activeSession = agents.find(a => 
      a.label && a.label.toLowerCase().includes(configAgent.id.toLowerCase())
    );

    return {
      id: configAgent.id,
      name: configAgent.name,
      description: configAgent.description,
      enabled: configAgent.enabled !== false,
      status: activeSession ? activeSession.status : 'idle',
      currentTask: activeSession ? activeSession.label : null,
      lastActive: activeSession ? activeSession.lastActivity : null,
      sessionId: activeSession ? activeSession.sessionId : null,
      tags: configAgent.tags || []
    };
  });

  return {
    agents: enrichedAgents,
    sessions: agents,
    runs: runs.slice(0, 20), // Last 20 runs
    summary: {
      total: enrichedAgents.length,
      working: enrichedAgents.filter(a => a.status === 'working').length,
      idle: enrichedAgents.filter(a => a.status === 'idle').length,
      error: enrichedAgents.filter(a => a.status === 'error').length,
      activeSessionsCount: agents.filter(a => a.status === 'working').length
    },
    lastUpdated: now
  };
}

/**
 * Determine agent status from session data
 */
function determineStatus(sessionData, now) {
  const acp = sessionData.acp;
  if (!acp) return 'idle';

  // Check ACP state
  if (acp.state === 'running' || acp.state === 'active') return 'working';
  if (acp.state === 'error') return 'error';
  if (acp.state === 'idle') return 'idle';

  // Check last activity (if updated in last 5 min = working)
  const timeSinceUpdate = now - sessionData.updatedAt;
  if (timeSinceUpdate < 5 * 60 * 1000) return 'working';

  return 'idle';
}

/**
 * Get detailed session info
 */
export function getSessionDetails(sessionId) {
  const sessions = readSessions();
  
  for (const [key, data] of Object.entries(sessions)) {
    if (data.sessionId === sessionId) {
      return {
        ...data,
        sessionKey: key
      };
    }
  }
  
  return null;
}

/**
 * Get active runs
 */
export async function getActiveRuns() {
  try {
    const data = await fetchRunsFromCEO();
    return data;
  } catch (err) {
    return { active: [], recent: [], counts: { active: 0, completed: 0 } };
  }
}

/**
 * Get recent completions
 */
export function getRecentCompletions(limit = 20) {
  const runsData = readRuns();
  const completions = [];

  for (const [runId, runData] of Object.entries(runsData.runs)) {
    if (runData.endedAt) {
      completions.push({
        runId,
        task: runData.task,
        startedAt: runData.startedAt,
        endedAt: runData.endedAt,
        status: runData.outcome?.status || 'unknown',
        endedReason: runData.endedReason,
        duration: runData.endedAt - runData.startedAt
      });
    }
  }

  return completions
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, limit);
}
