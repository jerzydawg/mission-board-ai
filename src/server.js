import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

// ─── Required env var guard — fail fast, never deploy broken ─────────────────
const REQUIRED_ENV = [
  'JWT_SECRET',
  'CUSTOMER_JWT_SECRET',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD_HASH',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'RESEND_API_KEY',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[startup] FATAL: Missing required environment variables:\n  ${missing.join('\n  ')}`);
  console.error('[startup] Set these in /etc/systemd/system/mrdelegate-platform.service.d/env.conf');
  process.exit(1);
}

// ─── Agent registry validation — warn if agents are missing SOUL.md ──────────
import { readFileSync as _readFileSync, existsSync as _existsSync } from 'fs';
import { join as _join } from 'path';
try {
  const agentsConfig = JSON.parse(_readFileSync('/root/mrdelegate/config/agents.json', 'utf-8'));
  const missingSOUL = [];
  for (const agent of agentsConfig.agents || []) {
    const soulPath = _join('/root/mrdelegate', agent.path, 'SOUL.md');
    if (!_existsSync(soulPath)) missingSOUL.push(agent.id);
  }
  if (missingSOUL.length > 0) {
    console.warn(`[startup] WARNING: Agents missing SOUL.md: ${missingSOUL.join(', ')}`);
  } else {
    console.log(`[startup] Agent registry OK — ${agentsConfig.agents.length} agents registered`);
  }
} catch (err) {
  console.warn('[startup] Could not validate agent registry:', err.message);
}

// ─── Feature flags — log active features ──────────────────────────────────────
try {
  const featuresConfig = JSON.parse(_readFileSync('/root/mrdelegate/config/features.json', 'utf-8'));
  const active = Object.entries(featuresConfig.features || {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  console.log(`[startup] Features enabled: ${active.join(', ')}`);
} catch (err) {
  console.warn('[startup] Could not load feature flags:', err.message);
}
// ─────────────────────────────────────────────────────────────────────────────
import { stripeRoutes } from './routes/stripe.js';
import { vultrRoutes } from './routes/vultr.js';
import { healthRoutes } from './routes/health.js';
import { adminRoutes } from './routes/admin.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { authRoutes } from './routes/auth.js';
import { verifyAdmin } from './middleware/auth.js';
import { emailRoutes } from './routes/email.js';
import { oauthRoutes } from './routes/oauth.js';
import { customerAuthRoutes } from './routes/customer-auth.js';
import { webhookRoutes } from './routes/webhook.js';
import { customerRoutes } from './routes/customer.js';
import { supportRoutes } from './routes/support.js';
import { surveyRoutes } from './routes/survey.js';
import { njElectricLeadsRoutes } from './routes/nj-electric-leads.js';
import { publicStatsRoutes } from './routes/public-stats.js';
import customerSignupRoutes from './routes/customer-signup.js';
import { missionBoardRoutes } from './routes/mission-board/index.js';
import { opsRoutes } from './routes/ops.js';
import { renderNotFoundPage } from './lib/not-found.js';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new Hono();

// ─── Global error handler — never show stack traces to users ──
app.onError((err, c) => {
  console.error(`[ERROR] ${c.req.method} ${c.req.path}:`, err.message);
  return c.json({ error: 'Internal server error' }, 500);
});

// ─── 404 handler ──────────────────────────────────────────────
app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return c.json({ error: 'Not found' }, 404);
  }
  return c.html(renderNotFoundPage(pathname), 404);
});

// ─── Security headers ─────────────────────────────────────────
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '1; mode=block');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.APP_URL?.startsWith('https://')) {
    c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
});

// ─── Trailing slash normalizer ────────────────────────────────
// Strips trailing slash from all non-root requests before routing
// So /ops/ === /ops, /start/ === /start, etc.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path !== '/' && path.endsWith('/')) {
    const clean = path.replace(/\/+$/, '');
    const url = new URL(c.req.url);
    url.pathname = clean;
    return c.redirect(url.toString(), 301);
  }
  return next();
});

// ─── Static files from Astro dist ─────────────────────────────
// Serve blog, comparison pages, and other Astro-generated static content
app.use('*', serveStatic({ root: '/root/mrdelegate/astro/dist' }));

// ─── Platform static assets (JS, CSS, images) ─────────────────
app.use('/js/*', serveStatic({ root: '/root/mrdelegate/platform/public' }));
app.use('/sounds/*', serveStatic({ root: '/root/mrdelegate/platform/public' }));
app.use('/css/*', serveStatic({ root: '/root/mrdelegate/platform/public' }));
app.use('/img/*', serveStatic({ root: '/root/mrdelegate/platform/public' }));

// Health check
app.route('/api/health', healthRoutes);

