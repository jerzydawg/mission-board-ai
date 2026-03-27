/**
 * VPS Lifecycle Service
 *
 * Handles automated VPS deletion, health monitoring, and Vultr/DB reconciliation.
 * Called by vps-lifecycle-worker.js (cron, every 15 min).
 */

import { createClient } from '@supabase/supabase-js';
import { deleteInstance, getInstance, listInstances } from './vultr-api.js';

const FOUNDER_TELEGRAM_ID = process.env.FOUNDER_TELEGRAM_ID || '262207319';
const HEALTH_CHECK_TIMEOUT_MS = 10000;
const OPENCLAW_HEALTH_PORT = 3000;

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY required');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export async function sendTelegramAlert(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !FOUNDER_TELEGRAM_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: FOUNDER_TELEGRAM_ID,
        text,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error('[vps-lifecycle] Telegram alert failed:', err.message);
  }
}

// ─── Trial Expiry ─────────────────────────────────────────────────────────────

/**
 * Returns customers whose trial ended >24h ago and never converted (still 'trial' status).
 * These VPS should be deleted — the user didn't convert or cancel, trial just lapsed.
 */
export async function getExpiredTrials() {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('customers')
    .select('id, email, name, vultr_instance_id, vps_ip, trial_ends_at, status')
    .eq('status', 'trial')
    .lt('trial_ends_at', cutoff)
    .not('vultr_instance_id', 'is', null);

  if (error) throw error;
  return data || [];
}

// ─── Cancellation Queue ───────────────────────────────────────────────────────

/**
 * Returns customers whose grace period has passed (delete_after is in the past).
 */
export async function getDeletionQueue() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customers')
    .select('id, email, name, vultr_instance_id, vps_ip, delete_after, status')
    .not('delete_after', 'is', null)
    .lt('delete_after', new Date().toISOString())
    .not('vultr_instance_id', 'is', null);

  if (error) throw error;
  return data || [];
}

// ─── VPS Deletion ─────────────────────────────────────────────────────────────

/**
 * Deletes a customer's VPS and marks them as deprovisioned in Supabase.
 * This is an automated deletion — lifecycle worker has implicit founder approval.
 */
export async function deleteCustomerVPS(customer, reason = 'lifecycle') {
  const supabase = getSupabase();
  const instanceId = customer.vultr_instance_id;

  console.log(`[vps-lifecycle] Deleting VPS ${instanceId} for ${customer.email} (reason: ${reason})`);

  // Alert founder before deletion
  await sendTelegramAlert(
    `🗑️ <b>VPS Deletion</b> — ${reason}\n\n` +
    `<b>${customer.name || customer.email}</b>\n` +
    `Instance: <code>${instanceId}</code>\n` +
    `IP: <code>${customer.vps_ip || 'unknown'}</code>`
  );

  try {
    await deleteInstance(instanceId, { confirmedByFounder: true });
    console.log(`[vps-lifecycle] VPS ${instanceId} deleted from Vultr`);
  } catch (err) {
    // If Vultr says 404, instance is already gone — treat as success
    if (err.message?.includes('404')) {
      console.warn(`[vps-lifecycle] VPS ${instanceId} not found in Vultr (already deleted?)`);
    } else {
      throw err;
    }
  }

  // Update DB
  await supabase
    .from('customers')
    .update({
      vultr_instance_id: null,
      vps_ip: null,
      vps_status: 'deprovisioned',
      delete_after: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', customer.id);

  // Log activity
  await supabase.from('activity_log').insert({
    customer_id: customer.id,
    event: 'vps_deleted',
    data: { reason, instance_id: instanceId },
  }).catch(() => {});

  console.log(`[vps-lifecycle] DB updated for ${customer.email} — VPS deprovisioned`);
}

// ─── Health Monitoring ────────────────────────────────────────────────────────

/**
 * Returns all active/trial customers with a live VPS.
 */
export async function getActiveVPSCustomers() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customers')
    .select('id, email, name, vultr_instance_id, vps_ip, vps_status, health_status, last_health_check')
    .in('status', ['active', 'trial'])
    .not('vultr_instance_id', 'is', null)
    .not('vps_ip', 'is', null);

  if (error) throw error;
  return data || [];
}

/**
 * Checks a customer's OpenClaw health endpoint.
 * Returns 'healthy', 'unhealthy', or 'unreachable'.
 */
export async function checkVPSHealth(customer) {
  const { vps_ip } = customer;
  if (!vps_ip) return 'unreachable';

  const url = `http://${vps_ip}:${OPENCLAW_HEALTH_PORT}/health`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return res.ok ? 'healthy' : 'unhealthy';
  } catch {
    return 'unreachable';
  }
}

/**
 * Updates health status in Supabase after a check.
 */
export async function updateHealthStatus(customerId, status) {
  const supabase = getSupabase();
  await supabase
    .from('customers')
    .update({
      health_status: status,
      last_health_check: new Date().toISOString(),
    })
    .eq('id', customerId);
}

// ─── Vultr / DB Reconciliation ────────────────────────────────────────────────

/**
 * Returns all Vultr instances tagged 'mrdelegate' and all DB customers with a VPS.
 * Compares them to find orphans (Vultr instances not in DB).
 */
export async function reconcileVultrWithDB() {
  const supabase = getSupabase();

  // Fetch all Vultr instances tagged for our fleet
  const allInstances = await listInstances();
  const ourInstances = (allInstances || []).filter(i =>
    i.tags?.includes('mrdelegate') || i.tags?.includes('customer')
  );

  // Fetch all DB records with a Vultr instance
  const { data: dbCustomers, error } = await supabase
    .from('customers')
    .select('id, email, vultr_instance_id, vps_status')
    .not('vultr_instance_id', 'is', null);

  if (error) throw error;

  const dbInstanceIds = new Set((dbCustomers || []).map(c => c.vultr_instance_id));
  const vultrInstanceIds = new Set(ourInstances.map(i => i.id));

  // Orphans: in Vultr but not in our DB
  const orphans = ourInstances.filter(i => !dbInstanceIds.has(i.id));

  // Missing: in DB but not in Vultr (VPS may have been manually deleted)
  const missing = (dbCustomers || []).filter(c => !vultrInstanceIds.has(c.vultr_instance_id));

  return { orphans, missing, total: ourInstances.length };
}

/**
 * Marks a DB customer's VPS as missing (deleted outside our system).
 */
export async function markVPSMissing(customer) {
  const supabase = getSupabase();
  await supabase
    .from('customers')
    .update({
      vps_status: 'missing',
      health_status: 'unreachable',
      updated_at: new Date().toISOString(),
    })
    .eq('id', customer.id);

  await supabase.from('activity_log').insert({
    customer_id: customer.id,
    event: 'vps_missing',
    data: { vultr_instance_id: customer.vultr_instance_id },
  }).catch(() => {});
}
