/**
 * Task Dispatcher - Auto-assign pending tasks to OpenClaw subagents
 * Runs every 30 seconds, picks highest priority pending task, spawns subagent
 */

import { createClient } from '@supabase/supabase-js';
import { spawnSubagentForTask, pollSubagentStatus } from './openclaw-integration.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MAX_CONCURRENT_TASKS = 5; // Don't overload the system

async function dispatch() {
  try {
    // 1. Check current running tasks
    const { data: running } = await supabase
      .from('mission_tasks')
      .select('id')
      .eq('status', 'running');

    if (running && running.length >= MAX_CONCURRENT_TASKS) {
      console.log(`[Dispatcher] At capacity (${running.length}/${MAX_CONCURRENT_TASKS})`);
      return { skipped: 'at_capacity' };
    }

    // 2. Get next pending task (highest priority, oldest first)
    const { data: tasks } = await supabase
      .from('mission_tasks')
      .select('*')
      .eq('status', 'pending')
      .is('locked_by', null)
      .order('priority', { ascending: true }) // P0 < P1 < P2
      .order('created_at', { ascending: true })
      .limit(1);

    if (!tasks || tasks.length === 0) {
      console.log('[Dispatcher] No pending tasks');
      return { skipped: 'no_tasks' };
    }

    const task = tasks[0];
    console.log(`[Dispatcher] Dispatching task ${task.id}: ${task.title}`);

    // 3. Lock the task
    const { error: lockError } = await supabase
      .from('mission_tasks')
      .update({
        locked_by: 'dispatcher',
        locked_at: new Date().toISOString(),
        status: 'running',
        started_at: new Date().toISOString()
      })
      .eq('id', task.id)
      .is('locked_by', null); // Optimistic lock

    if (lockError) {
      console.error(`[Dispatcher] Failed to lock task ${task.id}:`, lockError);
      return { error: 'lock_failed' };
    }

    // 4. Spawn OpenClaw subagent
    const spawnResult = await spawnSubagentForTask(task);

    if (!spawnResult.success) {
      // Mark as failed
      await supabase
        .from('mission_tasks')
        .update({
          status: 'failed',
          last_error: spawnResult.error,
          locked_by: null,
          locked_at: null
        })
        .eq('id', task.id);

      return { error: spawnResult.error };
    }

    // 5. Update task with session info
    await supabase
      .from('mission_tasks')
      .update({
        metadata: {
          ...task.metadata,
          openclaw_session_key: spawnResult.sessionKey,
          openclaw_session_id: spawnResult.sessionId,
          dispatched_at: new Date().toISOString()
        }
      })
      .eq('id', task.id);

    console.log(`[Dispatcher] Task ${task.id} dispatched to ${spawnResult.sessionKey}`);

    // Broadcast SSE update
    if (globalThis.sseConnections) {
      globalThis.sseConnections.forEach(conn => {
        conn.send('task_dispatched', {
          task_id: task.id,
          title: task.title,
          session_key: spawnResult.sessionKey
        });
      });
    }

    return {
      success: true,
      task_id: task.id,
      session_key: spawnResult.sessionKey
    };

  } catch (err) {
    console.error('[Dispatcher] Error:', err);
    return { error: err.message };
  }
}

// Run every 30 seconds
if (import.meta.url === `file://${process.argv[1]}`) {
  setInterval(dispatch, 30 * 1000);
  console.log('[Task Dispatcher] Started - running every 30 seconds');
  dispatch(); // Run once immediately
}

export { dispatch };
