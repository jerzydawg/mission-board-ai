/**
 * OpenClaw Integration - Spawn real subagents for tasks
 * Uses HTTP API to talk to local OpenClaw Gateway
 */

import { readFileSync } from 'fs';

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || readFileSync('/home/openclaw/.openclaw/.token', 'utf-8').trim();

async function spawnSubagentForTask(task) {
  try {
    const response = await fetch(`${OPENCLAW_URL}/v1/sessions/spawn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`
      },
      body: JSON.stringify({
        task: `${task.title}\n\n${task.description || ''}`,
        mode: 'run',
        runtime: 'subagent',
        label: `mission-${task.task_key}`,
        runTimeoutSeconds: (task.estimated_completion_min || 30) * 60,
        cleanup: 'delete'
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenClaw spawn failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return {
      success: true,
      sessionKey: data.sessionKey,
      sessionId: data.sessionId
    };
  } catch (err) {
    console.error(`[OpenClaw] Failed to spawn for task ${task.id}:`, err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

async function pollSubagentStatus(sessionKey) {
  try {
    const response = await fetch(`${OPENCLAW_URL}/v1/sessions/list`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`
      }
    });

    if (!response.ok) return null;

    const data = await response.json();
    const session = data.sessions?.find(s => s.sessionKey === sessionKey);
    
    if (!session) return null;

    return {
      status: session.status || 'unknown',
      lastMessage: session.lastMessage,
      messageCount: session.messageCount
    };
  } catch (err) {
    console.error(`[OpenClaw] Failed to poll status:`, err.message);
    return null;
  }
}

export { spawnSubagentForTask, pollSubagentStatus, OPENCLAW_URL, OPENCLAW_TOKEN };