// Unsubscribe — actually suppresses future sequence emails
app.get('/unsubscribe', async (c) => {
  const email = c.req.query('email');
  if (!email) return c.text('Invalid link', 400);
  console.log(`[email] Unsubscribe request: ${email}`);
  // Cancel any pending queued emails for this customer
  try {
    const { getCustomerByEmail } = await import('./services/supabase.js');
    const customer = await getCustomerByEmail(email);
    if (customer) {
      const { default: supabase } = await import('./services/supabase.js');
      await Promise.all([
        supabase
          .from('customers')
          .update({ email_unsubscribed: true, updated_at: new Date().toISOString() })
          .eq('id', customer.id),
        supabase
          .from('email_queue')
          .update({ status: 'failed', error: 'Unsubscribed' })
          .eq('customer_id', customer.id)
          .eq('status', 'pending'),
      ]);
      console.log(`[email] Unsubscribed and cancelled pending emails for ${email}`);
    }
  } catch (err) {
    console.error(`[email] Unsubscribe DB error (non-fatal):`, err.message);
  }
  return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Unsubscribed - MrDelegate</title></head><body style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:80px auto;padding:20px;text-align:center;background:#FFFDF9;">
    <p style="font-size:14px;font-weight:700;letter-spacing:3px;color:#3D3A35;margin-bottom:32px;">MR &middot; DELEGATE</p>
    <h2 style="color:#3D3A35;font-size:24px;margin-bottom:12px;">Unsubscribed</h2>
    <p style="color:#7A756C;line-height:1.6;">You've been removed from MrDelegate marketing emails.<br>Transactional emails (sign-in links) will still be sent.</p>
    <p style="margin-top:24px;"><a href="https://mrdelegate.ai" style="color:#F76707;font-weight:600;text-decoration:none;">Back to MrDelegate</a></p>
  </body></html>`);
});

// Stripe checkout + webhooks
app.route('/api/stripe', stripeRoutes);

// Vultr VPS provisioning — admin only
app.use('/api/vultr/*', verifyAdmin);
app.route('/api/vultr', vultrRoutes);

// Admin dashboard API
app.route('/api/admin', adminRoutes);

// Ops routes (manual operations dashboard)
app.route('/ops/api', opsRoutes);

// Auth
app.route('/api/auth', authRoutes);

// ─── Admin — secure path (/ops) ─────────────────────
// /admin and /dashboard return 404 — no redirect, no hints
app.get('/admin', (c) => c.notFound());
app.get('/admin/dashboard', (c) => c.notFound());

app.get('/ops', (c) => {
  // Get token from cookie header
  const cookieHeader = c.req.header('Cookie') || '';
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '') || 
    (cookieHeader.match(/md_admin_token=([^;]+)/) || [])[1];
  
  if (token) {
    const dashHtml = readFileSync(join(__dirname, 'dashboard-live.html'), 'utf-8');
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    return c.html(dashHtml);
  }
  
  const html = readFileSync(join(__dirname, 'dashboard-login.html'), 'utf-8');
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  return c.html(html);
});

app.get('/ops/dash', (c) => {
  const html = readFileSync(join(__dirname, 'dashboard-live.html'), 'utf-8');
  return c.html(html);
});

// Mission Board — agent control dashboard
app.route('/ops/mission-board', missionBoardRoutes);
// Admin login page
app.get('/ops/login', (c) => {
  const html = readFileSync(join(__dirname, 'dashboard-login.html'), 'utf-8');
  return c.html(html);
});


app.get('/admindashboard', (c) => {
  const html = readFileSync('/root/mrdelegate/life/static/admin-dashboard.html', 'utf-8');
  return c.html(html);
});

// /dashboard — customer dashboard (authenticated)
app.get('/dashboard', (c) => {
  const html = readFileSync(join(__dirname, 'customer-dashboard.html'), 'utf-8');
  return c.html(html);
});

// Waitlist
app.route('/api/waitlist', waitlistRoutes);

// Email sequences
app.route('/api/email', emailRoutes);
app.route('/api/oauth', oauthRoutes);
app.route('/api/customer/auth', customerAuthRoutes);

app.route('/api/webhook', webhookRoutes);
app.get('/login', (c) => {
  const html = readFileSync(join(__dirname, 'customer-login.html'), 'utf-8');
  return c.html(html);
});

app.get('/app', (c) => {
  const html = readFileSync(join(__dirname, 'customer-app.html'), 'utf-8');
  return c.html(html);
});

// /billing — redirect customers to Stripe billing portal
// Linked from lifecycle emails (e.g., payment failed, trial ending)
app.get('/billing', async (c) => {
  const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET;
  const JWT_SECRET = process.env.JWT_SECRET;

  // Extract token from cookie or Authorization header
  const cookie = c.req.header('cookie') || '';
  const mdCustomerToken = cookie.match(/md_customer_token=([^;]+)/)?.[1];
  const mdToken = cookie.match(/md_token=([^;]+)/)?.[1];
  const auth = c.req.header('authorization') || '';
  const bearerToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  const { default: jwt } = await import('jsonwebtoken');
  let decoded = null;
  for (const candidate of [mdCustomerToken, mdToken, bearerToken]) {
    if (!candidate) continue;
    try { decoded = jwt.verify(candidate, CUSTOMER_JWT_SECRET); break; } catch {}
    try { decoded = jwt.verify(candidate, JWT_SECRET); break; } catch {}
  }

  if (!decoded?.customerId) return c.redirect('/login', 302);

  try {
    const { getCustomerById } = await import('./services/supabase.js');
    const customer = await getCustomerById(decoded.customerId);
    if (!customer?.stripe_customer_id) return c.redirect('/app', 302);

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.stripe_customer_id,
      return_url: `${process.env.APP_URL || 'https://mrdelegate.ai'}/app`,
    });
    return c.redirect(session.url, 302);
  } catch (err) {
    console.error('[billing] Portal redirect error:', err.message);
    return c.redirect('/app', 302);
  }
});

app.route('/api/customer', customerRoutes);
app.route('/', customerSignupRoutes);  // Signup route mounted at root for /api/customer/signup
app.route('/api/support', supportRoutes);
app.route('/api/nj-electric-leads', njElectricLeadsRoutes);
app.route('/api/public-stats', publicStatsRoutes);

// Cancellation survey (public — authenticated by JWT in token param)
app.route('/survey', surveyRoutes);
app.route('/api/survey', surveyRoutes);

// Landing page
app.get('/', (c) => {
  const html = readFileSync('/root/mrdelegate/life/static/mrdelegate-ui.html', 'utf-8');
  return c.html(html);
});

// Signup page
app.get('/start', (c) => {
  const html = readFileSync(join(__dirname, 'start.html'), 'utf-8');
  return c.html(html);
});

// Welcome page — post-checkout live provisioning tracker
app.get('/welcome', (c) => {
  const html = readFileSync(join(__dirname, 'welcome.html'), 'utf-8');
  return c.html(html);
});

// Post-checkout success — redirect to /welcome (the real experience)
app.get('/start/success', (c) => {
  const sessionId = c.req.query('session_id') || '';
  return c.redirect('/welcome' + (sessionId ? '?session_id=' + sessionId : ''));
});

app.get('/chat', (c) => {
  const html = readFileSync(join(__dirname, 'chat.html'), 'utf-8');
  return c.html(html);
});

app.get('/nj-electric-admin', (c) => {
  const html = readFileSync(join(__dirname, 'nj-electric-admin.html'), 'utf-8');
  return c.html(html);
});

// Basic chat API — proxies to customer's agent via OpenClaw gateway
// Full implementation after Stripe + VPS provisioning is wired
app.post('/api/chat', async (c) => {
  const { customerId, message, answers } = await c.req.json();
  // Placeholder — will proxy to customer's VPS OpenClaw gateway
  // For now returns a smart canned response based on message
  const lc = message.toLowerCase();
  let reply = "I'm processing your request. Full agent connectivity comes online once your VPS is fully provisioned.";
  if (lc.includes('server') || lc.includes('hosting')) reply = "Your OpenClaw hosting is ready! You have a dedicated VPS with full root access. Check your dashboard to manage deployments and monitor performance.";
  if (lc.includes('deploy') || lc.includes('app')) reply = "To deploy applications, use the dashboard or SSH directly to your server. You have complete control over your hosting environment.";
  if (lc.includes('performance') || lc.includes('monitoring')) reply = "Server monitoring is available in your dashboard. You can track CPU usage, memory, disk space, and application performance metrics.";
  if (lc.includes('hello') || lc.includes('hi') || lc.includes('hey')) reply = "Hey! Your OpenClaw hosting is live and ready. What would you like to do — deploy an app, check server status, or configure settings?";
  return c.json({ reply });
});


// ── Email draft safety state (in-process, single instance) ───────────────────
// pendingEdits: chatId → { gmailMessageId, subject, customerId }
// Customer is prompted to type their edit; next text message from that chatId is the new draft.
const pendingEdits = new Map();

// pendingSends: scheduleId → { chatId, gmailMessageId, timeoutId, customerId }
// 30-second undo window — cleared by cancel or by the timeout executing the send.
const pendingSends = new Map();

// Telegram bot webhook — captures customer's first /start message and stores their chat_id.
// Without this, workers filter out customers whose channel_id is null and send nothing.
// Register this webhook with: POST https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://mrdelegate.ai/api/telegram/webhook
app.post('/api/telegram/webhook', async (c) => {
  try {
    const update = await c.req.json();
    
    // Handle callback_query (inline button presses)
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const callbackData = callbackQuery.data || '';
      const chatId = String(callbackQuery.message?.chat?.id || callbackQuery.from?.id);
      const callbackId = callbackQuery.id;
      
      console.log(`[telegram-webhook] Callback query: ${callbackData} from chat ${chatId}`);
      
      if (callbackData.startsWith('send_reply:')) {
        const gmailMessageId = callbackData.replace('send_reply:', '');
        await handleSendReplyCallback(chatId, gmailMessageId, callbackId);
      } else if (callbackData.startsWith('edit_reply:')) {
        const gmailMessageId = callbackData.replace('edit_reply:', '');
        await handleEditReplyCallback(chatId, gmailMessageId, callbackId);
      } else if (callbackData.startsWith('discard_reply:')) {
        const gmailMessageId = callbackData.replace('discard_reply:', '');
        await handleDiscardReplyCallback(chatId, gmailMessageId, callbackId);
      } else if (callbackData.startsWith('cancel_send:')) {
        const scheduleId = callbackData.replace('cancel_send:', '');
        await handleCancelSendCallback(chatId, scheduleId, callbackId);
      }

      return c.json({ ok: true });
    }
    
    const message = update.message || update.edited_message;
    if (!message) return c.json({ ok: true });

    const chatId = String(message.chat.id);
    const username = message.from?.username;
    const text = message.text || '';
    const voice = message.voice || message.audio || null;

    // ── Edit mode: customer is replying with their edited draft ─────────────
    if (text && pendingEdits.has(chatId)) {
      const editCtx = pendingEdits.get(chatId);
      pendingEdits.delete(chatId);
      await handleEditSubmitted(chatId, editCtx, text);
      return c.json({ ok: true });
    }

    // ── Telegram commands ────────────────────────────────────────────────────
    if (text && text.startsWith('/')) {
      const cmdLower = text.toLowerCase().trim();
      if (cmdLower === '/stop emails' || cmdLower === '/stop_emails') {
        await handleEmailKillSwitch(chatId, true);
        return c.json({ ok: true });
      }
      if (cmdLower === '/resume emails' || cmdLower === '/resume_emails') {
        await handleEmailKillSwitch(chatId, false);
        return c.json({ ok: true });
      }
      if (cmdLower === '/drafts') {
        await handleDraftsCommand(chatId);
        return c.json({ ok: true });
      }
    }

    // Look up customer by channel_handle (stored as @username or username during signup)
    if (username) {
      const { default: supabase } = await import('./services/supabase.js');
      const { data: customer } = await supabase
        .from('customers')
        .select('*')
        .or(`channel_handle.eq.@${username},channel_handle.eq.${username}`)
        .maybeSingle();

      if (customer && !customer.telegram_chat_id) {
        // First contact — store chat_id and send welcome
        await supabase
          .from('customers')
          .update({ telegram_chat_id: chatId, updated_at: new Date().toISOString() })
          .eq('id', customer.id);

        const { sendProvisioningWelcome } = await import('./services/telegram.js');
        await sendProvisioningWelcome({ ...customer, telegram_chat_id: chatId });
        console.log(`[telegram-webhook] Linked chat_id ${chatId} to customer ${customer.email}`);
      } else if (customer) {
        if (voice) {
          // Voice note received — log it. Transcription is handled on the customer VPS
          // by voice-handler.js (port 18788) called by the agent via web_fetch.
          console.log(`[telegram-webhook] Voice note from ${customer.email} — file_id: ${voice.file_id}, duration: ${voice.duration || 0}s`);
        } else {
          console.log(`[telegram-webhook] Message from known customer ${customer.email} (chat_id: ${chatId})`);
        }
      } else {
        if (voice) {
          console.log(`[telegram-webhook] Voice note from unknown user @${username} (chat_id: ${chatId}) — not a customer yet`);
        } else {
          console.log(`[telegram-webhook] Unknown user @${username} (chat_id: ${chatId}) — not a customer yet`);
        }
      }
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error('[telegram-webhook] Error:', err.message);
    return c.json({ ok: true }); // Always 200 to Telegram
  }
});

// ── Shared helpers ────────────────────────────────────────────────────────────

async function getCustomerByChatId(chatId) {
  const { default: supabase } = await import('./services/supabase.js');
  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();
  return data;
}

async function logEmailAudit(customerId, triagedEmailId, action, metadata = {}) {
  const { default: supabase } = await import('./services/supabase.js');
  await supabase.from('email_audit_log').insert([{
    customer_id: customerId,
    triaged_email_id: triagedEmailId || null,
    action,
    metadata: { ...metadata, timestamp: new Date().toISOString() },
  }]).catch(() => {});
}

// Returns true if under limit, false if rate-limited.
// Also returns minutesUntilReset if over limit.
async function checkEmailRateLimit(customerId) {
  const { default: supabase } = await import('./services/supabase.js');
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('email_sends')
    .select('sent_at')
    .eq('customer_id', customerId)
    .gte('sent_at', oneHourAgo)
    .order('sent_at', { ascending: true });
  if (error) return { ok: true }; // fail open
  const count = (data || []).length;
  if (count < 10) return { ok: true, count };
  // Over limit — find when the oldest send falls out of the window
  const oldest = new Date(data[0].sent_at);
  const resetMs = oldest.getTime() + 60 * 60 * 1000 - Date.now();
  const minutesUntilReset = Math.ceil(resetMs / 60000);
  return { ok: false, count, minutesUntilReset };
}

// ── Send Reply callback: schedule a 30-second delayed send ───────────────────
async function handleSendReplyCallback(chatId, gmailMessageId, callbackId) {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const { default: supabase } = await import('./services/supabase.js');

  // Answer callback immediately
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text: 'Scheduling send…' }),
  }).catch(() => {});

  try {
    const customer = await getCustomerByChatId(chatId);
    if (!customer) {
      await sendTelegramMessage(chatId, '❌ Could not find your account.');
      return;
    }

    // Kill switch check
    if (customer.email_paused) {
      await sendTelegramMessage(chatId, '🛑 Email sending is paused. Use /resume_emails to re-enable.');
      return;
    }

    // Rate limit check
    const rateCheck = await checkEmailRateLimit(customer.id);
    if (!rateCheck.ok) {
      await sendTelegramMessage(chatId, `⚠️ Slow down! Max 10 emails/hour. Try again in ${rateCheck.minutesUntilReset} minute${rateCheck.minutesUntilReset === 1 ? '' : 's'}.`);
      return;
    }

    // Get draft
    const { data: triaged } = await supabase
      .from('triaged_emails')
      .select('*')
      .eq('customer_id', customer.id)
      .eq('gmail_message_id', gmailMessageId)
      .maybeSingle();

    if (!triaged || (!triaged.draft_reply && !triaged.edited_reply)) {
      await sendTelegramMessage(chatId, '❌ No draft found for this email.');
      return;
    }
    if (triaged.sent_at) {
      await sendTelegramMessage(chatId, '⚠️ This reply was already sent.');
      return;
    }
    if (triaged.discarded_at) {
      await sendTelegramMessage(chatId, '⚠️ This draft was discarded.');
      return;
    }

    // Already in the 30s window?
    const scheduleId = `${customer.id}_${gmailMessageId}`;
    if (pendingSends.has(scheduleId)) {
      await sendTelegramMessage(chatId, '⏳ Already scheduled to send in a moment. Tap 🚫 Cancel to abort.');
      return;
    }

    // Mark as scheduled
    await supabase.from('triaged_emails').update({
      scheduled_send_at: new Date().toISOString(),
    }).eq('id', triaged.id);

    await logEmailAudit(customer.id, triaged.id, 'send_scheduled', {
      to: triaged.from_email,
      subject: triaged.subject,
    });

    // Show undo message with cancel button
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✉️ Sending in 30s to *${triaged.from_name || triaged.from_email}*…`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '🚫 Cancel', callback_data: `cancel_send:${scheduleId}` },
        ]]},
      }),
    }).catch(() => {});

    // Schedule the actual send after 30 seconds
    const timeoutId = setTimeout(async () => {
      pendingSends.delete(scheduleId);
      await executeEmailSend(chatId, gmailMessageId, customer.id, triaged);
    }, 30000);

    pendingSends.set(scheduleId, { chatId, gmailMessageId, timeoutId, customerId: customer.id });

  } catch (err) {
    console.error('[telegram-webhook] handleSendReplyCallback error:', err.message);
    await sendTelegramMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}

