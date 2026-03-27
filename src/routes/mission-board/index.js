import { Hono } from 'hono';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { 
  getLiveAgentStatus, 
  getActiveRuns, 
  getRecentCompletions,
  getSessionDetails 
} from '../../lib/agent-status.js';
import { taskRoutes } from './api/tasks.js';
// eventsHandler replaced with inline Hono SSE

const __dirname = dirname(fileURLToPath(import.meta.url));

export const missionBoardRoutes = new Hono();

// Mount new task management API
missionBoardRoutes.route('/api/tasks', taskRoutes);

// Mount SSE events endpoint — Hono SSE
missionBoardRoutes.get('/api/events', (c) => {
  if (!globalThis.sseConnections) globalThis.sseConnections = new Map();
  const connId = Math.random().toString(36).substr(2, 9);
  let timer;

  const stream = new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder();
      const nl = '\n';
      ctrl.enqueue(enc.encode('event: connected' + nl + 'data: ' + JSON.stringify({id:connId}) + nl + nl));
      globalThis.sseConnections.set(connId, {
        send(type, data) {
          try { ctrl.enqueue(enc.encode('event: ' + type + nl + 'data: ' + JSON.stringify(data) + nl + nl)); }
          catch(e) { globalThis.sseConnections.delete(connId); }
        }
      });
      timer = setInterval(() => {
        try { ctrl.enqueue(enc.encode(': heartbeat' + nl + nl)); }
        catch(e) { clearInterval(timer); }
      }, 30000);
    },
    cancel() { clearInterval(timer); globalThis.sseConnections.delete(connId); }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
});

const TASKS_PATH = '/var/lib/mrdelegate/mission-tasks.json';

// Helper: Get mission tasks
function getMissionTasks() {
  try {
    if (!existsSync(TASKS_PATH)) return { tasks: [], completions: [] };
    return JSON.parse(readFileSync(TASKS_PATH, 'utf-8'));
  } catch {
    return { tasks: [], completions: [] };
  }
}

// Helper: Save mission tasks
function saveMissionTasks(data) {
  writeFileSync(TASKS_PATH, JSON.stringify(data, null, 2));
}

// GET /ops/mission-board — Main dashboard
missionBoardRoutes.get('/', (c) => {
  const html = readFileSync(join(__dirname, '../../mission-board.html'), 'utf-8');
  return c.html(html);
});

// GET /api/mission-board/agents — Get all agents with REAL status from OpenClaw
missionBoardRoutes.get('/api/agents', async (c) => {
  const liveData = getLiveAgentStatus();
  // Count working agents from running tasks in Supabase
  let workingFromTasks = 0;
  try {
    const sbUrl = process.env.SUPABASE_URL || '';
    const sbKey = process.env.SUPABASE_SERVICE_KEY || '';
    if (sbUrl && sbKey) {
      const r = await fetch(sbUrl + '/rest/v1/mission_tasks?status=eq.running&select=agent_id', {
        headers: { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey }
      });
      if (r.ok) {
        const rows = await r.json();
        workingFromTasks = new Set(rows.map(t => t.agent_id).filter(Boolean)).size;
      }
    }
  } catch(e) {}
  
  return c.json({
    agents: liveData.agents,
    summary: { ...liveData.summary, working: workingFromTasks || liveData.summary.working },
    lastUpdated: liveData.lastUpdated,
    activeSessionsCount: liveData.summary.activeSessionsCount
  });
});

// GET /api/mission-board/sessions — Get all active sessions (detailed)
missionBoardRoutes.get('/api/sessions', (c) => {
  const liveData = getLiveAgentStatus();
  
  return c.json({
    sessions: liveData.sessions,
    count: liveData.sessions.length
  });
});

// GET /api/mission-board/runs — Get active runs and recent completions
missionBoardRoutes.get('/api/runs', async (c) => {
  const runsData = await getActiveRuns();
  const recentCompletions = [];
  
  return c.json({
    active: runsData.active || [],
    recent: recentCompletions,
    counts: {
      active: (runsData.active || []).length,
      completed: recentCompletions.length
    }
  });
});

