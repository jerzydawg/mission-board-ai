#!/usr/bin/env node
/**
 * IMAP Triage Worker
 * Runs every 30 minutes (same schedule as inbox-triage-worker).
 *
 * For each active customer with an IMAP connector:
 *   1. Connect via IMAP using stored (decrypted) credentials
 *   2. Fetch unread emails from INBOX (last 24h)
 *   3. Classify by urgency using the same AI logic as Gmail triage
 *   4. Send triage summary to customer via Telegram
 *   5. Reply to emails via SMTP using sendReplyViaSMTP()
 *   6. Disconnect cleanly after each customer
 *
 * Supports: iCloud, Yahoo, Zoho, GoDaddy, corporate Exchange, Rackspace, Fastmail
 */

import { createClient } from '@supabase/supabase-js';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { decryptConnectorTokens } from '../src/lib/token-crypto.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPS_TELEGRAM_CHAT_ID = process.env.OPS_TELEGRAM_CHAT_ID;
const AI_API_KEY = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY;

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TELEGRAM_BOT_TOKEN'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[imap-triage] Missing env: ${missing.join(', ')}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BATCH_SIZE = Number(process.env.IMAP_TRIAGE_BATCH_SIZE || 10);
const CONNECT_TIMEOUT_MS = 15000;
const RUN_TIMEOUT_MS = Number(process.env.IMAP_TRIAGE_RUN_TIMEOUT_MS || 20 * 60 * 1000);
const LOOKBACK_HOURS = Number(process.env.IMAP_TRIAGE_LOOKBACK_HOURS || 24);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Telegram helper ──────────────────────────────────────────────────────────