// ── Execute the actual email send (called after 30s undo window) ─────────────
async function executeEmailSend(chatId, gmailMessageId, customerId, triagedRow) {
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const { default: supabase } = await import('./services/supabase.js');

  try {
    // Re-fetch in case it was discarded/already sent during the 30s window
    const { data: triaged } = await supabase
      .from('triaged_emails')
      .select('*')
      .eq('id', triagedRow.id)
      .maybeSingle();

    if (!triaged) {
      await sendTelegramMessage(chatId, '❌ Draft no longer found.');
      return;
    }
    if (triaged.sent_at) {
      await sendTelegramMessage(chatId, '⚠️ Already sent.');
      return;
    }
    if (triaged.discarded_at) {
      await sendTelegramMessage(chatId, '⚠️ Draft was discarded.');
      return;
    }

    // Re-check kill switch and rate limit
    const { data: customer } = await supabase.from('customers').select('*').eq('id', customerId).maybeSingle();
    if (customer?.email_paused) {
      await sendTelegramMessage(chatId, '🛑 Email sending was paused. Draft saved — use /resume_emails then tap Send again.');
      await supabase.from('triaged_emails').update({ scheduled_send_at: null }).eq('id', triaged.id);
      return;
    }

    const rateCheck = await checkEmailRateLimit(customerId);
    if (!rateCheck.ok) {
      await sendTelegramMessage(chatId, `⚠️ Rate limit hit. Draft saved — try again in ${rateCheck.minutesUntilReset} min.`);
      await supabase.from('triaged_emails').update({ scheduled_send_at: null }).eq('id', triaged.id);
      return;
    }

    // Get Gmail connector
    const { data: connector } = await supabase
      .from('customer_connectors')
      .select('*')
      .eq('customer_id', customerId)
      .eq('connector_type', 'gmail')
      .eq('connected', true)
      .maybeSingle();

    if (!connector) {
      await sendTelegramMessage(chatId, '❌ Gmail not connected. Please reconnect in your dashboard.');
      await logEmailAudit(customerId, triaged.id, 'send_failed', { reason: 'no_connector' });
      return;
    }

    const { decryptConnectorTokens } = await import('./lib/token-crypto.js');
    const { refreshToken: storedRefresh } = decryptConnectorTokens(connector, 'send-reply');
    if (!storedRefresh) {
      await sendTelegramMessage(chatId, '❌ Gmail token expired. Please reconnect.');
      await logEmailAudit(customerId, triaged.id, 'send_failed', { reason: 'no_refresh_token' });
      return;
    }

    // Refresh access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: storedRefresh,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      await sendTelegramMessage(chatId, '❌ Failed to refresh Gmail token. Please reconnect.');
      await logEmailAudit(customerId, triaged.id, 'send_failed', { reason: 'token_refresh_failed' });
      return;
    }

    // Use edited_reply if present, otherwise draft_reply
    const body = triaged.edited_reply || triaged.draft_reply;
    const replySubject = triaged.subject?.startsWith('Re:') ? triaged.subject : `Re: ${triaged.subject || ''}`;
    const raw = [
      `To: ${triaged.from_email}`,
      `Subject: ${replySubject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');
    const encoded = Buffer.from(raw).toString('base64url');

    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded, threadId: triaged.thread_id }),
    });
    const sendData = await sendRes.json();

    if (sendData.id) {
      const now = new Date().toISOString();
      await supabase.from('triaged_emails').update({
        sent_at: now,
        scheduled_send_at: null,
      }).eq('id', triaged.id);

      // Record in email_sends for rate limiting
      await supabase.from('email_sends').insert([{
        customer_id: customerId,
        triaged_email_id: triaged.id,
        sent_at: now,
      }]).catch(() => {});

      await logEmailAudit(customerId, triaged.id, 'send_completed', {
        to: triaged.from_email,
        subject: replySubject,
        gmail_message_id: sendData.id,
      });

      await supabase.from('activity_log').insert([{
        customer_id: customerId,
        type: 'email_sent',
        data: {
          to: triaged.from_email,
          subject: replySubject,
          gmail_message_id: sendData.id,
          timestamp: now,
        },
      }]).catch(() => {});

      await sendTelegramMessage(chatId, `✅ Reply sent to *${triaged.from_name || triaged.from_email}*!`);
      console.log(`[telegram-webhook] Email sent for customer ${customerId} to ${triaged.from_email}`);
    } else {
      console.error('[telegram-webhook] Gmail send failed:', sendData);
      await logEmailAudit(customerId, triaged.id, 'send_failed', {
        error: sendData.error?.message || 'unknown',
      });
      await supabase.from('triaged_emails').update({ scheduled_send_at: null }).eq('id', triaged.id);
      await sendTelegramMessage(chatId, `❌ Failed to send: ${sendData.error?.message || 'Unknown error'}`);
    }
  } catch (err) {
    console.error('[telegram-webhook] executeEmailSend error:', err.message);
    await sendTelegramMessage(chatId, '❌ Something went wrong sending. Please try again.');
  }
}

// ── Cancel pending send (30s undo window) ────────────────────────────────────
async function handleCancelSendCallback(chatId, scheduleId, callbackId) {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const { default: supabase } = await import('./services/supabase.js');

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text: 'Cancelled!' }),
  }).catch(() => {});

  const pending = pendingSends.get(scheduleId);
  if (!pending) {
    await sendTelegramMessage(chatId, '⚠️ Too late — email was already sent (or cancel window expired).');
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingSends.delete(scheduleId);

  try {
    // Clear scheduled_send_at so draft is available again
    const { data: triaged } = await supabase
      .from('triaged_emails')
      .select('id')
      .eq('customer_id', pending.customerId)
      .eq('gmail_message_id', pending.gmailMessageId)
      .maybeSingle();

    if (triaged) {
      await supabase.from('triaged_emails').update({ scheduled_send_at: null }).eq('id', triaged.id);
      await logEmailAudit(pending.customerId, triaged.id, 'send_cancelled', {});
    }
  } catch (err) {
    console.error('[telegram-webhook] handleCancelSendCallback DB error:', err.message);
  }

  await sendTelegramMessage(chatId, '🚫 Cancelled. Draft saved — tap ✅ Send whenever you\'re ready.');
}

// ── Edit Reply callback: prompt customer to type their edit ──────────────────
async function handleEditReplyCallback(chatId, gmailMessageId, callbackId) {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const { default: supabase } = await import('./services/supabase.js');

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text: 'Edit mode on' }),
  }).catch(() => {});

  try {
    const customer = await getCustomerByChatId(chatId);
    if (!customer) {
      await sendTelegramMessage(chatId, '❌ Could not find your account.');
      return;
    }

    const { data: triaged } = await supabase
      .from('triaged_emails')
      .select('id, subject, draft_reply, edited_reply, sent_at, discarded_at')
      .eq('customer_id', customer.id)
      .eq('gmail_message_id', gmailMessageId)
      .maybeSingle();

    if (!triaged) {
      await sendTelegramMessage(chatId, '❌ Draft not found.');
      return;
    }
    if (triaged.sent_at) {
      await sendTelegramMessage(chatId, '⚠️ Already sent — cannot edit.');
      return;
    }
    if (triaged.discarded_at) {
      await sendTelegramMessage(chatId, '⚠️ Draft was discarded.');
      return;
    }

    await logEmailAudit(customer.id, triaged.id, 'draft_viewed', { gmail_message_id: gmailMessageId });

    // Store edit context so next message from this chatId is treated as the edit
    pendingEdits.set(chatId, {
      gmailMessageId,
      subject: triaged.subject,
      triagedId: triaged.id,
      customerId: customer.id,
    });

    const currentDraft = triaged.edited_reply || triaged.draft_reply || '';
    await sendTelegramMessage(chatId,
      `✏️ *Edit draft for:* ${triaged.subject || '(no subject)'}\n\nCurrent draft:\n_"${currentDraft}"_\n\nReply with your changes:`
    );
  } catch (err) {
    console.error('[telegram-webhook] handleEditReplyCallback error:', err.message);
    await sendTelegramMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}

// ── Receive edited draft text from customer ───────────────────────────────────
async function handleEditSubmitted(chatId, editCtx, newText) {
  const { default: supabase } = await import('./services/supabase.js');
  try {
    await supabase.from('triaged_emails').update({
      edited_reply: newText,
    }).eq('id', editCtx.triagedId);

    await logEmailAudit(editCtx.customerId, editCtx.triagedId, 'draft_edited', {
      new_length: newText.length,
    });

    // Show updated draft with action buttons
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✅ Updated draft:\n\n_"${newText}"_\n\nReady to send?`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '✅ Send',    callback_data: `send_reply:${editCtx.gmailMessageId}` },
          { text: '✏️ Edit',   callback_data: `edit_reply:${editCtx.gmailMessageId}` },
          { text: '❌ Discard', callback_data: `discard_reply:${editCtx.gmailMessageId}` },
        ]]},
      }),
    }).catch(() => {});
  } catch (err) {
    console.error('[telegram-webhook] handleEditSubmitted error:', err.message);
    await sendTelegramMessage(chatId, '❌ Could not save your edit. Please try again.');
  }
}

