/**
 * Task CRUD API - Mission Board
 * Supabase-backed, all functions async
 */

import { Hono } from 'hono';
import {
  createTask,
  getTask,
  getTaskByKey,
  listTasks,
  updateTask,
  addExecutionHistory,
  addTaskProgress,
  deleteTask,
  completeTask,
  checkoutTask,
  releaseTask,
  getTaskStats,
  getBlockedTasks,
  getNextRunnableTask,
  getAuditLog,
  appendAuditLog,
  loadTasks
} from '../../../lib/task-sessions.js';

export const taskRoutes = new Hono();

// POST /api/tasks - Create a new task
taskRoutes.post('/', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.agentId && !body.agent_id) {
      return c.json({ error: 'Missing required field: agentId' }, 400);
    }
    if (body.priority && !['P0', 'P1', 'P2'].includes(body.priority)) {
      return c.json({ error: 'Invalid priority. Must be P0, P1, or P2' }, 400);
    }

    const task = await createTask({
      agentId: body.agentId || body.agent_id,
      taskKey: body.taskKey || body.task_key || `task-${Date.now()}`,
      title: body.title,
      description: body.description,
      priority: body.priority || 'P2',
      goalStream: body.goalStream || body.goal_stream || null,
      estimatedCompletionMin: body.estimatedCompletionMin || null,
      dependencies: body.dependencies || [],
      tags: body.tags || [],
      metadata: body.metadata || {}
    });

    // Broadcast SSE event
    broadcastTaskUpdate('task-created', {
      task,
      message: `New ${task.priority || 'P2'} task created`,
      timestamp: Date.now()
    });

    return c.json({ success: true, task }, 201);
  } catch (err) {
    return c.json({ error: err.message }, err.message.includes('already exists') ? 409 : 500);
  }
});

