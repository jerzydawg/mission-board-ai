import { Hono } from 'hono';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import { provisionVPS } from '../services/provisioner.js';
import { sendEmail, SEQUENCES, buildSequenceEmail } from '../services/email.js';
import {
  getCustomerByEmail,
  getCustomerByStripeId,
  getCustomerBySubscription,
  getCustomerById,
  createCustomer,
  updateCustomer,
  claimProvisioningSlot,
  logActivity,
  queueEmail,
} from '../services/supabase.js';
import supabase from '../services/supabase.js';

// Customer JWT secret (matches middleware/customer routes)
const CUSTOMER_JWT_SECRET = (() => {
  if (!process.env.CUSTOMER_JWT_SECRET) throw new Error('CUSTOMER_JWT_SECRET env var required');
  return process.env.CUSTOMER_JWT_SECRET;
})();
const JWT_SECRET = (() => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET env var required');
  return process.env.JWT_SECRET;
})();
const checkoutAttempts = new Map();
const CHECKOUT_WINDOW_MS = 60 * 1000;
const CHECKOUT_MAX_ATTEMPTS = 5;

function getRequestIp(c) {
  return (c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown').split(',')[0].trim();
}

function checkRateLimit(store, key, maxAttempts, windowMs) {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now - entry.start > windowMs) {
    store.set(key, { count: 1, start: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= maxAttempts;
}

export const stripeRoutes = new Hono();

const APP_URL = process.env.APP_URL || 'https://mrdelegate.ai';

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
}

// ── Helper: queue a full email sequence ─────────────────────────
async function queueSequenceEmails(customerId, email, name, sequences) {
  for (const { sequence, step, delayHours } of sequences) {
    const sendAt = new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString();
    try {
      await queueEmail(customerId, email, sequence, {
        sequence,
        step,
        name: name || email.split('@')[0],
      }, sendAt);
      console.log(`[email] Queued ${sequence}[${step}] for ${email} at +${delayHours}h`);
    } catch (err) {
      console.error(`[email] Failed to queue ${sequence}[${step}] for ${email}:`, err.message);
    }
  }
}

function getInvoicePlanAmount(invoice) {
  const amountCents = invoice?.lines?.data?.[0]?.price?.unit_amount
    ?? invoice?.amount_due
    ?? invoice?.amount_paid
    ?? 0;
  return amountCents / 100;
}

// ─────────────────────────────────────────────
// POST /api/stripe/checkout
// Called from /start onboarding page
// ─────────────────────────────────────────────
stripeRoutes.post('/checkout', async (c) => {
  const rateKey = `checkout:${getRequestIp(c)}`;
  if (!checkRateLimit(checkoutAttempts, rateKey, CHECKOUT_MAX_ATTEMPTS, CHECKOUT_WINDOW_MS)) {
    return c.json({ error: 'Too many checkout attempts. Try again in a minute.' }, 429);
  }

  let stripe;
  try { stripe = getStripe(); } catch (e) {
    return c.json({ error: 'Stripe not configured. Contact support.' }, 503);
  }

  const { email, name, channel, channelHandle, aiProvider, plan, timezone, briefTime } = await c.req.json();
  if (!email) return c.json({ error: 'Email required' }, 400);
  // Validate email format before calling Stripe (prevents 500 on malformed inputs)
  if (typeof email !== 'string' || email.length > 254 || !/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email)) {
    return c.json({ error: 'Invalid email address' }, 400);
  }

  const isAnnual = plan === 'annual';
  if (isAnnual && !process.env.STRIPE_ANNUAL_PRICE_ID) {
    console.error('[stripe] STRIPE_ANNUAL_PRICE_ID not set — refusing annual checkout');
    return c.json({ error: 'Annual plan not available. Contact support.' }, 503);
  }
  const priceId = isAnnual
    ? process.env.STRIPE_ANNUAL_PRICE_ID
    : process.env.STRIPE_PRICE_ID;

  if (!priceId) {
    return c.json({ error: 'Stripe price not configured. Contact support.' }, 503);
  }

  // Pre-create or update customer in Supabase with onboarding data
  // so webhook has it when it fires
  try {
    let customer = await getCustomerByEmail(email.toLowerCase().trim());
    const onboardingData = {
      name: name || email.split('@')[0],
      channel: channel || 'telegram',
      channel_handle: channelHandle || '',
      ai_provider: aiProvider || 'gemini',
      status: 'lead',
      ...(timezone ? { timezone } : {}),
      ...(briefTime ? { brief_time: briefTime } : {}),
    };
    if (customer) {
      await updateCustomer(customer.id, onboardingData);
    } else {
      await createCustomer({ email: email.toLowerCase().trim(), ...onboardingData });
    }
  } catch (e) {
    console.error('[stripe] Pre-create customer error (non-fatal):', e.message);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: email,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 3, // 3-day trial — card required, $0 today
      metadata: { source: 'mrdelegate-onboarding', email, name: name || '', channel: channel || 'telegram', channelHandle: channelHandle || '', aiProvider: aiProvider || 'gemini' },
    },
    // Stripe compliance: show terms + privacy links at checkout
    consent_collection: { terms_of_service: 'required' },
    custom_text: {
      terms_of_service_acceptance: {
        message: `I agree to the [Terms of Service](https://mrdelegate.ai/terms) and [Privacy Policy](https://mrdelegate.ai/privacy). ${isAnnual ? '$397/yr' : '$47/mo'} after 3-day trial. Cancel anytime.`,
      },
    },
    success_url: `${APP_URL}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/start?cancelled=true`,
    metadata: { email, name: name || '', channel: channel || 'telegram', channelHandle: channelHandle || '', aiProvider: aiProvider || 'gemini' },
    // Stripe compliance: allow billing address for fraud prevention
    billing_address_collection: 'auto',
  });

  return c.json({ url: session.url, sessionId: session.id });
});

