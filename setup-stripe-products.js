#!/usr/bin/env node
/**
 * Create proper MrDelegate products and prices in Stripe
 * Run this once to set up the production-ready pricing structure
 */

import Stripe from 'stripe';

const STRIPE_SECRET_KEY = 'process.env.STRIPE_SECRET_KEY || "sk_test_placeholder"';
const stripe = new Stripe(STRIPE_SECRET_KEY);

async function setupMrDelegateProducts() {
  console.log('🚀 Setting up MrDelegate products and pricing in Stripe...');

  try {
    // 1. Create or update main product
    console.log('\n📦 Creating MrDelegate product...');
    
    const product = await stripe.products.create({
      name: 'MrDelegate',
      description: 'AI Executive Assistant - Dedicated OpenClaw VPS with morning brief, inbox triage, and calendar protection',
      metadata: {
        platform: 'mrdelegate',
        tier: 'standard',
        features: 'dedicated_vps,morning_brief,inbox_triage,calendar_protection,3_day_trial'
      },
      url: 'https://mrdelegate.ai',
      images: ['https://mrdelegate.ai/og-image.svg'],
      shippable: false,
      statement_descriptor: 'MRDELEGATE.AI',
      unit_label: 'month'
    });

    console.log(`✅ Product created: ${product.id}`);
    console.log(`   Name: ${product.name}`);
    console.log(`   Description: ${product.description}`);

    // 2. Create $47/month price
    console.log('\n💰 Creating $47/month price...');
    
    const monthlyPrice = await stripe.prices.create({
      unit_amount: 4700, // $47.00
      currency: 'usd',
      recurring: { 
        interval: 'month',
        usage_type: 'licensed' // Fixed monthly fee
      },
      product: product.id,
      active: true,
      metadata: {
        plan_name: 'standard',
        tier: 'production',
        description: 'Standard plan with 3-day free trial'
      },
      nickname: 'Standard Monthly',
      tax_behavior: 'exclusive' // Tax added on top
    });

    console.log(`✅ Monthly price created: ${monthlyPrice.id}`);
    console.log(`   Amount: $${monthlyPrice.unit_amount / 100}/month`);
    console.log(`   Active: ${monthlyPrice.active}`);

    // 3. Create annual price ($397/year = 30% off monthly)
    console.log('\n📅 Creating annual price (30% discount)...');

    const annualPrice = await stripe.prices.create({
      unit_amount: 39700, // $397.00
      currency: 'usd',
      recurring: { 
        interval: 'year',
        usage_type: 'licensed'
      },
      product: product.id,
      active: true,
      metadata: {
        plan_name: 'standard_annual',
        tier: 'production',
        description: 'Annual plan (10% discount) with 3-day free trial',
        discount_percent: '10'
      },
      nickname: 'Standard Annual (10% off)',
      tax_behavior: 'exclusive'
    });

    console.log(`✅ Annual price created: ${annualPrice.id}`);
    console.log(`   Amount: $${annualPrice.unit_amount / 100}/year`);
    console.log(`   Savings: $${(47 * 12 - annualPrice.unit_amount / 100).toFixed(2)}/year`);

    // 4. Test checkout session with new price
    console.log('\n🧪 Testing checkout with new price...');
    
    const testSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: monthlyPrice.id, quantity: 1 }],
      success_url: 'https://mrdelegate.ai/welcome?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://mrdelegate.ai/pricing',
      customer_email: 'test@mrdelegate.ai',
      subscription_data: {
        trial_period_days: 3,
        metadata: { source: 'setup_test' }
      },
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      consent_collection: { terms_of_service: 'required' }
    });

    console.log(`✅ Test checkout created: ${testSession.id}`);
    console.log(`   URL: ${testSession.url}`);

    // Expire the test session immediately
    await stripe.checkout.sessions.expire(testSession.id);
    console.log(`✅ Test session expired (cleanup)`);

    // 5. Summary
    console.log('\n🎉 Setup Complete!');
    console.log('=' .repeat(50));
    console.log(`📦 Product ID: ${product.id}`);
    console.log(`💰 Monthly Price ID: ${monthlyPrice.id}`);
    console.log(`📅 Annual Price ID: ${annualPrice.id}`);
    
    console.log('\n🔧 Environment Variables:');
    console.log(`STRIPE_PRODUCT_ID=${product.id}`);
    console.log(`STRIPE_PRICE_ID=${monthlyPrice.id}`);
    console.log(`STRIPE_ANNUAL_PRICE_ID=${annualPrice.id}`);
    
    console.log('\n📋 Next Steps:');
    console.log('1. Add the environment variables above to your platform');
    console.log('2. Update your checkout flow to use the new price IDs');
    console.log('3. Test a real checkout session');
    console.log('4. Configure billing portal settings in Stripe dashboard');

    return { product, monthlyPrice, annualPrice };

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    throw error;
  }
}

setupMrDelegateProducts().catch(console.error);