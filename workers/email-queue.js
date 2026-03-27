#!/usr/bin/env node
/**
 * MrDelegate Email Queue Worker
 * Processes pending emails from Supabase email_queue table and sends via Resend
 * Run via cron every 5 minutes:
 * Add to crontab: cd /root/mrdelegate/platform && node workers/email-queue.js >> /var/log/mrdelegate-email-queue.log 2>&1
 */

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { buildSequenceEmail } from '../src/services/email.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_API_KEY) {
  console.error('[email-queue] FATAL: Missing environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const resend = new Resend(RESEND_API_KEY);

function htmlToPlainText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<\/div>/gi, '\n')
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ( $1 )')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x2192;/g, '->')
    .replace(/&#x2714;/g, '✓')
    .replace(/&#x2014;/g, '—')
    .replace(/&middot;/g, '·')
    .replace(/&rarr;/g, '->')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function processPendingEmails() {
  const now = new Date().toISOString();
  console.log(`[email-queue] ${now} — Checking for pending emails`);

  try {
    // Fetch pending emails scheduled for now or earlier
    const { data: emails, error } = await supabase
      .from('email_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_for', now)
      .order('scheduled_for', { ascending: true })
      .limit(50);

    if (error) throw error;
    if (!emails || emails.length === 0) {
      console.log('[email-queue] No pending emails');
      return;
    }

    console.log(`[email-queue] Found ${emails.length} pending email(s)`);

    for (const email of emails) {
      try {
        console.log(`[email-queue] Processing: ${email.id} → ${email.to_email} (${email.template})`);

        // Build email content from template
        let subject = email.subject || 'MrDelegate';
        let html = email.html;
        let text = email.text;

        // If template is specified, use sequence builder
        if (email.template) {
          const parts = email.template.split(':');
          const sequenceName = parts[0];
          const stepIndex = parseInt(parts[1] || '0', 10);
          const customerData = email.data || {};

          try {
            const built = buildSequenceEmail(sequenceName, stepIndex, customerData.name || '', email.to_email, customerData);
            subject = built.subject;
            html = built.html;
            text = text || htmlToPlainText(html);
          } catch (err) {
            console.error(`[email-queue] Template build failed for ${email.template}:`, err.message);
            throw new Error(`Template error: ${err.message}`);
          }
        }

        // List-Unsubscribe headers
        const encodedTo = encodeURIComponent(email.to_email);
        const unsubscribeUrl = `https://mrdelegate.ai/unsubscribe?email=${encodedTo}`;
        const headers = {
          'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:team@mrdelegate.ai?subject=unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        };

        // Send via Resend
        const result = await resend.emails.send({
          from: email.from_email || 'MrDelegate <team@mrdelegate.ai>',
          to: email.to_email,
          subject,
          html,
          text,
          replyTo: email.reply_to || 'team@mrdelegate.ai',
          headers,
        });

        if (result.error) {
          throw new Error(`Resend error: ${result.error.message}`);
        }

        // Mark as sent
        const { error: updateError } = await supabase
          .from('email_queue')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            resend_id: result.data?.id || null,
          })
          .eq('id', email.id);

        if (updateError) {
          console.error(`[email-queue] WARNING: Failed to mark ${email.id} as sent:`, updateError.message);
        } else {
          console.log(`[email-queue] ✓ Sent ${email.id} — Resend ID: ${result.data?.id || 'unknown'}`);
        }
      } catch (err) {
        console.error(`[email-queue] ✗ Failed ${email.id}:`, err.message);

        // Mark as failed
        const { error: failError } = await supabase
          .from('email_queue')
          .update({
            status: 'failed',
            error: err.message,
            failed_at: new Date().toISOString(),
          })
          .eq('id', email.id);

        if (failError) {
          console.error(`[email-queue] WARNING: Failed to mark ${email.id} as failed:`, failError.message);
        }
      }
    }

    console.log('[email-queue] Batch complete');
  } catch (err) {
    console.error('[email-queue] FATAL:', err.message);
    process.exit(1);
  }
}

// Run once and exit (cron will re-invoke)
processPendingEmails().then(() => {
  console.log('[email-queue] Done');
  process.exit(0);
}).catch((err) => {
  console.error('[email-queue] Unhandled error:', err);
  process.exit(1);
});
