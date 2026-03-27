#!/usr/bin/env node
/**
 * VPS Lifecycle Worker
 * Runs every 15 minutes via cron on the CEO VPS.
 *
 * Responsibilities:
 *  1. Trial expiry — delete VPS for trials ended >24h with no conversion
 *  2. Cancellation queue — delete VPS where delete_after has passed (7-day grace)
 *  3. Health monitoring — check all active customer VPS, alert on unhealthy
 *  4. Billing sync — reconcile Supabase records with Vultr reality
 *  5. Orphan detection — find Vultr instances not in our DB, alert for review
 *
 * Crontab (CEO VPS):
 *   * /15 * * * * node /root/mrdelegate/platform/scripts/vps-lifecycle-worker.js >> /var/log/mrdelegate-vps-lifecycle.log 2>&1
 */

import {
  getExpiredTrials,
  getDeletionQueue,
  deleteCustomerVPS,
  getActiveVPSCustomers,
  checkVPSHealth,
  updateHealthStatus,
  reconcileVultrWithDB,
  markVPSMissing,
  sendTelegramAlert,
} from '../src/services/vps-lifecycle.js';

const RUN_TIMEOUT_MS = 12 * 60 * 1000; // 12 min max (cron fires every 15)

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg, ...args) {
  console.log(`[vps-lifecycle] ${new Date().toISOString()} ${msg}`, ...args);
}

// ── Task: Delete expired trials ───────────────────────────────────────────────

async function processExpiredTrials() {
  log('--- Checking expired trials...');
  const expired = await getExpiredTrials();

  if (expired.length === 0) {
    log('No expired trials to clean up');
    return { deleted: 0, failed: 0 };
  }

  log(`Found ${expired.length} expired trial(s) to clean up`);
  let deleted = 0;
  let failed = 0;

  for (const customer of expired) {
    const trialEndedAt = new Date(customer.trial_ends_at).toISOString();
    log(`Deleting trial VPS for ${customer.email} (trial ended ${trialEndedAt})`);
    try {
      await deleteCustomerVPS(customer, 'trial_expired');
      deleted++;
    } catch (err) {
      log(`ERROR deleting trial VPS for ${customer.email}: ${err.message}`);
      await sendTelegramAlert(
        `❌ <b>Trial VPS deletion failed</b>\n\n` +
        `<b>${customer.email}</b>\n` +
        `Error: ${err.message}`
      );
      failed++;
    }
  }

  log(`Trial cleanup done: ${deleted} deleted, ${failed} failed`);
  return { deleted, failed };
}

// ── Task: Process cancellation deletion queue ─────────────────────────────────

async function processDeletionQueue() {
  log('--- Checking cancellation deletion queue...');
  const queue = await getDeletionQueue();

  if (queue.length === 0) {
    log('No VPS in deletion queue');
    return { deleted: 0, failed: 0 };
  }

  log(`Found ${queue.length} VPS in deletion queue`);
  let deleted = 0;
  let failed = 0;

  for (const customer of queue) {
    log(`Processing deletion queue: ${customer.email} (delete_after: ${customer.delete_after})`);
    try {
      await deleteCustomerVPS(customer, 'cancellation_grace_period_ended');
      deleted++;
    } catch (err) {
      log(`ERROR deleting VPS for ${customer.email}: ${err.message}`);
      await sendTelegramAlert(
        `❌ <b>Cancellation VPS deletion failed</b>\n\n` +
        `<b>${customer.email}</b>\n` +
        `Error: ${err.message}`
      );
      failed++;
    }
  }

  log(`Deletion queue done: ${deleted} deleted, ${failed} failed`);
  return { deleted, failed };
}

// ── Task: Health check active VPS ─────────────────────────────────────────────

