/**
 * Customer signup API
 * POST /api/customer/signup — creates new customer account
 */

import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createCustomer, getCustomerByEmail, logActivity } from '../services/supabase.js';
import { sendEmail } from '../services/email.js';
import { provisionVPS } from '../services/provisioner.js';

const app = new Hono();

// Customer JWT secret (for md_customer_token cookie)
const CUSTOMER_JWT_SECRET = (() => {
  if (!process.env.CUSTOMER_JWT_SECRET) throw new Error('CUSTOMER_JWT_SECRET env var required');
  return process.env.CUSTOMER_JWT_SECRET;
})();

// Pricing mapping
const PLAN_PRICING = {
  starter: { monthly: 29, yearly: 29 * 12 * 0.9 },
  pro: { monthly: 49, yearly: 49 * 12 * 0.9 },
  business: { monthly: 99, yearly: 99 * 12 * 0.9 },
  enterprise: { monthly: 199, yearly: 199 * 12 * 0.9 }
};

app.post('/api/customer/signup', async (c) => {
  try {
    const body = await c.req.json();
    const { name, email, password, plan } = body;

    // Validate input
    if (!name || !email || !password || !plan) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    if (password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400);
    }

    if (!PLAN_PRICING[plan]) {
      return c.json({ error: 'Invalid plan selected' }, 400);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return c.json({ error: 'Invalid email address' }, 400);
    }

    // Check if customer already exists
    const existingCustomer = await getCustomerByEmail(email);
    if (existingCustomer) {
      return c.json({ error: 'Account already exists with this email' }, 400);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create customer record
    const customerData = {
      name,
      email: email.toLowerCase(),
      password_hash: hashedPassword,
      plan,
      status: 'trial', // Start with trial status
      vps_status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 day trial
      billing_cycle: 'monthly',
      mrr: PLAN_PRICING[plan].monthly
    };

    const customer = await createCustomer(customerData);

    // Create JWT token for authentication
    const token = jwt.sign(
      {
        customerId: customer.id,
        email: customer.email,
        name: customer.name
      },
      CUSTOMER_JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Log activity
    await logActivity(customer.id, 'signup', {
      plan,
      trial_ends_at: customerData.trial_ends_at,
      signup_method: 'direct'
    });

    // Auto-provision VPS on free trial signup (async, don't block response)
    setImmediate(async () => {
      try {
        console.log(`[signup] Auto-provisioning VPS for ${customer.email} (trial)`);
        const instance = await provisionVPS(customer);
        await logActivity(customer.id, 'vps_provisioned', {
          ip: instance.main_ip,
          instanceId: instance.id,
          trigger: 'trial_signup'
        });
        console.log(`[signup] VPS provisioned for ${customer.email}: ${instance.main_ip}`);
      } catch (vpsError) {
        console.error(`[signup] VPS provision failed for ${customer.email}:`, vpsError.message);
      }
    });

    // Send welcome email (async, don't block response)
    setImmediate(async () => {
      try {
        await sendEmail({
          to: customer.email,
          template: 'welcome',
          data: {
            customerName: customer.name,
            plan: customer.plan,
            trialEndsAt: customerData.trial_ends_at,
            customerId: customer.id
          }
        });
      } catch (emailError) {
        console.error('Welcome email failed:', emailError);
      }
    });

    // Set secure cookie
    c.header('Set-Cookie', `md_customer_token=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}; Path=/`);

    return c.json({
      success: true,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        plan: customer.plan,
        status: customer.status,
        vps_status: customer.vps_status,
        trial_ends_at: customerData.trial_ends_at
      }
    });

  } catch (error) {
    console.error('Signup error:', error);

    // Handle specific database errors
    if (error.message?.includes('duplicate key')) {
      return c.json({ error: 'Account already exists with this email' }, 400);
    }

    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;