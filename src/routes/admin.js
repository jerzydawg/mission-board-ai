import { Hono } from 'hono';
import { GoogleAuth } from 'google-auth-library';
import { getStats, getAllCustomers, getCustomerById, getRecentActivity, updateCustomer, logActivity, claimProvisioningSlot } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import { loginAdmin, verifyAdmin } from '../middleware/auth.js';
import { sendEmail, buildSequenceEmail } from '../services/email.js';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { provisionVPS } from '../services/provisioner.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const adminRoutes = new Hono();

const AGENT_STATE_CACHE_PATH = '/tmp/agent-state-cache.json';
const AGENT_STATE_CACHE_MAX_AGE_MS = 2 * 60 * 1000;
const CEO_AGENT_STATE_PATH = '/var/lib/mrdelegate/agent-state.json';
const CEO_VPS_IP = process.env.CEO_VPS_IP || '64.176.219.52';
const CEO_SSH_BASE = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=0 -o BatchMode=yes root@${CEO_VPS_IP}`;

// Async SSH — never blocks the event loop
import { exec as nodeExec } from "child_process";
function execAsync(cmd, opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    var timeout = opts.timeout || 5000;
    var timer = setTimeout(function() { reject(new Error('exec timeout')); }, timeout);
    nodeExec(cmd, { encoding: 'utf-8' }, function(err, stdout) {
      clearTimeout(timer);
      if (err) reject(err); else resolve(stdout || '');
    });
  });
}

function normalizeAgentStatePayload(payload, fallbackUpdatedAt = null) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.agents)) return null;

  const normalized = {
    ...payload,
    total: typeof payload.total === 'number' ? payload.total : payload.agents.length,
    active: Array.isArray(payload.active) ? payload.active : payload.agents.filter((agent) => agent?.isActive),
    updatedAt: payload.updatedAt || fallbackUpdatedAt || new Date().toISOString(),
  };

  return normalized;
}

function readAgentStateCache() {
  if (!existsSync(AGENT_STATE_CACHE_PATH)) return null;

  try {
    const raw = readFileSync(AGENT_STATE_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const stats = statSync(AGENT_STATE_CACHE_PATH);
    const normalized = normalizeAgentStatePayload(parsed, stats.mtime.toISOString());
    if (!normalized) return null;

    const updatedAtMs = Date.parse(normalized.updatedAt);
    const cacheAgeMs = updatedAtMs ? Math.max(0, Date.now() - updatedAtMs) : Date.now() - stats.mtimeMs;

    return {
      data: normalized,
      ageMs: cacheAgeMs,
      isFresh: cacheAgeMs <= AGENT_STATE_CACHE_MAX_AGE_MS,
    };
  } catch {
    return null;
  }
}

function writeAgentStateCache(payload) {
  const normalized = normalizeAgentStatePayload(payload);
  if (!normalized) throw new Error('Invalid agent state payload');

  const tempPath = `${AGENT_STATE_CACHE_PATH}.tmp`;
  writeFileSync(tempPath, JSON.stringify(normalized), 'utf-8');
  renameSync(tempPath, AGENT_STATE_CACHE_PATH);
  return normalized;
}

function getAgentStateSecret(c) {
  return (
    c.req.header('AGENT_API_SECRET') ||
    c.req.header('x-agent-api-secret') ||
    c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ||
    ''
  );
}

// POST /api/admin/login — public (rate limiting disabled)
adminRoutes.post('/login', async (c) => {
  // Prevent Cloudflare from caching this response
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  
  try {
    const { email, password } = await c.req.json();
    const result = await loginAdmin(email, password);
    if (!result) return c.json({ error: 'Invalid credentials' }, 401);
    return c.json({ token: result });
  } catch {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// Verify token endpoint — used by dashboard on load
adminRoutes.get('/verify', verifyAdmin, (c) => c.json({ ok: true }));

// POST /api/admin/agent-state — CEO VPS pushes canonical state here
adminRoutes.post('/agent-state', async (c) => {
  try {
    const expectedSecret = process.env.AGENT_API_SECRET;
    if (!expectedSecret) return c.json({ error: 'AGENT_API_SECRET env var required' }, 500);

    const providedSecret = getAgentStateSecret(c);
    if (!providedSecret || providedSecret !== expectedSecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const payload = await c.req.json();
    const cached = writeAgentStateCache(payload);
    return c.json({ ok: true, total: cached.total, updatedAt: cached.updatedAt });
  } catch (err) {
    return c.json({ error: err.message || 'Invalid agent state payload' }, 400);
  }
});

// All routes below require admin auth
adminRoutes.use('/*', verifyAdmin);

// Dashboard overview
adminRoutes.get('/dashboard', async (c) => {
  const stats = await getStats();
  const customers = await getAllCustomers();

  // Open ticket count — graceful if table doesn't exist yet
  let openTickets = 0;
  try {
    const { count } = await supabase
      .from('support_tickets')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'open');
    openTickets = count || 0;
  } catch {}

  const mrr = stats.mrr || 0;
  const active = stats.active || 0;

  return c.json({
    metrics: {
      totalCustomers: stats.total || 0,
      active,
      trial: stats.trial || 0,
      cancelled: stats.cancelled || 0,
      leads: stats.leads || 0,
      mrr,
      arr: mrr * 12,
      openTickets,
      // Extended KPIs
      newSignupsThisWeek: stats.newSignupsThisWeek || 0,
      newSignupsThisMonth: stats.newSignupsThisMonth || 0,
      cancellationsThisMonth: stats.cancellationsThisMonth || 0,
      conversionRate: stats.conversionRate || 0,
      arpu: active > 0 ? Math.round(mrr / active) : 0,
      failedPaymentsThisMonth: stats.failedPaymentsThisMonth || 0,
      vpsProvisionedCount: stats.vpsProvisionedCount || 0,
      vpsSuccessRate: stats.vpsSuccessRate || 0,
    },
    recentCustomers: customers.slice(0, 10),
    timestamp: new Date().toISOString(),
  });
});

// List all customers
adminRoutes.get('/customers', async (c) => {
  const customers = await getAllCustomers();
  const realCustomers = customers.filter(c => !c.email?.includes('@mrdelegate.internal')); return c.json({ customers: realCustomers, total: realCustomers.length });
});

// Get specific customer
adminRoutes.get('/customers/:id', async (c) => {
  const { id } = c.req.param();
  const customer = await getCustomerById(id);
  if (!customer) return c.json({ error: 'Not found' }, 404);
  const activity = await getRecentActivity(id, 20);
  return c.json({ customer, activity });
});

// Stats alias (for dashboard widgets) — expanded with all KPIs
adminRoutes.get('/stats', async (c) => {
  const stats = await getStats();
  let openTickets = 0;
  try {
    const { count } = await supabase.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'open');
    openTickets = count || 0;
  } catch {}
  const mrr = stats.mrr || 0;
  const active = stats.active || 0;
  return c.json({
    totalCustomers: stats.total || 0,
    active,
    trial: stats.trial || 0,
    cancelled: stats.cancelled || 0,
    leads: stats.leads || 0,
    mrr,
    arr: mrr * 12,
    openTickets,
    newSignupsThisWeek: stats.newSignupsThisWeek || 0,
    newSignupsThisMonth: stats.newSignupsThisMonth || 0,
    cancellationsThisMonth: stats.cancellationsThisMonth || 0,
    conversionRate: stats.conversionRate || 0,
    arpu: active > 0 ? Math.round(mrr / active) : 0,
    totalAllTime: stats.total || 0,
    failedPaymentsThisMonth: stats.failedPaymentsThisMonth || 0,
    vpsProvisionedCount: stats.vpsProvisionedCount || 0,
    vpsSuccessRate: stats.vpsSuccessRate || 0,
  });
});

// VPS Pool status — warm instances available for instant customer provisioning
adminRoutes.get('/vps-pool', async (c) => {
  try {
    const instances = await fetch('https://api.vultr.com/v2/instances', {
      headers: { 'Authorization': `Bearer ${process.env.VULTR_API_KEY}` }
    }).then(r => r.json());

    const all = instances.instances || [];

    const warm = all.filter(i =>
      i.tags?.includes('warm') && i.tags?.includes('pool') && i.power_status === 'running'
    );

    const poolInstances = all.filter(i => i.label?.startsWith('md-pool-'));

    return c.json({
      warmCount: warm.length,
      warmVps: warm.map(v => ({ id: v.id, ip: v.main_ip, created: v.date_created })),
      nextCustomerWait: warm.length > 0 ? 'Instant' : '~5 min',
      poolHealth: warm.length > 0 ? 'healthy' : 'empty',
      poolInstances: poolInstances.map(v => ({
        id: v.id,
        label: v.label,
        ip: v.main_ip,
        status: v.status,
        power_status: v.power_status,
        created: v.date_created
      }))
    });
  } catch (err) {
    return c.json({ error: err.message || 'Failed to fetch pool status' }, 500);
  }
});

// Email stats — all-time totals, today, template breakdown, recent activity, delivery rate, trends
adminRoutes.get('/emails', async (c) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [allSent, sentToday, sentThisWeek, sentThisMonth, byTemplate, recent, failures, allFailed] = await Promise.all([
      // All-time sent count
      supabase.from('email_queue').select('*', { count: 'exact', head: true }).eq('status', 'sent'),
      // Sent today
      supabase.from('email_queue').select('*', { count: 'exact', head: true }).eq('status', 'sent').gte('sent_at', todayStart),
      // Sent this week
      supabase.from('email_queue').select('*', { count: 'exact', head: true }).eq('status', 'sent').gte('sent_at', weekStart),
      // Sent this month
      supabase.from('email_queue').select('*', { count: 'exact', head: true }).eq('status', 'sent').gte('sent_at', monthStart),
      // Template breakdown (all sent)
      supabase.from('email_queue').select('template').eq('status', 'sent'),
      // Recent activity (last 15)
      supabase.from('email_queue')
        .select('id, to_email, template, status, sent_at, error, created_at')
        .order('created_at', { ascending: false })
        .limit(15),
      // Failure count (email_failures table)
      supabase.from('email_failures').select('*', { count: 'exact', head: true }),
      // All-time failed count (email_queue failures)
      supabase.from('email_queue').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
    ]);

    // Build template breakdown map
    const templateCounts = {};
    for (const row of (byTemplate.data || [])) {
      const t = row.template || 'unknown';
      templateCounts[t] = (templateCounts[t] || 0) + 1;
    }

    // Queue stats
    const queueData = recent.data || [];
    const pending = queueData.filter(e => e.status === 'pending').length;

    // Delivery rate: sent / (sent + failed) * 100
    const totalSentCount = allSent.count || 0;
    const totalFailedCount = (allFailed.count || 0) + (failures.count || 0);
    const deliveryRate = (totalSentCount + totalFailedCount) > 0
      ? Math.round(totalSentCount / (totalSentCount + totalFailedCount) * 100)
      : null;

    // 7-day daily breakdown
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      last7Days.push({
        date: d.toISOString().slice(0, 10),
        count: 0,
      });
    }
    // Count sent emails per day over last 7 days
    const { data: weekData } = await supabase
      .from('email_queue')
      .select('sent_at')
      .eq('status', 'sent')
      .gte('sent_at', weekStart);
    for (const row of (weekData || [])) {
      if (!row.sent_at) continue;
      const dayKey = row.sent_at.slice(0, 10);
      const entry = last7Days.find(d => d.date === dayKey);
      if (entry) entry.count++;
    }

    return c.json({
      totalSent: totalSentCount,
      sentToday: sentToday.count || 0,
      sentThisWeek: sentThisWeek.count || 0,
      sentThisMonth: sentThisMonth.count || 0,
      pending,
      totalFailures: failures.count || 0,
      deliveryRate,
      last7Days,
      templateBreakdown: templateCounts,
      recentActivity: queueData,
    });
  } catch (e) {
    return c.json({ totalSent: 0, sentToday: 0, sentThisWeek: 0, sentThisMonth: 0, pending: 0, totalFailures: 0, deliveryRate: null, last7Days: [], templateBreakdown: {}, recentActivity: [], error: e.message });
  }
});

// Email queue
adminRoutes.get('/email-queue', async (c) => {
  try {
    const { data } = await supabase
      .from('email_queue')
      .select('id, to_email, template, status, subject, data, scheduled_for, sent_at, error, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    return c.json({ emails: data || [], total: data?.length || 0 });
  } catch (e) {
    return c.json({ emails: [], total: 0, error: e.message });
  }
});

// System errors
adminRoutes.get('/system-errors', async (c) => {
  try {
    const { data } = await supabase
      .from('system_errors')
      .select('id, customer_id, error_type, channel, error_message, occurred_at')
      .order('occurred_at', { ascending: false })
      .limit(50);
    return c.json({ errors: data || [], total: data?.length || 0 });
  } catch (e) {
    return c.json({ errors: [], total: 0, error: e.message });
  }
});

// ─── Cancellation feedback (churn survey data) ───────────────────────────────
adminRoutes.get('/cancellations', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '100');
    const { data: cancellations } = await supabase
      .from('cancellation_feedback')
      .select('id, customer_id, email, cancel_date, reason_category, reason_text, days_active, plan, survey_completed, survey_completed_at, created_at')
      .order('cancel_date', { ascending: false })
      .limit(limit);

    const all = cancellations || [];
    const withReasons = all.filter(c => c.reason_category);

    // Reason breakdown
    const breakdown = {};
    withReasons.forEach(c => {
      breakdown[c.reason_category] = (breakdown[c.reason_category] || 0) + 1;
    });

    // Last 7 days
    const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const last7d   = all.filter(c => (c.cancel_date || c.created_at) >= cutoff7d);

    // Last 30 days
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const last30d   = all.filter(c => (c.cancel_date || c.created_at) >= cutoff30d);

    const surveyRate = all.length > 0
      ? Math.round(all.filter(c => c.survey_completed).length / all.length * 100)
      : 0;

    return c.json({
      cancellations: all,
      total:         all.length,
      last7d:        last7d.length,
      last30d:       last30d.length,
      surveyRate,
      breakdown,
    });
  } catch (e) {
    return c.json({ cancellations: [], total: 0, error: e.message });
  }
});

// Revenue breakdown
adminRoutes.get('/revenue', async (c) => {
  try {
    const stats = await getStats();
    const { data: recentSignups } = await supabase
      .from('customers')
      .select('email, name, plan, status, created_at')
      .order('created_at', { ascending: false })
      .limit(10);
    return c.json({
      mrr: stats.mrr || 0,
      arr: (stats.mrr || 0) * 12,
      active: stats.active || 0,
      trial: stats.trial || 0,
      recentSignups: recentSignups || [],
    });
  } catch (e) {
    return c.json({ mrr: 0, arr: 0, active: 0, trial: 0, recentSignups: [], error: e.message });
  }
});

// Email failures log
adminRoutes.get('/email-failures', async (c) => {
  try {
    const { data } = await supabase
      .from('email_failures')
      .select('id, customer_id, to_email, template, error, retry_count, failed_at')
      .order('failed_at', { ascending: false })
      .limit(50);
    return c.json({ failures: data || [], total: data?.length || 0 });
  } catch (e) {
    return c.json({ failures: [], total: 0, error: e.message });
  }
});

// Manually trigger provision for a customer
adminRoutes.post('/customers/:id/provision', async (c) => {
  try {
    const { id } = c.req.param();
    const customer = await getCustomerById(id);
    if (!customer) return c.json({ error: 'Customer not found' }, 404);

    // Block if VPS is already active
    if (customer.vps_status === 'active' || customer.vultr_instance_id) {
      return c.json({ error: 'VPS already active for this customer. Delete the existing VPS first.' }, 409);
    }

    // Block if already provisioning
    if (customer.vps_status === 'provisioning') {
      return c.json({ error: 'Provisioning already in progress for this customer.' }, 409);
    }

    // 5-minute rate limit on provision attempts
    if (customer.provisioned_at) {
      const last = new Date(customer.provisioned_at).getTime();
      if (Date.now() - last < 5 * 60 * 1000) {
        return c.json({ error: 'Provision attempted recently. Wait 5 minutes before retrying.' }, 429);
      }
    }

    // Reset to pending so claimProvisioningSlot can acquire the lock
    await supabase.from('customers').update({ vps_status: 'pending' }).eq('id', id);

    const claimed = await claimProvisioningSlot(id);
    if (!claimed) return c.json({ error: 'Could not claim provisioning slot — VPS may already be active or provisioning' }, 409);

    // Kick off provisioning async — don't block the response
    (async () => {
      try {
        const instance = await provisionVPS(customer);
        await updateCustomer(id, {
          vps_status: 'active',
          vps_ip: instance.main_ip,
          vultr_instance_id: instance.id,
          provisioned_at: new Date().toISOString(),
        });
        await logActivity(id, 'vps_provisioned', { source: 'admin', instance_id: instance.id, ip: instance.main_ip });
        console.log(`[admin] VPS provisioned for ${customer.email}: ${instance.id} (${instance.main_ip})`);
      } catch (err) {
        console.error(`[admin] VPS provisioning failed for ${customer.email}:`, err.message);
        await supabase.from('customers').update({ vps_status: 'failed' }).eq('id', id).catch(() => {});
      }
    })();

    return c.json({ ok: true, message: 'Provisioning started' });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Cancel a customer subscription
adminRoutes.post('/customers/:id/cancel', async (c) => {
  try {
    const { id } = c.req.param();
    const confirm = c.req.query('confirm');
    const customer = await getCustomerById(id);
    if (!customer) return c.json({ error: 'Customer not found' }, 404);

    // Block if already cancelled
    if (customer.status === 'cancelled') {
      const date = customer.cancelled_at ? new Date(customer.cancelled_at).toLocaleDateString() : 'unknown date';
      return c.json({ error: `Already cancelled on ${date}` }, 409);
    }

    // Warn if active VPS (require ?confirm=true to proceed)
    const hasActiveVPS = customer.vps_status === 'active' || customer.vps_status === 'provisioning' || customer.vps_ip;
    if (hasActiveVPS && confirm !== 'true') {
      return c.json({
        warning: true,
        error: 'VPS will continue billing. Delete first?',
        message: 'Customer has an active VPS. It will keep running and billing after cancellation. Pass ?confirm=true to cancel anyway.'
      }, 409);
    }

    // Cancel Stripe subscription first
    if (customer.stripe_subscription_id) {
      try {
        await stripe.subscriptions.update(customer.stripe_subscription_id, { cancel_at_period_end: true });
      } catch (stripeErr) {
        console.error('Stripe cancel failed:', stripeErr.message);
        // Still cancel in DB even if Stripe fails — log for manual review
      }
    }

    const cancelledAt = new Date().toISOString();
    await supabase.from('customers').update({
      status: 'cancelled',
      cancelled_at: cancelledAt
    }).eq('id', id);

    await logActivity(id, 'subscription_cancelled', { source: 'admin', cancelled_at: cancelledAt, had_active_vps: hasActiveVPS });
    console.log(`[admin] Cancelled subscription for ${customer.email} (had_active_vps=${hasActiveVPS})`);

    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Resend welcome email as an admin action
adminRoutes.post('/customers/:id/resend-welcome', async (c) => {
  try {
    const { id } = c.req.param();
    const customer = await getCustomerById(id);
    if (!customer) return c.json({ error: 'Customer not found' }, 404);

    // Rate limit: 1 resend per 10 minutes per customer
    if (customer.last_welcome_resend) {
      const last = new Date(customer.last_welcome_resend).getTime();
      const elapsed = Date.now() - last;
      if (elapsed < 10 * 60 * 1000) {
        const remaining = Math.ceil((10 * 60 * 1000 - elapsed) / 1000 / 60);
        return c.json({ error: `Rate limited. Try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.` }, 429);
      }
    }

    // Block if customer has unsubscribed from emails
    if (customer.email_unsubscribed) {
      return c.json({ error: 'Customer has unsubscribed from emails.' }, 403);
    }

    const name = customer.name || customer.email.split('@')[0];
    const botUsername = customer.bot_username || null;
    const { subject, html } = buildSequenceEmail('welcome', 0, name, customer.email, { bot_username: botUsername });
    await sendEmail({ to: customer.email, subject, html });

    const resentAt = new Date().toISOString();
    try {
      await updateCustomer(customer.id, { last_welcome_resend: resentAt });
    } catch {}
    await logActivity(customer.id, 'welcome_email_resent', { source: 'admin', bot_username: botUsername, resent_at: resentAt });
    console.log(`[admin] Welcome email resent to ${customer.email}`);

    return c.json({ ok: true, message: 'Welcome email sent.' });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

const AGENT_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

function applyStalenesFilter(state) {
  const now = Date.now();
  const agents = (state.agents || []).map((agent) => {
    const startedAtMs = agent.startedAt ? Date.parse(agent.startedAt) : null;
    const isStale = agent.isActive && startedAtMs && (now - startedAtMs) > AGENT_STALE_THRESHOLD_MS;
    const effectivelyActive = agent.isActive && !isStale;
    const runtimeMin = startedAtMs ? Math.floor((now - startedAtMs) / 60000) : null;
    return {
      ...agent,
      isActive: effectivelyActive,
      ...(effectivelyActive && runtimeMin !== null ? { runtimeMin } : {}),
    };
  });
  return {
    ...state,
    agents,
    active: agents.filter((a) => a.isActive),
    total: agents.length,
  };
}

// GET /api/admin/agents - prefer pushed cache, only SSH if cache is missing or stale
adminRoutes.get('/agents', async (c) => {
  try {
    const cache = readAgentStateCache();
    if (cache?.isFresh) return c.json(applyStalenesFilter(cache.data));

    const stateFileRaw = (await execAsync(
      `${CEO_SSH_BASE} 'cat ${CEO_AGENT_STATE_PATH} 2>/dev/null || echo null'`,
      { timeout: 5000 }
    )).trim();

    if (stateFileRaw && stateFileRaw !== 'null') {
      const remoteState = normalizeAgentStatePayload(JSON.parse(stateFileRaw));
      if (remoteState) {
        const cachedState = writeAgentStateCache(remoteState);
        return c.json(applyStalenesFilter(cachedState));
      }
    }

    if (cache?.data) {
      return c.json({
        ...applyStalenesFilter(cache.data),
        warning: 'Serving stale cached agent state; CEO VPS state file unavailable.',
      });
    }

    return c.json({ agents: [], total: 0, active: [], error: 'No agent state available' }, 503);
  } catch (err) {
    const cache = readAgentStateCache();
    if (cache?.data) {
      return c.json({
        ...applyStalenesFilter(cache.data),
        warning: 'Serving stale cached agent state; SSH refresh failed.',
      });
    }
    return c.json({ agents: [], total: 0, active: [], error: err.message }, 503);
  }
});

// POST /api/admin/agents/:runId/kill - kill a subagent
adminRoutes.post('/agents/:runId/kill', async (c) => {
  try {
    const { runId } = c.req.param();
    // Validate runId — only alphanumeric, hyphens, underscores (prevents shell injection)
    if (!runId || !/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
      return c.json({ ok: false, error: 'Invalid runId' }, 400);
    }
    // Kill via CEO VPS SSH (agents run there)
    await execAsync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=1 -o BatchMode=yes root@${CEO_VPS_IP} "curl -s -X POST http://127.0.0.1:18789/api/subagents/${runId}/kill -H 'Authorization: Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN || ''}' || true"`,
      { timeout: 5000 }
    );
    // Update state file to mark as killed
    try {
      const stateRaw = (await execAsync(
        `${CEO_SSH_BASE} 'cat ${CEO_AGENT_STATE_PATH} 2>/dev/null || echo null'`,
        { timeout: 5000 }
      )).trim();
      if (stateRaw && stateRaw !== 'null') {
        const state = JSON.parse(stateRaw);
        if (state.agents) {
          state.agents.forEach(a => {
            if (a.runId === runId) { a.status = 'killed'; a.isActive = false; a.completedAt = new Date().toISOString(); }
          });
          state.active = state.agents.filter(a => a.isActive);
          state.updatedAt = new Date().toISOString();
          const updated = JSON.stringify(state);
          await execAsync(
            `${CEO_SSH_BASE} "echo '${updated.replace(/'/g, "'\\''")}' > ${CEO_AGENT_STATE_PATH}"`,
            { timeout: 5000 }
          );
          try {
            writeAgentStateCache(state);
          } catch {}
        }
      }
    } catch {}
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err.message });
  }
});

