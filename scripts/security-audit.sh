#!/bin/bash
# security-audit.sh — Run on any customer VPS to check security posture
set -euo pipefail

ISSUES=0

ok()   { echo "  [OK]   $*"; }
warn() { echo "  [WARN] $*"; ISSUES=$((ISSUES + 1)); }
info() { echo "  [INFO] $*"; }

echo "=== MrDelegate Security Audit — $(date) ==="
echo "=== Host: $(hostname) ==="
echo ""

# ── Firewall ─────────────────────────────────────────────────────────────────
echo "--- Firewall (UFW) ---"
if systemctl is-active --quiet ufw 2>/dev/null; then
  ok "UFW is active"
  ufw_status=$(ufw status 2>/dev/null)
  for port in 22 80 443 3333; do
    if echo "$ufw_status" | grep -q "^${port}"; then
      ok "Port ${port} allowed"
    else
      warn "Port ${port} not found in UFW rules"
    fi
  done
  default_in=$(ufw status verbose 2>/dev/null | grep "Default:" | head -1)
  if echo "$default_in" | grep -q "deny (incoming)"; then
    ok "Default incoming: DENY"
  else
    warn "Default incoming is not DENY — check UFW defaults"
  fi
else
  warn "UFW is NOT active"
fi
echo ""

# ── Fail2ban ──────────────────────────────────────────────────────────────────
echo "--- Fail2ban ---"
if systemctl is-active --quiet fail2ban 2>/dev/null; then
  ok "fail2ban is active"
  banned=$(fail2ban-client status sshd 2>/dev/null | grep "Currently banned:" | awk '{print $NF}' || echo "0")
  info "SSH currently banned IPs: ${banned}"
else
  warn "fail2ban is NOT active"
fi
echo ""

# ── SSH failed attempts ───────────────────────────────────────────────────────
echo "--- Recent SSH failures (last 24h) ---"
if command -v journalctl &>/dev/null; then
  failed_count=$(journalctl -u ssh --since "24 hours ago" 2>/dev/null | grep -c "Failed password\|Invalid user\|authentication failure" || true)
  info "Failed SSH attempts in last 24h: ${failed_count}"
  if [ "$failed_count" -gt 50 ]; then
    warn "High number of SSH failures (${failed_count}) — brute force likely"
  fi
else
  warn "journalctl not available — cannot check SSH failures"
fi
echo ""

# ── Listening ports ───────────────────────────────────────────────────────────
echo "--- Listening ports ---"
if command -v ss &>/dev/null; then
  listening=$(ss -tlnp 2>/dev/null | tail -n +2)
  echo "$listening" | while read -r line; do
    port=$(echo "$line" | awk '{print $4}' | rev | cut -d: -f1 | rev)
    case "$port" in
      22|80|443|3333) ok "Port ${port} (expected)" ;;
      *)              warn "Unexpected listening port: ${port} — line: ${line}" ;;
    esac
  done
else
  warn "ss not available — cannot check listening ports"
fi
echo ""

# ── SSH hardening ─────────────────────────────────────────────────────────────
echo "--- SSH config ---"
if grep -rq "PasswordAuthentication no" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null; then
  ok "PasswordAuthentication disabled"
else
  warn "PasswordAuthentication may be enabled — check /etc/ssh/sshd_config"
fi
if grep -rq "PermitRootLogin prohibit-password\|PermitRootLogin no" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null; then
  ok "Root login: key-only or disabled"
else
  warn "Root password login may be permitted — check PermitRootLogin"
fi
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "=== Audit complete — ${ISSUES} issue(s) found ==="
if [ "$ISSUES" -gt 0 ]; then
  exit 1
fi
