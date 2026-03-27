# ERROR_LOG.md - Mistakes & Lessons

## 2026-03-27 17:06 UTC - Mission Board Workers Startup Failure

### Error
PM2 workers (mission-intelligence, mission-dispatcher) crashed on startup:
- `Error: supabaseUrl is required` (intelligence-engine.js)
- `ENOENT: no such file or directory, open '/home/openclaw/.openclaw/.token'` (task-dispatcher.js)

### Root Cause
PM2 ecosystem.config.cjs env vars not passed to workers. Shell script `/tmp/start-workers.sh` exports env vars but PM2 doesn't inherit them properly when started via script.

### Fix Applied
1. Updated openclaw-integration.js to try-catch token file read, fall back to env var
2. Need to use PM2 env file or inline env in ecosystem config

### Lesson
**Always verify worker processes are actually running (check logs, not just PM2 status).** PM2 "online" doesn't mean functional.

### Prevention
- Add health check endpoints for workers
- Monitor worker logs for startup errors
- Use PM2 ecosystem config with explicit env vars (not shell exports)

---

## 2026-03-27 17:06 UTC - Zombie Task in "running" State

### Error
Task "Real OpenClaw agent test" (2efbf787-7b58-4a5b-a13b-02236c051830) stuck in "running" since 16:47 (20+ min)

### Root Cause
Dispatcher never got completion event (worker crashed during execution)

### Fix Applied
Marked as failed manually via Supabase API

### Lesson
**Need task timeout + auto-cleanup.** Tasks stuck in "running" >10 min should auto-fail.

### Prevention
- Add task timeout watcher (every 5 min, check running tasks, fail if >estimated_completion_min*2)
- Add to intelligence-engine.js

---

## Mistakes Logged
1. ❌ PM2 env config not working (ecosystem.config.cjs)
2. ❌ Workers showing "online" but crashed
3. ❌ Zombie task cleanup needed

## Next Steps
1. Fix PM2 env passing (use dotenv or inline env)
2. Add task timeout watcher to intelligence-engine.js
3. Add worker health checks
4. Test full cycle: add task → dispatch → complete → verify