async function runHealthChecks() {
  log('--- Running VPS health checks...');
  const customers = await getActiveVPSCustomers();

  if (customers.length === 0) {
    log('No active VPS to health check');
    return { healthy: 0, unhealthy: 0, unreachable: 0 };
  }

  log(`Health checking ${customers.length} active VPS...`);
  const stats = { healthy: 0, unhealthy: 0, unreachable: 0 };

  // Run health checks concurrently in batches of 10
  const BATCH_SIZE = 10;
  for (let i = 0; i < customers.length; i += BATCH_SIZE) {
    const batch = customers.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async (customer) => {
      try {
        const status = await checkVPSHealth(customer);
        await updateHealthStatus(customer.id, status);
        stats[status] = (stats[status] || 0) + 1;

        if (status !== 'healthy') {
          log(`UNHEALTHY: ${customer.email} (${customer.vps_ip}) — ${status}`);

          // Alert if previously healthy or this is the first check
          const prevStatus = customer.health_status;
          if (prevStatus === 'healthy' || prevStatus === 'unknown' || !prevStatus) {
            await sendTelegramAlert(
              `⚠️ <b>VPS Health Alert</b>\n\n` +
              `<b>${customer.name || customer.email}</b>\n` +
              `IP: <code>${customer.vps_ip}</code>\n` +
              `Status: ${status}`
            );
          }
        } else {
          log(`healthy: ${customer.email} (${customer.vps_ip})`);
        }
      } catch (err) {
        log(`ERROR health check for ${customer.email}: ${err.message}`);
        stats.unreachable = (stats.unreachable || 0) + 1;
      }
    }));
  }

  log(`Health check done: ${stats.healthy} healthy, ${stats.unhealthy} unhealthy, ${stats.unreachable} unreachable`);
  return stats;
}

// ── Task: Vultr/DB reconciliation ─────────────────────────────────────────────

async function runBillingSync() {
  log('--- Running Vultr/DB reconciliation...');

  try {
    const { orphans, missing, total } = await reconcileVultrWithDB();
    log(`Vultr fleet: ${total} instance(s) | ${orphans.length} orphan(s) | ${missing.length} missing in Vultr`);

    // Alert on orphans (Vultr instances not in DB)
    if (orphans.length > 0) {
      const orphanList = orphans
        .map(i => `• <code>${i.id}</code> (${i.label || 'no label'}, ${i.main_ip || 'no IP'})`)
        .join('\n');

      await sendTelegramAlert(
        `🔍 <b>Orphan VPS Detected</b>\n\n` +
        `Found ${orphans.length} Vultr instance(s) not in our database. Review and delete manually if not needed:\n\n` +
        orphanList
      );
      log(`Alerted founder: ${orphans.length} orphan(s)`);
    }

    // Mark missing VPS in DB (exist in DB but not in Vultr — manually deleted or lost)
    for (const customer of missing) {
      log(`VPS missing from Vultr for ${customer.email} (${customer.vultr_instance_id}) — marking missing`);
      await markVPSMissing(customer);
    }

    if (missing.length > 0) {
      await sendTelegramAlert(
        `⚠️ <b>VPS Missing from Vultr</b>\n\n` +
        `${missing.length} customer VPS found in DB but not in Vultr (deleted outside system?):\n\n` +
        missing.map(c => `• ${c.email} — <code>${c.vultr_instance_id}</code>`).join('\n')
      );
    }

    return { orphans: orphans.length, missing: missing.length, total };
  } catch (err) {
    log(`ERROR during billing sync: ${err.message}`);
    await sendTelegramAlert(`❌ <b>VPS Billing Sync Failed</b>\n\nError: ${err.message}`);
    return { error: err.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('=== VPS Lifecycle Worker starting ===');

  const results = {};

  try {
    results.trials = await processExpiredTrials();
  } catch (err) {
    log(`FATAL: Trial expiry check failed: ${err.message}`);
    results.trials = { error: err.message };
  }

  try {
    results.deletionQueue = await processDeletionQueue();
  } catch (err) {
    log(`FATAL: Deletion queue check failed: ${err.message}`);
    results.deletionQueue = { error: err.message };
  }

  try {
    results.health = await runHealthChecks();
  } catch (err) {
    log(`FATAL: Health check failed: ${err.message}`);
    results.health = { error: err.message };
  }

  try {
    results.billing = await runBillingSync();
  } catch (err) {
    log(`FATAL: Billing sync failed: ${err.message}`);
    results.billing = { error: err.message };
  }

  log('=== VPS Lifecycle Worker done ===', JSON.stringify(results));
}

const runTimeout = setTimeout(() => {
  console.error(`[vps-lifecycle] Run exceeded ${RUN_TIMEOUT_MS}ms — exiting`);
  process.exit(1);
}, RUN_TIMEOUT_MS);
runTimeout.unref?.();

main().catch(err => {
  console.error('[vps-lifecycle] Fatal error:', err);
  process.exit(1);
}).finally(() => {
  clearTimeout(runTimeout);
});