// ─────────────────────────────────────────────
// GET /api/stripe/session?session_id=xxx
// Called by /welcome page on load.
// Retrieves Stripe checkout session, finds customer in Supabase,
// sets md_customer_token JWT cookie, returns customer info.
// ─────────────────────────────────────────────
stripeRoutes.get('/session', async (c) => {
  let stripe;
  try { stripe = getStripe(); } catch (e) { return c.json({ error: 'Stripe not configured' }, 503); }

  const sessionId = c.req.query('session_id');
  if (!sessionId) return c.json({ error: 'session_id required' }, 400);

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const email = session.customer_email || session.metadata?.email;
    if (!email) return c.json({ error: 'No email in session' }, 400);

    // Look up customer in Supabase
    let customer = await getCustomerByEmail(email.toLowerCase());
    if (!customer) {
      // Webhook may not have fired yet — return minimal info from session
      return c.json({
        status: 'provisioning',
        vps_status: 'provisioning',
        vps_ip: null,
        progress: 10,
        email,
        name: session.metadata?.name || email.split('@')[0],
      });
    }

    // Issue md_customer_token JWT cookie
    const token = jwt.sign(
      { customerId: customer.id, email: customer.email },
      CUSTOMER_JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Set cookie — SameSite=Lax works for same-origin; Secure only in prod
    const isSecure = (process.env.APP_URL || '').startsWith('https');
    c.header('Set-Cookie',
      `md_customer_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isSecure ? '; Secure' : ''}`
    );

    const vpsStatus = customer.vps_status || 'pending';
    const progressMap = { pending: 10, provisioning: 50, active: 100, failed: 0 };

    return c.json({
      ok: true,
      id: customer.id,
      email: customer.email,
      name: customer.name,
      vps_status: vpsStatus,
      vps_ip: customer.vps_ip || null,
      progress: progressMap[vpsStatus] ?? 10,
      bot_username: customer.bot_username || null,
      ai_provider: customer.ai_provider || 'gemini',
      gemini_key_set: !!(customer.gemini_key_set),
      onboarding_complete: !!(customer.onboarding_complete),
      status: customer.status,
      trial_ends_at: customer.trial_ends_at || null,
    });
  } catch (e) {
    console.error('[stripe/session] Error:', e.message);
    // Stripe throws on invalid session IDs — return 400, not 500
    const status = e.type === 'StripeInvalidRequestError' ? 400 : 500;
    return c.json({ error: status === 400 ? 'Invalid session ID' : 'Failed to retrieve session' }, status);
  }
});

