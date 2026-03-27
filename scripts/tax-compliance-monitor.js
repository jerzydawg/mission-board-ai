#!/usr/bin/env node
/**
 * Tax Compliance Monitor
 * Tracks sales by state and alerts when approaching nexus thresholds
 * Runs daily via cron to check Stripe data and warn before registration required
 */

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FOUNDER_TELEGRAM_ID = process.env.FOUNDER_TELEGRAM_ID || '262207319'; // Bart's ID

if (!STRIPE_SECRET_KEY) {
  console.log('[tax-monitor] Stripe key not configured yet, skipping');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Economic nexus thresholds by state (revenue OR transaction count)
// Updated for 2026 - most states are $100k/200 transactions, some exceptions
const NEXUS_THRESHOLDS = {
  // Lower thresholds - watch carefully
  'CA': { revenue: 500000, transactions: 200 }, // California - $500k threshold
  'TX': { revenue: 500000, transactions: 200 }, // Texas - $500k threshold
  'FL': { revenue: 100000, transactions: 200 }, // Florida
  'NY': { revenue: 500000, transactions: 100 }, // New York - lower transaction count
  'PA': { revenue: 100000, transactions: 200 }, // Pennsylvania
  
  // Standard $100k/200 transaction states (major ones)
  'IL': { revenue: 100000, transactions: 200 },
  'OH': { revenue: 100000, transactions: 200 },
  'GA': { revenue: 100000, transactions: 200 },
  'NC': { revenue: 100000, transactions: 200 },
  'MI': { revenue: 100000, transactions: 200 },
  'NJ': { revenue: 100000, transactions: 200 }, // Our home state
  'VA': { revenue: 100000, transactions: 200 },
  'WA': { revenue: 100000, transactions: 200 },
  'AZ': { revenue: 100000, transactions: 200 },
  'MA': { revenue: 100000, transactions: 200 },
  'TN': { revenue: 100000, transactions: 200 },
  'IN': { revenue: 100000, transactions: 200 },
  'MO': { revenue: 100000, transactions: 200 },
  'MD': { revenue: 100000, transactions: 200 },
  'WI': { revenue: 100000, transactions: 200 },
  'CO': { revenue: 100000, transactions: 200 },
  'MN': { revenue: 100000, transactions: 200 },
  
  // States without sales tax (no nexus concern)
  // 'AK', 'DE', 'MT', 'NH', 'OR' - we still track for completeness
  'AK': { revenue: Infinity, transactions: Infinity },
  'DE': { revenue: Infinity, transactions: Infinity },
  'MT': { revenue: Infinity, transactions: Infinity },
  'NH': { revenue: Infinity, transactions: Infinity },
  'OR': { revenue: Infinity, transactions: Infinity },
};

// Get sales data from Stripe for current year
async function getYearToDateSales() {
  const startOfYear = new Date(new Date().getFullYear(), 0, 1);
  const charges = await stripe.charges.list({
    created: { gte: Math.floor(startOfYear.getTime() / 1000) },
    limit: 100,
  });

  const salesByState = {};
  
  for await (const charge of stripe.charges.list({
    created: { gte: Math.floor(startOfYear.getTime() / 1000) },
    expand: ['data.billing_details'],
  })) {
    if (!charge.paid) continue;
    
    const state = charge.billing_details?.address?.state;
    if (!state) continue;
    
    const stateCode = state.toUpperCase();
    if (!salesByState[stateCode]) {
      salesByState[stateCode] = { revenue: 0, transactions: 0 };
    }
    
    salesByState[stateCode].revenue += charge.amount; // in cents
    salesByState[stateCode].transactions += 1;
  }

  // Convert revenue from cents to dollars
  Object.keys(salesByState).forEach(state => {
    salesByState[state].revenue = salesByState[state].revenue / 100;
  });

  return salesByState;
}

// Check which states are approaching thresholds
function checkNexusAlerts(salesByState) {
  const alerts = [];
  const registrationRequired = [];

  Object.entries(NEXUS_THRESHOLDS).forEach(([state, thresholds]) => {
    const sales = salesByState[state] || { revenue: 0, transactions: 0 };
    
    const revenuePercent = (sales.revenue / thresholds.revenue) * 100;
    const transactionPercent = (sales.transactions / thresholds.transactions) * 100;
    
    // Either threshold triggers nexus
    const maxPercent = Math.max(revenuePercent, transactionPercent);
    
    if (maxPercent >= 100) {
      registrationRequired.push({
        state,
        revenue: sales.revenue,
        transactions: sales.transactions,
        thresholds,
        overagePercent: maxPercent - 100
      });
    } else if (maxPercent >= 80) {
      alerts.push({
        state,
        revenue: sales.revenue,
        transactions: sales.transactions,
        thresholds,
        warningPercent: maxPercent
      });
    }
  });

  return { alerts, registrationRequired };
}

// Send Telegram alert
async function sendTaxAlert(message) {
  if (!TELEGRAM_BOT_TOKEN) return;
  
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: FOUNDER_TELEGRAM_ID,
      text: message,
      parse_mode: 'Markdown'
    })
  });
}

