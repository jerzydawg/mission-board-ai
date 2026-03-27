#!/usr/bin/env node
/**
 * Quick Launch Readiness Test
 * Focuses on core Stripe functionality only - minimal test for launch readiness
 */

import Stripe from 'stripe';

const STRIPE_SECRET_KEY = 'process.env.STRIPE_SECRET_KEY || "sk_test_placeholder"';
const stripe = new Stripe(STRIPE_SECRET_KEY);

class QuickLaunchTest {
  constructor() {
    this.results = [];
  }

  log(test, status, details = '') {
    const statusIcon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
    console.log(`${statusIcon} ${test}: ${details}`);
    this.results.push({ test, status, details });
  }

  async runLaunchChecks() {
    console.log('🚀 MrDelegate Launch Readiness Check');
    console.log('=' .repeat(40));

    try {
      // 1. Stripe API connectivity
      const balance = await stripe.balance.retrieve();
      this.log('Stripe API Connection', 'PASS', `Connected to ${balance.object} API`);

      // 2. Product exists
      const products = await stripe.products.list({ limit: 10 });
      const mrDelegateProduct = products.data.find(p => p.name.includes('MrDelegate') || p.name.includes('Delegate'));
      if (mrDelegateProduct) {
        this.log('Product Configuration', 'PASS', `Found product: ${mrDelegateProduct.id}`);
      } else {
        this.log('Product Configuration', 'WARN', 'No MrDelegate product found - will create on first checkout');
      }

      // 3. Price exists
      const prices = await stripe.prices.list({ limit: 10, active: true });
      const fortySevenDollarPrice = prices.data.find(p => p.unit_amount === 4700);
      if (fortySevenDollarPrice) {
        this.log('Price Configuration', 'PASS', `$47/mo price: ${fortySevenDollarPrice.id}`);
        console.log(`   🔑 Use this Price ID: STRIPE_PRICE_ID=${fortySevenDollarPrice.id}`);
      } else {
        this.log('Price Configuration', 'WARN', 'No $47 price found - will create on first checkout');
      }

      // 4. Webhooks
      const webhooks = await stripe.webhookEndpoints.list();
      const mrDelegateWebhook = webhooks.data.find(w => w.url.includes('mrdelegate.ai'));
      if (mrDelegateWebhook) {
        this.log('Webhook Configuration', 'PASS', `Webhook: ${mrDelegateWebhook.id}`);
        console.log(`   🔑 Use this Webhook Secret: STRIPE_WEBHOOK_SECRET=${mrDelegateWebhook.secret}`);
      } else {
        this.log('Webhook Configuration', 'FAIL', 'No webhook endpoint configured');
      }

      // 5. Test checkout creation
      const testSession = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        line_items: [{ price: fortySevenDollarPrice?.id || 'price_1TCl9P8HwYNE0tqhMeehNFiT', quantity: 1 }],
        success_url: 'https://mrdelegate.ai/success',
        cancel_url: 'https://mrdelegate.ai/pricing',
        customer_email: 'test@mrdelegate.ai',
        subscription_data: { trial_period_days: 3 }
      });

      if (testSession.url) {
        this.log('Checkout Creation', 'PASS', `Test session: ${testSession.id}`);
        console.log(`   🔗 Test URL: ${testSession.url}`);
        
        // Clean up test session by expiring it
        await stripe.checkout.sessions.expire(testSession.id);
        this.log('Test Cleanup', 'PASS', 'Test session expired');
      }

      // 6. Customer portal availability
      try {
        const testCustomer = await stripe.customers.create({
          email: 'portal-test@mrdelegate.ai',
          metadata: { test: 'portal_check' }
        });

        const portalSession = await stripe.billingPortal.sessions.create({
          customer: testCustomer.id,
          return_url: 'https://mrdelegate.ai/app'
        });

        this.log('Customer Portal', 'PASS', 'Billing portal accessible');
        
        // Clean up
        await stripe.customers.del(testCustomer.id);

      } catch (portalError) {
        this.log('Customer Portal', 'WARN', 'Billing portal may need configuration');
      }

    } catch (error) {
      this.log('Stripe Integration', 'FAIL', error.message);
    }

    // Generate summary
    const passed = this.results.filter(r => r.status === 'PASS').length;
    const failed = this.results.filter(r => r.status === 'FAIL').length;
    const warnings = this.results.filter(r => r.status === 'WARN').length;

    console.log('\n📊 LAUNCH READINESS SUMMARY:');
    console.log(`   ✅ PASSED: ${passed}`);
    console.log(`   ❌ FAILED: ${failed}`);
    console.log(`   ⚠️ WARNINGS: ${warnings}`);

    if (failed === 0) {
      console.log('\n🚀 LAUNCH READY!');
      console.log('   Core Stripe functionality is operational.');
      console.log('   You can accept customers in test mode.');
      if (warnings > 0) {
        console.log('   ⚠️ Address warnings for optimal experience.');
      }
    } else {
      console.log('\n❌ NOT LAUNCH READY');
      console.log('   Fix failed checks before accepting customers.');
    }

    return { passed, failed, warnings, launchReady: failed === 0 };
  }
}

const test = new QuickLaunchTest();
test.runLaunchChecks().catch(console.error);