// ─────────────────────────────────────────────
// GET /api/stripe/session/:sessionId
// Called from /start/success to confirm checkout
// ─────────────────────────────────────────────
stripeRoutes.get('/session/:sessionId', async (c) => {
  let stripe;
  try { stripe = getStripe(); } catch (e) { return c.json({ error: 'Stripe not configured' }, 503); }

  const { sessionId } = c.req.param();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  return c.json({
    status: session.payment_status,
    email: session.customer_email,
    name: session.metadata?.name || '',
    customerId: session.customer,
    ai_provider: session.metadata?.aiProvider || 'gemini',
  });
});

// ─────────────────────────────────────────────
// POST /api/stripe/webhook
// Stripe sends events here — MUST be raw body
// ─────────────────────────────────────────────
stripeRoutes.post('/webhook', async (c) => {
  let stripe;
  try { stripe = getStripe(); } catch (e) { return c.json({ error: 'Stripe not configured' }, 503); }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[stripe] STRIPE_WEBHOOK_SECRET not configured');
    return c.json({ error: 'Webhook not configured' }, 503);
  }

  const body = await c.req.text();
  const sig = c.req.header('stripe-signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe] Webhook signature failed:', err.message);
    return c.json({ error: 'Invalid signature' }, 400);
  }

  console.log(`[stripe] ${event.type} (${event.id})`);

  switch (event.type) {

    // ── New subscriber — trial starts ──────────────────────────
    case 'checkout.session.completed': {
      const session = event.data.object;
      const stripeCustomerId = session.customer;
      const stripeSubscriptionId = session.subscription;
      const email = session.customer_email || session.metadata?.email;
      const name = session.metadata?.name || email?.split('@')[0] || 'Customer';

      console.log(`[stripe] New signup: ${email}`);

      // Upsert customer in Supabase
      let customer = await getCustomerByEmail(email);
      if (customer) {
        // Upgrade existing lead/trial to trial with Stripe IDs
        await updateCustomer(customer.id, {
          stripe_customer_id: stripeCustomerId,
          stripe_subscription_id: stripeSubscriptionId,
          status: 'trial',
          trial_ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          vps_status: 'pending',
          name,
        });
        customer = await getCustomerByEmail(email);
      } else {
        customer = await createCustomer({
          email,
          name,
          stripe_customer_id: stripeCustomerId,
          stripe_subscription_id: stripeSubscriptionId,
          status: 'trial',
          trial_ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          vps_status: 'pending',
        });
      }

      await logActivity(customer.id, 'checkout_completed', { stripeCustomerId, stripeSubscriptionId });

      // Atomically claim the row before provisioning.
      // This blocks duplicate Stripe deliveries from double-creating VPS instances.
      const claimed = await claimProvisioningSlot(customer.id);
      if (!claimed) {
        console.log(`[provision] Skipping — provisioning already claimed for ${email}`);
        break;
      }

      try {
        const vps = await provisionVPS({ ...customer, stripeCustomerId });
        const botUsername = `md_${stripeCustomerId.slice(-8)}`;
        await updateCustomer(customer.id, {
          vps_status: 'active',
          vps_ip: vps.main_ip || null,
          vultr_instance_id: vps.id,
          provisioned_at: new Date().toISOString(),
          bot_username: botUsername,
        });
        await logActivity(customer.id, 'vps_provisioned', { ip: vps.main_ip, instanceId: vps.id });
        console.log(`[provision] VPS live for ${email}: ${vps.main_ip}`);

        // ── Send welcome Telegram message ───────────────────────
        try {
          const telegramService = await import('../services/telegram.js');
          const channelHandle = customer.channel_handle || customer.channel_id || '';
          if (channelHandle) {
            await telegramService.sendWelcomeMessage({
              name: name || customer.name,
              channelHandle,
              botToken: process.env.TELEGRAM_BOT_TOKEN
            });
          }
        } catch (tgErr) {
          console.error(`[telegram] Welcome message failed for ${email}:`, tgErr.message);
        }

        // ── Send welcome email immediately (with bot link if available) ──
        try {
          // Re-fetch customer to get bot_username (may have been set during provisioning)
          const freshCustomer = await getCustomerByEmail(email);
          const botUsername = freshCustomer?.bot_username || null;
          const { subject, html } = buildSequenceEmail('welcome', 0, name, email, { bot_username: botUsername });
          await sendEmail({ to: email, subject, html });
          console.log(`[email] Welcome email sent to ${email} (bot: ${botUsername || 'pending'})`);
        } catch (emailErr) {
          console.error(`[email] Failed to send welcome to ${email}:`, emailErr.message);
          // Queue for retry — customer must not be stranded
          try {
            await queueEmail(customer.id, email, 'welcome', {
              sequence: 'welcome',
              step: 0,
              name: name || email.split('@')[0],
              retry_count: 1,
            }, new Date(Date.now() + 60 * 1000).toISOString()); // retry in 1 min
            console.log(`[email] Queued welcome email retry for ${email}`);
          } catch (queueErr) {
            console.error(`[email] Failed to queue welcome retry for ${email}:`, queueErr.message);
          }
        }

        // ── Queue trial engagement email sequence ──────────────
        // Uses current branded sequences (upgraded 2026-03-20 by Email Agent)
        await queueSequenceEmails(customer.id, email, name, [
          { sequence: 'onboardingNudge',     step: 0, delayHours: 24 },  // Day 1: connected?
          { sequence: 'valueReinforcement',  step: 0, delayHours: 48 },  // Day 2: agent worked while you slept
          { sequence: 'trialEnding',         step: 0, delayHours: 60 },  // Day 2.5: 12h left in 72h trial
          { sequence: 'onboardingTips',      step: 0, delayHours: 72 },  // Day 3: power user tips (legacy, kept)
          { sequence: 'weekOneStats',        step: 0, delayHours: 168 }, // Day 7: stats recap
          { sequence: 'featureSpotlight',    step: 0, delayHours: 336 }, // Day 14: calendar protection spotlight
          { sequence: 'monthOneSummary',     step: 0, delayHours: 720 }, // Day 30: monthly recap
          { sequence: 'day60CheckIn',        step: 0, delayHours: 1440 }, // Day 60: member check-in
        ]);

      } catch (err) {
        console.error(`[provision] Failed for ${email}:`, err.message);
        await updateCustomer(customer.id, { vps_status: 'failed' });
        await logActivity(customer.id, 'vps_provision_failed', { error: err.message });

        // ── Send provision failed email ─────────────────────────
        try {
          const { subject, html } = buildSequenceEmail('provisionFailed', 0, name, email);
          await sendEmail({ to: email, subject, html });
          console.log(`[email] Provision-failed email sent to ${email}`);
        } catch (emailErr) {
          console.error(`[email] Failed to send provision-failed to ${email}:`, emailErr.message);
        }
      }
      break;
    }

    // ── Checkout abandoned / expired ───────────────────────────
    case 'checkout.session.expired': {
      const session = event.data.object;
      const email = session.customer_email || session.metadata?.email;
      if (!email) break;

      const customer = await getCustomerByEmail(email.toLowerCase().trim());
      if (!customer) break;

      if (customer.status === 'trial' || customer.status === 'active') {
        console.log(`[stripe] Ignoring expired checkout for active customer: ${email}`);
        break;
      }

      await logActivity(customer.id, 'checkout_expired', { sessionId: session.id });

      try {
        await queueEmail(customer.id, email, 'abandonedCheckout', {
          sequence: 'abandonedCheckout',
          step: 0,
          name: customer.name || session.metadata?.name || email.split('@')[0],
        });
        console.log(`[email] Queued abandoned checkout recovery for ${email}`);
      } catch (err) {
        console.error(`[email] Failed to queue abandoned checkout recovery for ${email}:`, err.message);
      }
      break;
    }

    // ── Trial ended, first real charge succeeded ───────────────
    case 'invoice.paid': {
      const invoice = event.data.object;
      if (invoice.billing_reason === 'subscription_create') break; // trial setup invoice, skip
      const customer = await getCustomerByStripeId(invoice.customer);
      if (!customer) break;
      const amountPaid = getInvoicePlanAmount(invoice);
      // Only upgrade from trial to active on real payment
      if (customer.status === 'trial') {
        await updateCustomer(customer.id, {
          status: 'active',
          mrr: amountPaid >= 300 ? Math.round((amountPaid / 12) * 100) / 100 : amountPaid || 47,
          trial_ends_at: null,
        });
        await logActivity(customer.id, 'converted_to_paid', { amount: invoice.amount_paid, amountPaid });
        console.log(`[stripe] Trial converted: ${customer.email}`);

        // ── Send conversion celebration email ───────────────────
        try {
          const { subject, html } = buildSequenceEmail('conversionCelebration', 0, customer.name, customer.email, {
            amountPaid,
            isAnnual: amountPaid >= 300,
          });
          await sendEmail({ to: customer.email, subject, html });
          console.log(`[email] Conversion celebration sent to ${customer.email}`);
        } catch (emailErr) {
          console.error(`[email] Failed to send conversion email to ${customer.email}:`, emailErr.message);
        }
      }
      break;
    }

    // ── Payment failed ─────────────────────────────────────────
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customer = await getCustomerByStripeId(invoice.customer);
      if (!customer) break;
      await updateCustomer(customer.id, { status: 'payment_failed' });
      await logActivity(customer.id, 'payment_failed', { invoiceId: invoice.id, attempt: invoice.attempt_count });
      console.log(`[stripe] Payment failed: ${customer.email} (attempt ${invoice.attempt_count})`);
      try {
        const { subject, html } = buildSequenceEmail('paymentFailed', 0, customer.name, customer.email, {
          attemptCount: invoice.attempt_count || 1,
        });
        await sendEmail({ to: customer.email, subject, html });
        console.log(`[email] Payment failed notification sent to ${customer.email}`);
      } catch (emailErr) {
        console.error(`[email] Failed to send payment-failed email to ${customer.email}:`, emailErr.message);
        try {
          await queueEmail(customer.id, customer.email, 'paymentFailed', {
            sequence: 'paymentFailed',
            step: 0,
            name: customer.name || customer.email.split('@')[0],
            context: { attemptCount: invoice.attempt_count || 1 },
          }, new Date(Date.now() + 15 * 60 * 1000).toISOString());
          console.log(`[email] Queued payment-failed retry for ${customer.email}`);
        } catch (queueErr) {
          console.error(`[email] Failed to queue payment-failed retry for ${customer.email}:`, queueErr.message);
        }
      }
      break;
    }

    // ── Subscription cancelled ─────────────────────────────────
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const customer = await getCustomerBySubscription(sub.id);
      if (!customer) break;
      console.log(`[stripe] Cancelled: ${customer.email}`);

      // 7-day grace period: VPS stays up until delete_after passes.
      // vps-lifecycle-worker.js will delete it automatically after that.
      const cancelledAt = new Date().toISOString();
      const deleteAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      await updateCustomer(customer.id, {
        status: 'cancelled',
        mrr: 0,
        cancelled_at: cancelledAt,
        delete_after: deleteAfter,
        vps_status: 'pending_deletion',
      });
      await logActivity(customer.id, 'cancelled', {});

      // ── Queue cancellation/win-back email (1h delay) ──────────
      try {
        await queueSequenceEmails(customer.id, customer.email, customer.name, [
          { sequence: 'cancelled', step: 0, delayHours: 1 },
        ]);
      } catch (emailErr) {
        console.error(`[email] Failed to queue cancellation email for ${customer.email}:`, emailErr.message);
      }

      // ── Churn feedback survey ─────────────────────────────────
      try {
        const createdAt  = customer.created_at ? new Date(customer.created_at) : null;
        const daysActive = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : null;

        // Generate a 30-day survey token
        const surveyToken = jwt.sign(
          { customerId: customer.id, email: customer.email, name: customer.name, purpose: 'cancel_survey' },
          CUSTOMER_JWT_SECRET,
          { expiresIn: '30d' }
        );

        // Log to cancellation_feedback table
        await supabase.from('cancellation_feedback').insert({
          customer_id:      customer.id,
          email:            customer.email,
          cancel_date:      cancelledAt,
          days_active:      daysActive,
          plan:             customer.plan || null,
          survey_token:     surveyToken,
          survey_completed: false,
        });

        // Send survey link to customer via Telegram
        const chatId = customer.telegram_chat_id || customer.channel_id;
        if (chatId && process.env.TELEGRAM_BOT_TOKEN) {
          const surveyUrl = `${APP_URL}/survey/cancel?token=${surveyToken}`;
          const firstName = customer.name ? customer.name.split(' ')[0] : 'there';
          const msg =
            `Hey ${firstName}, sorry to see you go. 💙\n\n` +
            `One quick question — what could we have done better?\n\n` +
            `${surveyUrl}\n\nTakes 30 seconds. Your answer helps us improve.`;
          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: msg }),
          });
          console.log(`[churn] Survey sent via Telegram to ${customer.email}`);
        }

        // Alert founder about cancellation
        const founderChatId = process.env.FOUNDER_TELEGRAM_ID;
        if (founderChatId && process.env.TELEGRAM_BOT_TOKEN) {
          const displayName = customer.name || customer.email;
          const days = daysActive !== null ? `${daysActive}d active` : 'unknown duration';
          const alertMsg =
            `😞 <b>Cancellation</b>\n\n<b>${displayName}</b> (${customer.plan || 'unknown'}, ${days}) just cancelled.\n\nSurvey sent. Tracking in dashboard → Churn.`;
          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: founderChatId, text: alertMsg, parse_mode: 'HTML' }),
          });
        }

        console.log(`[churn] Feedback record created for ${customer.email}`);
      } catch (churnErr) {
        console.error(`[churn] Failed to create feedback record for ${customer.email}:`, churnErr.message);
      }

      break;
    }

    // ── Trial ending warning (fires 3 days before trial ends) ──
    case 'customer.subscription.trial_will_end': {
      const sub = event.data.object;
      const customer = await getCustomerByStripeId(sub.customer);
      if (!customer) break;
      await logActivity(customer.id, 'trial_ending_soon', { trialEnd: sub.trial_end });
      console.log(`[stripe] Trial ending soon: ${customer.email} (ends ${new Date(sub.trial_end * 1000).toISOString()})`);
      if (!customer.email_unsubscribed) {
        try {
          const { subject, html } = buildSequenceEmail('trialEnding', 0, customer.name, customer.email);
          await sendEmail({ to: customer.email, subject, html });
          console.log(`[email] Trial ending warning sent to ${customer.email}`);
        } catch (emailErr) {
          console.error(`[email] Failed to send trial_will_end to ${customer.email}:`, emailErr.message);
          try {
            await queueEmail(customer.id, customer.email, 'trialEnding', {
              sequence: 'trialEnding',
              step: 0,
              name: customer.name || customer.email.split('@')[0],
            }, new Date(Date.now() + 15 * 60 * 1000).toISOString());
            console.log(`[email] Queued trial-ending retry for ${customer.email}`);
          } catch (queueErr) {
            console.error(`[email] Failed to queue trial-ending retry for ${customer.email}:`, queueErr.message);
          }
        }
      }
      break;
    }

    // ── Payment succeeded (renewal confirmations) ──────────────
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      if (invoice.billing_reason === 'subscription_create') break; // trial setup, skip
      const customer = await getCustomerByStripeId(invoice.customer);
      if (!customer) break;
      const amountPaid = getInvoicePlanAmount(invoice);
      await logActivity(customer.id, 'payment_succeeded', { invoiceId: invoice.id, amount: invoice.amount_paid, amountPaid });
      console.log(`[stripe] Payment succeeded: ${customer.email} ($${amountPaid})`);
      break;
    }

    // ── Subscription updated (trial → active, etc.) ────────────
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const customer = await getCustomerBySubscription(sub.id);
      if (!customer) break;
      if (sub.status === 'active' && customer.status === 'trial') {
        // Trial converted — invoice.paid handles the DB update
      }
      await logActivity(customer.id, 'subscription_updated', { status: sub.status });
      break;
    }

    default:
      // Log but don't error on unknown events
      break;
  }

  return c.json({ received: true });
});

