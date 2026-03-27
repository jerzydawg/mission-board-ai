/**
 * Trial Email Sequence Runner
 * 
 * Reads customer trial data and determines which emails to send today.
 * Designed to run daily via cron.
 * 
 * Usage:
 *   node trial-email-sequence.js --dry-run    # Preview what would be sent
 *   node trial-email-sequence.js              # Actually send (requires RESEND_API_KEY)
 * 
 * Env vars required for sending:
 *   RESEND_API_KEY=re_...
 *   EMAIL_FROM=noreply@mrdelegate.ai
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getEmailTemplate, SEQUENCE_DAYS } from './email-templates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const CONFIG_PATH = join(__dirname, '../../data/trial-sequence-config.json');

/**
 * Calculate which email day a customer should receive today
 * based on their trial start date
 */
function getDaysSinceTrialStart(trialStartDate) {
  const start = new Date(trialStartDate);
  const now = new Date();
  const diffMs = now - start;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Find which sequence email day applies today
 */
function getEmailDayForCustomer(trialStartDate) {
  const daysSince = getDaysSinceTrialStart(trialStartDate);
  // Check if today matches any sequence day (with 1-day tolerance window)
  return SEQUENCE_DAYS.find(d => daysSince >= d && daysSince < d + 1) || null;
}

/**
 * Send email via Resend API
 */
async function sendEmail({ to, subject, html, from }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set in environment');
  
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: from || process.env.EMAIL_FROM || 'MrDelegate <noreply@mrdelegate.ai>',
      to: [to],
      subject,
      html,
    }),
  });
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
  
  return await res.json();
}

/**
 * Main runner
 */
async function run() {
  console.log(`[trial-email-sequence] Starting${DRY_RUN ? ' (DRY RUN)' : ''} at ${new Date().toISOString()}`);
  
  // Load config / customer list
  let config;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    config = JSON.parse(raw);
  } catch (e) {
    console.error(`[trial-email-sequence] Failed to load config from ${CONFIG_PATH}:`, e.message);
    process.exit(1);
  }
  
  const { customers = [] } = config;
  console.log(`[trial-email-sequence] Processing ${customers.length} trial customers`);
  
  let sent = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const customer of customers) {
    const { email, firstName, trialStartDate, plan, upgradePrice, sentEmails = [] } = customer;
    
    if (!email || !trialStartDate) {
      console.warn(`[skip] Customer missing email or trialStartDate:`, customer);
      skipped++;
      continue;
    }
    
    const daysSince = getDaysSinceTrialStart(trialStartDate);
    
    // Skip if trial is over (past day 15) and no further emails needed
    if (daysSince > 15) {
      skipped++;
      continue;
    }
    
    // Find today's email day
    const emailDay = getEmailDayForCustomer(trialStartDate);
    if (!emailDay) {
      skipped++;
      continue;
    }
    
    // Skip if this email was already sent
    if (sentEmails.includes(emailDay)) {
      console.log(`[skip] ${email} — day ${emailDay} already sent`);
      skipped++;
      continue;
    }
    
    // Get the template
    let template;
    try {
      template = getEmailTemplate(emailDay, { firstName, plan, upgradePrice });
    } catch (e) {
      console.error(`[error] ${email} — failed to get template for day ${emailDay}:`, e.message);
      errors++;
      continue;
    }
    
    if (DRY_RUN) {
      console.log(`[DRY RUN] Would send day ${emailDay} email to ${email} (${firstName}) — "${template.subject}"`);
      sent++;
      continue;
    }
    
    // Send it
    try {
      const result = await sendEmail({ to: email, subject: template.subject, html: template.html });
      console.log(`[sent] Day ${emailDay} → ${email} (id: ${result.id})`);
      sent++;
      
      // Mark as sent in customer record (caller should persist this back to DB/config)
      customer.sentEmails = [...sentEmails, emailDay];
    } catch (e) {
      console.error(`[error] Failed to send day ${emailDay} to ${email}:`, e.message);
      errors++;
    }
  }
  
  console.log(`[trial-email-sequence] Done. Sent: ${sent} | Skipped: ${skipped} | Errors: ${errors}`);
  return { sent, skipped, errors };
}

run().catch(e => {
  console.error('[trial-email-sequence] Fatal error:', e);
  process.exit(1);
});
