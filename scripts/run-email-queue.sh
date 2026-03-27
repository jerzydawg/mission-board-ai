#!/bin/bash
# Email queue processor wrapper — called by cron every 5 minutes
# Sources env vars from systemd env.conf (primary) and morning-brief.env (fallback),
# then runs the Node processor.

set -e

# Source env vars from the platform service config (primary)
ENV_FILE="/etc/systemd/system/mrdelegate-platform.service.d/env.conf"
if [ -f "$ENV_FILE" ]; then
  # Parse Environment= lines from systemd env.conf
  while IFS= read -r line; do
    if [[ "$line" =~ ^Environment=(.+)$ ]]; then
      export "${BASH_REMATCH[1]}"
    fi
  done < "$ENV_FILE"
fi

# Fallback: source morning-brief.env if RESEND_API_KEY still not set
BRIEF_ENV="/root/mrdelegate/platform/scripts/morning-brief.env"
if [ -z "$RESEND_API_KEY" ] && [ -f "$BRIEF_ENV" ]; then
  set -a
  source "$BRIEF_ENV"
  set +a
fi

# Also export NODE_ENV
export NODE_ENV=production

cd /root/mrdelegate/platform
exec /usr/bin/node scripts/process-email-queue.js
