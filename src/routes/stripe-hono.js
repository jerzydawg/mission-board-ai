/**
 * Stripe Integration for Hono Framework
 * 
 * Handles checkout sessions, webhooks, and subscription management
 */

import { Hono } from 'hono';
import Stripe from 'stripe';
import { createSupabaseClient } from '../services/supabase.js';

const app = new Hono();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createSupabaseClient();

/**
 * POST /create-checkout-session
 * Create Stripe checkout session with 3-day trial
 */
app.post('/create-checkout-session', async (c) => {
  try {
    const { customer_id, email, name } = await c.req.json();

    if (!customer_id || !email) {
      return c.json({ error: 'Missing customer_id or email' }, 400);
    }

    // Verify customer exists
    const { data: customer } = await supabase
      .from('customers')
      .select('id, email, name')
      .eq('id', customer_id)
      .single();

    if (!customer) {
      return c.json({ error: 'Customer not found' }, 404);
    }

    console.log(`[STRIPE] Creating checkout for ${customer.email}`);

    // Create or get Stripe customer
    let stripeCustomer;
    const existingCustomers = await stripe.customers.list({
      email: customer.email,
      limit: 1
    });

    if (existingCustomers.data.length > 0) {
      stripeCustomer = existingCustomers.data[0];
    } else {
      stripeCustomer = await stripe.customers.create({
        email: customer.email,
        name: customer.name || name,
        metadata: { customer_id }
      });
    }

    // Get price ID from environment (you'll set this after creating the product)
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      console.error('[STRIPE] STRIPE_PRICE_ID not configured');
      return c.json({ error: 'Pricing not configured - admin needs to set STRIPE_PRICE_ID' }, 500);
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomer.id,
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: 'https://mrdelegate.ai/onboarding?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://mrdelegate.ai/start?cancelled=true',
      
      // 3-day trial
      subscription_data: {
        trial_period_days: 3,
        metadata: {
          customer_id,
          plan: 'mrdelegate_standard'
        }
      },
      
      metadata: {
        customer_id,
        plan: 'mrdelegate_standard'
      },

      billing_address_collection: 'required',
      allow_promotion_codes: true,
      
      customer_update: {
        address: 'auto',
        name: 'auto'
      }
    });

    // Update customer record
    await supabase
      .from('customers')
      .update({
        stripe_customer_id: stripeCustomer.id,
        checkout_session_id: session.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', customer_id);

    return c.json({
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('[STRIPE] Checkout error:', error);
    return c.json({ 
      error: 'Failed to create checkout session',
      details: error.message 
    }, 500);
  }
});

/**
 * POST /webhook
 * Handle Stripe webhooks
 */
app.post('/webhook', async (c) => {
  const sig = c.req.header('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    console.error('[STRIPE] Webhook secret not configured');
    return c.json({ error: 'Webhook secret not configured' }, 500);
  }

  let event;
  try {
    const body = await c.req.text();
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error('[STRIPE] Webhook signature verification failed:', err.message);
    return c.json({ error: `Webhook Error: ${err.message}` }, 400);
  }

  console.log(`[STRIPE] Received event: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionCancelled(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      default:
        console.log(`[STRIPE] Unhandled event type: ${event.type}`);
    }

    return c.json({ received: true });
    
  } catch (error) {
    console.error(`[STRIPE] Error handling ${event.type}:`, error);
    return c.json({ error: 'Webhook handler failed' }, 500);
  }
});

/**
 * POST /create-billing-portal
 * Create customer billing portal session
 */
app.post('/create-billing-portal', async (c) => {
  try {
    const { customer_id } = await c.req.json();

    if (!customer_id) {
      return c.json({ error: 'Missing customer_id' }, 400);
    }

    const { data: customer } = await supabase
      .from('customers')
      .select('stripe_customer_id')
      .eq('id', customer_id)
      .single();

    if (!customer?.stripe_customer_id) {
      return c.json({ error: 'Customer not found or not activated' }, 404);
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer.stripe_customer_id,
      return_url: 'https://mrdelegate.ai/app',
    });

    return c.json({ url: portalSession.url });

  } catch (error) {
    console.error('[STRIPE] Billing portal error:', error);
    return c.json({ error: 'Failed to create billing portal session' }, 500);
  }
});

/**
 * GET /customer/:customerId/subscription
 * Get subscription status for customer dashboard
 */
app.get('/customer/:customerId/subscription', async (c) => {
  try {
    const customerId = c.req.param('customerId');

    const { data: customer } = await supabase
      .from('customers')
      .select('stripe_customer_id, stripe_subscription_id, status, trial_ends_at, current_period_end')
      .eq('id', customerId)
      .single();

    if (!customer) {
      return c.json({ error: 'Customer not found' }, 404);
    }

    let subscriptionDetails = null;
    if (customer.stripe_subscription_id) {
      try {
        subscriptionDetails = await stripe.subscriptions.retrieve(customer.stripe_subscription_id);
      } catch (error) {
        console.error('[STRIPE] Error retrieving subscription:', error);
      }
    }

    return c.json({
      status: customer.status,
      trial_ends_at: customer.trial_ends_at,
      current_period_end: customer.current_period_end,
      subscription: subscriptionDetails ? {
        id: subscriptionDetails.id,
        status: subscriptionDetails.status,
        current_period_start: subscriptionDetails.current_period_start,
        current_period_end: subscriptionDetails.current_period_end,
        trial_end: subscriptionDetails.trial_end,
        cancel_at_period_end: subscriptionDetails.cancel_at_period_end
      } : null
    });

  } catch (error) {
    console.error('[STRIPE] Subscription status error:', error);
    return c.json({ error: 'Failed to get subscription status' }, 500);
  }
});

/**
 * GET /health
 * Health check for Stripe integration
 */
app.get('/health', async (c) => {
  try {
    // Test Stripe API connection
    await stripe.prices.list({ limit: 1 });
    
    return c.json({ 
      status: 'healthy',
      stripe_connected: true,
      price_id_configured: !!process.env.STRIPE_PRICE_ID,
      webhook_secret_configured: !!process.env.STRIPE_WEBHOOK_SECRET
    });
  } catch (error) {
    return c.json({ 
      status: 'unhealthy',
      error: error.message,
      stripe_connected: false 
    }, 500);
  }
});

// Webhook handlers
async function handleCheckoutCompleted(session) {
  const customerId = session.metadata?.customer_id;
  if (!customerId) {
    console.error('[STRIPE] No customer_id in checkout session metadata');
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(session.subscription);

  await supabase
    .from('customers')
    .update({
      stripe_customer_id: session.customer,
      stripe_subscription_id: subscription.id,
      status: subscription.status === 'trialing' ? 'trial' : 'active',
      trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    })
    .eq('id', customerId);

  console.log(`[STRIPE] Customer ${customerId} activated with subscription ${subscription.id}`);
}

async function handleSubscriptionCreated(subscription) {
  const customer = await getCustomerByStripeId(subscription.customer);
  if (!customer) return;

  await supabase
    .from('customers')
    .update({
      stripe_subscription_id: subscription.id,
      status: subscription.status === 'trialing' ? 'trial' : 'active',
      trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    })
    .eq('id', customer.id);
}

async function handleSubscriptionUpdated(subscription) {
  const customer = await getCustomerByStripeId(subscription.customer);
  if (!customer) return;

  await supabase
    .from('customers')
    .update({
      status: subscription.status,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
    })
    .eq('id', customer.id);
}

async function handleSubscriptionCancelled(subscription) {
  const customer = await getCustomerByStripeId(subscription.customer);
  if (!customer) return;

  await supabase
    .from('customers')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
    })
    .eq('id', customer.id);
}

async function handlePaymentSucceeded(invoice) {
  const customer = await getCustomerByStripeId(invoice.customer);
  if (!customer) return;

  await supabase
    .from('customers')
    .update({
      last_payment_failed: false,
      last_payment_date: new Date().toISOString(),
    })
    .eq('id', customer.id);
}

async function handlePaymentFailed(invoice) {
  const customer = await getCustomerByStripeId(invoice.customer);
  if (!customer) return;

  await supabase
    .from('customers')
    .update({
      last_payment_failed: true,
      last_payment_failure_date: new Date().toISOString(),
    })
    .eq('id', customer.id);
}

async function getCustomerByStripeId(stripeCustomerId) {
  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();
    
  return data;
}

export { app as stripeRoutesNew };