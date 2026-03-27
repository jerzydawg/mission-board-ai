/**
 * Mission Board Live Updates - SSE Event Stream
 * Real-time notifications for agent task updates
 * 
 * Improvements over Paperclip:
 * - Offline event queue (buffered events on reconnect)
 * - Event filtering by agent/priority/type
 * - Heartbeat with connection health
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SSE connection pool
const connections = new Set();

// Event buffer for offline clients (last 50 events)
const eventBuffer = [];
const MAX_BUFFER_SIZE = 50;

// File watcher for mission-tasks.json
const TASKS_FILE = '/var/lib/mrdelegate/mission-tasks.json';
const RUNS_FILE = '/var/lib/mrdelegate/runs.json';
let tasksWatcher = null;
let runsWatcher = null;
let lastTasksContent = null;
let lastRunsContent = null;

/**
 * SSE connection handler
 */
export default function handler(req, res) {
  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Nginx SSE fix
  });

  // Parse query filters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filters = {
    agent: url.searchParams.get('agent'), // Filter by agentId
    priority: url.searchParams.get('priority'), // Filter by P0/P1/P2
    type: url.searchParams.get('type'), // Filter by event type
  };

  // Create connection object
  const connection = {
    id: Math.random().toString(36).substr(2, 9),
    res,
    filters,
    lastEventId: parseInt(url.searchParams.get('lastEventId') || '0', 10),
  };

  connections.add(connection);

  // Send initial connection event
  sendEvent(connection, {
    type: 'connected',
    data: {
      connectionId: connection.id,
      timestamp: Date.now(),
      bufferSize: eventBuffer.length,
    },
  });

  // Send buffered events if client reconnected
  if (connection.lastEventId > 0) {
    const missedEvents = eventBuffer.filter(
      (event) => event.id > connection.lastEventId
    );
    missedEvents.forEach((event) => sendEvent(connection, event));
  }

  // Heartbeat interval (every 30s)
  const heartbeatInterval = setInterval(() => {
    sendEvent(connection, {
      type: 'heartbeat',
      data: { timestamp: Date.now() },
    });
  }, 30000);

  // Start file watchers if not running
  startWatchers();

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    connections.delete(connection);
    
    // Stop watchers if no connections
    if (connections.size === 0) {
      stopWatchers();
    }
  });
}

/**
 * Send SSE event to specific connection
 */
function sendEvent(connection, event) {
  // Apply filters
  if (connection.filters.agent && event.data?.agentId !== connection.filters.agent) {
    return;
  }
  if (connection.filters.priority && event.data?.priority !== connection.filters.priority) {
    return;
  }
  if (connection.filters.type && event.type !== connection.filters.type) {
    return;
  }

  // Format SSE message
  const id = event.id || Date.now();
  const data = JSON.stringify(event.data || {});
  
  connection.res.write(`id: ${id}\n`);
  connection.res.write(`event: ${event.type}\n`);
  connection.res.write(`data: ${data}\n\n`);
}

/**
 * Broadcast event to all connections
 */
function broadcast(event) {
  // Add to buffer
  const eventWithId = {
    ...event,
    id: Date.now(),
  };
  
  eventBuffer.push(eventWithId);
  
  // Keep buffer size limited
  if (eventBuffer.length > MAX_BUFFER_SIZE) {
    eventBuffer.shift();
  }

  // Send to all connections
  connections.forEach((connection) => {
    sendEvent(connection, eventWithId);
  });
}

/**
 * Start file watchers
 */
function startWatchers() {
  if (tasksWatcher || runsWatcher) return; // Already running

  // Watch mission-tasks.json
  if (fs.existsSync(TASKS_FILE)) {
    lastTasksContent = fs.readFileSync(TASKS_FILE, 'utf-8');
    
    tasksWatcher = fs.watch(TASKS_FILE, (eventType) => {
      if (eventType === 'change') {
        handleTasksChange();
      }
    });
  }

  // Watch runs.json
  if (fs.existsSync(RUNS_FILE)) {
    lastRunsContent = fs.readFileSync(RUNS_FILE, 'utf-8');
    
    runsWatcher = fs.watch(RUNS_FILE, (eventType) => {
      if (eventType === 'change') {
        handleRunsChange();
      }
    });
  }
}

/**
 * Stop file watchers
 */
function stopWatchers() {
  if (tasksWatcher) {
    tasksWatcher.close();
    tasksWatcher = null;
  }
  if (runsWatcher) {
    runsWatcher.close();
    runsWatcher = null;
  }
}

/**
 * Handle mission-tasks.json changes
 */