async function sendTelegram(chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[imap-triage] Telegram error: ${data.description}`);
  } catch (e) {
    console.warn('[imap-triage] Telegram send failed:', e.message);
  }
}

async function notifyOps(msg) {
  if (!OPS_TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OPS_TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* non-critical */ }
}

// ── Log activity ─────────────────────────────────────────────────────────────

async function logActivity(customerId, event, data) {
  await supabase.from('activity_log').insert([{
    customer_id: customerId,
    event,
    data: { ...data, timestamp: new Date().toISOString() },
  }]).catch(() => {});
}

// ── AI email classification (same as Gmail triage) ───────────────────────────

async function classifyEmails(emails, customerName) {
  if (!AI_API_KEY || emails.length === 0) {
    return emails.map(e => ({
      ...e,
      category: e.subject?.includes('?') ? 'needs_reply' : 'fyi',
      reason: 'heuristic',
      draftReply: null,
    }));
  }

  const emailList = emails.map((e, i) =>
    `Email ${i + 1}:\nFrom: ${e.from}\nSubject: ${e.subject}\nPreview: ${e.snippet}`
  ).join('\n\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-3-5-20241022',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `You are an executive assistant triaging ${customerName}'s inbox. Classify each email.

Categories:
- vip: Clearly important business relationship or VIP contact
- needs_reply: Requires a response (direct question, request, meeting invite)
- fyi: Informational, no action needed (receipts, confirmations, updates)
- archive: Low priority (newsletters, promotions, automated notifications)

For vip and needs_reply emails, write a SHORT suggested reply (1-3 sentences, professional).

${emailList}

Respond as JSON array:
[{"index": 1, "category": "vip|needs_reply|fyi|archive", "reason": "brief reason", "draftReply": "suggested reply or null"}]`,
        }],
      }),
      signal: AbortSignal.timeout(20000),
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');

    const classifications = JSON.parse(jsonMatch[0]);
    return emails.map((e, i) => {
      const c = classifications.find(cl => cl.index === i + 1) || { category: 'fyi', reason: 'unclassified', draftReply: null };
      return { ...e, ...c };
    });
  } catch (e) {
    console.error('[imap-triage] AI classification error:', e.message);
    return emails.map(e => ({ ...e, category: 'needs_reply', reason: 'ai_error', draftReply: null }));
  }
}

// ── Format triage summary ────────────────────────────────────────────────────

function formatTriageSummary(classified, providerLabel) {
  const vip = classified.filter(e => e.category === 'vip');
  const needsReply = classified.filter(e => e.category === 'needs_reply');
  const fyi = classified.filter(e => e.category === 'fyi');
  const archived = classified.filter(e => e.category === 'archive');

  let msg = `📬 *${providerLabel} Triage* — ${classified.length} new emails\n\n`;

  if (vip.length > 0) {
    msg += `🔴 *PRIORITY* (${vip.length})\n`;
    for (const e of vip) {
      msg += `• *${e.from}*: ${e.subject}\n`;
      if (e.draftReply) msg += `  💬 Draft: _"${e.draftReply}"_\n`;
    }
    msg += '\n';
  }

  if (needsReply.length > 0) {
    msg += `🟡 *NEEDS REPLY* (${needsReply.length})\n`;
    for (const e of needsReply) {
      msg += `• *${e.from}*: ${e.subject}\n`;
      if (e.draftReply) msg += `  💬 Draft: _"${e.draftReply}"_\n`;
    }
    msg += '\n';
  }

  if (fyi.length > 0) {
    msg += `🔵 *FYI* (${fyi.length})\n`;
    for (const e of fyi) msg += `• ${e.from}: ${e.subject}\n`;
    msg += '\n';
  }

  if (archived.length > 0) {
    msg += `📦 *Auto-archived* (${archived.length}): ${archived.map(e => e.from).join(', ')}\n`;
  }

  msg += '\n_Reply "draft reply to [name]" to refine any draft._';
  return msg;
}

// ── IMAP: fetch unread emails from INBOX ─────────────────────────────────────

async function fetchImapEmails(credentials) {
  const { imapHost, imapPort, email, password, useSsl } = credentials;

  const client = new ImapFlow({
    host: imapHost,
    port: Number(imapPort),
    secure: useSsl !== false,
    auth: { user: email, pass: password },
    logger: false,  // NEVER log credentials
    tls: { rejectUnauthorized: true },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: 5000,
    socketTimeout: CONNECT_TIMEOUT_MS,
  });

  const emails = [];
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search for unseen messages since cutoff
      const since = cutoff.toISOString().split('T')[0]; // YYYY-MM-DD
      const uids = await client.search({ seen: false, since: new Date(since) }, { uid: true });

      if (!uids || uids.length === 0) {
        return emails;
      }

      // Fetch up to 15 most recent
      const fetchUids = uids.slice(-15);

      for await (const msg of client.fetch(fetchUids, {
        uid: true,
        envelope: true,
        bodyStructure: true,
        bodyParts: ['TEXT'],
        internalDate: true,
      }, { uid: true })) {
        const env = msg.envelope || {};
        const fromAddr = env.from?.[0];
        const fromName = fromAddr?.name || fromAddr?.address || 'Unknown';
        const fromEmail = fromAddr?.address || '';
        const subject = env.subject || '(no subject)';

        // Get a snippet from body text
        let snippet = '';
        try {
          const textPart = msg.bodyParts?.get('TEXT');
          if (textPart) {
            const raw = Buffer.isBuffer(textPart) ? textPart.toString('utf8') : String(textPart);
            snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
          }
        } catch {}

        emails.push({
          uid: msg.uid,
          from: fromName,
          fromEmail,
          subject,
          snippet,
          date: env.date?.toISOString() || new Date().toISOString(),
        });
      }
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (e) {
    await client.close?.().catch(() => {});
    throw e;
  }

  return emails;
}

// ── SMTP: send reply via customer's own credentials ──────────────────────────

/**
 * Send a reply email via the customer's SMTP credentials.
 * The reply appears to come from the customer's own email address.
 *
 * @param {Object} connector - connector row (with decrypted metadata + password)
 * @param {Object} originalEmail - { fromEmail, subject, uid }
 * @param {string} replyText - the reply body text
 */
export async function sendReplyViaSMTP(connector, originalEmail, replyText) {
  const meta = connector.connector_metadata || {};
  const { smtp_host, smtp_port, use_ssl, email } = meta;
  const password = connector._decryptedPassword;

  if (!smtp_host || !smtp_port || !email || !password) {
    throw new Error('Missing SMTP credentials in connector metadata');
  }

  const transporter = nodemailer.createTransport({
    host: smtp_host,
    port: Number(smtp_port),
    // port 465 = secure (implicit TLS), 587/25 = STARTTLS
    secure: Number(smtp_port) === 465,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: true },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS,
  });

  const replySubject = originalEmail.subject?.startsWith('Re:')
    ? originalEmail.subject
    : `Re: ${originalEmail.subject}`;

  await transporter.sendMail({
    from: email,
    to: originalEmail.fromEmail,
    subject: replySubject,
    text: replyText,
    headers: {
      'In-Reply-To': originalEmail.messageId || '',
      'References': originalEmail.messageId || '',
    },
  });

  transporter.close();
}

// ── Track triaged emails (by UID + connector account) ────────────────────────

async function getTriagedUids(customerId, connectorAccount) {
  const { data } = await supabase
    .from('triaged_emails')
    .select('gmail_message_id')
    .eq('customer_id', customerId)
    .like('gmail_message_id', `imap:${connectorAccount}:%`)
    .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  return new Set((data || []).map(r => r.gmail_message_id));
}

async function markTriaged(customerId, connectorAccount, uids, classifications) {
  const rows = uids.map((uid, i) => ({
    customer_id: customerId,
    gmail_message_id: `imap:${connectorAccount}:${uid}`,
    category: classifications[i]?.category || 'unknown',
    created_at: new Date().toISOString(),
  }));
  await supabase.from('triaged_emails').insert(rows).catch(() => {});
}

// ── Process single IMAP connector ────────────────────────────────────────────

async function processImapConnector(connector) {
  const customer = connector.customers;
  const account = connector.connector_account || `connector:${connector.id}`;
  const meta = connector.connector_metadata || {};

  try {
    // Decrypt the stored app password
    const { accessToken: password } = decryptConnectorTokens(connector, 'imap-triage');
    if (!password) {
      console.log(`[imap-triage] Skipping ${account} — could not decrypt credentials`);
      await logActivity(connector.customer_id, 'imap_triage_skipped', { reason: 'decrypt_failed', account });
      await supabase.from('customer_connectors').update({
        consecutive_failures: (connector.consecutive_failures || 0) + 1,
        last_error: 'credential_decrypt_failed',
        updated_at: new Date().toISOString(),
      }).eq('id', connector.id);
      return;
    }

    const credentials = {
      imapHost: meta.imap_host,
      imapPort: meta.imap_port || 993,
      email: meta.email || account,
      password,
      useSsl: meta.use_ssl !== false,
    };

    // Attach decrypted password for SMTP use
    connector._decryptedPassword = password;

    const emails = await fetchImapEmails(credentials);
    if (emails.length === 0) {
      console.log(`[imap-triage] ${account} — inbox clear`);
      await supabase.from('customer_connectors').update({
        last_used: new Date().toISOString(),
        consecutive_failures: 0,
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq('id', connector.id);
      return;
    }

    // Filter already-triaged UIDs
    const triaged = await getTriagedUids(connector.customer_id, account);
    const newEmails = emails.filter(e => !triaged.has(`imap:${account}:${e.uid}`));
    if (newEmails.length === 0) {
      console.log(`[imap-triage] ${account} — no new emails`);
      return;
    }

    console.log(`[imap-triage] ${account} — triaging ${newEmails.length} new email(s)`);

    const classified = await classifyEmails(newEmails, customer?.name || account);

    // Derive a friendly provider label from IMAP host
    const hostLabel = meta.imap_host?.replace(/^imap\./, '').replace(/\.com$/, '') || 'Custom Email';
    const providerLabel = hostLabel.charAt(0).toUpperCase() + hostLabel.slice(1);

    const summary = formatTriageSummary(classified, providerLabel);
    if (customer?.channel_id) {
      await sendTelegram(customer.channel_id, summary);
    }

    await supabase.from('customer_connectors').update({
      last_used: new Date().toISOString(),
      last_verified: new Date().toISOString(),
      consecutive_failures: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', connector.id);

    await markTriaged(connector.customer_id, account, newEmails.map(e => e.uid), classified);
    await logActivity(connector.customer_id, 'inbox_triage', {
      connector: 'imap',
      account,
      total: newEmails.length,
      vip: classified.filter(e => e.category === 'vip').length,
      needs_reply: classified.filter(e => e.category === 'needs_reply').length,
      fyi: classified.filter(e => e.category === 'fyi').length,
      archived: classified.filter(e => e.category === 'archive').length,
    });

    console.log(`[imap-triage] ✓ ${account} — ${newEmails.length} triaged`);

  } catch (e) {
    console.error(`[imap-triage] ✗ ${account}:`, e.message);
    await logActivity(connector.customer_id, 'inbox_triage_error', {
      connector: 'imap',
      account,
      error: e.message,
    });
    await supabase.from('customer_connectors').update({
      consecutive_failures: (connector.consecutive_failures || 0) + 1,
      last_error: e.message.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq('id', connector.id);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[imap-triage] Starting at', new Date().toISOString());

  const { data: connectors, error } = await supabase
    .from('customer_connectors')
    .select(`
      id, access_token, connector_type, connector_account, connector_metadata,
      consecutive_failures, customer_id,
      customers!inner(id, email, name, channel, channel_id, status)
    `)
    .eq('connector_type', 'imap')
    .eq('connected', true)
    .in('customers.status', ['active', 'trial', 'founder'])
    .eq('customers.channel', 'telegram')
    .not('customers.channel_id', 'is', null);

  if (error) {
    console.error('[imap-triage] Failed to fetch connectors:', error.message);
    process.exit(1);
  }

  console.log(`[imap-triage] ${connectors.length} active IMAP connector(s)`);
  if (connectors.length === 0) {
    console.log('[imap-triage] Nothing to process — done.');
    return;
  }

  for (let i = 0; i < connectors.length; i += BATCH_SIZE) {
    const batch = connectors.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(c => processImapConnector(c)));
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[imap-triage] Unhandled rejection:', r.reason?.message || r.reason);
      }
    }
    if (i + BATCH_SIZE < connectors.length) await sleep(200);
  }

  console.log('[imap-triage] Done.');
}

const runTimeout = setTimeout(() => {
  console.error(`[imap-triage] Run exceeded ${RUN_TIMEOUT_MS}ms — exiting`);
  process.exit(1);
}, RUN_TIMEOUT_MS);
runTimeout.unref?.();

main().catch(e => {
  console.error('[imap-triage] Fatal:', e);
  process.exit(1);
}).finally(() => {
  clearTimeout(runTimeout);
});
