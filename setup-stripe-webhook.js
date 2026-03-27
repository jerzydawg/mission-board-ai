#!/usr/bin/env node
/**
 * Create Stripe webhook endpoint for MrDelegate
 * Run this once to configure webhook in Stripe dashboard
 */

import Stripe from 'stripe';

const STRIPE_SECRET_KEY = 'process.env.STRIPE_SECRET_KEY || "sk_test_placeholder"';
const stripe = new Stripe(STRIPE_SECRET_KEY);

const WEBHOOK_URL = 'https://mrdelegate.ai/api/stripe/webhook'; // Production URL
// const WEBHOOK_URL = 'http://localhost:3000/api/stripe/webhook'; // For local testing

const REQUIRED_EVENTS = [
  'checkout.session.completed',      // New customer signup completed
  'customer.subscription.deleted',   // Customer cancelled subscription  
  'customer.subscription.updated',   // Subscription status changed
  'invoice.paid',                    // Trial ended, first real charge
  'invoice.payment_failed',          // Payment failed, retry logic
  'customer.created',                // For logging
  'customer.updated',                // For customer data sync
];

async function createWebhook() {
  try {
    console.log('🔗 Creating Stripe webhook endpoint...');
    
    // Check if webhook already exists
    const existingWebhooks = await stripe.webhookEndpoints.list();
    const existing = existingWebhooks.data.find(wh => wh.url === WEBHOOK_URL);
    
    if (existing) {
      console.log(`✅ Webhook already exists: ${existing.id}`);
      console.log(`📍 URL: ${existing.url}`);
      console.log(`📋 Events: ${existing.enabled_events.join(', ')}`);
      console.log(`🔑 Secret: ${existing.secret}`);
      
      // Check if events match what we need
      const missingEvents = REQUIRED_EVENTS.filter(event => !existing.enabled_events.includes(event));
      if (missingEvents.length > 0) {
        console.log(`⚠️ Missing events: ${missingEvents.join(', ')}`);
        console.log('Consider updating the webhook to include these events.');
      } else {
        console.log('✅ All required events are configured.');
      }
      
      return existing;
    }

    // Create new webhook
    const webhook = await stripe.webhookEndpoints.create({
      url: WEBHOOK_URL,
      enabled_events: REQUIRED_EVENTS,
      description: 'MrDelegate - Customer lifecycle events',
    });

    console.log('✅ Webhook created successfully!');
    console.log(`📍 URL: ${webhook.url}`);
    console.log(`🆔 ID: ${webhook.id}`);
    console.log(`🔑 Secret: ${webhook.secret}`);
    console.log(`📋 Events: ${webhook.enabled_events.join(', ')}`);

    console.log('\n🚨 IMPORTANT:');
    console.log(`Add this to your environment variables:`);
    console.log(`STRIPE_WEBHOOK_SECRET=${webhook.secret}`);

    return webhook;

  } catch (error) {
    console.error('❌ Failed to create webhook:', error.message);
    throw error;
  }
}

async function testWebhookConnection() {
  try {
    console.log('\n🧪 Testing webhook endpoint connectivity...');
    
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)'
      },
      body: JSON.stringify({ test: true })
    });

    if (response.status === 400) {
      console.log('✅ Webhook endpoint is reachable (400 = signature validation, expected)');
    } else if (response.ok) {
      console.log('✅ Webhook endpoint is reachable');
    } else {
      console.log(`⚠️ Webhook returned status: ${response.status}`);
    }

  } catch (error) {
    console.log(`❌ Webhook endpoint unreachable: ${error.message}`);
  }
}

async function main() {
  console.log('🚀 MrDelegate Stripe Webhook Setup');
  console.log('=' .repeat(40));

  const webhook = await createWebhook();
  await testWebhookConnection();

  console.log('\n✅ Setup complete!');
  console.log('\n📝 Next steps:');
  console.log('1. Add STRIPE_WEBHOOK_SECRET to your environment');
  console.log('2. Test webhook with a real checkout session');
  console.log('3. Monitor webhook events in Stripe dashboard');
}

main().catch(console.error);