// GET /api/tasks - List tasks with filters
taskRoutes.get('/', async (c) => {
  try {
    const status = c.req.query('status') || null;
    const agentId = c.req.query('agentId') || null;
    const priority = c.req.query('priority') || null;
    const goalStream = c.req.query('goalStream') || null;
    const limit = parseInt(c.req.query('limit')) || 100;
    const offset = parseInt(c.req.query('offset')) || 0;

    const result = await listTasks({ status, agentId, priority, goalStream, limit, offset });
    return c.json({ success: true, ...result });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/tasks/stats/all
taskRoutes.get('/stats/all', async (c) => {
  try {
    const agentId = c.req.query('agentId') || null;
    const stats = await getTaskStats(agentId);
    return c.json({ success: true, stats });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/tasks/blocked/all
taskRoutes.get('/blocked/all', async (c) => {
  try {
    const blocked = await getBlockedTasks();
    return c.json({ success: true, blocked, count: blocked.length });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/tasks/next/runnable
taskRoutes.get('/next/runnable', async (c) => {
  try {
    const agentId = c.req.query('agentId') || null;
    const task = await getNextRunnableTask(agentId);
    return c.json({ success: true, task, message: task ? null : 'No runnable tasks available' });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/tasks/audit/log
taskRoutes.get('/audit/log', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit')) || 100;
    const log = await getAuditLog(limit);
    return c.json({ success: true, log, count: log.length });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/tasks/optimize/run - AI pattern analysis
taskRoutes.get('/optimize/run', async (c) => {
  try {
    const data = await loadTasks();
    const tasks = data.tasks || [];
    const completions = data.completions || [];
    const now = new Date();

    const insights = [];
    const suggestions = [];
    const escalations = [];

    // Agent load analysis
    const agentTaskCounts = {};
    tasks.forEach(t => { agentTaskCounts[t.agentId] = (agentTaskCounts[t.agentId] || 0) + 1; });
    Object.entries(agentTaskCounts).forEach(([agentId, count]) => {
      if (count >= 3) suggestions.push({ type: 'overload', message: `${agentId} has ${count} tasks queued`, agentId, taskCount: count });
    });

    // Stale P0 detection
    const staleP0 = tasks.filter(t => t.priority === 'P0' && t.status === 'pending' && (now - new Date(t.createdAt)) > 2 * 60 * 60 * 1000);
    staleP0.forEach(t => {
      const hoursOld = Math.round((now - new Date(t.createdAt)) / 3600000);
      suggestions.push({ type: 'stale_p0', message: `P0 task "${t.title}" has been pending ${hoursOld}h`, taskId: t.id, agentId: t.agentId, hoursOld });
    });

    // P1 → P0 auto-escalation (pending > 4 hours)
    const escalateP1 = tasks.filter(t => t.priority === 'P1' && t.status === 'pending' && (now - new Date(t.createdAt)) > 4 * 60 * 60 * 1000);
    for (const t of escalateP1) {
      const hoursOld = Math.round((now - new Date(t.createdAt)) / 3600000);
      escalations.push({ taskId: t.id, title: t.title, agentId: t.agentId, hoursOld, message: `Auto-escalated from P1 → P0 after ${hoursOld}h pending` });
      try {
        await updateTask(t.id, { priority: 'P0', metadata: { ...t.metadata, escalatedAt: now.toISOString(), escalatedFrom: 'P1' } });
        await appendAuditLog({ action: 'escalated', taskId: t.id, agentId: t.agentId, changes: { from: 'P1', to: 'P0', reason: `${hoursOld}h pending` } });
      } catch {}
    }

    const totalCostCents = completions.reduce((s, t) => s + (t.tokenCost || 0), 0);

    return c.json({
      success: true,
      insights,
      suggestions,
      escalations,
      summary: { agentLoad: agentTaskCounts, staleP0Count: staleP0.length, escalatedCount: escalations.length, totalCostCents },
      lastRun: now.toISOString()
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/tasks/by-key/:agentId/:taskKey
taskRoutes.get('/by-key/:agentId/:taskKey', async (c) => {
  try {
    const agentId = c.req.param('agentId');
    const taskKey = c.req.param('taskKey');
    const task = await getTaskByKey(agentId, taskKey);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    return c.json({ success: true, task });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/tasks/stream - SSE real-time updates
taskRoutes.get('/stream', (c) => {
  if (!globalThis.taskSSEConnections) globalThis.taskSSEConnections = new Map();
  const connId = Math.random().toString(36).substr(2, 9);
  let timer;

  const stream = new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder();
      const nl = '\n';
      
      // Send connected event
      ctrl.enqueue(enc.encode(`event: connected${nl}data: ${JSON.stringify({ id: connId, timestamp: Date.now() })}${nl}${nl}`));
      
      // Register connection
      globalThis.taskSSEConnections.set(connId, {
        send(type, data) {
          try {
            ctrl.enqueue(enc.encode(`event: ${type}${nl}data: ${JSON.stringify(data)}${nl}${nl}`));
          } catch (e) {
            globalThis.taskSSEConnections.delete(connId);
          }
        }
      });
      
      // Heartbeat every 30s
      timer = setInterval(() => {
        try {
          ctrl.enqueue(enc.encode(`: heartbeat${nl}${nl}`));
        } catch (e) {
          clearInterval(timer);
          globalThis.taskSSEConnections.delete(connId);
        }
      }, 30000);
    },
    cancel() {
      clearInterval(timer);
      globalThis.taskSSEConnections.delete(connId);
    }
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

// GET /api/tasks/:id
taskRoutes.get('/:id', async (c) => {
  try {
    const taskId = c.req.param('id');
    const task = await getTask(taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    return c.json({ success: true, task });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// PATCH /api/tasks/:id
taskRoutes.patch('/:id', async (c) => {
  try {
    const taskId = c.req.param('id');
    const updates = await c.req.json();
    if (updates.status && !['pending', 'running', 'paused', 'completed', 'failed', 'cancelled', 'blocked'].includes(updates.status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }
    if (updates.priority && !['P0', 'P1', 'P2'].includes(updates.priority)) {
      return c.json({ error: 'Invalid priority. Must be P0, P1, or P2' }, 400);
    }
    const task = await updateTask(taskId, updates);
    
    // Broadcast SSE event
    let message = 'Task updated';
    if (updates.status) message = `Task moved to ${updates.status}`;
    if (updates.priority) message = `Task priority changed to ${updates.priority}`;
    if (updates.agentId) message = `Task assigned to ${updates.agentId}`;
    
    broadcastTaskUpdate('task-updated', {
      task,
      changes: updates,
      message,
      timestamp: Date.now()
    });
    
    return c.json({ success: true, task });
  } catch (err) {
    return c.json({ error: err.message }, err.message.includes('not found') ? 404 : 500);
  }
});

// DELETE /api/tasks/:id
taskRoutes.delete('/:id', async (c) => {
  try {
    const taskId = c.req.param('id');
    const task = await deleteTask(taskId);
    
    // Broadcast SSE event
    broadcastTaskUpdate('task-deleted', {
      taskId,
      message: `Task deleted`,
      timestamp: Date.now()
    });
    
    return c.json({ success: true, deleted: task });
  } catch (err) {
    return c.json({ error: err.message }, err.message.includes('not found') ? 404 : 500);
  }
});

// POST /api/tasks/:id/complete
taskRoutes.post('/:id/complete', async (c) => {
  try {
    const taskId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const task = await completeTask(taskId, body.result || null);
    
    // Broadcast SSE event
    broadcastTaskUpdate('task-completed', {
      task,
      message: `Task ${task.id} completed successfully`,
      timestamp: Date.now()
    });
    
    return c.json({ success: true, task });
  } catch (err) {
    return c.json({ error: err.message }, err.message.includes('not found') ? 404 : 500);
  }
});

// POST /api/tasks/:id/progress
taskRoutes.post('/:id/progress', async (c) => {
  try {
    const taskId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const validStatuses = ['working', 'blocked', 'waiting_on_model', 'testing', 'done'];
    if (body.status && !validStatuses.includes(body.status)) {
      return c.json({ error: 'Invalid progress status' }, 400);
    }
    const task = await addTaskProgress(taskId, {
      status: body.status || 'working',
      message: body.message || '',
      currentFile: body.currentFile || null,
      nextStep: body.nextStep || null,
      blocker: body.blocker || null
    });
    return c.json({ success: true, task });
  } catch (err) {
    return c.json({ error: err.message }, err.message.includes('not found') ? 404 : 500);
  }
});

// POST /api/tasks/:id/history
taskRoutes.post('/:id/history', async (c) => {
  try {
    const taskId = c.req.param('id');
    const body = await c.req.json();
    if (!body.runId || !body.status) return c.json({ error: 'Missing required fields: runId, status' }, 400);
    if (!['completed', 'failed'].includes(body.status)) return c.json({ error: 'Invalid status' }, 400);
    const task = await addExecutionHistory(taskId, body.runId, body.status, body.error || null);
    return c.json({ success: true, task });
  } catch (err) {
    return c.json({ error: err.message }, err.message.includes('not found') ? 404 : 500);
  }
});

// POST /api/tasks/:id/checkout
taskRoutes.post('/:id/checkout', async (c) => {
  try {
    const taskId = c.req.param('id');
    const { agentId } = await c.req.json().catch(() => ({}));
    if (!agentId) return c.json({ error: 'agentId required' }, 400);
    const task = await checkoutTask(taskId, agentId);
    return c.json({ success: true, task });
  } catch (err) {
    return c.json({ error: err.message }, err.message.includes('not found') ? 404 : 409);
  }
});

// POST /api/tasks/:id/release
taskRoutes.post('/:id/release', async (c) => {
  try {
    const taskId = c.req.param('id');
    const { agentId } = await c.req.json().catch(() => ({}));
    const task = await releaseTask(taskId, agentId || null);
    return c.json({ success: true, task });
  } catch (err) {
    return c.json({ error: err.message }, err.message.includes('not found') ? 404 : 500);
  }
});

// Broadcast helper - call from task mutations
export function broadcastTaskUpdate(type, data) {
  if (!globalThis.taskSSEConnections) return;
  globalThis.taskSSEConnections.forEach(conn => {
    conn.send(type, data);
  });
}