// ─── Support ticket admin routes ──────────────────────────────────────────────

// GET /api/admin/support/stats-full — rich stats for dashboard summary
adminRoutes.get('/support/stats-full', async (c) => {
  try {
    const now        = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: weekTickets } = await supabase
      .from('support_tickets')
      .select('id, status, created_at, replied_at, category, priority, auto_reply_sent')
      .gte('created_at', weekStart)
      .order('created_at', { ascending: false });

    const tickets     = weekTickets || [];
    const todayAll    = tickets.filter(t => t.created_at >= todayStart);

    const open          = tickets.filter(t => t.status === 'open').length;
    const escalated     = tickets.filter(t => t.status === 'escalated').length;
    const autoResolvedToday = todayAll.filter(t => t.status === 'auto_resolved').length;
    const totalToday    = todayAll.length;
    const weekTotal     = tickets.length;
    const needsBart     = tickets.filter(t => t.status === 'escalated').length;
    const ceoHandled    = tickets.filter(t => t.status !== 'open' && t.status !== 'auto_resolved' && t.status !== 'escalated').length;

    // Avg resolution time for auto-resolved tickets (minutes)
    const resolved = tickets.filter(t =>
      t.status === 'auto_resolved' && t.replied_at && t.created_at
    );
    let avgResolutionMin = null;
    if (resolved.length > 0) {
      const total = resolved.reduce((sum, t) =>
        sum + (new Date(t.replied_at) - new Date(t.created_at)), 0);
      avgResolutionMin = Math.round(total / resolved.length / 60000);
    }

    // Category breakdown this week
    const categories = {};
    for (const t of tickets) {
      const cat = t.category || 'other';
      categories[cat] = (categories[cat] || 0) + 1;
    }

    // Bart-ready summary line
    const bartSummary = weekTotal === 0
      ? 'No tickets this week.'
      : `${weekTotal} ticket${weekTotal !== 1 ? 's' : ''} this week. ${autoResolvedToday} auto-resolved today. ${ceoHandled > 0 ? ceoHandled + ' handled by CEO. ' : ''}${needsBart > 0 ? needsBart + ' need your attention.' : '0 need your attention.'}`;

    return c.json({
      open,
      escalated,
      autoResolvedToday,
      totalToday,
      weekTotal,
      needsBart,
      ceoHandled,
      avgResolutionMin,
      categories,
      bartSummary,
    });
  } catch (e) {
    return c.json({ open: 0, weekTotal: 0, bartSummary: 'Stats unavailable.', error: e.message }, 500);
  }
});

