import { Hono } from 'hono';
import { sendEmail, SEQUENCES, withFooter } from '../services/email.js';
import {
  queueEmail,
  getPendingEmails,
  markEmailSent,
  markEmailFailed,
  getCustomerByEmail,
} from '../services/supabase.js';
import supabase from '../services/supabase.js';

export const emailRoutes = new Hono();

// Trigger a sequence for a customer
emailRoutes.post('/trigger', async (c) => {
  const { email, name, sequence } = await c.req.json();
  if (!email || !sequence) return c.json({ error: 'email and sequence required' }, 400);
  if (!SEQUENCES[sequence]) return c.json({ error: `Unknown sequence: ${sequence}` }, 400);

  const customer = await getCustomerByEmail(email.toLowerCase().trim());
  const customerId = customer?.id || null;
  const now = new Date();

  for (const step of SEQUENCES[sequence]) {
    const scheduledFor = new Date(now.getTime() + step.delayHours * 60 * 60 * 1000).toISOString();
    await queueEmail(customerId, email, sequence, { name: name || email.split('@')[0], subject: step.subject, html: step.html }, scheduledFor);
  }

  console.log(`[email] Queued ${SEQUENCES[sequence].length} emails for ${email} (sequence: ${sequence})`);
  return c.json({ status: 'queued', count: SEQUENCES[sequence].length });
});

// Process pending emails (called by cron every 15 min)
emailRoutes.post('/process', async (c) => {
  const pending = await getPendingEmails();
  let sent = 0;

  for (const item of pending) {
    try {
      const html = withFooter((item.data.html || '').replace(/\{\{name\}\}/g, item.data.name || 'there'), item.to_email);
      await sendEmail({
        to: item.to_email,
        subject: item.data.subject || item.template,
        html,
        from: 'MrDelegate <team@mrdelegate.ai>',
      });
      await markEmailSent(item.id);
      sent++;
    } catch (err) {
      console.error(`[email] Failed to send to ${item.to_email}:`, err.message);
      await markEmailFailed(item.id, err.message);
    }
  }

  return c.json({ processed: sent, remaining: pending.length - sent });
});

// View queue status
emailRoutes.get('/status', async (c) => {
  const pending = await getPendingEmails();
  return c.json({
    pending: pending.length,
    scheduled: pending.slice(0, 20),
  });
});

// POST /api/email/unsubscribe — CAN-SPAM compliance
emailRoutes.post('/unsubscribe', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const emailParam = c.req.query('email') || body.email;
  if (!emailParam) return c.json({ error: 'Email required' }, 400);
  await supabase.from('customers').update({ email_unsubscribed: true, updated_at: new Date().toISOString() }).eq('email', emailParam).catch(() => {});
  return c.json({ ok: true, message: 'Unsubscribed successfully' });
});

// GET /api/email/unsubscribe — handle link clicks from email
emailRoutes.get('/unsubscribe', async (c) => {
  const email = c.req.query('email');
  if (email) {
    await supabase.from('customers').update({ email_unsubscribed: true, updated_at: new Date().toISOString() }).eq('email', email).catch(() => {});
  }
  return c.redirect('/unsubscribe?success=1');
});

// List available sequences
emailRoutes.get('/sequences', (c) => {
  const seqs = {};
  for (const [name, steps] of Object.entries(SEQUENCES)) {
    seqs[name] = { steps: steps.length, delays: steps.map(s => `${s.delayHours}h`) };
  }
  return c.json({ sequences: seqs });
});