// Log to Supabase for tracking
async function logTaxCheck(salesByState, alerts, registrationRequired) {
  await supabase.from('activity_log').insert([{
    customer_id: null, // System activity
    type: 'tax_compliance_check',
    data: {
      year: new Date().getFullYear(),
      totalStates: Object.keys(salesByState).length,
      alerts: alerts.length,
      registrationsRequired: registrationRequired.length,
      salesByState,
      timestamp: new Date().toISOString()
    }
  }]).catch(() => {});
}

async function main() {
  console.log('[tax-monitor] Running sales tax nexus check...');

  try {
    const salesByState = await getYearToDateSales();
    const { alerts, registrationRequired } = checkNexusAlerts(salesByState);

    // Log the check
    await logTaxCheck(salesByState, alerts, registrationRequired);

    // URGENT: Registration required  
    if (registrationRequired.length > 0) {
      let message = `🚨 *TAX REGISTRATION REQUIRED*\n\n`;
      message += `You've exceeded nexus thresholds in ${registrationRequired.length} state(s):\n\n`;
      
      registrationRequired.forEach(item => {
        const trigger = item.revenue >= item.thresholds.revenue ? 
          `Revenue: $${item.revenue.toLocaleString()} (${item.thresholds.revenue >= 500000 ? '$500k' : '$100k'} threshold)` :
          `Transactions: ${item.transactions} (${item.thresholds.transactions} threshold)`;
        
        message += `• **${item.state}**: ${trigger}\n`;
      });
      
      message += `\n**ACTION REQUIRED:**\n`;
      message += `1. Register for sales tax permit in each state\n`;
      message += `2. Set up filing schedule (usually monthly/quarterly)\n`;
      message += `3. Stripe Tax is collecting, but you must file returns\n\n`;
      message += `Consider hiring a tax professional for multi-state compliance.`;
      
      await sendTaxAlert(message);
      console.log(`[tax-monitor] 🚨 URGENT: Registration required in ${registrationRequired.length} states`);
    }

    // WARNING: Approaching thresholds
    if (alerts.length > 0) {
      let message = `⚠️ *Sales Tax Alert*\n\n`;
      message += `Approaching nexus thresholds in ${alerts.length} state(s):\n\n`;
      
      alerts.forEach(item => {
        const revenuePercent = (item.revenue / item.thresholds.revenue * 100).toFixed(0);
        const transactionPercent = (item.transactions / item.thresholds.transactions * 100).toFixed(0);
        
        message += `• **${item.state}**: ${Math.max(revenuePercent, transactionPercent)}% of threshold\n`;
        message += `  Revenue: $${item.revenue.toLocaleString()} / $${item.thresholds.revenue.toLocaleString()}\n`;
        message += `  Transactions: ${item.transactions} / ${item.thresholds.transactions}\n\n`;
      });
      
      message += `Monitor closely. Registration required when either threshold is exceeded.`;
      
      await sendTaxAlert(message);
      console.log(`[tax-monitor] ⚠️ Approaching thresholds in ${alerts.length} states`);
    }

    // Summary for logs
    const totalRevenue = Object.values(salesByState).reduce((sum, state) => sum + state.revenue, 0);
    const totalTransactions = Object.values(salesByState).reduce((sum, state) => sum + state.transactions, 0);
    
    console.log(`[tax-monitor] ✓ YTD: $${totalRevenue.toLocaleString()} revenue, ${totalTransactions} transactions across ${Object.keys(salesByState).length} states`);
    
    if (alerts.length === 0 && registrationRequired.length === 0) {
      console.log('[tax-monitor] ✓ All states below nexus thresholds');
    }

  } catch (error) {
    console.error('[tax-monitor] Error:', error);
    await sendTaxAlert(`🚨 Tax monitoring script failed: ${error.message}`);
  }
}

main().catch(console.error);