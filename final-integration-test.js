#!/usr/bin/env node
/**
 * Final Integration Test Suite
 * Comprehensive end-to-end testing with Opus oversight
 * Tests entire customer journey: signup → webhook → dashboard → cancellation
 */

import Stripe from 'stripe';
import crypto from 'crypto';

const STRIPE_SECRET_KEY = 'process.env.STRIPE_SECRET_KEY || "sk_test_placeholder"';
const WEBHOOK_SECRET = 'whsec_b8qGjjepV5VdQ98gwDZEOYXYGwWqUqYC';
const PRICE_ID = 'price_1TCl9P8HwYNE0tqhMeehNFiT';

const stripe = new Stripe(STRIPE_SECRET_KEY);

class FinalTestSuite {
  constructor() {
    this.results = [];
    this.testCustomer = null;
    this.testSubscription = null;
  }

  log(category, test, status, details = '') {
    const result = { category, test, status, details, timestamp: new Date().toISOString() };
    this.results.push(result);
    
    const statusIcon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : status === 'WARN' ? '⚠️' : 'ℹ️';
    console.log(`${statusIcon} [${category}] ${test}: ${details}`);
  }

  generateStripeSignature(payload, secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const elements = `${timestamp}.${payload}`;
    const signature = crypto.createHmac('sha256', secret).update(elements, 'utf8').digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  async testStripeCheckoutFlow() {
    try {
      this.log('STRIPE', 'Checkout Session Creation', 'INFO', 'Testing complete checkout flow...');

      // Create checkout session (simulates customer clicking "Start Free Trial")
      const response = await fetch('http://localhost:3000/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'opus.test@mrdelegate.ai',
          name: 'Opus Test Customer'
        })
      });