// ─────────────────────────────────────────────
// GET /api/stripe/portal/:customerId
// Returns Stripe customer portal URL for self-service billing
// ─────────────────────────────────────────────
stripeRoutes.get('/portal/:customerId', async (c) => {
  let stripe;
  try { stripe = getStripe(); } catch (e) { return c.json({ error: 'Stripe not configured' }, 503); }

  const customer = await getCustomerByStripeId(c.req.param('customerId'));
  if (!customer?.stripe_customer_id) return c.json({ error: 'No billing account found' }, 404);

  const auth = c.req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const cookie = c.req.header('cookie') || '';
  const mdCustomerToken = cookie.match(/md_customer_token=([^;]+)/)?.[1];
  const mdToken = cookie.match(/md_token=([^;]+)/)?.[1];

  let decoded = null;
  for (const candidate of [token, mdCustomerToken, mdToken]) {
    if (!candidate) continue;
    try {
      decoded = jwt.verify(candidate, JWT_SECRET);
      break;
    } catch {}
    try {
      decoded = jwt.verify(candidate, CUSTOMER_JWT_SECRET);
      break;
    } catch {}
  }

  if (!decoded) return c.json({ error: 'Unauthorized' }, 401);
  if (decoded.role !== 'admin' && decoded.customerId !== customer.id && decoded.email !== customer.email) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customer.stripe_customer_id,
    return_url: `${APP_URL}/app`,
  });
  return c.json({ url: session.url });
});

