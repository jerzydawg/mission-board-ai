#!/bin/bash
# restore-env.sh — Restore environment variables from backup
# Run this if env.conf ever gets wiped or corrupted
# Usage: bash /root/mrdelegate/platform/scripts/restore-env.sh

set -e

BACKUP="/root/mrdelegate-secrets/env-backup.conf"
TARGET="/etc/systemd/system/mrdelegate-platform.service.d/env.conf"

if [ ! -f "$BACKUP" ]; then
  echo "❌ ERROR: Backup not found at $BACKUP"
  echo "   Contact founder — keys need to be re-entered manually."
  exit 1
fi

echo "🔄 Restoring env.conf from backup..."
mkdir -p "$(dirname "$TARGET")"
cp "$BACKUP" "$TARGET"
chmod 600 "$TARGET"
systemctl daemon-reload
echo "✅ Restored. Restarting platform service..."
systemctl restart mrdelegate-platform 2>/dev/null || echo "⚠️  Service not running — start manually with: systemctl start mrdelegate-platform"
echo "✅ Done."
