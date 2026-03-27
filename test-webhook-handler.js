#!/usr/bin/env node
/**
 * Webhook Handler Test
 * Simulates Stripe webhook events and tests our handler responses
 */

import crypto from 'crypto';

const TEST_WEBHOOK_SECRET = 'whsec_test_webhook_secret_for_testing';

class WebhookTestSuite {
  constructor() {
    this.results = [];
  }

  log(test, status, details = '') {
    const result = { test, status, details, timestamp: new Date().toISOString() };
    this.results.push(result);
    
    const statusIcon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
    console.log(`${statusIcon} ${test}: ${details}`);
  }

  // Generate valid Stripe webhook signature
  generateStripeSignature(payload, secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const elements = `${timestamp}.${payload}`;
    const signature = crypto.createHmac('sha256', secret).update(elements, 'utf8').digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  // Test webhook payload examples
  getTestEvents() {
    return {
      'checkout.session.completed': {
        id: 'evt_test_webhook',
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            object: 'checkout_session',
            customer: 'cus_test_123',
            subscription: 'sub_test_123',
            customer_details: {
              email: 'test@mrdelegate.ai',
              name: 'Test Customer'
            },
            metadata: {
              signup_source: 'website'
            }
          }
        }
      },
      'customer.subscription.deleted': {
        id: 'evt_test_webhook_2',
        object: 'event', 
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_test_123',
            object: 'subscription',
            customer: 'cus_test_123',
            status: 'canceled',
            canceled_at: Math.floor(Date.now() / 1000)
          }
        }
      },
      'invoice.payment_failed': {
        id: 'evt_test_webhook_3',
        object: 'event',
        type: 'invoice.payment_failed', 
        data: {
          object: {
            id: 'in_test_123',
            object: 'invoice',
            customer: 'cus_test_123',
            subscription: 'sub_test_123',
            amount_due: 4700,
            attempt_count: 2
          }
        }
      }
    };
  }

  async testWebhookEndpoint(eventType, eventData) {
    try {
      const payload = JSON.stringify(eventData);
      const signature = this.generateStripeSignature(payload, TEST_WEBHOOK_SECRET);

      const response = await fetch('http://localhost:3000/api/webhooks/stripe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': signature
        },
        body: payload
      });

      if (response.ok) {
        this.log(`Webhook ${eventType}`, 'PASS', `Status: ${response.status}`);
        
        const responseText = await response.text();
        if (responseText) {
          this.log(`Webhook Response`, 'INFO', responseText.substring(0, 100));
        }
      } else {
        this.log(`Webhook ${eventType}`, 'FAIL', `Status: ${response.status}`);
      }

    } catch (error) {
      this.log(`Webhook ${eventType}`, 'FAIL', error.message);
    }
  }

  async runAllWebhookTests() {
    console.log('\n🔗 Testing Webhook Handler Endpoints');
    console.log('=' .repeat(40));

    const events = this.getTestEvents();
    
    for (const [eventType, eventData] of Object.entries(events)) {
      await this.testWebhookEndpoint(eventType, eventData);
    }
  }

  generateReport() {
    const passed = this.results.filter(r => r.status === 'PASS').length;
    const failed = this.results.filter(r => r.status === 'FAIL').length;
    
    console.log(`\n📊 Webhook Tests: ${passed} passed, ${failed} failed`);
    return { passed, failed, total: this.results.length };
  }
}

// Run webhook tests if server is available
async function runWebhookTests() {
  const suite = new WebhookTestSuite();
  
  try {
    // Check if server is running
    const healthCheck = await fetch('http://localhost:3000/api/health');
    if (!healthCheck.ok) {
      throw new Error('Server not running');
    }

    await suite.runAllWebhookTests();
  } catch (error) {
    suite.log('Webhook Test Setup', 'WARN', 'Server not running - webhook tests skipped');
  }

  return suite.generateReport();
}

runWebhookTests().catch(console.error);