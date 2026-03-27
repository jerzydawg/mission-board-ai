#!/usr/bin/env node
// Email Queue Processor
// Runs every 5 minutes via cron. Picks up pending emails from Supabase email_queue,
// renders the sequence template, sends via Resend, and marks as sent/failed.
//
// Usage: node /root/mrdelegate/platform/scripts/process-email-queue.js
// Cron: every 5 min via run-email-queue.sh

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// ── Config ──────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[email-queue] SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
  process.exit(1);
}
if (!RESEND_KEY) {
  console.error('[email-queue] RESEND_API_KEY not set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const resend = new Resend(RESEND_KEY);
const EMAIL_QUEUE_BATCH_SIZE = Number(process.env.EMAIL_QUEUE_BATCH_SIZE || 50);
const EMAIL_QUEUE_SEND_TIMEOUT_MS = Number(process.env.EMAIL_QUEUE_SEND_TIMEOUT_MS || 30000);
const EMAIL_QUEUE_RUN_TIMEOUT_MS = Number(process.env.EMAIL_QUEUE_RUN_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_WELCOME_RETRIES = Number(process.env.EMAIL_QUEUE_MAX_WELCOME_RETRIES || 3);

// ── Import sequence builder ─────────────────────────────────────
// We need to dynamically import since this runs standalone
import { buildSequenceEmail } from '../src/services/email.js';

async function getRetentionStats(customerId, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [{ count: triagedCount, error: triagedError }, { data: activityRows, error: activityError }] = await Promise.all([
    supabase
      .from('triaged_emails')
      .select('*', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .gte('created_at', since),
    supabase
      .from('activity_log')
      .select('event,data')
      .eq('customer_id', customerId)
      .gte('created_at', since)
      .in('event', ['morning_brief', 'calendar_protection']),
  ]);

  if (triagedError) throw triagedError;
  if (activityError) throw activityError;

  const rows = activityRows || [];
  const briefsDelivered = rows.filter((row) => row.event === 'morning_brief' && row.data?.success !== false).length;
  const calendarRows = rows.filter((row) => row.event === 'calendar_protection');
  const calendarAlerts = calendarRows.reduce((sum, row) => sum + Number(row.data?.issues || 0), 0);
  const focusBlocksCreated = calendarRows.reduce((sum, row) => sum + (row.data?.focusBlockCreated ? 1 : 0), 0);
  const emailsTriaged = triagedCount || 0;
  const estimatedHoursSaved = Math.round((((emailsTriaged * 4) + (briefsDelivered * 6) + (calendarAlerts * 5) + (focusBlocksCreated * 15)) / 60) * 10) / 10;

  return {
    briefsDelivered,
    emailsTriaged,
    calendarAlerts,
    focusBlocksCreated,
    estimatedHoursSaved,
  };
}

async function getCalendarConnectionState(customerId) {
  const { count, error } = await supabase
    .from('customer_connectors')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .eq('connector_type', 'google_calendar')
    .eq('connected', true);

  if (error) throw error;
  return (count || 0) > 0;
}

async function enrichContext(seqName, customerId, context) {
  if (!customerId) return context;
  const enriched = { ...context };

  if (seqName === 'weekOneStats') {
    enriched.stats = await getRetentionStats(customerId, 7);
  } else if (seqName === 'monthOneSummary') {
    enriched.stats = await getRetentionStats(customerId, 30);
  } else if (seqName === 'featureSpotlight') {
    enriched.calendarConnected = await getCalendarConnectionState(customerId);
  }

  return enriched;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// ── Main ────────────────────────────────────────────────────────
async function processQueue() {
  const now = new Date().toISOString();

  // Fetch pending emails that are due
  const { data: pending, error } = await supabase
    .from('email_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', now)
    .order('scheduled_for', { ascending: true })
    .limit(EMAIL_QUEUE_BATCH_SIZE);

  if (error) {
    console.error('[email-queue] Failed to fetch queue:', error.message);
    process.exit(1);
  }

  if (!pending || pending.length === 0) {
    console.log(`[email-queue] ${new Date().toISOString()} — No pending emails`);
    return;
  }

  console.log(`[email-queue] ${new Date().toISOString()} — Processing ${pending.length} emails`);

  for (const item of pending) {
    try {
      // Check if customer still exists and hasn't unsubscribed/cancelled
      // (For cancellation emails, we still send)
      const { data: customer } = await supabase
        .from('customers')
        .select('name, email, status, email_unsubscribed')
        .eq('id', item.customer_id)
        .single();

      if (!customer) {
        console.log(`[email-queue] Skipping ${item.id} — customer not found`);
        await markFailed(item.id, 'Customer not found', item);
        continue;
      }

      if (customer.email_unsubscribed) {
        console.log(`[email-queue] Skipping ${item.id} — customer unsubscribed`);
        await supabase
          .from('email_queue')
          .update({ status: 'failed', error: 'Unsubscribed' })
          .eq('id', item.id);
        continue;
      }

      // Build the email from sequence template
      const seqName = item.data?.sequence || item.template;
      const stepIndex = item.data?.step ?? 0;
      const name = item.data?.name || customer.name || customer.email.split('@')[0];

      let subject, html;
      try {
        // Pass extra context for dynamic emails (e.g. welcome email needs bot_username)
        const context = await enrichContext(seqName, item.customer_id, item.data?.context || {});
        // For welcome emails, try to get bot_username from customer record if not in context
        if (seqName === 'welcome' && !context.bot_username) {
          const { data: fullCustomer } = await supabase
            .from('customers')
            .select('bot_username')
            .eq('id', item.customer_id)
            .single();
          if (fullCustomer?.bot_username) {
            context.bot_username = fullCustomer.bot_username;
          }
        }
        const built = buildSequenceEmail(seqName, stepIndex, name, item.to_email, context);
        subject = built.subject;
        html = built.html;
      } catch (buildErr) {
        // If sequence/step doesn't exist, use fallback subject from queue record
        console.error(`[email-queue] Build failed for ${seqName}[${stepIndex}]:`, buildErr.message);
        await markFailed(item.id, `Build error: ${buildErr.message}`, item);
        continue;
      }

      // Send via Resend
      const result = await withTimeout(resend.emails.send({
        from: 'MrDelegate <hello@send.mrdelegate.ai>',
        to: item.to_email,
        subject: item.subject || subject,
        html,
        replyTo: 'hello@mrdelegate.ai',
      }), EMAIL_QUEUE_SEND_TIMEOUT_MS, `email send for ${item.to_email}`);

      if (result.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }

      // Mark as sent
      await supabase
        .from('email_queue')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', item.id);

      console.log(`[email-queue] Sent: "${subject}" to ${item.to_email} (${seqName}[${stepIndex}]) — id: ${result.data?.id}`);

      // Small delay between sends to avoid rate limits
      await new Promise(r => setTimeout(r, 500));

    } catch (sendErr) {
      console.error(`[email-queue] Failed to send ${item.id}:`, sendErr.message);
      await markFailed(item.id, sendErr.message, item);
    }
  }

  console.log(`[email-queue] ${new Date().toISOString()} — Done`);
}

async function markFailed(id, errorMsg, item = null) {
  const retryCount = (item?.data?.retry_count || 0);
  const retryDelaysMs = [60000, 300000, 900000];

  // For welcome emails: retry up to 3 times with increasing delays (1min, 5min, 15min)
  if (item && item.data?.sequence === 'welcome' && retryCount < MAX_WELCOME_RETRIES) {
    const delayMs = retryDelaysMs[Math.min(retryCount, retryDelaysMs.length - 1)];
    const nextRetry = new Date(Date.now() + delayMs).toISOString();
    console.log(`[email-queue] Scheduling welcome email retry ${retryCount + 1}/3 for ${item.to_email} at ${nextRetry}`);

    await supabase
      .from('email_queue')
      .update({
        status: 'pending',
        error: `Retry ${retryCount + 1}: ${errorMsg}`,
        scheduled_for: nextRetry,
        data: { ...item.data, retry_count: retryCount + 1 },
      })
      .eq('id', id);
    return;
  }

  // Mark as permanently failed
  await supabase
    .from('email_queue')
    .update({ status: 'failed', error: errorMsg })
    .eq('id', id);

  // For welcome emails that exhausted retries: log to email_failures and alert Bart
  if (item && item.data?.sequence === 'welcome' && retryCount >= MAX_WELCOME_RETRIES) {
    console.error(`[email-queue] CRITICAL: Welcome email failed 3 times for ${item.to_email}`);

    // Log to email_failures table
    try {
      await supabase.from('email_failures').insert({
        customer_id: item.customer_id,
        to_email: item.to_email,
        template: 'welcome',
        error: errorMsg,
        retry_count: retryCount,
        failed_at: new Date().toISOString(),
      });
    } catch (logErr) {
      // Table may not exist yet — log error but don't crash
      console.error(`[email-queue] Failed to log to email_failures (table may not exist):`, logErr.message);
    }

    // Send Telegram alert to Bart
    try {
      const ALERT_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
      const BART_CHAT_ID = process.env.BART_TELEGRAM_CHAT_ID || '';
      if (ALERT_BOT_TOKEN && BART_CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: BART_CHAT_ID,
            text: `🚨 WELCOME EMAIL FAILED 3x\n\nCustomer: ${item.to_email}\nError: ${errorMsg}\n\nCustomer may be stranded. Check Supabase email_failures table.`,
            parse_mode: 'HTML',
          }),
        });
        console.log(`[email-queue] Alert sent to Bart for ${item.to_email}`);
      }
    } catch (alertErr) {
      console.error(`[email-queue] Failed to send Telegram alert:`, alertErr.message);
    }
  }
}

// Run
const runTimeout = setTimeout(() => {
  console.error(`[email-queue] Run exceeded ${EMAIL_QUEUE_RUN_TIMEOUT_MS}ms — exiting`);
  process.exit(1);
}, EMAIL_QUEUE_RUN_TIMEOUT_MS);
runTimeout.unref?.();

processQueue().catch(err => {
  console.error('[email-queue] Fatal:', err);
  process.exit(1);
}).finally(() => {
  clearTimeout(runTimeout);
});
