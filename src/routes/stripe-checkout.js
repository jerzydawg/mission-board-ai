/**
 * Stripe Checkout Integration
 * 
 * Handles subscription creation with 3-day trial and webhook setup
 */

const express = require('express');
const router = express.Router();
const { createSupabaseClient } = require('../services/supabase');

const supabase = createSupabaseClient();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * POST /api/stripe/create-checkout-session
 * 
 * Creates Stripe checkout session for new customer
 * Includes 3-day trial and proper metadata for webhook handling
 */
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { customer_id, email, name } = req.body;

    if (!customer_id || !email) {
      return res.status(400).json({ error: 'Missing customer_id or email' });
    }

    // Verify customer exists in our database
    const { data: customer } = await supabase
      .from('customers')
      .select('id, email, name')
      .eq('id', customer_id)
      .single();

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    console.log(`[STRIPE] Creating checkout session for ${customer.email}`);

    // Create or retrieve Stripe customer
    let stripeCustomer;
    try {
      // Try to find existing Stripe customer by email
      const existingCustomers = await stripe.customers.list({
        email: customer.email,
        limit: 1
      });

      if (existingCustomers.data.length > 0) {
        stripeCustomer = existingCustomers.data[0];
        console.log(`[STRIPE] Using existing Stripe customer: ${stripeCustomer.id}`);
      } else {
        // Create new Stripe customer
        stripeCustomer = await stripe.customers.create({
          email: customer.email,
          name: customer.name || name,
          metadata: {
            customer_id: customer_id
          }
        });
        console.log(`[STRIPE] Created new Stripe customer: ${stripeCustomer.id}`);
      }
    } catch (error) {
      console.error('[STRIPE] Error creating/retrieving customer:', error);
      return res.status(500).json({ error: 'Failed to create customer' });
    }

    // Get the product and price IDs (will be set via environment variables)
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      console.error('[STRIPE] STRIPE_PRICE_ID not configured');
      return res.status(500).json({ error: 'Pricing not configured' });
    }

    // Create checkout session with 3-day trial
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomer.id,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `https://mrdelegate.ai/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://mrdelegate.ai/start?cancelled=true`,
      
      // 3-day trial configuration
      subscription_data: {
        trial_period_days: 3,
        metadata: {
          customer_id: customer_id,
          plan: 'mrdelegate_standard'
        }
      },
      
      // Metadata for webhook processing
      metadata: {
        customer_id: customer_id,
        plan: 'mrdelegate_standard'
      },

      // Collect billing address for tax compliance
      billing_address_collection: 'required',
      
      // Allow promotion codes
      allow_promotion_codes: true,

      // Automatic tax calculation
      automatic_tax: { enabled: false }, // Enable when tax setup is complete
      
      // Customer portal configuration
      customer_update: {
        address: 'auto',
        name: 'auto'
      }
    });

    console.log(`[STRIPE] Checkout session created: ${session.id}`);

    // Update customer record with Stripe customer ID
    await supabase
      .from('customers')
      .update({
        stripe_customer_id: stripeCustomer.id,
        checkout_session_id: session.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', customer_id);

    res.json({
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('[STRIPE] Checkout session error:', error);
    res.status(500).json({ 
      error: 'Failed to create checkout session',
      details: error.message 
    });
  }
});

/**
 * GET /api/stripe/session/:sessionId
 * 
 * Retrieve checkout session details for onboarding flow
 */
router.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'customer']
    });

    res.json({
      id: session.id,
      customer: session.customer,
      subscription: session.subscription,
      payment_status: session.payment_status,
      customer_id: session.metadata?.customer_id
    });

  } catch (error) {
    console.error('[STRIPE] Session retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve session' });
  }
});

/**
 * POST /api/stripe/create-billing-portal
 * 
 * Create billing portal session for customer management
 */
router.post('/create-billing-portal', async (req, res) => {
  try {
    const { customer_id } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'Missing customer_id' });
    }

    // Get customer's Stripe customer ID
    const { data: customer } = await supabase
      .from('customers')
      .select('stripe_customer_id')
      .eq('id', customer_id)
      .single();

    if (!customer?.stripe_customer_id) {
      return res.status(404).json({ error: 'Customer not found or not activated' });
    }

    // Create billing portal session
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer.stripe_customer_id,
      return_url: 'https://mrdelegate.ai/app',
    });

    res.json({
      url: portalSession.url
    });

  } catch (error) {
    console.error('[STRIPE] Billing portal error:', error);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

/**
 * GET /api/stripe/customer/:customerId/subscription
 * 
 * Get current subscription status for customer dashboard
 */
router.get('/customer/:customerId/subscription', async (req, res) => {
  try {
    const { customerId } = req.params;

    // Get customer's subscription info
    const { data: customer } = await supabase
      .from('customers')
      .select('stripe_customer_id, stripe_subscription_id, status, trial_ends_at, current_period_end')
      .eq('id', customerId)
      .single();

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    let subscriptionDetails = null;
    if (customer.stripe_subscription_id) {
      try {
        subscriptionDetails = await stripe.subscriptions.retrieve(customer.stripe_subscription_id);
      } catch (error) {
        console.error('[STRIPE] Error retrieving subscription:', error);
      }
    }

    res.json({
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
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

module.exports = router;