// ── Discard Reply callback ────────────────────────────────────────────────────
async function handleDiscardReplyCallback(chatId, gmailMessageId, callbackId) {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const { default: supabase } = await import('./services/supabase.js');

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text: 'Draft discarded' }),
  }).catch(() => {});

  try {
    const customer = await getCustomerByChatId(chatId);
    if (!customer) {
      await sendTelegramMessage(chatId, '❌ Could not find your account.');
      return;
    }

    const { data: triaged } = await supabase
      .from('triaged_emails')
      .select('id, subject, sent_at')
      .eq('customer_id', customer.id)
      .eq('gmail_message_id', gmailMessageId)
      .maybeSingle();

    if (!triaged) {
      await sendTelegramMessage(chatId, '❌ Draft not found.');
      return;
    }
    if (triaged.sent_at) {
      await sendTelegramMessage(chatId, '⚠️ Already sent — cannot discard.');
      return;
    }

    const now = new Date().toISOString();
    await supabase.from('triaged_emails').update({
      discarded_at: now,
      scheduled_send_at: null,
    }).eq('id', triaged.id);

    // If there was a pending send, cancel it
    const scheduleId = `${customer.id}_${gmailMessageId}`;
    if (pendingSends.has(scheduleId)) {
      clearTimeout(pendingSends.get(scheduleId).timeoutId);
      pendingSends.delete(scheduleId);
    }
    // Clear any pending edit
    pendingEdits.delete(chatId);

    await logEmailAudit(customer.id, triaged.id, 'draft_discarded', {
      subject: triaged.subject,
    });

    await sendTelegramMessage(chatId, '🗑️ Operation cancelled.');
  } catch (err) {
    console.error('[telegram-webhook] handleDiscardReplyCallback error:', err.message);
    await sendTelegramMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}

