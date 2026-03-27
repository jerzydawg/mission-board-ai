import { Hono } from 'hono';
import supabase from '../services/supabase.js';
import { getCustomerById } from '../services/supabase.js';
import { verifyAdmin } from '../middleware/auth.js';
import { sendEmail } from '../services/email.js';
import jwt from 'jsonwebtoken';

export const supportRoutes = new Hono();

const FOUNDER_TELEGRAM_ID = process.env.FOUNDER_TELEGRAM_ID || '262207319';
const BART_TELEGRAM_ID    = process.env.BART_TELEGRAM_CHAT_ID || process.env.FOUNDER_TELEGRAM_ID || '262207319';
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const JWT_SECRET          = process.env.CUSTOMER_JWT_SECRET || process.env.JWT_SECRET;
const STRIPE_PORTAL_URL   = process.env.STRIPE_PORTAL_URL || 'https://billing.stripe.com/p/login/mrdelegate';

function getCustomerFromRequest(c) {
  try {
    const auth = c.req.header('authorization') || '';
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded?.customerId) return decoded;
    }
    const cookie = c.req.header('cookie') || '';
    const match = cookie.match(/md_customer_token=([^;]+)/);
    if (match) {
      const decoded = jwt.verify(decodeURIComponent(match[1]), JWT_SECRET);
      if (decoded?.customerId) return decoded;
    }
  } catch {}
  return null;
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function notifyCEO(ticket, reason) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const tag = reason ? `[${reason}]` : '';
  const msg = `🎫 Support Ticket ${tag}\n\nFrom: ${ticket.customer_name || ticket.customer_email}\nSubject: ${ticket.subject}\n\n${(ticket.message || '').substring(0, 300)}${(ticket.message || '').length > 300 ? '...' : ''}\n\nView: https://mrdelegate.ai/ops/dashboard#support`;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: FOUNDER_TELEGRAM_ID, text: msg })
    });
  } catch (e) {
    console.error('[support] CEO notify failed:', e.message);
  }
}

async function notifyBart(ticket, reason) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const msg = `🚨 ESCALATION REQUIRED\n\nReason: ${reason}\nFrom: ${ticket.customer_name || ticket.customer_email}\nSubject: ${ticket.subject}\n\n${(ticket.message || '').substring(0, 400)}${(ticket.message || '').length > 400 ? '...' : ''}\n\nAction needed: https://mrdelegate.ai/ops/dashboard#support`;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: BART_TELEGRAM_ID, text: msg })
    });
  } catch (e) {
    console.error('[support] Bart notify failed:', e.message);
  }
}

// ─── Ticket classification ────────────────────────────────────────────────────

