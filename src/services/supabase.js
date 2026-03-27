import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default supabase;

// ─── Customers ────────────────────────────────────────────────────────────────

export async function getCustomerByEmail(email) {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('email', email)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function getCustomerById(id) {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', id)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function getCustomerBySubscription(subscriptionId) {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('stripe_subscription_id', subscriptionId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function getCustomerByStripeId(stripeCustomerId) {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function createCustomer(data) {
  const { data: customer, error } = await supabase
    .from('customers')
    .insert(data)
    .select()
    .single();
  if (error) throw error;
  return customer;
}

export async function updateCustomer(id, updates) {
  const { data, error } = await supabase
    .from('customers')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function claimProvisioningSlot(id) {
  const { data, error } = await supabase
    .from('customers')
    .update({
      vps_status: 'provisioning',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .is('vultr_instance_id', null)
    .in('vps_status', ['pending', 'failed'])
    .select('id');

  if (error) throw error;
  return (data || []).length > 0;
}

export async function getAllCustomers() {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getActiveCustomers() {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .in('status', ['active', 'trial'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ─── Magic Tokens ─────────────────────────────────────────────────────────────

export async function createMagicToken(email, token, expiresAt) {
  const { error } = await supabase
    .from('magic_tokens')
    .insert({ email, token, expires_at: expiresAt });
  if (error) throw error;
}

export async function getMagicToken(token) {
  const { data, error } = await supabase
    .from('magic_tokens')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function consumeMagicToken(token) {
  const { error } = await supabase
    .from('magic_tokens')
    .update({ used: true })
    .eq('token', token);
  if (error) throw error;
}

// ─── OAuth Tokens ─────────────────────────────────────────────────────────────

export async function getOAuthToken(customerId, provider) {
  const { data, error } = await supabase
    .from('oauth_tokens')
    .select('*')
    .eq('customer_id', customerId)
    .eq('provider', provider)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function upsertOAuthToken(customerId, provider, tokens) {
  const { error } = await supabase
    .from('oauth_tokens')
    .upsert({
      customer_id: customerId,
      provider,
      ...tokens,
    }, { onConflict: 'customer_id,provider' });
  if (error) throw error;
}

// ─── Email Queue ──────────────────────────────────────────────────────────────

export async function queueEmail(customerId, toEmail, template, data = {}, scheduledFor = null) {
  const { error } = await supabase
    .from('email_queue')
    .insert({
      customer_id: customerId,
      to_email: toEmail,
      template,
      data,
      scheduled_for: scheduledFor || new Date().toISOString(),
    });
  if (error) throw error;
}

export async function getPendingEmails() {
  const { data, error } = await supabase
    .from('email_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(50);
  if (error) throw error;
  return data;
}

export async function markEmailSent(id) {
  const { error } = await supabase
    .from('email_queue')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function markEmailFailed(id, errorMsg) {
  const { error } = await supabase
    .from('email_queue')
    .update({ status: 'failed', error: errorMsg })
    .eq('id', id);
  if (error) throw error;
}

// ─── VPS Fleet ────────────────────────────────────────────────────────────────

export async function upsertVPS(vultrId, data) {
  const { error } = await supabase
    .from('vps_fleet')
    .upsert({ vultr_id: vultrId, ...data }, { onConflict: 'vultr_id' });
  if (error) throw error;
}

export async function getVPSByCustomer(customerId) {
  const { data, error } = await supabase
    .from('vps_fleet')
    .select('*')
    .eq('customer_id', customerId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

// ─── Activity Log ─────────────────────────────────────────────────────────────

export async function logActivity(customerId, event, data = {}) {
  const { error } = await supabase
    .from('activity_log')
    .insert({ customer_id: customerId, event, data });
  if (error) console.error('Activity log error:', error.message);
}

export async function getRecentActivity(customerId, limit = 20) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// ─── Waitlist ─────────────────────────────────────────────────────────────────

export async function addToWaitlist(email, name = null, source = null) {
  const { error } = await supabase
    .from('waitlist')
    .upsert({ email, name, source }, { onConflict: 'email' });
  if (error) throw error;
}

export async function getWaitlist() {
  const { data, error } = await supabase
    .from('waitlist')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ─── NJ Electric Leads ────────────────────────────────────────────────────────

export async function createNJElectricLead(leadData) {
  const { data, error } = await supabase
    .from('nj_electric_leads')
    .insert({
      name: leadData.name,
      phone: leadData.phone,
      email: leadData.email,
      service: leadData.service,
      message: leadData.message,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getNJElectricLeads() {
  const { data, error } = await supabase
    .from('nj_electric_leads')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getNJElectricLeadById(id) {
  const { data, error } = await supabase
    .from('nj_electric_leads')
    .select('*')
    .eq('id', id)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function updateNJElectricLead(id, updates) {
  const { data, error } = await supabase
    .from('nj_electric_leads')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteNJElectricLead(id) {
  const { error } = await supabase
    .from('nj_electric_leads')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ─── Stats (for admin dashboard) ─────────────────────────────────────────────

export async function getStats() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: total },
    { count: active },
    { count: trial },
    { count: cancelled },
    { count: leads },
    { count: founders },
    { count: newThisWeek },
    { count: newThisMonth },
    { count: cancellationsThisMonth },
  ] = await Promise.all([
    supabase.from('customers').select('*', { count: 'exact', head: true }),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('status', 'trial'),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('status', 'cancelled'),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('status', 'lead'),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('status', 'founder'),
    supabase.from('customers').select('*', { count: 'exact', head: true }).gte('created_at', weekStart),
    supabase.from('customers').select('*', { count: 'exact', head: true }).gte('created_at', monthStart),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('status', 'cancelled').gte('cancelled_at', monthStart),
  ]);

  // MRR price per seat — update if plan price changes
  const MRR_PER_SEAT = 47;

  // MRR = sum of mrr field for active customers (fallback: active * price for those with Stripe)
  let mrr = 0;
  let paidActive = 0;
  try {
    const { data: mrrData } = await supabase
      .from('customers')
      .select('mrr')
      .eq('status', 'active');
    if (mrrData && mrrData.length > 0) {
      mrr = mrrData.reduce((sum, c) => sum + (Number(c.mrr) || 0), 0);
      // If mrr column is all zeros, fall back to headcount × $47 for Stripe-connected accounts
      if (mrr === 0) {
        const { count: sc } = await supabase
          .from('customers')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'active')
          .not('stripe_customer_id', 'is', null);
        paidActive = sc || 0;
        mrr = paidActive * MRR_PER_SEAT;
      }
    } else if ((active || 0) > 0) {
      const { count: sc } = await supabase
        .from('customers')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active')
        .not('stripe_customer_id', 'is', null);
      paidActive = sc || 0;
      mrr = paidActive * MRR_PER_SEAT;
    }
  } catch {
    mrr = 0;
  }

  // VPS provisioning stats
  let vpsProvisionedCount = 0;
  let vpsSuccessRate = 0;
  try {
    const { count: vpsTotal } = await supabase
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .not('vps_ip', 'is', null);
    const { count: vpsAttempted } = await supabase
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .not('vps_status', 'is', null)
      .neq('vps_status', 'pending');
    vpsProvisionedCount = vpsTotal || 0;
    vpsSuccessRate = vpsAttempted > 0 ? Math.round((vpsTotal / vpsAttempted) * 100) : 0;
  } catch {}

  // Conversion rate: active / (active + trial + cancelled) — includes all who ever started a trial
  const conversionRate = (active || 0) > 0 && (total || 0) > 0
    ? Math.round(((active || 0) / Math.max((active || 0) + (trial || 0) + (cancelled || 0), 1)) * 100)
    : 0;

  // Failed payments this month (check payment_failed status)
  let failedPaymentsThisMonth = 0;
  try {
    const { count: fp } = await supabase
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'payment_failed')
      .gte('updated_at', monthStart);
    failedPaymentsThisMonth = fp || 0;
  } catch {}

  return {
    total: total || 0,
    active: active || 0,
    trial: trial || 0,
    cancelled: cancelled || 0,
    leads: leads || 0,
    founders: founders || 0,
    mrr,
    newSignupsThisWeek: newThisWeek || 0,
    newSignupsThisMonth: newThisMonth || 0,
    cancellationsThisMonth: cancellationsThisMonth || 0,
    conversionRate,
    arpu: (active || 0) > 0 ? Math.round(mrr / (active || 1)) : 0,
    failedPaymentsThisMonth,
    vpsProvisionedCount,
    vpsSuccessRate,
  };
}