function handleTasksChange() {
  try {
    const newContent = fs.readFileSync(TASKS_FILE, 'utf-8');
    
    // Skip if content unchanged (debounce)
    if (newContent === lastTasksContent) return;
    
    const oldTasks = JSON.parse(lastTasksContent || '[]');
    const newTasks = JSON.parse(newContent);
    
    lastTasksContent = newContent;

    // Detect changes
    newTasks.forEach((newTask) => {
      const oldTask = oldTasks.find((t) => t.id === newTask.id);
      
      if (!oldTask) {
        // New task created
        broadcast({
          type: 'task_assigned',
          data: {
            taskId: newTask.id,
            agentId: newTask.agentId,
            title: newTask.title,
            priority: newTask.priority,
            timestamp: Date.now(),
            actor: resolveActor(newTask.assignedBy),
          },
        });
      } else if (JSON.stringify(oldTask.progress || []) !== JSON.stringify(newTask.progress || [])) {
        const latest = (newTask.progress || [])[newTask.progress.length - 1];
        if (latest) {
          broadcast({
            type: 'task_progress',
            data: {
              taskId: newTask.id,
              agentId: newTask.agentId,
              title: newTask.title,
              priority: newTask.priority,
              progress: latest,
              timestamp: Date.now(),
              actor: resolveActor(newTask.agentId),
            },
          });
        }
      } else if (oldTask.status !== newTask.status) {
        // Task status changed
        if (newTask.status === 'completed') {
          broadcast({
            type: 'task_completed',
            data: {
              taskId: newTask.id,
              agentId: newTask.agentId,
              title: newTask.title,
              priority: newTask.priority,
              duration: newTask.completedAt - newTask.startedAt,
              timestamp: Date.now(),
              actor: resolveActor(newTask.agentId),
            },
          });
        } else if (newTask.status === 'failed') {
          broadcast({
            type: 'task_failed',
            data: {
              taskId: newTask.id,
              agentId: newTask.agentId,
              title: newTask.title,
              error: newTask.lastError,
              timestamp: Date.now(),
              actor: resolveActor(newTask.agentId),
            },
          });
        }
      } else if (oldTask.priority !== newTask.priority) {
        // Priority changed
        broadcast({
          type: 'task_priority_changed',
          data: {
            taskId: newTask.id,
            agentId: newTask.agentId,
            title: newTask.title,
            oldPriority: oldTask.priority,
            newPriority: newTask.priority,
            timestamp: Date.now(),
            actor: resolveActor('ceo'),
          },
        });
      }
    });
  } catch (err) {
    console.error('[SSE] Error handling tasks change:', err);
  }
}

/**
 * Handle runs.json changes
 */
function handleRunsChange() {
  try {
    const newContent = fs.readFileSync(RUNS_FILE, 'utf-8');
    
    // Skip if content unchanged
    if (newContent === lastRunsContent) return;
    
    const oldRuns = JSON.parse(lastRunsContent || '[]');
    const newRuns = JSON.parse(newContent);
    
    lastRunsContent = newContent;

    // Detect new runs
    newRuns.forEach((newRun) => {
      const oldRun = oldRuns.find((r) => r.id === newRun.id);
      
      if (!oldRun && newRun.status === 'running') {
        // Agent run started
        broadcast({
          type: 'agent_run_started',
          data: {
            runId: newRun.id,
            agentId: newRun.agentId,
            taskId: newRun.taskId,
            timestamp: Date.now(),
            actor: resolveActor(newRun.agentId),
          },
        });
      } else if (oldRun && oldRun.status === 'running' && newRun.status === 'completed') {
        // Agent run completed
        broadcast({
          type: 'agent_run_completed',
          data: {
            runId: newRun.id,
            agentId: newRun.agentId,
            taskId: newRun.taskId,
            duration: newRun.completedAt - newRun.startedAt,
            timestamp: Date.now(),
            actor: resolveActor(newRun.agentId),
          },
        });
      } else if (oldRun && oldRun.status === 'running' && newRun.status === 'failed') {
        // Agent run failed
        broadcast({
          type: 'agent_run_failed',
          data: {
            runId: newRun.id,
            agentId: newRun.agentId,
            taskId: newRun.taskId,
            error: newRun.error,
            timestamp: Date.now(),
            actor: resolveActor(newRun.agentId),
          },
        });
      }
    });
  } catch (err) {
    console.error('[SSE] Error handling runs change:', err);
  }
}

/**
 * Resolve actor name from ID
 */
function resolveActor(actorId) {
  const actors = {
    'ceo': 'CEO',
    'mr-web': 'Mr. Web',
    'mr-seo': 'Mr. SEO',
    'mr-copy': 'Mr. Copy',
    'mr-design': 'Mr. Design',
    'mr-leadgen': 'Mr. LeadGen',
    'mr-email': 'Mr. Email',
    'mr-support': 'Mr. Support',
    'mr-analytics': 'Mr. Analytics',
    'mr-infra': 'Mr. Infra',
    'mr-qa': 'Mr. QA',
    'miamicarlos': 'MiamiCarlos',
    'system': 'System',
  };
  
  return actors[actorId] || actorId;
}

// Export for manual event broadcasting
export { broadcast };