// GET /api/mission-board/tasks — Get current and recent tasks
missionBoardRoutes.get('/api/tasks', (c) => {
  const tasks = getMissionTasks();
  
  return c.json({
    current: (tasks.tasks || []).filter(t => t.status === 'in_progress'),
    pending: (tasks.tasks || []).filter(t => t.status === 'pending'),
    completions: (tasks.completions || []).slice(0, 20) // Last 20 completions
  });
});

// POST /api/mission-board/assign — Assign a task to an agent
missionBoardRoutes.post('/api/assign', async (c) => {
  try {
    const { agentId, task, priority } = await c.req.json();
    
    if (!agentId || !task) {
      return c.json({ error: 'agentId and task are required' }, 400);
    }

    const tasks = getMissionTasks();
    const newTask = {
      id: `task_${Date.now()}`,
      assignedTo: agentId,
      description: task,
      priority: priority || 'normal',
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    tasks.tasks = tasks.tasks || [];
    tasks.tasks.push(newTask);
    saveMissionTasks(tasks);

    return c.json({ success: true, task: newTask });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/mission-board/learnings — Serve MISSION-BOARD-LEARNINGS.md as text/JSON
missionBoardRoutes.get('/api/learnings', (c) => {
  const learningsPath = '/root/mrdelegate/agents/ceo/intelligence/MISSION-BOARD-LEARNINGS.md';
  try {
    if (!existsSync(learningsPath)) {
      return c.json({ success: true, content: null, message: 'No learnings yet — run /api/tasks/optimize/run first' });
    }
    const content = readFileSync(learningsPath, 'utf-8');
    return c.json({ success: true, content, lastUpdated: new Date().toISOString() });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/mission-board/agent-states — Get pause/governance states
missionBoardRoutes.get('/api/agent-states', (c) => {
  const statesPath = '/var/lib/mrdelegate/agent-states.json';
  try {
    if (!existsSync(statesPath)) return c.json({ success: true, states: {} });
    return c.json({ success: true, states: JSON.parse(readFileSync(statesPath, 'utf-8')) });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/mission-board/agent-states — Pause/resume/terminate an agent
missionBoardRoutes.post('/api/agent-states', async (c) => {
  const statesPath = '/var/lib/mrdelegate/agent-states.json';
  try {
    const { agentId, action } = await c.req.json();
    if (!agentId || !action) return c.json({ error: 'agentId and action required' }, 400);
    if (!['pause', 'resume', 'terminate'].includes(action)) return c.json({ error: 'Invalid action' }, 400);

    let states = {};
    if (existsSync(statesPath)) {
      try { states = JSON.parse(readFileSync(statesPath, 'utf-8')); } catch {}
    }
    states[agentId] = { action, updatedAt: new Date().toISOString() };
    const dir = statesPath.split('/').slice(0, -1).join('/');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statesPath, JSON.stringify(states, null, 2));
    return c.json({ success: true, agentId, action });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/mission-board/agent-budgets — Per-agent budget tracking
missionBoardRoutes.get('/api/agent-budgets', (c) => {
  const budgetsPath = '/var/lib/mrdelegate/agent-budgets.json';
  try {
    if (!existsSync(budgetsPath)) return c.json({ success: true, budgets: {} });
    return c.json({ success: true, budgets: JSON.parse(readFileSync(budgetsPath, 'utf-8')) });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/mission-board/complete — Mark a task as complete
missionBoardRoutes.post('/api/complete', async (c) => {
  try {
    const { taskId, result } = await c.req.json();
    
    if (!taskId) {
      return c.json({ error: 'taskId is required' }, 400);
    }

    const tasks = getMissionTasks();
    const taskIndex = tasks.tasks?.findIndex(t => t.id === taskId);
    
    if (taskIndex === -1 || taskIndex === undefined) {
      return c.json({ error: 'Task not found' }, 404);
    }

    const completedTask = tasks.tasks[taskIndex];
    completedTask.status = 'completed';
    completedTask.completedAt = new Date().toISOString();
    completedTask.result = result || 'Completed';

    // Move to completions
    tasks.completions = tasks.completions || [];
    tasks.completions.unshift(completedTask);
    tasks.tasks.splice(taskIndex, 1);

    // Keep only last 100 completions
    if (tasks.completions.length > 100) {
      tasks.completions = tasks.completions.slice(0, 100);
    }

    saveMissionTasks(tasks);

    return c.json({ success: true, task: completedTask });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});