const TIER1_REPLIES = {
  gmail_connect: {
    category: 'technical',
    match: (s, b) => /gmail|connect|oauth|google.*auth/i.test(s + ' ' + b),
    subject: 'Re: Gmail reconnect instructions',
    text: `Your Gmail connection needs to be reauthorized. Here's how to fix it in 60 seconds:

1. Go to your dashboard → Connectors
2. Click "Reconnect" next to Gmail
3. Approve access when Google prompts you
4. Your inbox triage and morning brief will resume automatically

If you still have trouble after reconnecting, reply to this email and I'll check your connector state directly.`,
  },
  outlook_connect: {
    category: 'technical',
    match: (s, b) => /outlook|microsoft|hotmail|live\.com.*connect/i.test(s + ' ' + b),
    subject: 'Re: Outlook reconnect instructions',
    text: `Your Outlook connection needs to be reauthorized. Here's how:

1. Go to your dashboard → Connectors
2. Click "Reconnect" next to Outlook/Microsoft
3. Approve access when Microsoft prompts you
4. Your inbox triage will resume within a few minutes

Reply here if the reconnect doesn't work and I'll check your connector state directly.`,
  },
  morning_brief: {
    category: 'technical',
    match: (s, b) => /brief|morning brief|daily brief/i.test(s + ' ' + b),
    subject: 'Re: Your morning brief',
    text: `I checked this for you. I'm reviewing the morning-brief worker logs now and will resend your brief if the run failed or stalled.

Common reasons briefs don't arrive:
- Gmail/Outlook connector needs reauthorization (check Dashboard → Connectors)
- Brief landed in spam — check your spam folder and mark as not spam
- Brief sent to a different address — check the email on your account

If your connector looks connected and you still didn't receive it, reply here and I'll trigger a manual resend.`,
  },
  login: {
    category: 'technical',
    match: (s, b) => /can't log in|cannot log in|login|sign in|password|access|forgot|magic link/i.test(s + ' ' + b),
    subject: 'Re: Login help',
    text: `We use magic links — no passwords needed. Here's how to get in:

1. Go to mrdelegate.ai and click "Log In"
2. Enter the email address you signed up with
3. Check your inbox for a magic link (check spam too)
4. Click the link to sign in instantly

If you're not receiving the magic link, reply with the email you used to sign up and I'll check your account directly.`,
  },
  feature_request: {
    category: 'feature_request',
    match: (s, b) => /feature|suggestion|idea|would be nice|can you add|request|roadmap.*question/i.test(s + ' ' + b),
    subject: 'Re: Feature request received',
    text: `Thanks for this — I've logged it for the product team and it's properly tracked now.

We review feature requests when planning each release. If there's a workaround in the current product that gets you most of the way there, I'll send that along too.

I'll follow up if this ships or if I need any clarification.`,
  },
  roadmap: {
    category: 'feature_request',
    match: (s, b) => /when.*coming|roadmap|planned|timeline|eta|release|launch.*when/i.test(s + ' ' + b),
    subject: 'Re: Roadmap question',
    text: `Great question. We don't publish a detailed public roadmap (things move fast), but here's where we're focused right now:

- Expanding connector coverage (Slack, Calendar depth, CRM integrations)
- Improving morning brief personalization
- Smarter inbox triage with action suggestions

If you're asking about something specific, reply with what you're hoping for and I'll tell you if it's on deck or log it as a request.`,
  },
  cancel: {
    category: 'churn_risk',
    match: (s, b) => /cancel|cancellation|cancel my subscription|unsubscribe|stop.*billing/i.test(s + ' ' + b),
    subject: 'Re: Cancellation request',
    text: `I can take care of that. Before I cancel it — one question: is there something specific that wasn't working, or a feature that would have made the difference?

If it's a setup issue (Gmail not connecting, brief not arriving), those are quick fixes and I can walk you through it right now. If you'd like a 1-week extension to try a fresh setup, I'm happy to do that.

If you still want to cancel, I'll process it immediately: ${STRIPE_PORTAL_URL}

Just reply and let me know what you'd like to do.`,
  },
  refund: {
    category: 'billing',
    match: (s, b) => /refund/i.test(s + ' ' + b),
    subject: 'Re: Refund request',
    text: `I'm checking your billing timeline now. If the charge falls within our 3-day refund window, I'll process the refund for you and confirm once it's done.

You can also manage your billing directly here: ${STRIPE_PORTAL_URL}

I'll follow up within a few hours once I've verified the charge date.`,
  },
  billing: {
    category: 'billing',
    match: (s, b) => /billing|invoice|charge|credit card|payment|subscription.*cost|plan.*price|upgrade|downgrade/i.test(s + ' ' + b),
    subject: 'Re: Billing question',
    text: `You can manage everything billing-related (invoices, payment method, plan changes) directly from your billing portal:

${STRIPE_PORTAL_URL}

If there's a charge you don't recognize or something looks wrong, reply here with the amount and date and I'll investigate it directly.`,
  },
  broken: {
    category: 'bug',
    match: (s, b) => /broken|not working|broke|failed|error|bug|issue|problem|crash/i.test(s + ' ' + b),
    subject: 'Re: Issue report',
    text: `I'm checking platform health and your account logs now. If this is isolated to your account, I'll fix or route it directly. If it's a wider platform issue, I'll escalate it immediately and keep the context attached so you don't have to repeat yourself.

I'll follow up within 2 hours (business hours) or first thing in the morning if this comes in overnight.`,
  },
};