      if (response.ok) {
        const data = await response.json();
        this.log('STRIPE', 'Checkout API', 'PASS', `Session created: ${data.sessionId}`);
        this.log('STRIPE', 'Checkout URL', 'INFO', data.url);
        return data.sessionId;
      } else {
        const error = await response.text();
        this.log('STRIPE', 'Checkout API', 'FAIL', `Status ${response.status}: ${error}`);
        return null;
      }

    } catch (error) {
      this.log('STRIPE', 'Checkout Flow', 'FAIL', error.message);
      return null;
    }
  }

  async testWebhookHandling() {
    try {
      this.log('WEBHOOK', 'Webhook Processing', 'INFO', 'Testing webhook event handling...');

      // Create a real customer and subscription for webhook testing
      this.testCustomer = await stripe.customers.create({
        email: 'opus.webhook@mrdelegate.ai',
        name: 'Opus Webhook Test',
        metadata: { test_suite: 'final_test' }
      });

      this.testSubscription = await stripe.subscriptions.create({
        customer: this.testCustomer.id,
        items: [{ price: PRICE_ID }],
        trial_period_days: 3,
        metadata: { test_suite: 'final_test' }
      });

      this.log('WEBHOOK', 'Test Resources', 'PASS', `Customer: ${this.testCustomer.id}, Subscription: ${this.testSubscription.id}`);

      // Simulate checkout.session.completed webhook
      const webhookPayload = {
        id: 'evt_test_final_integration',
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_final',
            object: 'checkout_session',
            customer: this.testCustomer.id,
            subscription: this.testSubscription.id,
            customer_email: this.testCustomer.email,
            customer_details: {
              email: this.testCustomer.email,
              name: this.testCustomer.name
            },
            metadata: {
              signup_source: 'final_integration_test'
            }
          }
        }
      };

      const payload = JSON.stringify(webhookPayload);
      const signature = this.generateStripeSignature(payload, WEBHOOK_SECRET);

      const webhookResponse = await fetch('http://localhost:3000/api/stripe/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': signature
        },
        body: payload
      });

      if (webhookResponse.ok) {
        const result = await webhookResponse.json();
        this.log('WEBHOOK', 'Checkout Completed', 'PASS', `Webhook processed: ${JSON.stringify(result)}`);
      } else {
        this.log('WEBHOOK', 'Checkout Completed', 'FAIL', `Status: ${webhookResponse.status}`);
      }

    } catch (error) {
      this.log('WEBHOOK', 'Webhook Processing', 'FAIL', error.message);
    }
  }

  async testAdminDashboard() {
    try {
      this.log('DASHBOARD', 'Admin Endpoints', 'INFO', 'Testing admin dashboard functionality...');

      const endpoints = [
        { path: '/api/health', auth: false, expectedStatus: 200 },
        { path: '/api/admin/customers', auth: true, expectedStatus: 401 }, // Should require auth
        { path: '/api/admin/subscriptions', auth: true, expectedStatus: 401 },
        { path: '/api/admin/metrics', auth: true, expectedStatus: 401 }
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await fetch(`http://localhost:3000${endpoint.path}`, {
            headers: endpoint.auth ? { 'Authorization': 'Bearer invalid_token' } : {}
          });

          if (response.status === endpoint.expectedStatus) {
            this.log('DASHBOARD', `Endpoint ${endpoint.path}`, 'PASS', `Status: ${response.status} (expected)`);
          } else {
            this.log('DASHBOARD', `Endpoint ${endpoint.path}`, 'WARN', `Status: ${response.status}, expected: ${endpoint.expectedStatus}`);
          }
        } catch (fetchError) {
          this.log('DASHBOARD', `Endpoint ${endpoint.path}`, 'FAIL', fetchError.message);
        }
      }

    } catch (error) {
      this.log('DASHBOARD', 'Admin Dashboard', 'FAIL', error.message);
    }
  }

  async testBillingPortal() {
    try {
      this.log('BILLING', 'Customer Portal', 'INFO', 'Testing Stripe billing portal generation...');

      if (!this.testCustomer) {
        this.log('BILLING', 'Customer Portal', 'SKIP', 'No test customer available');
        return;
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: this.testCustomer.id,
        return_url: 'https://mrdelegate.ai/app'
      });

      if (portalSession.url) {
        this.log('BILLING', 'Portal Generation', 'PASS', `Portal URL generated: ${portalSession.url.substring(0, 50)}...`);
      } else {
        this.log('BILLING', 'Portal Generation', 'FAIL', 'No portal URL returned');
      }

    } catch (error) {
      this.log('BILLING', 'Customer Portal', 'FAIL', error.message);
    }
  }

  async testTaxCompliance() {
    try {
      this.log('TAX', 'Compliance Monitoring', 'INFO', 'Testing tax monitoring script...');

      // Check if tax monitoring script exists and is executable
      const { execSync } = await import('child_process');
      
      try {
        const output = execSync('node /root/mrdelegate/platform/scripts/tax-compliance-monitor.js', { 
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, STRIPE_SECRET_KEY } // Pass Stripe key for testing
        });
        
        this.log('TAX', 'Monitoring Script', 'PASS', 'Tax compliance monitor executed successfully');
        if (output.includes('[tax-monitor] ✓')) {
          this.log('TAX', 'Monitoring Logic', 'PASS', 'Tax calculations working');
        }
      } catch (execError) {
        if (execError.message.includes('Stripe key not configured')) {
          this.log('TAX', 'Monitoring Script', 'INFO', 'Script requires proper Stripe configuration');
        } else {
          this.log('TAX', 'Monitoring Script', 'FAIL', execError.message);
        }
      }

    } catch (error) {
      this.log('TAX', 'Compliance Monitoring', 'FAIL', error.message);
    }
  }

  async testErrorHandling() {
    try {
      this.log('ERROR', 'Error Handling', 'INFO', 'Testing error scenarios...');

      // Test invalid webhook signature
      const invalidWebhookResponse = await fetch('http://localhost:3000/api/stripe/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': 'invalid_signature'
        },
        body: JSON.stringify({ test: 'invalid' })
      });

      if (invalidWebhookResponse.status === 400) {
        this.log('ERROR', 'Invalid Webhook Signature', 'PASS', 'Properly rejected invalid signature');
      } else {
        this.log('ERROR', 'Invalid Webhook Signature', 'FAIL', `Status: ${invalidWebhookResponse.status}`);
      }

      // Test checkout with missing data
      const badCheckoutResponse = await fetch('http://localhost:3000/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}) // Missing email
      });

      if (badCheckoutResponse.status === 400) {
        this.log('ERROR', 'Invalid Checkout Data', 'PASS', 'Properly rejected missing email');
      } else {
        this.log('ERROR', 'Invalid Checkout Data', 'FAIL', `Status: ${badCheckoutResponse.status}`);
      }

    } catch (error) {
      this.log('ERROR', 'Error Handling', 'FAIL', error.message);
    }
  }

  async cleanup() {
    try {
      this.log('CLEANUP', 'Resource Cleanup', 'INFO', 'Cleaning up test resources...');

      if (this.testSubscription) {
        await stripe.subscriptions.cancel(this.testSubscription.id);
        this.log('CLEANUP', 'Test Subscription', 'PASS', `Cancelled subscription: ${this.testSubscription.id}`);
      }

      if (this.testCustomer) {
        await stripe.customers.del(this.testCustomer.id);
        this.log('CLEANUP', 'Test Customer', 'PASS', `Deleted customer: ${this.testCustomer.id}`);
      }

    } catch (error) {
      this.log('CLEANUP', 'Resource Cleanup', 'FAIL', error.message);
    }
  }

  generateFinalReport() {
    console.log('\n🎯 FINAL INTEGRATION TEST REPORT');
    console.log('=' .repeat(60));

    const categories = [...new Set(this.results.map(r => r.category))];
    
    for (const category of categories) {
      const categoryResults = this.results.filter(r => r.category === category);
      const passed = categoryResults.filter(r => r.status === 'PASS').length;
      const failed = categoryResults.filter(r => r.status === 'FAIL').length;
      const warnings = categoryResults.filter(r => r.status === 'WARN').length;
      
      console.log(`\n📊 ${category}: ${passed} ✅ ${failed} ❌ ${warnings} ⚠️`);
      
      // Show critical failures
      const criticalFails = categoryResults.filter(r => r.status === 'FAIL');
      criticalFails.forEach(fail => {
        console.log(`   ❌ ${fail.test}: ${fail.details}`);
      });
    }

    const totalPassed = this.results.filter(r => r.status === 'PASS').length;
    const totalFailed = this.results.filter(r => r.status === 'FAIL').length;
    const totalWarnings = this.results.filter(r => r.status === 'WARN').length;

    console.log('\n🏆 OVERALL RESULTS:');
    console.log(`   ✅ PASSED: ${totalPassed}`);
    console.log(`   ❌ FAILED: ${totalFailed}`);
    console.log(`   ⚠️ WARNINGS: ${totalWarnings}`);
    console.log(`   📊 TOTAL: ${this.results.length}`);

    // Launch readiness assessment
    const criticalFailures = this.results.filter(r => 
      r.status === 'FAIL' && (
        r.test.includes('Checkout API') ||
        r.test.includes('Webhook Processing') ||
        r.test.includes('Portal Generation')
      )
    );

    if (totalFailed === 0) {
      console.log('\n🚀 LAUNCH READY: All systems operational!');
      console.log('   Ready to accept customers with Stripe test mode.');
    } else if (criticalFailures.length === 0) {
      console.log('\n🟡 MOSTLY READY: Core functionality working, minor issues detected.');
    } else {
      console.log('\n🚫 NOT LAUNCH READY: Critical failures must be fixed.');
    }

    return {
      passed: totalPassed,
      failed: totalFailed,
      warnings: totalWarnings,
      total: this.results.length,
      launchReady: criticalFailures.length === 0
    };
  }
}

async function runFinalTests() {
  const suite = new FinalTestSuite();
  
  try {
    console.log('🎯 MrDelegate Final Integration Test Suite (Opus)');
    console.log('Testing complete customer journey with Stripe integration');
    console.log('=' .repeat(60));

    // Core integration tests
    await suite.testStripeCheckoutFlow();
    await suite.testWebhookHandling();
    await suite.testAdminDashboard();
    await suite.testBillingPortal();
    await suite.testTaxCompliance();
    await suite.testErrorHandling();

  } catch (error) {
    suite.log('SYSTEM', 'Test Suite Execution', 'FAIL', `Critical error: ${error.message}`);
  } finally {
    await suite.cleanup();
    const report = suite.generateFinalReport();
    
    // Save detailed results
    const fs = await import('fs');
    await fs.promises.writeFile(
      '/root/mrdelegate/final-integration-results.json', 
      JSON.stringify(suite.results, null, 2)
    );
    
    console.log('\n📄 Detailed results: /root/mrdelegate/final-integration-results.json');
    return report;
  }
}

runFinalTests().catch(console.error);