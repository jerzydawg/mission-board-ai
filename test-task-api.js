#!/usr/bin/env node
/**
 * Quick integration test for Task Sessions API
 */

import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  addExecutionHistory,
  completeTask,
  getTaskStats,
  getBlockedTasks,
  getNextRunnableTask
} from './src/lib/task-sessions.js';

console.log('🧪 Testing Task Sessions API\n');

try {
  // Test 1: Create a task
  console.log('1️⃣ Creating P0 task...');
  const task1 = createTask({
    agentId: 'mr-web',
    taskKey: 'test-homepage-fix',
    title: 'Fix Homepage 404',
    description: 'Homepage returning 404 for some users',
    priority: 'P0',
    estimatedCompletionMin: 30,
    tags: ['frontend', 'critical']
  });
  console.log(`✅ Created task: ${task1.id} (${task1.taskKey})\n`);
  
  // Test 2: Create dependency task
  console.log('2️⃣ Creating P1 dependency task...');
  const task2 = createTask({
    agentId: 'mr-web',
    taskKey: 'test-deploy-staging',
    title: 'Deploy to Staging',
    description: 'Deploy latest code to staging',
    priority: 'P1',
    estimatedCompletionMin: 15
  });
  console.log(`✅ Created task: ${task2.id} (${task2.taskKey})\n`);
  
  // Test 3: Create task with dependency
  console.log('3️⃣ Creating P0 task with dependency...');
  const task3 = createTask({
    agentId: 'mr-web',
    taskKey: 'test-deploy-prod',
    title: 'Deploy to Production',
    description: 'Deploy after staging verification',
    priority: 'P0',
    dependencies: [task2.id],
    estimatedCompletionMin: 20
  });
  console.log(`✅ Created task: ${task3.id} (depends on ${task2.taskKey})\n`);
  
  // Test 4: List tasks
  console.log('4️⃣ Listing all tasks...');
  const { tasks, total } = listTasks();
  console.log(`✅ Found ${total} tasks:\n`);
  tasks.forEach(t => {
    console.log(`   - ${t.taskKey} [${t.priority}] (${t.status})`);
  });
  console.log();
  
  // Test 5: Get blocked tasks
  console.log('5️⃣ Checking for blocked tasks...');
  const blocked = getBlockedTasks();
  console.log(`✅ Found ${blocked.length} blocked tasks:\n`);
  blocked.forEach(b => {
    console.log(`   - ${b.task.taskKey} blocked by ${b.blockedBy.length} task(s)`);
  });
  console.log();
  
  // Test 6: Get next runnable task
  console.log('6️⃣ Getting next runnable task...');
  const nextTask = getNextRunnableTask('mr-web');
  if (nextTask) {
    console.log(`✅ Next task: ${nextTask.taskKey} [${nextTask.priority}]\n`);
  } else {
    console.log(`❌ No runnable tasks found\n`);
  }
  
  // Test 7: Update task to running
  console.log('7️⃣ Starting task...');
  const updated = updateTask(task1.id, {
    status: 'running',
    lastRunId: 'run_test_123'
  });
  console.log(`✅ Task ${updated.taskKey} is now ${updated.status}\n`);
  
  // Test 8: Add execution history
  console.log('8️⃣ Adding execution history...');
  const withHistory = addExecutionHistory(task1.id, 'run_test_123', 'completed', null);
  console.log(`✅ Added history entry (${withHistory.executionHistory.length} total)\n`);
  
  // Test 9: Complete task
  console.log('9️⃣ Completing task...');
  const completed = completeTask(task1.id, 'Fixed by redirecting to index page');
  console.log(`✅ Task completed at ${completed.completedAt}\n`);
  
  // Test 10: Get statistics
  console.log('🔟 Getting statistics...');
  const stats = getTaskStats('mr-web');
  console.log(`✅ Stats for mr-web:`);
  console.log(`   - Total tasks: ${stats.total}`);
  console.log(`   - Pending: ${stats.byStatus.pending}`);
  console.log(`   - Running: ${stats.byStatus.running}`);
  console.log(`   - Completed: ${stats.byStatus.completed}`);
  console.log(`   - P0: ${stats.byPriority.P0}, P1: ${stats.byPriority.P1}, P2: ${stats.byPriority.P2}`);
  if (stats.avgCompletionMin) {
    console.log(`   - Avg completion: ${stats.avgCompletionMin} min`);
  }
  if (stats.successRate) {
    console.log(`   - Success rate: ${stats.successRate}%`);
  }
  console.log();
  
  console.log('✅ All tests passed!\n');
  
} catch (err) {
  console.error('❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
}
