#!/bin/bash
# customer-env-guard.sh — Verify customer VPS env vars are intact
# Run this in the nightly security sweep for each customer VPS
# Usage: bash customer-env-guard.sh <customer_vps_ip>

VPS_IP="$1"
REQUIRED_VARS=("STRIPE_SECRET_KEY" "SUPABASE_URL" "ANTHROPIC_API_KEY" "JWT_SECRET")
MISSING=()

for VAR in "${REQUIRED_VARS[@]}"; do
  RESULT=$(ssh -o ConnectTimeout=5 root@"$VPS_IP" "systemctl show mrdelegate-platform | grep -c '$VAR'" 2>/dev/null)
  if [ "$RESULT" -eq 0 ]; then
    MISSING+=("$VAR")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "🚨 CRITICAL: Customer VPS $VPS_IP missing env vars: ${MISSING[*]}"
  echo "   Auto-restoring from customer backup..."
  ssh root@"$VPS_IP" "bash /root/mrdelegate/platform/scripts/restore-env.sh"
  exit 1
fi

echo "✅ VPS $VPS_IP: All env vars present"
