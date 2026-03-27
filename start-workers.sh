#!/bin/bash
# Mission Board Worker Launcher - ensures env vars are set
set -e

export NODE_ENV=production
export SUPABASE_URL=https://mwsvekxgkjlmbglargmg.supabase.co
export SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im13c3Zla3hna2psbWJnbGFyZ21nIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzkxOTE3MiwiZXhwIjoyMDg5NDk1MTcyfQ._2NymYGbZDJYmyyyjrZ0niD7VaqCULhjZho1aeU3EtQ
export OPENCLAW_URL=http://127.0.0.1:18789
export OPENCLAW_TOKEN=P0bLOExLU30tRossxTrZjYELqWd3EZLm

cd /home/openclaw/.openclaw/mission-board-local

# Kill existing workers
pm2 delete mission-intelligence mission-dispatcher 2>/dev/null || true

# Start with env vars in PM2 interpreter args
pm2 start src/workers/intelligence-engine.js --name mission-intelligence \
  --node-args="--env-file=.env" 2>/dev/null || \
  node src/workers/intelligence-engine.js &

pm2 start src/workers/task-dispatcher.js --name mission-dispatcher \
  --node-args="--env-file=.env" 2>/dev/null || \
  node src/workers/task-dispatcher.js &

pm2 save
pm2 list
