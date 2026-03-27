#!/usr/bin/env node
/**
 * Draft Reply Handler
 * Called by the Telegram bot webhook when a customer approves a draft reply
 * Sends the email via Gmail API on their behalf
 * 
 * Flow:
 * 1. Customer gets inbox triage with draft replies
 * 2. Customer replies "send reply to [name]" or taps an inline button
 * 3. This handler picks up the command, finds the draft, sends via Gmail
 * 4. Confirms delivery to customer
 *
 * Also handles: "edit reply to [name]: [new text]"
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Token refresh ────────────────────────────────────────────────────────────
async function getValidToken(customer) {
  const { google_refresh_token, google_access_token, google_token_expiry } = customer;
  if (!google_refresh_token) return null;

  if (google_access_token && google_token_expiry) {
    const expiry = new Date(google_token_expiry);
    if (expiry > new Date(Date.now() + 5 * 60 * 1000)) {
      return google_access_token;
    }
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: google_refresh_token,
        grant_type: 'refresh_token',
      }).toString()
    });
    const tokens = await res.json();
    if (!tokens.access_token) return null;

    await supabase.from('customers').update({
      google_access_token: tokens.access_token,
      google_token_expiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    }).eq('id', customer.id);

    return tokens.access_token;
  } catch (e) {
    return null;
  }
}

// ── Send email via Gmail ─────────────────────────────────────────────────────
export async function sendReply(token, threadId, messageId, to, subject, body) {
  // Build RFC 2822 message
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const raw = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${messageId}`,
    `References: ${messageId}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64url');

  try {
    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          raw: encoded,
          threadId,
        })
      }
    );
    const data = await res.json();
    if (data.id) return { success: true, id: data.id };
    return { success: false, error: data.error?.message || 'Unknown error' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Create Gmail draft (for "edit and review later") ─────────────────────────
export async function createDraft(token, threadId, to, subject, body) {
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const raw = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64url');

  try {
    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: { raw: encoded, threadId },
        })
      }
    );
    const data = await res.json();
    if (data.id) return { success: true, draftId: data.id };
    return { success: false, error: data.error?.message || 'Unknown error' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Process a send command ───────────────────────────────────────────────────
export async function processSendCommand(customerId, targetName, editedBody = null) {
  // Look up the customer
  const { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single();

  if (!customer) return { success: false, error: 'Customer not found' };

  const token = await getValidToken(customer);
  if (!token) return { success: false, error: 'Google token expired — reconnect at mrdelegate.ai/app' };

  // Find the triaged email matching the target name
  const { data: triaged } = await supabase
    .from('triaged_emails')
    .select('*')
    .eq('customer_id', customerId)
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .in('category', ['vip', 'needs_reply'])
    .order('created_at', { ascending: false });

  if (!triaged || triaged.length === 0) {
    return { success: false, error: 'No recent emails to reply to' };
  }

  // Match by name (fuzzy)
  const target = triaged.find(t => {
    const name = (t.from_name || '').toLowerCase();
    return name.includes(targetName.toLowerCase());
  });

  if (!target) {
    return { success: false, error: `Couldn't find an email from "${targetName}" in recent triage` };
  }

  // Get the draft text
  const replyBody = editedBody || target.draft_reply;
  if (!replyBody) {
    return { success: false, error: 'No draft reply available for this email' };
  }

  // Send it
  const result = await sendReply(
    token,
    target.thread_id,
    target.gmail_message_id,
    target.from_email,
    target.subject,
    replyBody
  );

  if (result.success) {
    // Mark as sent
    await supabase.from('triaged_emails').update({ reply_sent: true, reply_sent_at: new Date().toISOString() })
      .eq('id', target.id);
    await supabase.from('activity_log').insert([{
      customer_id: customerId,
      type: 'email_sent',
      data: { to: target.from_email, subject: target.subject },
    }]).catch(() => {});
  }

  return result;
}
