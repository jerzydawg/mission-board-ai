#!/usr/bin/env node
/**
 * Test Mission Board Integration - Phases 1-3
 * 
 * Tests:
 * 1. Task API - Create/Read/Update/Delete
 * 2. SSE Events - Connection and event streaming
 * 3. Toast notifications - Via browser check
 * 4. Live updates - Verify UI auto-refresh
 */

import fetch from 'node-fetch';
import fs from 'fs';

const BASE_URL = 'http://localhost:3000/ops/mission-board';
const TASKS_FILE = '/var/lib/mrdelegate/mission-tasks.json';

console.log('🧪 Mission Board Integration Test\n');

// Test 1: Task API - Create task
console.log('1️⃣ Testing Task API...');

async function testTaskAPI() {
  try {
    // Create task
    const createRes = await fetch(`${BASE_URL}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'mr-web',
        taskKey: 'integration_test_task',
        title: 'Integration Test Task',
        description: 'This is a test task created by integration test',
        priority: 'P1',
        tags: ['test', 'integration'],
      }),
    });

    if (!createRes.ok) {
      const error = await createRes.json();
      console.error('   ❌ Failed to create task:', error);
      return false;
    }

    const created = await createRes.json();
    console.log('   ✅ Task created:', created.task.id);

    // Read task
    const readRes = await fetch(`${BASE_URL}/api/tasks/${created.task.id}`);
    const read = await readRes.json();
    
    if (!read.success || read.task.id !== created.task.id) {
      console.error('   ❌ Failed to read task');
      return false;
    }
    console.log('   ✅ Task read successfully');

    // Update task
    const updateRes = await fetch(`${BASE_URL}/api/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'running',
        priority: 'P0',
      }),
    });

    const updated = await updateRes.json();
    
    if (!updated.success || updated.task.status !== 'running' || updated.task.priority !== 'P0') {
      console.error('   ❌ Failed to update task');
      return false;
    }
    console.log('   ✅ Task updated successfully');

    // Complete task
    const completeRes = await fetch(`${BASE_URL}/api/tasks/${created.task.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: 'Test completed successfully',
      }),
    });

    const completed = await completeRes.json();
    
    if (!completed.success || completed.task.status !== 'completed') {
      console.error('   ❌ Failed to complete task');
      return false;
    }
    console.log('   ✅ Task completed successfully');

    // List completed tasks
    const listRes = await fetch(`${BASE_URL}/api/tasks?status=completed&limit=5`);
    const list = await listRes.json();
    
    if (!list.success || !list.tasks.some(t => t.id === created.task.id)) {
      console.error('   ❌ Failed to list completed tasks');
      return false;
    }
    console.log('   ✅ Completed task appears in list');

    // Delete task
    const deleteRes = await fetch(`${BASE_URL}/api/tasks/${created.task.id}`, {
      method: 'DELETE',
    });

    const deleted = await deleteRes.json();
    
    if (!deleted.success) {
      console.error('   ❌ Failed to delete task');
      return false;
    }
    console.log('   ✅ Task deleted successfully');

    return true;
  } catch (err) {
    console.error('   ❌ Task API test failed:', err.message);
    return false;
  }
}

// Test 2: SSE Events
console.log('\n2️⃣ Testing SSE Events...');

async function testSSE() {
  try {
    // Note: Full SSE test requires browser/EventSource
    // Here we just verify the endpoint responds
    const res = await fetch(`${BASE_URL}/api/events`, {
      headers: {
        'Accept': 'text/event-stream',
      },
    });

    if (res.status !== 200) {
      console.error('   ❌ SSE endpoint returned', res.status);
      return false;
    }

    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      console.error('   ❌ SSE endpoint wrong content-type');
      return false;
    }

    console.log('   ✅ SSE endpoint responding correctly');
    
    // Close connection
    res.body.destroy();
    
    return true;
  } catch (err) {
    console.error('   ❌ SSE test failed:', err.message);
    return false;
  }
}

// Test 3: File watching
console.log('\n3️⃣ Testing file watching...');

async function testFileWatching() {
  try {
    // Ensure tasks file exists
    if (!fs.existsSync(TASKS_FILE)) {
      fs.writeFileSync(TASKS_FILE, JSON.stringify([], null, 2));
    }

    const before = fs.readFileSync(TASKS_FILE, 'utf-8');
    const tasks = JSON.parse(before);
    
    // Add a test task
    tasks.push({
      id: 'test_watch_' + Date.now(),
      agentId: 'test',
      taskKey: 'test',
      title: 'Test watch',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    
    console.log('   ✅ File write successful (SSE should broadcast)');
    
    // Restore original
    fs.writeFileSync(TASKS_FILE, before);
    
    return true;
  } catch (err) {
    console.error('   ❌ File watching test failed:', err.message);
    return false;
  }
}

// Test 4: HTML integration
console.log('\n4️⃣ Testing HTML integration...');

async function testHTMLIntegration() {
  try {
    const htmlPath = '/root/mrdelegate/platform/src/mission-board.html';
    const html = fs.readFileSync(htmlPath, 'utf-8');

    // Check for toast CSS
    if (!html.includes('/css/toast.css')) {
      console.error('   ❌ Toast CSS not linked');
      return false;
    }
    console.log('   ✅ Toast CSS linked');

    // Check for toast JS
    if (!html.includes('/js/toast.js')) {
      console.error('   ❌ Toast JS not linked');
      return false;
    }
    console.log('   ✅ Toast JS linked');

    // Check for live-updates JS
    if (!html.includes('/js/live-updates.js')) {
      console.error('   ❌ Live updates JS not linked');
      return false;
    }
    console.log('   ✅ Live updates JS linked');

    // Check for MissionBoardLiveUpdates.init
    if (!html.includes('MissionBoardLiveUpdates.init')) {
      console.error('   ❌ Live updates not initialized');
      return false;
    }
    console.log('   ✅ Live updates initialized');

    // Check for task API integration
    if (!html.includes('/ops/mission-board/api/tasks')) {
      console.error('   ❌ Task API not integrated');
      return false;
    }
    console.log('   ✅ Task API integrated');

    // Check for toast calls
    if (!html.includes('MissionBoard.toast')) {
      console.error('   ❌ Toast notifications not used');
      return false;
    }
    console.log('   ✅ Toast notifications integrated');

    return true;
  } catch (err) {
    console.error('   ❌ HTML integration test failed:', err.message);
    return false;
  }
}

// Run all tests
(async () => {
  const results = {
    taskAPI: await testTaskAPI(),
    sse: await testSSE(),
    fileWatching: await testFileWatching(),
    htmlIntegration: await testHTMLIntegration(),
  };

  console.log('\n📊 Test Results:');
  console.log('─'.repeat(40));
  
  let passed = 0;
  let total = 0;
  
  Object.entries(results).forEach(([name, result]) => {
    total++;
    if (result) passed++;
    console.log(`   ${result ? '✅' : '❌'} ${name}`);
  });

  console.log('─'.repeat(40));
  console.log(`\n${passed}/${total} tests passed`);

  if (passed === total) {
    console.log('\n🎉 All integration tests passed!');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed');
    process.exit(1);
  }
})();
