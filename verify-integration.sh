#!/bin/bash
# Quick verification script for Mission Board integration

echo "🔍 Mission Board Integration Verification"
echo "=========================================="
echo ""

# Check 1: HTML has all required scripts
echo "1️⃣ Checking mission-board.html..."
if grep -q "toast.css" /root/mrdelegate/platform/src/mission-board.html; then
  echo "   ✅ Toast CSS linked"
else
  echo "   ❌ Toast CSS missing"
fi

if grep -q "toast.js" /root/mrdelegate/platform/src/mission-board.html; then
  echo "   ✅ Toast JS linked"
else
  echo "   ❌ Toast JS missing"
fi

if grep -q "live-updates.js" /root/mrdelegate/platform/src/mission-board.html; then
  echo "   ✅ Live updates JS linked"
else
  echo "   ❌ Live updates JS missing"
fi

if grep -q "MissionBoardLiveUpdates.init" /root/mrdelegate/platform/src/mission-board.html; then
  echo "   ✅ SSE initialized"
else
  echo "   ❌ SSE not initialized"
fi

# Check 2: Routes file has SSE endpoint
echo ""
echo "2️⃣ Checking routes/mission-board/index.js..."
if grep -q "eventsHandler" /root/mrdelegate/platform/src/routes/mission-board/index.js; then
  echo "   ✅ SSE handler imported"
else
  echo "   ❌ SSE handler not imported"
fi

if grep -q "/api/events" /root/mrdelegate/platform/src/routes/mission-board/index.js; then
  echo "   ✅ SSE endpoint mounted"
else
  echo "   ❌ SSE endpoint not mounted"
fi

# Check 3: Required files exist
echo ""
echo "3️⃣ Checking required files..."
FILES=(
  "/root/mrdelegate/platform/public/css/toast.css"
  "/root/mrdelegate/platform/public/js/toast.js"
  "/root/mrdelegate/platform/public/js/live-updates.js"
  "/root/mrdelegate/platform/src/lib/task-sessions.js"
  "/root/mrdelegate/platform/src/routes/mission-board/api/tasks.js"
  "/root/mrdelegate/platform/src/routes/mission-board/api/events.js"
)

for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    echo "   ✅ $(basename $file)"
  else
    echo "   ❌ $(basename $file) missing"
  fi
done

# Check 4: State files
echo ""
echo "4️⃣ Checking state files..."
if [ -f "/var/lib/mrdelegate/mission-tasks.json" ]; then
  TASKS=$(cat /var/lib/mrdelegate/mission-tasks.json | jq -r '.tasks | length' 2>/dev/null || echo "0")
  echo "   ✅ mission-tasks.json ($TASKS tasks)"
else
  echo "   ⚠️  mission-tasks.json not found (will be created)"
fi

if [ -f "/var/lib/mrdelegate/runs.json" ]; then
  echo "   ✅ runs.json"
else
  echo "   ⚠️  runs.json not found"
fi

# Check 5: Git status
echo ""
echo "5️⃣ Git status..."
cd /root/mrdelegate
if git diff --quiet platform/src/mission-board.html; then
  echo "   ✅ mission-board.html committed"
else
  echo "   ⚠️  mission-board.html has uncommitted changes"
fi

if git diff --quiet platform/src/routes/mission-board/index.js; then
  echo "   ✅ index.js committed"
else
  echo "   ⚠️  index.js has uncommitted changes"
fi

echo ""
echo "=========================================="
echo "✅ Integration verification complete!"
echo ""
echo "Next steps:"
echo "1. Restart platform server: systemctl restart mrdelegate-platform"
echo "2. Test endpoint: curl https://mrdelegate.ai/ops/mission-board"
echo "3. Open in browser and test task creation"