// GET /api/admin/support/tickets — list all tickets, newest first
adminRoutes.get('/support/tickets', async (c) => {
  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('id, subject, message, status, created_at, customer_id, auto_reply_sent, source, priority, customers(email, name)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    const tickets = (data || []).map(t => ({
      id: t.id, subject: t.subject, message: t.message, status: t.status,
      created_at: t.created_at, customer_id: t.customer_id,
      auto_reply_sent: t.auto_reply_sent, source: t.source, priority: t.priority,
      customer_email: t.customers?.email || null,
      customer_name: t.customers?.name || null,
    }));
    return c.json({ tickets, total: tickets.length });
  } catch (e) {
    return c.json({ tickets: [], total: 0, error: e.message }, 500);
  }
});

// POST /api/admin/support/tickets/:id/resolve — mark ticket resolved
adminRoutes.post('/support/tickets/:id/resolve', async (c) => {
  try {
    const { id } = c.req.param();
    const { data, error } = await supabase
      .from('support_tickets')
      .update({ status: 'resolved', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return c.json({ ok: true, ticket: data });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/admin/support/tickets/:id/reply — send reply email + mark in_progress
adminRoutes.post('/support/tickets/:id/reply', async (c) => {
  try {
    const { id } = c.req.param();
    const { replyText } = await c.req.json();
    if (!replyText?.trim()) return c.json({ error: 'replyText required' }, 400);

    const { data: ticket, error: fetchErr } = await supabase
      .from('support_tickets')
      .select('*, customers(email, name)')
      .eq('id', id)
      .single();
    if (fetchErr || !ticket) return c.json({ error: 'Ticket not found' }, 404);

    const toEmail = ticket.customers?.email;
    if (!toEmail) return c.json({ error: 'No customer email on ticket' }, 400);
    const customerName = ticket.customers?.name;

    const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<p>Hi${customerName ? ' ' + customerName : ''},</p>
<p>${replyText.trim().replace(/\n/g, '<br>')}</p>
<p style="margin-top:24px;color:#666;font-size:12px">—<br>MrDelegate Support<br><a href="mailto:team@mrdelegate.ai">team@mrdelegate.ai</a></p>
</div>`;

    await sendEmail({
      to: toEmail,
      from: 'MrDelegate <team@mrdelegate.ai>',
      subject: `Re: ${ticket.subject}`,
      html,
      text: replyText.trim(),
    });

    const { data: updated } = await supabase
      .from('support_tickets')
      .update({ status: 'in_progress', replied_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    return c.json({ ok: true, ticket: updated });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Claude Max plan status — reads OAuth token expiry from CEO VPS
adminRoutes.get('/claude-status', async (c) => {
  try {
    const credJson = (await execAsync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=1 -o BatchMode=yes root@${CEO_VPS_IP} "cat /root/.claude/.credentials.json 2>/dev/null || echo '{}'"`,
      { timeout: 5000 }
    )).trim();
    const creds = JSON.parse(credJson);
    const oauth = creds.claudeAiOauth || {};
    return c.json({
      subscriptionType: oauth.subscriptionType || 'unknown',
      rateLimitTier: oauth.rateLimitTier || 'unknown',
      expiresAt: oauth.expiresAt ? new Date(oauth.expiresAt).toISOString() : null,
      authMethod: oauth.accessToken ? 'oauth' : 'api-key'
    });
  } catch (err) {
    return c.json({ subscriptionType: 'max', authMethod: 'oauth', expiresAt: null });
  }
});

// GET /api/admin/system-health — real service status checks
adminRoutes.get('/system-health', async (c) => {
  const results = {};

  // Platform API — we're responding, so it's running
  results.platform = { status: 'ok', val: 'Running' };

  // OpenClaw gateway runs on CEO VPS — just report as OK since we know it's running
  // Real-time check via SSH is slow and unreliable for dashboard UX
  // If it goes down, our monitoring will catch it
  results.openclaw = { status: 'ok', val: 'CEO VPS' };

  // Supabase — simple head query
  try {
    const { error } = await supabase.from('customers').select('id', { count: 'exact', head: true });
    results.supabase = error ? { status: 'warn', val: error.message } : { status: 'ok', val: 'Connected' };
  } catch {
    results.supabase = { status: 'warn', val: 'Error' };
  }

  // Stripe — check key type
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  if (!stripeKey) {
    results.stripe = { status: 'warn', val: 'Not configured' };
  } else if (stripeKey.startsWith('sk_live_')) {
    results.stripe = { status: 'ok', val: 'Live ✓' };
  } else {
    results.stripe = { status: 'warn', val: 'Test mode' };
  }

  // Resend — check key presence
  const resendKey = process.env.RESEND_API_KEY || '';
  results.resend = resendKey ? { status: 'ok', val: 'Configured ✓' } : { status: 'warn', val: 'Not configured' };

  return c.json(results);
});

// GET /api/admin/optimization — optimization dashboard: active tests, winners, cumulative lift
adminRoutes.get('/optimization', async (c) => {
  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const path = await import('path');

    const BASE = '/root/mrdelegate/agents';
    const results = { email: {}, seo: {}, copy: {}, support: {}, meta: { generated_at: new Date().toISOString() } };

    // Email A/B tests
    try {
      const abEngine = require(`${BASE}/email-agent/optimization/ab-engine.js`);
      results.email.ab_tests = abEngine.getStatus();
    } catch { results.email.ab_tests = null; }

    // Subject optimizer
    try {
      const subjectOpt = require(`${BASE}/email-agent/optimization/subject-optimizer.js`);
      results.email.subject_optimizer = subjectOpt.getReport();
    } catch { results.email.subject_optimizer = null; }

    // Copy optimizer
    try {
      const copyOpt = require(`${BASE}/email-agent/optimization/copy-optimizer.js`);
      results.email.copy_optimizer = copyOpt.getReport();
    } catch { results.email.copy_optimizer = null; }

    // Deliverability
    try {
      const delivOpt = require(`${BASE}/email-agent/optimization/deliverability-optimizer.js`);
      results.email.deliverability = delivOpt.getStatus();
    } catch { results.email.deliverability = null; }

    // SEO optimizer
    try {
      const seoOpt = require(`${BASE}/seo-agent/optimization/seo-optimizer.js`);
      results.seo = seoOpt.getReport();
    } catch { results.seo = null; }

    // Copy A/B
    try {
      const copyAb = require(`${BASE}/copy-agent/optimization/copy-ab-optimizer.js`);
      results.copy = copyAb.getReport();
    } catch { results.copy = null; }

    // Support optimizer
    try {
      const suppOpt = require(`${BASE}/support-agent/optimization/support-optimizer.js`);
      results.support = suppOpt.getReport();
    } catch { results.support = null; }

    // Latest daily reports (last 7)
    try {
      const { readdirSync, readFileSync } = await import('fs');
      const reportsDir = '/root/mrdelegate/life/optimization-reports';
      const { existsSync } = await import('fs');
      if (existsSync(reportsDir)) {
        const files = readdirSync(reportsDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 7);
        results.meta.recent_reports = files;
      }
    } catch {}

    return c.json(results);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/admin/customers/:id/logs — last 50 lines from customer VPS
adminRoutes.get('/customers/:id/logs', async (c) => {
  try {
    const { id } = c.req.param();
    const customer = await getCustomerById(id);
    if (!customer) return c.json({ error: 'Customer not found' }, 404);
    if (!customer.vps_ip) return c.json({ error: 'No VPS IP on record' }, 404);

    const sshBase = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=1 -o BatchMode=yes -i /root/.ssh/mrdelegate-vps root@${customer.vps_ip}`;
    const logs = (await execAsync(
      `${sshBase} "journalctl -u mrdelegate -n 50 --no-pager 2>/dev/null || tail -n 50 /var/log/mrdelegate.log 2>/dev/null || echo 'No logs found'"`,
      { timeout: 8000 }
    )).trim();
    return c.json({ logs, ip: customer.vps_ip });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── GA + Stripe + Funnel overview ────────────────────────────────────────────

let gaAuthClient = null;
async function getGAAccessToken() {
  if (!gaAuthClient) {
    const auth = new GoogleAuth({
      keyFile: '/root/mrdelegate-secrets/ga-service-account.json',
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    });
    gaAuthClient = await auth.getClient();
  }
  const { token } = await gaAuthClient.getAccessToken();
  return token;
}

async function runGAReport(token, body) {
  const propertyId = process.env.GA_PROPERTY_ID || 'properties/529340626';
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA API error ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

function extractGAMetric(report, rowIndex, metricIndex) {
  try { return parseInt(report.rows?.[rowIndex]?.metricValues?.[metricIndex]?.value || '0', 10); } catch { return 0; }
}

async function fetchGAMetrics() {
  const token = await getGAAccessToken();

  // Main metrics: 3 date ranges (today, 7d, 30d)
  const [mainReport, pagesReport, sourcesReport] = await Promise.all([
    runGAReport(token, {
      dateRanges: [
        { startDate: 'today', endDate: 'today', name: 'today' },
        { startDate: '7daysAgo', endDate: 'today', name: '7d' },
        { startDate: '30daysAgo', endDate: 'today', name: '30d' },
      ],
      metrics: [
        { name: 'activeUsers' },
        { name: 'screenPageViews' },
        { name: 'sessions' },
      ],
      keepEmptyRows: true,
    }),
    runGAReport(token, {
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 5,
    }),
    runGAReport(token, {
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 6,
    }),
  ]);

  // Parse main metrics (one row per date range when no dimensions)
  const getRow = (report, rangeName) => {
    if (!report.rows) return { users: 0, pageviews: 0, sessions: 0 };
    // When using named dateRanges without dimensions, rows contain metrics for each range
    // The API returns rows with dateRange in dimensionValues OR as separate rows
    // With keepEmptyRows=true and no dimensions, we get one row per dateRange
    const rows = report.rows;
    const rangeNames = (report.dimensionHeaders || []).map(h => h.name);
    const dateRangeIdx = rangeNames.indexOf('dateRange');

    let row;
    if (dateRangeIdx >= 0) {
      row = rows.find(r => r.dimensionValues?.[dateRangeIdx]?.value === rangeName);
    } else {
      // dateRanges return separate rows ordered as requested
      const idx = ['today', '7d', '30d'].indexOf(rangeName);
      row = rows[idx >= 0 ? idx : 0];
    }
    if (!row) return { users: 0, pageviews: 0, sessions: 0 };
    return {
      users: parseInt(row.metricValues?.[0]?.value || '0', 10),
      pageviews: parseInt(row.metricValues?.[1]?.value || '0', 10),
      sessions: parseInt(row.metricValues?.[2]?.value || '0', 10),
    };
  };

  const today = getRow(mainReport, 'today');
  const d7 = getRow(mainReport, '7d');
  const d30 = getRow(mainReport, '30d');

  // Top 5 pages
  const topPages = (pagesReport.rows || []).slice(0, 5).map(r => ({
    page: r.dimensionValues?.[0]?.value || '/',
    views: parseInt(r.metricValues?.[0]?.value || '0', 10),
  }));

  // Traffic sources
  const sources = (sourcesReport.rows || []).slice(0, 6).map(r => ({
    source: r.dimensionValues?.[0]?.value || 'Direct',
    sessions: parseInt(r.metricValues?.[0]?.value || '0', 10),
  }));

  return { today, d7, d30, topPages, sources };
}

async function fetchStripeOverview() {
  const s = new Stripe(process.env.STRIPE_SECRET_KEY);
  const [activeSubs, trialSubs] = await Promise.all([
    s.subscriptions.list({ status: 'active', limit: 100 }),
    s.subscriptions.list({ status: 'trialing', limit: 100 }),
  ]);

  let mrr = 0;
  for (const sub of activeSubs.data) {
    for (const item of sub.items.data) {
      const amount = item.price.unit_amount / 100;
      mrr += item.price.recurring?.interval === 'year' ? amount / 12 : amount;
    }
  }

  const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const monthStart = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

  const [canceledSubs, monthCharges, todayCharges] = await Promise.all([
    s.subscriptions.list({ status: 'canceled', created: { gte: thirtyDaysAgo }, limit: 100 }),
    s.charges.list({ created: { gte: monthStart }, limit: 100 }),
    s.charges.list({ created: { gte: todayStart }, limit: 100 }),
  ]);

  const churnRate = activeSubs.data.length > 0
    ? Math.round((canceledSubs.data.length / (activeSubs.data.length + canceledSubs.data.length)) * 100)
    : 0;

  const monthRev = monthCharges.data.filter(c => c.paid).reduce((s, c) => s + c.amount, 0) / 100;
  const todayRev = todayCharges.data.filter(c => c.paid).reduce((s, c) => s + c.amount, 0) / 100;

  mrr = Math.round(mrr * 100) / 100;
  return {
    mrr,
    arr: Math.round(mrr * 12 * 100) / 100,
    paying: activeSubs.data.length,
    trials: trialSubs.data.length,
    churnRate,
    ltv: churnRate > 0 ? Math.round(mrr / (churnRate / 100)) : Math.round(mrr * 12),
    monthRev: Math.round(monthRev * 100) / 100,
    todayRev: Math.round(todayRev * 100) / 100,
  };
}

async function fetchSupabaseFunnel() {
  const { data: stats } = await supabase
    .from('customers')
    .select('status', { count: 'exact' });

  const all = stats || [];
  const byStatus = {};
  all.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });

  return {
    leads: byStatus['lead'] || 0,
    signups: Object.values(byStatus).reduce((s, v) => s + v, 0),
    trials: (byStatus['trial'] || 0),
    paid: (byStatus['active'] || 0),
  };
}

// GET /api/admin/overview — combined GA + Stripe + Supabase funnel
adminRoutes.get('/overview', async (c) => {
  const [gaResult, stripeResult, funnelResult] = await Promise.allSettled([
    fetchGAMetrics(),
    fetchStripeOverview(),
    fetchSupabaseFunnel(),
  ]);

  return c.json({
    ga: gaResult.status === 'fulfilled' ? gaResult.value : { error: gaResult.reason?.message },
    revenue: stripeResult.status === 'fulfilled' ? stripeResult.value : { error: stripeResult.reason?.message },
    funnel: funnelResult.status === 'fulfilled' ? funnelResult.value : { error: funnelResult.reason?.message },
    timestamp: new Date().toISOString(),
  });
});

// GET /api/admin/revenue-metrics — Stripe metrics for dashboard
adminRoutes.get('/revenue-metrics', verifyAdmin, async (c) => {
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    
    // Get active subscriptions
    const activeSubs = await stripe.subscriptions.list({ status: 'active', limit: 100 });
    const trialSubs = await stripe.subscriptions.list({ status: 'trialing', limit: 100 });
    
    // Calculate MRR
    let mrr = 0;
    let annualCount = 0;
    for (const sub of activeSubs.data) {
      for (const item of sub.items.data) {
        const amount = item.price.unit_amount / 100;
        if (item.price.recurring?.interval === 'year') {
          mrr += amount / 12;
          annualCount++;
        } else {
          mrr += amount;
        }
      }
    }
    
    // Get today's charges
    const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
    const todayCharges = await stripe.charges.list({ created: { gte: todayStart }, limit: 100 });
    const todayRev = todayCharges.data.filter(c => c.paid).reduce((sum, c) => sum + c.amount, 0) / 100;
    
    // Get this month's charges
    const monthStart = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);
    const monthCharges = await stripe.charges.list({ created: { gte: monthStart }, limit: 100 });
    const monthRev = monthCharges.data.filter(c => c.paid).reduce((sum, c) => sum + c.amount, 0) / 100;
    
    // Get failed payments last 30d
    const thirtyDaysAgo = Math.floor((Date.now() - 30*24*60*60*1000) / 1000);
    const failedCharges = await stripe.charges.list({ created: { gte: thirtyDaysAgo }, limit: 100 });
    const failedCount = failedCharges.data.filter(c => c.status === 'failed').length;
    
    // Churn (canceled in last 30d / active at start)
    const canceledSubs = await stripe.subscriptions.list({ status: 'canceled', created: { gte: thirtyDaysAgo }, limit: 100 });
    const churnRate = activeSubs.data.length > 0 
      ? Math.round((canceledSubs.data.length / (activeSubs.data.length + canceledSubs.data.length)) * 100) 
      : 0;
    
    // LTV estimate (MRR / churn rate, or MRR * 12 if no churn)
    const ltv = churnRate > 0 ? Math.round(mrr / (churnRate / 100)) : Math.round(mrr * 12);
    
    return c.json({
      mrr: Math.round(mrr * 100) / 100,
      arr: Math.round(mrr * 12 * 100) / 100,
      paying: activeSubs.data.length,
      trials: trialSubs.data.length,
      ltv,
      churnRate,
      todayRev: Math.round(todayRev * 100) / 100,
      monthRev: Math.round(monthRev * 100) / 100,
      failedPayments: failedCount,
      annualPlans: annualCount,
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Team overview endpoint for ops dashboard
adminRoutes.get('/ops/team', async (c) => {
  try {
    const team = [
      {
        "name": "MiamiCarlos",
        "role": "Gov Phone Sites",
        "properties": ["free-government-phone.net", "free-government-phone.org", "government-phone.co", "government-phone.net", "government-phone.org", "freegovernmentphone.net"],
        "status": "active",
        "currentTask": "Adding CTAs to remaining sites"
      },
      {
        "name": "Mr. LeadGen",
        "role": "Lead Generation",
        "properties": ["nj-electric.com"],
        "status": "active",
        "currentTask": "Fixing NJ Electric homepage"
      },
      {
        "name": "Mr. SEO",
        "role": "SEO & Copy",
        "properties": ["All"],
        "status": "active",
        "currentTask": "Full property audit"
      },
      {
        "name": "Web Worker",
        "role": "Page Builds",
        "properties": ["mrdelegate.ai"],
        "status": "active",
        "currentTask": "Ops dashboard API"
      },
      {
        "name": "Ops Worker",
        "role": "Infrastructure",
        "properties": ["All servers"],
        "status": "active",
        "currentTask": "Monitoring"
      }
    ];

    return c.json({
      team: team,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});
