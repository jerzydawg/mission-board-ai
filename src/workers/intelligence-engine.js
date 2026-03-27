/**
 * Intelligence Engine - Self-learning task optimization
 * Runs every 5 minutes, analyzes patterns, auto-optimizes
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function analyzePatterns() {
  const now = new Date();
  const insights = [];
  const actions = [];

  // 1. Fetch all active + recent tasks
  const { data: tasks } = await supabase
    .from('mission_tasks')
    .select('*')
    .in('status', ['pending', 'running', 'paused', 'failed'])
    .order('created_at', { ascending: false })
    .limit(200);

  if (!tasks) return { insights, actions };

  // 2. Stale P0 detection (pending >2 hours)
  const staleP0 = tasks.filter(t => 
    t.priority === 'P0' && 
    t.status === 'pending' &&
    (now - new Date(t.created_at)) > 2 * 60 * 60 * 1000
  );

  for (const task of staleP0) {
    const hoursOld = Math.round((now - new Date(task.created_at)) / 3600000);
    insights.push({
      type: 'stale_p0',
      severity: 'critical',
      task_id: task.id,
      message: `P0 task "${task.title}" pending ${hoursOld}h`,
      agent_id: task.agent_id
    });
    actions.push({
      type: 'alert',
      target: 'bart',
      message: `🚨 P0 STALE: "${task.title}" (${hoursOld}h pending)`
    });
  }

  // 3. Auto-escalate P1 → P0 (pending >4 hours)
  const escalateCandidates = tasks.filter(t =>
    t.priority === 'P1' &&
    t.status === 'pending' &&
    (now - new Date(t.created_at)) > 4 * 60 * 60 * 1000
  );

  for (const task of escalateCandidates) {
    const hoursOld = Math.round((now - new Date(task.created_at)) / 3600000);
    await supabase
      .from('mission_tasks')
      .update({
        priority: 'P0',
        metadata: {
          ...task.metadata,
          escalated_at: now.toISOString(),
          escalated_from: 'P1',
          escalation_reason: `${hoursOld}h pending`
        }
      })
      .eq('id', task.id);

    insights.push({
      type: 'auto_escalation',
      severity: 'warning',
      task_id: task.id,
      message: `Auto-escalated P1 → P0: "${task.title}" (${hoursOld}h)`
    });
    actions.push({
      type: 'escalate',
      task_id: task.id,
      from: 'P1',
      to: 'P0',
      reason: `${hoursOld}h pending`
    });
  }

  // 4. Failed task auto-retry (failed <30 min ago, retry_count <3)
  const retryableFailed = tasks.filter(t =>
    t.status === 'failed' &&
    (now - new Date(t.updated_at)) < 30 * 60 * 1000 &&
    (t.metadata?.retry_count || 0) < 3
  );

  for (const task of retryableFailed) {
    const retryCount = (task.metadata?.retry_count || 0) + 1;
    const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 60000); // exp backoff, max 60s

    await supabase
      .from('mission_tasks')
      .update({
        status: 'pending',
        last_error: null,
        locked_by: null,
        locked_at: null,
        metadata: {
          ...task.metadata,
          retry_count: retryCount,
          retry_at: new Date(now.getTime() + backoffMs).toISOString()
        }
      })
      .eq('id', task.id);

    insights.push({
      type: 'auto_retry',
      severity: 'info',
      task_id: task.id,
      message: `Auto-retry ${retryCount}/3: "${task.title}"`
    });
  }

  // 5. Agent load balancing (detect overload)
  const agentLoad = {};
  tasks.filter(t => t.status === 'pending').forEach(t => {
    agentLoad[t.agent_id] = (agentLoad[t.agent_id] || 0) + 1;
  });

  Object.entries(agentLoad).forEach(([agent, count]) => {
    if (count >= 5) {
      insights.push({
        type: 'agent_overload',
        severity: 'warning',
        agent_id: agent,
        message: `Agent ${agent} has ${count} pending tasks`
      });
    }
  });

  // 6. Cost tracking
  const { data: completedToday } = await supabase
    .from('mission_tasks')
    .select('token_cost')
    .eq('status', 'completed')
    .gte('completed_at', new Date(now.setHours(0, 0, 0, 0)).toISOString());

  const totalCostToday = (completedToday || []).reduce((sum, t) => sum + (t.token_cost || 0), 0);

  insights.push({
    type: 'daily_cost',
    severity: 'info',
    message: `Cost today: $${(totalCostToday / 100).toFixed(2)}`,
    cost_cents: totalCostToday
  });

  return { insights, actions };
}

async function executioner() {
  try {
    console.log('[Intelligence Engine] Running analysis...');
    const { insights, actions } = await analyzePatterns();
    
    console.log(`[Intelligence Engine] ${insights.length} insights, ${actions.length} actions`);
    
    // Log insights to audit table
    if (insights.length > 0) {
      await supabase
        .from('intelligence_insights')
        .insert(insights.map(i => ({ ...i, timestamp: new Date().toISOString() })))
        .select();
    }

    // Execute actions (alerts, escalations)
    for (const action of actions) {
      if (action.type === 'alert') {
        // Broadcast to SSE clients
        if (globalThis.sseConnections) {
          globalThis.sseConnections.forEach(conn => {
            conn.send('intelligence_alert', action);
          });
        }
      }
    }

    return { success: true, insights: insights.length, actions: actions.length };
  } catch (err) {
    console.error('[Intelligence Engine] Error:', err);
    return { success: false, error: err.message };
  }
}

// Run every 5 minutes
if (import.meta.url === `file://${process.argv[1]}`) {
  setInterval(executioner, 5 * 60 * 1000);
  console.log('[Intelligence Engine] Started - running every 5 minutes');
  executioner(); // Run once immediately
}

export { analyzePatterns, executioner };