// Returns { category, reply, isChurnRisk, isBug, autoResolvable }
function classifyTicket(subject, message) {
  const combined = (subject + ' ' + message).toLowerCase();

  for (const [key, tier] of Object.entries(TIER1_REPLIES)) {
    if (tier.match(subject, message)) {
      return {
        key,
        category:        tier.category,
        reply:           tier,
        isChurnRisk:     tier.category === 'churn_risk',
        isBug:           tier.category === 'bug',
        autoResolvable:  !['churn_risk', 'bug'].includes(tier.category),
      };
    }
  }

  // Sentiment check — angry language even without keyword match
  const angrySignals = /frustrated|unacceptable|terrible|horrible|useless|waste|awful|never.*work|worst|ridiculous/i.test(combined);
  if (angrySignals) {
    return { key: 'angry', category: 'churn_risk', reply: null, isChurnRisk: true, isBug: false, autoResolvable: false };
  }

  return { key: 'unknown', category: 'other', reply: null, isChurnRisk: false, isBug: false, autoResolvable: false };
}

function buildAutoReplyHtml(customerName, bodyText) {
  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<p>Hi${customerName ? ' ' + customerName : ''},</p>
<p>${bodyText.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
<p style="margin-top:24px;color:#666;font-size:12px">—<br>MrDelegate Support<br><a href="mailto:team@mrdelegate.ai">team@mrdelegate.ai</a></p>
</div>`;
}

// POST /api/support/ticket — customer submits a ticket
supportRoutes.post('/ticket', async (c) => {
  const decoded = getCustomerFromRequest(c);
  if (!decoded?.customerId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const customer = await getCustomerById(decoded.customerId);
    if (!customer) return c.json({ error: 'Not found' }, 404);

    const { subject, message } = await c.req.json();
    if (!subject?.trim() || !message?.trim()) {
      return c.json({ error: 'Subject and message are required' }, 400);
    }
    if (subject.length > 200) return c.json({ error: 'Subject too long (max 200 chars)' }, 400);
    if (message.length > 5000) return c.json({ error: 'Message too long (max 5000 chars)' }, 400);

    const classification = classifyTicket(subject.trim(), message.trim());
    const isAutoResolved = classification.autoResolvable;
    const isEscalation   = classification.isChurnRisk;
    const isBug          = classification.isBug;

    // Determine ticket status
    let status   = 'open';
    let priority = 'normal';
    if (isAutoResolved)    status = 'auto_resolved';
    else if (isEscalation) { status = 'escalated'; priority = 'high'; }
    else if (isBug)        priority = 'high';

    const { data: ticket, error } = await supabase
      .from('support_tickets')
      .insert({
        customer_id:     customer.id,
        customer_email:  customer.email,
        customer_name:   customer.name || null,
        subject:         subject.trim(),
        message:         message.trim(),
        status,
        priority,
        source:          'dashboard',
        auto_reply_sent: isAutoResolved,
        category:        classification.category,
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from('activity_log').insert({
      customer_id: customer.id,
      event: 'support_ticket_submitted',
      data: { ticket_id: ticket.id, subject: subject.trim(), category: classification.category }
    }).catch(() => {});

    // Always send acknowledgment email
    const ackOrReply = classification.reply;
    if (ackOrReply) {
      // Send category-specific auto-reply (serves as ack)
      await sendEmail({
        to:      customer.email,
        from:    'MrDelegate <team@mrdelegate.ai>',
        subject: ackOrReply.subject,
        html:    buildAutoReplyHtml(customer.name, ackOrReply.text),
        text:    ackOrReply.text,
      }).catch(e => console.error('[support/ticket] auto-reply failed:', e.message));
    } else {
      // Generic acknowledgment
      const ackText = `Thanks for reaching out. We received your message and will get back to you within 2 hours (business hours) or first thing tomorrow morning.\n\nTicket ID: ${ticket.id}`;
      await sendEmail({
        to:      customer.email,
        from:    'MrDelegate <team@mrdelegate.ai>',
        subject: `Re: ${subject.trim()}`,
        html:    buildAutoReplyHtml(customer.name, ackText),
        text:    ackText,
      }).catch(e => console.error('[support/ticket] ack email failed:', e.message));
    }

    // Route notifications
    if (isEscalation) {
      // Churn risk / angry customer → alert Bart immediately
      await notifyBart(ticket, classification.key === 'cancel' ? 'Cancellation request' : 'Churn risk / angry customer');
    } else if (isBug) {
      // Bug → alert CEO (not Bart)
      await notifyCEO(ticket, 'BUG REPORTED');
    } else if (!isAutoResolved) {
      // Unknown / needs review → alert CEO
      await notifyCEO(ticket, 'needs review');
    }
    // Auto-resolved tickets: no notification needed

    return c.json({
      ok: true,
      ticketId:    ticket.id,
      autoResolved: isAutoResolved,
      message: isAutoResolved
        ? "We've sent you an immediate reply. Your ticket is resolved — reply back if you need more help."
        : "Message received! We'll get back to you within 2 hours.",
    });
  } catch (e) {
    console.error('[support] ticket submit error:', e.message);
    return c.json({ error: 'Failed to submit. Please email team@mrdelegate.ai directly.' }, 500);
  }
});

// GET /api/support/my-tickets — customer views their own tickets
supportRoutes.get('/my-tickets', async (c) => {
  const decoded = getCustomerFromRequest(c);
  if (!decoded?.customerId) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const { data } = await supabase
      .from('support_tickets')
      .select('id, subject, status, admin_notes, replied_at, created_at, category')
      .eq('customer_id', decoded.customerId)
      .order('created_at', { ascending: false })
      .limit(20);
    return c.json({ tickets: data || [] });
  } catch {
    return c.json({ tickets: [] });
  }
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

supportRoutes.get('/admin/tickets', verifyAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'open';
    let query = supabase
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (status !== 'all') query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return c.json({ tickets: data || [] });
  } catch (e) {
    return c.json({ tickets: [] }, 500);
  }
});

supportRoutes.patch('/admin/tickets/:id', verifyAdmin, async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const updates = { updated_at: new Date().toISOString() };
    if (body.status) updates.status = body.status;
    if (body.priority) updates.priority = body.priority;
    if (body.admin_notes !== undefined) updates.admin_notes = body.admin_notes;
    if (body.status === 'resolved' || body.status === 'replied') {
      updates.replied_at = new Date().toISOString();
    }
    const { data, error } = await supabase
      .from('support_tickets')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return c.json({ ok: true, ticket: data });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

supportRoutes.get('/admin/stats', verifyAdmin, async (c) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: all } = await supabase
      .from('support_tickets')
      .select('status, created_at, replied_at, category, priority')
      .gte('created_at', weekStart);

    const tickets     = all || [];
    const todayAll    = tickets.filter(t => t.created_at >= todayStart);
    const open        = tickets.filter(t => t.status === 'open').length;
    const escalated   = tickets.filter(t => t.status === 'escalated').length;
    const autoToday   = todayAll.filter(t => t.status === 'auto_resolved').length;
    const totalToday  = todayAll.length;
    const ceoHandled  = tickets.filter(t => ['bug', 'other'].includes(t.category) && t.status !== 'open').length;
    const needsBart   = tickets.filter(t => t.status === 'escalated').length;
    const weekTotal   = tickets.length;

    // Avg resolution time (minutes) for resolved tickets this week
    const resolved = tickets.filter(t =>
      ['resolved', 'auto_resolved'].includes(t.status) && t.replied_at && t.created_at
    );
    let avgResolutionMin = null;
    if (resolved.length > 0) {
      const total = resolved.reduce((sum, t) =>
        sum + (new Date(t.replied_at) - new Date(t.created_at)), 0);
      avgResolutionMin = Math.round(total / resolved.length / 60000);
    }

    return c.json({
      open,
      escalated,
      autoToday,
      totalToday,
      ceoHandled,
      needsBart,
      weekTotal,
      avgResolutionMin,
      summary: `${weekTotal} tickets this week. ${autoToday} auto-resolved today. ${needsBart} need your attention.`,
    });
  } catch {
    return c.json({ open: 0, total: 0 });
  }
});

// ─── Inbound email webhook (Resend → no auth) ─────────────────────────────────

supportRoutes.post('/inbound-email', async (c) => {
  try {
    // Verify Resend webhook signature
    const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
    if (webhookSecret) {
      const svixId        = c.req.header('svix-id');
      const svixTimestamp = c.req.header('svix-timestamp');
      const svixSignature = c.req.header('svix-signature');
      if (!svixId || !svixTimestamp || !svixSignature) {
        return c.json({ error: 'Missing webhook signature headers' }, 401);
      }
      const rawBody = await c.req.text();
      const { createHmac } = await import('crypto');
      const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
      const secret = Buffer.from(webhookSecret.replace('whsec_', ''), 'base64');
      const computed = createHmac('sha256', secret).update(signedContent).digest('base64');
      const signatures = svixSignature.split(' ').map(s => s.split(',')[1]);
      if (!signatures.includes(computed)) {
        return c.json({ error: 'Invalid webhook signature' }, 401);
      }
      const body = JSON.parse(rawBody);
      return c.json(await handleInboundEmail(body));
    }
    const body = await c.req.json();
    return c.json(await handleInboundEmail(body));
  } catch (e) {
    console.error('[support/inbound-email] error:', e.message);
    return c.json({ ok: false, error: e.message }, 500);
  }
});

async function handleInboundEmail(body) {
  const from    = body.from || body.sender || '';
  const subject = body.subject || '(no subject)';
  const text    = body.text || body.plain || body.body || '';

  if (!from) return { ok: false, error: 'missing from' };

  const emailMatch  = from.match(/<([^>]+)>/) || [null, from.trim()];
  const senderEmail = emailMatch[1].toLowerCase().trim();

  let customer = null;
  try {
    const { data } = await supabase
      .from('customers')
      .select('id, name, email, created_at')
      .ilike('email', senderEmail)
      .limit(1)
      .single();
    customer = data || null;
  } catch {}

  const classification = classifyTicket(subject, text);

  // VIP check: customer > 3 months old
  const isVIP = customer?.created_at
    ? (Date.now() - new Date(customer.created_at).getTime()) > 90 * 24 * 60 * 60 * 1000
    : false;

  // Escalate VIP churn risk
  const shouldEscalate = classification.isChurnRisk || (isVIP && classification.category === 'churn_risk');
  const isAutoResolved = classification.autoResolvable && !shouldEscalate;

  let status   = 'open';
  let priority = 'normal';
  if (isAutoResolved)   status = 'auto_resolved';
  else if (shouldEscalate) { status = 'escalated'; priority = 'high'; }
  else if (classification.isBug) priority = 'high';

  const { data: ticket } = await supabase
    .from('support_tickets')
    .insert({
      customer_id:     customer?.id || null,
      customer_email:  senderEmail,
      customer_name:   customer?.name || null,
      subject:         subject.substring(0, 200),
      message:         text.substring(0, 5000),
      status,
      priority,
      source:          'email',
      auto_reply_sent: isAutoResolved,
      category:        classification.category,
    })
    .select()
    .single()
    .catch(() => ({ data: null }));

  // Send auto-reply or acknowledgment
  if (classification.reply) {
    const html = buildAutoReplyHtml(customer?.name, classification.reply.text);
    await sendEmail({
      to:      senderEmail,
      from:    'MrDelegate <team@mrdelegate.ai>',
      subject: classification.reply.subject,
      html,
      text:    classification.reply.text,
    }).catch(e => console.error('[support/inbound] auto-reply failed:', e.message));
  } else {
    // Always send ack
    const ackText = `Thanks for reaching out. We received your message and will get back to you within 2 hours (business hours) or first thing tomorrow morning.`;
    await sendEmail({
      to:      senderEmail,
      from:    'MrDelegate <team@mrdelegate.ai>',
      subject: `Re: ${subject.substring(0, 100)}`,
      html:    buildAutoReplyHtml(customer?.name, ackText),
      text:    ackText,
    }).catch(e => console.error('[support/inbound] ack failed:', e.message));
  }

  // Route notifications
  if (ticket) {
    if (shouldEscalate || (isVIP && classification.isChurnRisk)) {
      await notifyBart(ticket, isVIP ? 'VIP churn risk' : 'Cancellation / churn risk');
    } else if (classification.isBug) {
      await notifyCEO(ticket, 'BUG REPORTED via email');
    } else if (!isAutoResolved) {
      await notifyCEO(ticket, 'needs review');
    }
  }

  return { ok: true, ticketId: ticket?.id || null, autoResolved: isAutoResolved, category: classification.category };
}
