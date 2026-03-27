/**
 * Customer auth — magic link + Google OAuth (no passwords, no Firebase)
 * POST /api/customer/auth/magic-link    → sends email with token
 * POST /api/customer/auth/magic-verify  → verifies token, returns JWT
 * GET  /api/customer/auth/google         → redirect to Google OAuth
 * GET  /api/customer/auth/google/callback → handle Google OAuth callback
 */

import { Hono } from 'hono';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  getCustomerByEmail,
  createCustomer,
  updateCustomer,
  createMagicToken,
  getMagicToken,
  consumeMagicToken,
  logActivity,
} from '../services/supabase.js';
import { encryptToken } from '../lib/token-crypto.js';
import supabase from '../services/supabase.js';

export const customerAuthRoutes = new Hono();

const JWT_SECRET = (() => { if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET env var required'); return process.env.JWT_SECRET; })();
const APP_URL = process.env.APP_URL || 'https://mrdelegate.ai';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const magicLinkAttempts = new Map();
const MAGIC_LINK_WINDOW_MS = 15 * 60 * 1000;
const MAGIC_LINK_MAX_ATTEMPTS = 5;

function getRequestIp(c) {
  return (c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown').split(',')[0].trim();
}

function checkRateLimit(store, key, maxAttempts, windowMs) {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now - entry.start > windowMs) {
    store.set(key, { count: 1, start: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= maxAttempts;
}

function signStateValue(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyStateValue(raw, maxAgeMs = 15 * 60 * 1000) {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  const sig = parts.pop();
  const data = parts.join('.');
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (parsed.ts && Date.now() - parsed.ts > maxAgeMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

// POST /api/customer/auth/magic-link
customerAuthRoutes.post('/magic-link', async (c) => {
  let email;
  try {
    ({ email } = await c.req.json());
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!email) return c.json({ error: 'Email required' }, 400);
  const normalizedEmail = email.toLowerCase().trim();
  const rateKey = `magic-link:${getRequestIp(c)}:${normalizedEmail}`;
  if (!checkRateLimit(magicLinkAttempts, rateKey, MAGIC_LINK_MAX_ATTEMPTS, MAGIC_LINK_WINDOW_MS)) {
    return c.json({ error: 'Too many sign-in link requests. Try again in 15 minutes.' }, 429);
  }

  const customer = await getCustomerByEmail(normalizedEmail);
  if (!customer) return c.json({ error: 'No account found. Start a free trial first.' }, 404);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await createMagicToken(customer.email, token, expiresAt);

  const magicUrl = `${APP_URL}/login?token=${token}`;

  if (RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MrDelegate <team@mrdelegate.ai>',
        to: customer.email,
        subject: 'Your sign-in link — MrDelegate',
        html: `
          <div style="background:#ffffff;color:#0F0E0C;font-family:sans-serif;padding:40px;max-width:480px;margin:0 auto;border:1px solid #E8E6E1;border-radius:12px">
            <div style="font-size:22px;font-weight:800;margin-bottom:4px;color:#5B4DE0">MrDelegate</div>
            <p style="color:#7A756C;margin-bottom:32px;font-size:14px">Your sign-in link</p>
            <p style="margin-bottom:24px;color:#3D3A35">Click below to sign in to your dashboard. Link expires in 15 minutes and can only be used once.</p>
            <a href="${magicUrl}" style="display:inline-block;background:#5B4DE0;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">Sign in to dashboard →</a>
            <p style="color:#7A756C;font-size:12px;margin-top:32px">If you didn't request this, you can safely ignore this email.</p>
          </div>`
      })
    });
    await logActivity(customer.id, 'magic_link_sent', { email: customer.email });
  }

  return c.json({ ok: true, ...(RESEND_API_KEY ? {} : { devLink: magicUrl }) });
});

// POST /api/customer/auth/magic-verify
customerAuthRoutes.post('/magic-verify', async (c) => {
  let token;
  try {
    ({ token } = await c.req.json());
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!token) return c.json({ error: 'Token required' }, 400);

  const entry = await getMagicToken(token);
  if (!entry) return c.json({ error: 'Invalid or expired token' }, 401);

  await consumeMagicToken(token);

  const customer = await getCustomerByEmail(entry.email);
  if (!customer) return c.json({ error: 'Account not found' }, 404);

  const sessionToken = jwt.sign(
    { customerId: customer.id, email: customer.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  await logActivity(customer.id, 'login', { method: 'magic_link' });

  return c.json({ token: sessionToken, customerId: customer.id });
});

// ─── Google OAuth — no Firebase needed ───────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT = `${APP_URL}/api/customer/auth/google/callback`;

// GitHub OAuth configuration
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_REDIRECT = `${APP_URL}/api/customer/auth/github/callback`;

// GET /api/customer/auth/google → redirect to Google
customerAuthRoutes.get('/google', (c) => {
  if (!GOOGLE_CLIENT_ID) return c.json({ error: 'Google OAuth not configured yet' }, 503);
  const state = signStateValue({ flow: 'customer-auth-google', ts: Date.now() });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT,
    response_type: 'code',
    scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly',
    access_type: 'offline',
    prompt: 'select_account',
    state,
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /api/customer/auth/google/callback → exchange code for tokens, sign in
customerAuthRoutes.get('/google/callback', async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');
  const state = c.req.query('state');
  if (error || !code) return c.redirect(`${APP_URL}/login?error=google_cancelled`);
  const parsedState = verifyStateValue(state);
  if (!parsedState || parsedState.flow !== 'customer-auth-google') {
    return c.redirect(`${APP_URL}/login?error=google_state_invalid`);
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) return c.redirect(`${APP_URL}/login?error=google_failed`);

  // Get user info
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const googleUser = await userRes.json();
  if (!googleUser.email) return c.redirect(`${APP_URL}/login?error=google_no_email`);

  const email = googleUser.email.toLowerCase();

  // Find existing customer — or create as 'lead' for email retargeting
  // Full account (trial/active) only created after Stripe checkout
  let customer = await getCustomerByEmail(email);

  // Google token data to save (refresh_token only present on first auth or re-auth with prompt=consent)
  // Tokens are encrypted at rest using AES-256-GCM via TOKEN_ENCRYPTION_KEY
  const googleTokenUpdate = {
    google_access_token: encryptToken(tokens.access_token),
    google_token_expiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
  };
  if (tokens.refresh_token) {
    googleTokenUpdate.google_refresh_token = encryptToken(tokens.refresh_token);
  }

  if (!customer) {
    // Save as lead so we can email them — no VPS, no trial, no charge
    customer = await createCustomer({
      email,
      name: googleUser.name || email.split('@')[0],
      status: 'lead',
      trial_ends_at: null,
    });
    await logActivity(customer.id, 'signup_intent', { method: 'google' });
    // Save Google tokens for lead (useful later when they convert)
    await supabase.from('customers').update(googleTokenUpdate).eq('id', customer.id).catch(() => {});
    // Redirect to /start to complete checkout
    return c.redirect(`${APP_URL}/start?email=${encodeURIComponent(email)}`);
  }

  // Save/update Google tokens for existing customer
  await supabase.from('customers').update(googleTokenUpdate).eq('id', customer.id).catch(() => {});

  // Existing lead — send back to checkout
  if (customer.status === 'lead') {
    return c.redirect(`${APP_URL}/start?email=${encodeURIComponent(email)}`);
  }
  await logActivity(customer.id, 'login', { method: 'google' });

  // Issue JWT
  const sessionToken = jwt.sign(
    { customerId: customer.id, email: customer.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  // Redirect to app with token
  return c.redirect(`${APP_URL}/app?token=${sessionToken}`);
});

// ─── GitHub OAuth ─────────────────────────────────────────────────────────────

// GET /api/customer/auth/github → redirect to GitHub
customerAuthRoutes.get('/github', (c) => {
  if (!GITHUB_CLIENT_ID) return c.json({ error: 'GitHub OAuth not configured yet' }, 503);
  const state = signStateValue({ flow: 'customer-auth-github', ts: Date.now() });
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_REDIRECT,
    scope: 'user:email',
    state,
  });
  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// GET /api/customer/auth/github/callback → exchange code for tokens, sign in
customerAuthRoutes.get('/github/callback', async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');
  const state = c.req.query('state');
  if (error || !code) return c.redirect(`${APP_URL}/login?error=github_cancelled`);
  const parsedState = verifyStateValue(state);
  if (!parsedState || parsedState.flow !== 'customer-auth-github') {
    return c.redirect(`${APP_URL}/login?error=github_state_invalid`);
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: GITHUB_REDIRECT,
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) return c.redirect(`${APP_URL}/login?error=github_failed`);

  // Get user info
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const githubUser = await userRes.json();
  if (!githubUser.id) return c.redirect(`${APP_URL}/login?error=github_failed`);

  // Get primary email if not public
  let email = githubUser.email;
  if (!email) {
    const emailRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const emails = await emailRes.json();
    const primaryEmail = emails.find(e => e.primary && e.verified);
    email = primaryEmail?.email;
  }

  if (!email) return c.redirect(`${APP_URL}/login?error=github_no_email`);
  email = email.toLowerCase();

  // Find existing customer — or create as 'lead' for email retargeting
  let customer = await getCustomerByEmail(email);

  // GitHub token data to save (encrypted at rest)
  const githubTokenUpdate = {
    github_access_token: encryptToken(tokens.access_token),
  };

  if (!customer) {
    // Save as lead so we can email them — no VPS, no trial, no charge
    customer = await createCustomer({
      email,
      name: githubUser.name || githubUser.login || email.split('@')[0],
      status: 'lead',
      trial_ends_at: null,
    });
    await logActivity(customer.id, 'signup_intent', { method: 'github' });
    // Save GitHub tokens for lead (useful later when they convert)
    await supabase.from('customers').update(githubTokenUpdate).eq('id', customer.id).catch(() => {});
    // Redirect to /start to complete checkout
    return c.redirect(`${APP_URL}/start?email=${encodeURIComponent(email)}`);
  }

  // Save/update GitHub tokens for existing customer
  await supabase.from('customers').update(githubTokenUpdate).eq('id', customer.id).catch(() => {});

  // Existing lead — send back to checkout
  if (customer.status === 'lead') {
    return c.redirect(`${APP_URL}/start?email=${encodeURIComponent(email)}`);
  }
  await logActivity(customer.id, 'login', { method: 'github' });

  // Issue JWT
  const sessionToken = jwt.sign(
    { customerId: customer.id, email: customer.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  // Redirect to app with token
  return c.redirect(`${APP_URL}/app?token=${sessionToken}`);
});

// GET /api/customer/auth/bootstrap
// Called by dashboard on load — exchanges md_customer_token cookie for a Bearer JWT.
// Allows users arriving via Stripe/welcome flow (cookie-only) to get a localStorage token.
customerAuthRoutes.get('/bootstrap', async (c) => {
  const cookie = c.req.header('cookie') || '';
  // Try CUSTOMER_JWT_SECRET cookie (Stripe/welcome flow)
  const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET;
  let decoded = null;

  const cookieMatch = cookie.match(/md_customer_token=([^;]+)/);
  if (cookieMatch && CUSTOMER_JWT_SECRET) {
    try { decoded = jwt.verify(cookieMatch[1], CUSTOMER_JWT_SECRET); } catch {}
  }
  // Also try JWT_SECRET (legacy)
  if (!decoded && cookieMatch) {
    try { decoded = jwt.verify(cookieMatch[1], JWT_SECRET); } catch {}
  }

  if (!decoded?.customerId) {
    return c.json({ error: 'No valid session cookie' }, 401);
  }

  // Issue a new JWT_SECRET-signed token for localStorage use
  const token = jwt.sign(
    { customerId: decoded.customerId, email: decoded.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return c.json({ token, customerId: decoded.customerId });
});