// ── /stop emails and /resume emails kill switch ───────────────────────────────
async function handleEmailKillSwitch(chatId, pause) {
  const { default: supabase } = await import('./services/supabase.js');
  try {
    const customer = await getCustomerByChatId(chatId);
    if (!customer) {
      await sendTelegramMessage(chatId, '❌ Could not find your account.');
      return;
    }
    await supabase.from('customers').update({ email_paused: pause }).eq('id', customer.id);
    if (pause) {
      await sendTelegramMessage(chatId, '🛑 Email sending paused. Use /resume_emails to re-enable.');
    } else {
      await sendTelegramMessage(chatId, '✅ Email sending resumed. Your drafts are ready.');
    }
  } catch (err) {
    console.error('[telegram-webhook] handleEmailKillSwitch error:', err.message);
    await sendTelegramMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}

// ── /drafts: list pending drafts ─────────────────────────────────────────────
async function handleDraftsCommand(chatId) {
  const { default: supabase } = await import('./services/supabase.js');
  try {
    const customer = await getCustomerByChatId(chatId);
    if (!customer) {
      await sendTelegramMessage(chatId, '❌ Could not find your account.');
      return;
    }

    const { data: drafts } = await supabase
      .from('triaged_emails')
      .select('id, subject, from_name, from_email, gmail_message_id, draft_reply, edited_reply, created_at')
      .eq('customer_id', customer.id)
      .is('sent_at', null)
      .is('discarded_at', null)
      .in('category', ['vip', 'needs_reply'])
      .not('draft_reply', 'is', null)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!drafts || drafts.length === 0) {
      await sendTelegramMessage(chatId, '📝 No pending operations. All clear!');
      return;
    }

    let msg = `📝 *You have ${drafts.length} pending draft${drafts.length === 1 ? '' : 's'}:*\n\n`;
    for (const d of drafts) {
      const preview = (d.edited_reply || d.draft_reply || '').slice(0, 60);
      msg += `• *${d.from_name || d.from_email}*: ${d.subject || '(no subject)'}\n  _"${preview}${preview.length === 60 ? '…' : ''}"_\n\n`;
    }
    msg += '_Use the buttons in your triage summary to act on these._';

    await sendTelegramMessage(chatId, msg);
  } catch (err) {
    console.error('[telegram-webhook] handleDraftsCommand error:', err.message);
    await sendTelegramMessage(chatId, '❌ Could not fetch drafts. Please try again.');
  }
}