// GET /api/stripe/subscription/:stripeCustomerId
// Returns real subscription data for the billing tab
stripeRoutes.get('/subscription/:stripeCustomerId', async (c) => {
  let stripe;
  try { stripe = getStripe(); } catch (e) { return c.json({ error: 'Stripe not configured' }, 503); }

  const stripeCustomerId = c.req.param('stripeCustomerId');
  const customer = await getCustomerByStripeId(stripeCustomerId);
  if (!customer?.stripe_customer_id) return c.json({ error: 'No billing account found' }, 404);

  // Auth check
  const auth = c.req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const cookie = c.req.header('cookie') || '';
  const mdCustomerToken = cookie.match(/md_customer_token=([^;]+)/)?.[1];
  let decoded = null;
  for (const candidate of [token, mdCustomerToken]) {
    if (!candidate) continue;
    try { decoded = jwt.verify(candidate, CUSTOMER_JWT_SECRET); break; } catch {}
    try { decoded = jwt.verify(candidate, JWT_SECRET); break; } catch {}
  }
  if (!decoded) return c.json({ error: 'Unauthorized' }, 401);
  if (decoded.role !== 'admin' && decoded.customerId !== customer.id && decoded.email !== customer.email) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.stripe_customer_id,
      status: 'all',
      limit: 1,
      expand: ['data.default_payment_method'],
    });

    const sub = subscriptions.data[0];
    if (!sub) return c.json({ subscription: null });

    const item = sub.items?.data?.[0];
    const price = item?.price;
    const amountCents = price?.unit_amount || 0;
    const interval = price?.recurring?.interval || 'month';
    const amountDollars = amountCents / 100;

    // Payment method details
    let paymentLast4 = null;
    let paymentBrand = null;
    const pm = sub.default_payment_method;
    if (pm?.card) {
      paymentLast4 = pm.card.last4;
      paymentBrand = pm.card.brand;
    } else {
      // Try fetching from customer's default payment method
      try {
        const stripeCust = await stripe.customers.retrieve(customer.stripe_customer_id, {
          expand: ['invoice_settings.default_payment_method'],
        });
        const defaultPm = stripeCust.invoice_settings?.default_payment_method;
        if (defaultPm?.card) {
          paymentLast4 = defaultPm.card.last4;
          paymentBrand = defaultPm.card.brand;
        }
      } catch {}
    }

    return c.json({
      subscription: {
        status: sub.status,
        amount_dollars: amountDollars,
        interval,
        current_period_end: sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null,
        trial_end: sub.trial_end
          ? new Date(sub.trial_end * 1000).toISOString()
          : null,
        cancel_at_period_end: sub.cancel_at_period_end,
        payment_last4: paymentLast4,
        payment_brand: paymentBrand,
      },
    });
  } catch (e) {
    console.error('[stripe/subscription] Error:', e.message);
    return c.json({ error: 'Could not fetch subscription' }, 500);
  }
});
