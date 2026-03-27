/**
 * Stripe Webhook Handler
 * 
 * Handles all Stripe events for subscription lifecycle management
 * and prevents billing-related customer churn.
 */

const express = require('express');
const router = express.Router();
const { createSupabaseClient } = require('../services/supabase');

const supabase = createSupabaseClient();

// Stripe webhook endpoint secret (will be set after webhook creation)
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

/**
 * POST /api/stripe/webhook
 * 
 * Handles Stripe webhook events for subscription lifecycle
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  if (!WEBHOOK_SECRET) {
    console.error('[STRIPE] Webhook secret not configured');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;
  
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('[STRIPE] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
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
        
      case 'customer.subscription.trial_will_end':
        await handleTrialWillEnd(event.data.object);
        break;
        
      default:
        console.log(`[STRIPE] Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
    
  } catch (error) {
    console.error(`[STRIPE] Error handling ${event.type}:`, error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

/**
 * Handle successful checkout - activate trial or paid subscription
 */
async function handleCheckoutCompleted(session) {
  console.log('[STRIPE] Checkout completed:', session.id);
  
  const customerId = session.metadata?.customer_id;
  if (!customerId) {
    console.error('[STRIPE] No customer_id in checkout session metadata');
    return;
  }

  // Get subscription details
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const subscription = await stripe.subscriptions.retrieve(session.subscription);

  // Update customer record
  await supabase
    .from('customers')
    .update({
      stripe_customer_id: session.customer,
      stripe_subscription_id: subscription.id,
      status: subscription.status === 'trialing' ? 'trial' : 'active',
      trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', customerId);

  console.log(`[STRIPE] Customer ${customerId} activated with subscription ${subscription.id}`);

  // Trigger VPS provisioning if not already done
  await triggerVPSProvisioning(customerId);
}

/**
 * Handle new subscription creation
 */
async function handleSubscriptionCreated(subscription) {
  console.log('[STRIPE] Subscription created:', subscription.id);
  
  const customer = await getCustomerByStripeId(subscription.customer);
  if (!customer) {
    console.error('[STRIPE] Customer not found for subscription:', subscription.id);
    return;
  }

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

/**
 * Handle subscription updates (plan changes, etc.)
 */
async function handleSubscriptionUpdated(subscription) {
  console.log('[STRIPE] Subscription updated:', subscription.id);
  
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

  // If subscription became active from trial, notify customer
  if (subscription.status === 'active' && customer.status === 'trial') {
    await notifyCustomer(customer.id, 'subscription_activated', 'Your MrDelegate subscription is now active! Your agent will continue working without interruption.');
  }
}

/**
 * Handle subscription cancellation
 */
async function handleSubscriptionCancelled(subscription) {
  console.log('[STRIPE] Subscription cancelled:', subscription.id);
  
  const customer = await getCustomerByStripeId(subscription.customer);
  if (!customer) return;

  await supabase
    .from('customers')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
    })
    .eq('id', customer.id);

  // Schedule VPS termination for end of billing period
  const endDate = new Date(subscription.current_period_end * 1000);
  console.log(`[STRIPE] Scheduling VPS termination for ${customer.id} at ${endDate}`);

  // TODO: Implement delayed VPS termination
  // await scheduleVPSTermination(customer.id, endDate);

  // Notify customer
  await notifyCustomer(customer.id, 'subscription_cancelled', 
    `Your MrDelegate subscription has been cancelled. Your agent will continue working until ${endDate.toLocaleDateString()}.`);
}

/**
 * Handle successful payment
 */
async function handlePaymentSucceeded(invoice) {
  console.log('[STRIPE] Payment succeeded:', invoice.id);
  
  const customer = await getCustomerByStripeId(invoice.customer);
  if (!customer) return;

  // Reset any payment failure flags
  await supabase
    .from('customers')
    .update({
      last_payment_failed: false,
      last_payment_date: new Date().toISOString(),
    })
    .eq('id', customer.id);

  // If this resolves a payment failure, notify customer
  if (customer.last_payment_failed) {
    await notifyCustomer(customer.id, 'payment_resolved', 'Your payment has been processed successfully. Your agent is fully active again.');
  }
}

/**
 * Handle failed payment - critical for preventing service interruption
 */
async function handlePaymentFailed(invoice) {
  console.log('[STRIPE] Payment failed:', invoice.id);
  
  const customer = await getCustomerByStripeId(invoice.customer);
  if (!customer) return;

  await supabase
    .from('customers')
    .update({
      last_payment_failed: true,
      last_payment_failure_date: new Date().toISOString(),
    })
    .eq('id', customer.id);

  // Create support ticket for immediate follow-up
  await supabase.from('support_tickets').insert({
    customer_id: customer.id,
    subject: 'Payment Failed - Customer Retention Risk',
    description: `Payment failed for customer ${customer.email}. Invoice: ${invoice.id}. Immediate follow-up required to prevent churn.`,
    priority: 'high',
    status: 'open',
    created_at: new Date().toISOString()
  });

  // Notify customer with payment retry options
  await notifyCustomer(customer.id, 'payment_failed', 
    `Your payment couldn't be processed. Your agent is still active, but please update your payment method to avoid service interruption. Update payment: https://mrdelegate.ai/billing`);
}

/**
 * Handle trial ending soon
 */
async function handleTrialWillEnd(subscription) {
  console.log('[STRIPE] Trial will end:', subscription.id);
  
  const customer = await getCustomerByStripeId(subscription.customer);
  if (!customer) return;

  const endDate = new Date(subscription.trial_end * 1000);
  const daysLeft = Math.ceil((endDate - new Date()) / (24 * 60 * 60 * 1000));

  await notifyCustomer(customer.id, 'trial_ending', 
    `Your MrDelegate trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Your first charge will be $47 on ${endDate.toLocaleDateString()}. Cancel anytime: https://mrdelegate.ai/billing`);
}

/**
 * Get customer by Stripe customer ID
 */
async function getCustomerByStripeId(stripeCustomerId) {
  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();
    
  return data;
}

/**
 * Trigger VPS provisioning for new customer
 */
async function triggerVPSProvisioning(customerId) {
  // TODO: Integrate with VPS provisioning system
  console.log(`[PROVISION] Triggering VPS provisioning for customer ${customerId}`);
}

/**
 * Send notification to customer
 */
async function notifyCustomer(customerId, type, message) {
  // TODO: Integrate with notification system
  console.log(`[NOTIFY] ${type} for ${customerId}: ${message}`);
}

module.exports = router;