async function sendTelegramMessage(chatId, text) {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

// Provision files — serve customer VPS bootstrap files (fetched by cloud-init)
app.get('/provision/files/*', (c) => {
  const wildcard = c.req.path.slice('/provision/files/'.length);
  if (!wildcard || wildcard.includes('..') || wildcard.startsWith('/')) {
    return c.text('Not found', 404);
  }
  try {
    const content = readFileSync(join('/root/mrdelegate/provisioning/customer-files', wildcard), 'utf-8');
    return c.text(content);
  } catch {
    return c.text('Not found', 404);
  }
});

app.get('/about', (c) => {
  const html = readFileSync('/root/mrdelegate/life/about.html', 'utf-8');
  return c.html(html);
});

// Sitemap — dynamically generated from filesystem articles + static pages
app.get('/sitemap.xml', async (c) => {
  const today = new Date().toISOString().split('T')[0];

  const staticPages = [
    { url: 'https://mrdelegate.ai/', priority: '1.0', changefreq: 'weekly', lastmod: today },
    { url: 'https://mrdelegate.ai/blog/', priority: '0.8', changefreq: 'weekly', lastmod: today },
    { url: 'https://mrdelegate.ai/vs/startclaw', priority: '0.8', changefreq: 'monthly', lastmod: today },
    { url: 'https://mrdelegate.ai/vs/clawcloud', priority: '0.8', changefreq: 'monthly', lastmod: today },
    { url: 'https://mrdelegate.ai/vs/self-hosting', priority: '0.8', changefreq: 'monthly', lastmod: today },
    { url: 'https://mrdelegate.ai/vs/simen', priority: '0.8', changefreq: 'monthly', lastmod: today },
    { url: 'https://mrdelegate.ai/vs/superhuman', priority: '0.8', changefreq: 'monthly', lastmod: today },
    { url: 'https://mrdelegate.ai/vs/reclaim-ai', priority: '0.8', changefreq: 'monthly', lastmod: today },
    { url: 'https://mrdelegate.ai/vs/notion-ai', priority: '0.8', changefreq: 'monthly', lastmod: today },
    { url: 'https://mrdelegate.ai/vs/donely', priority: '0.8', changefreq: 'monthly', lastmod: today },
    { url: 'https://mrdelegate.ai/vs/hirejarvis', priority: '0.8', changefreq: 'monthly', lastmod: today },
    { url: 'https://mrdelegate.ai/vs/myclaw', priority: '0.8', changefreq: 'monthly', lastmod: today },
    { url: 'https://mrdelegate.ai/privacy', priority: '0.3', changefreq: 'yearly', lastmod: today },
    { url: 'https://mrdelegate.ai/terms', priority: '0.3', changefreq: 'yearly', lastmod: today },
    { url: 'https://mrdelegate.ai/refund', priority: '0.3', changefreq: 'yearly', lastmod: today },
  ];

  // Read all published articles from filesystem
  const articlesDir = '/root/mrdelegate/seo/articles';
  let blogPosts = [];
  try {
    const files = readdirSync(articlesDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = readFileSync(join(articlesDir, file), 'utf-8');
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) continue;
        const fields = {};
        for (const line of match[1].split('\n')) {
          const m = line.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
          if (m) fields[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
        }
        if (fields.status !== 'published') continue;
        const slug = fields.slug || file.replace('.md', '');
        const date = (fields.published_at || fields.pubDate || today).split('T')[0];
        blogPosts.push({ url: `https://mrdelegate.ai/blog/${slug}`, priority: '0.7', changefreq: 'monthly', lastmod: date });
      } catch { /* skip malformed files */ }
    }
  } catch { /* articlesDir missing */ }

  // Also fetch any posts from Supabase not already in filesystem
  const fsSlugs = new Set(blogPosts.map(p => p.url.split('/').pop()));
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (SUPABASE_URL && SUPABASE_KEY) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/blog_posts?select=slug,published_at,updated_at&status=eq.published&order=published_at.desc&limit=1000`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      if (res.ok) {
        const rows = await res.json();
        for (const row of rows) {
          if (!fsSlugs.has(row.slug)) {
            const date = (row.updated_at || row.published_at || today).split('T')[0];
            blogPosts.push({ url: `https://mrdelegate.ai/blog/${row.slug}`, priority: '0.7', changefreq: 'monthly', lastmod: date });
          }
        }
      }
    }
  } catch { /* Supabase unavailable — filesystem articles still included */ }

  const allPages = [...staticPages, ...blogPosts];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allPages.map(p => `  <url>
    <loc>${p.url}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  return c.text(xml, 200, { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=3600' });
});

// API info
app.get('/api', (c) => c.json({ service: 'MrDelegate Platform', version: '0.1.0', status: 'running' }));

const port = process.env.PORT || 3000;
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`MrDelegate Platform running on http://127.0.0.1:${info.port}`);
});

// TEST ROUTE - Dashboard without auth check (for QA)
app.get('/ops/dash-preview', (c) => {
  let html = readFileSync(join(__dirname, 'dashboard-live.html'), 'utf-8');
  // Remove the auth redirect
  html = html.replace(/if \(!r\.ok\) \{ localStorage\.removeItem.*?\}/g, '// Auth check disabled for preview');
  return c.html(html);
});
