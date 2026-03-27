/**
 * Google OAuth 2.0 connector
 * Handles Gmail + Calendar OAuth for customer agents
 * Also handles signup flow (Google Sign-In first on /start)
 * 
 * Setup required (founder action):
 * 1. Create Google Cloud project at console.cloud.google.com
 * 2. Enable Gmail API + Google Calendar API
 * 3. Create OAuth 2.0 credentials (Web Application)
 * 4. Add redirect URI: https://mrdelegate.ai/api/oauth/google/callback
 * 5. Set env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 */

import { Hono } from 'hono';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { decryptConnectorTokens, encryptToken } from '../lib/token-crypto.js';
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  fetchMicrosoftProfile,
  isMicrosoftOAuthConfigured,
  refreshMicrosoftToken,
} from '../lib/microsoft-oauth.js';
import jwt from 'jsonwebtoken';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');

export const oauthRoutes = new Hono();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const CALENDLY_CLIENT_ID = process.env.CALENDLY_CLIENT_ID || 'placeholder';
const CALENDLY_CLIENT_SECRET = process.env.CALENDLY_CLIENT_SECRET || 'placeholder';
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const APP_URL = process.env.APP_URL || 'https://mrdelegate.ai';
const JWT_SECRET = process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET env var required'); })();
const CUSTOMER_JWT_SECRET = (() => {
  if (!process.env.CUSTOMER_JWT_SECRET) throw new Error('CUSTOMER_JWT_SECRET env var required');
  return process.env.CUSTOMER_JWT_SECRET;
})();
const REDIRECT_URI = `${APP_URL}/api/oauth/google/callback`;
const CALENDLY_REDIRECT_URI = `${APP_URL}/api/oauth/calendly/callback`;
const SLACK_REDIRECT_URI = `${APP_URL}/api/oauth/slack/callback`;
const SLACK_USER_SCOPES = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'search:read',
  'users:read',
].join(',');

// Full scopes for connector flow (Gmail + Calendar)
const FULL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
  'profile'
].join(' ');

// Minimal scopes for signup login flow
const LOGIN_SCOPES = 'openid email profile';

// ── Cookie helpers ──────────────────────────────────────────────────────────

function signCookieValue(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyCookieValue(raw) {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  const sig = parts.pop();
  const data = parts.join('.');
  const expected = createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString());
    // Check expiry (1 hour)
    if (parsed.ts && Date.now() - parsed.ts > 3600000) return null;
    return parsed;
  } catch { return null; }
}

function signStateValue(payload) {
  return signCookieValue(payload);
}

function verifyStateValue(raw, maxAgeMs = 3600000) {
  const payload = verifyCookieValue(raw);
  if (!payload) return null;
  if (payload.ts && Date.now() - payload.ts > maxAgeMs) return null;
  return payload;
}

// C2: Single-use state tracking — prevents OAuth state replay attacks.
// In-process only (resets on restart). For full protection, use DB-backed tracking.
const usedStates = new Set();
function verifyAndConsumeState(raw, maxAgeMs = 300000) { // 5-minute TTL
  if (usedStates.has(raw)) return null; // already consumed — replay attempt
  const payload = verifyStateValue(raw, maxAgeMs);
  if (!payload) return null;
  usedStates.add(raw);
  setTimeout(() => usedStates.delete(raw), maxAgeMs); // cleanup
  return payload;
}

function getCustomerAuth(c) {
  const auth = c.req.header('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
      if (decoded?.customerId) return decoded;
    } catch {}
  }

  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/md_customer_token=([^;]+)/);
  if (!match) return null;

  try {
    const decoded = jwt.verify(decodeURIComponent(match[1]), CUSTOMER_JWT_SECRET);
    return decoded?.customerId ? decoded : null;
  } catch {
    return null;
  }
}

function requireCustomerMatch(c) {
  const decoded = getCustomerAuth(c);
  if (!decoded?.customerId) return { error: c.json({ error: 'Unauthorized' }, 401) };

  const customerId = c.req.query('customerId');
  if (!customerId) return { error: c.json({ error: 'customerId required' }, 400) };
  if (decoded.customerId !== customerId) return { error: c.json({ error: 'Forbidden' }, 403) };

  return { customerId };
}

// ── Token store helpers ─────────────────────────────────────────────────────

function loadTokens() {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, 'oauth-tokens.json'), 'utf-8'));
  } catch { return {}; }
}

function saveTokens(tokens) {
  writeFileSync(join(DATA_DIR, 'oauth-tokens.json'), JSON.stringify(tokens, null, 2));
}

function buildOAuthStatusPage({ title, subtitle, accent = '#10e87e', linkText = 'Go back', linkHref = '/' }) {
  return `<!DOCTYPE html>
<html><head><title>${title}</title>
<style>body{background:#050508;color:#f0eeff;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center}
h2{color:${accent};font-size:1.8rem;margin-bottom:8px}.sub{color:#6b6b8a;font-size:14px;max-width:420px;margin:0 auto}
a{color:#7c6bff}</style></head><body>
<div><h2>${title}</h2><p class="sub">${subtitle}</p>
<p class="sub" style="margin-top:24px"><a href="${linkHref}">${linkText}</a></p></div>
</body></html>`;
}

function isSlackOAuthConfigured() {
  return !!(SLACK_CLIENT_ID && SLACK_CLIENT_SECRET);
}

async function parseSlackResponse(response) {
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.code = data.error || 'slack_oauth_error';
    error.response = data;
    throw error;
  }
  return data;
}

function buildSlackAuthUrl(state) {
  const authUrl = new URL('https://slack.com/oauth/v2/authorize');
  authUrl.searchParams.set('client_id', SLACK_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', SLACK_REDIRECT_URI);
  authUrl.searchParams.set('user_scope', SLACK_USER_SCOPES);
  authUrl.searchParams.set('state', state);
  return authUrl.toString();
}

async function exchangeSlackCode(code) {
  return parseSlackResponse(await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      redirect_uri: SLACK_REDIRECT_URI,
    }),
  }));
}

async function refreshSlackToken(refreshToken) {
  return parseSlackResponse(await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
    }),
  }));
}

async function slackApi(token, method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return parseSlackResponse(await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  }));
}

// ── GET /api/oauth/google/login-start ──────────────────────────────────────
// Initiates Google Sign-In for the /start onboarding flow (minimal scopes)
oauthRoutes.get('/google/login-start', (c) => {
  if (!GOOGLE_CLIENT_ID) {
    return c.json({ error: 'Google OAuth not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET' }, 503);
  }

  const plan = c.req.query('plan') || 'monthly';
  const state = signStateValue({ flow: 'signup', plan, ts: Date.now() });

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', LOGIN_SCOPES);
  authUrl.searchParams.set('access_type', 'online');
  authUrl.searchParams.set('state', state);

  return c.redirect(authUrl.toString());
});

// ── GET /api/oauth/google/start?customerId=xxx ─────────────────────────────
// Initiates OAuth flow for a customer (full Gmail + Calendar scopes)
oauthRoutes.get('/google/start', (c) => {
  if (!GOOGLE_CLIENT_ID) {
    return c.json({ error: 'Google OAuth not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET' }, 503);
  }

  const auth = requireCustomerMatch(c);
  if (auth.error) return auth.error;
  const { customerId } = auth;

  const state = signStateValue({ customerId, provider: 'google', ts: Date.now() });

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', FULL_SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // force refresh_token
  authUrl.searchParams.set('state', state);

  return c.redirect(authUrl.toString());
});

// ── GET /api/oauth/google/callback ─────────────────────────────────────────
// Google redirects here after user grants permissions.
// Handles both: signup flow (state.flow === 'signup') and connector flow.
oauthRoutes.get('/google/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.html(`<p>OAuth denied: ${error}. <a href="/">Go back</a></p>`, 400);
  }

  const decoded = verifyAndConsumeState(state);
  if (!decoded) {
    return c.json({ error: 'Invalid state' }, 400);
  }

  // ── Signup flow: set cookie and redirect to /start ──
  if (decoded.flow === 'signup') {
    // Exchange code for tokens (minimal)
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return c.html(`<p>Sign-in failed. Please try again. <a href="/start">Go back</a></p>`, 400);
    }

    // Get user info from Google
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userInfo = await userRes.json();

    if (!userInfo.email) {
      return c.html(`<p>Could not retrieve your email from Google. <a href="/start">Go back</a></p>`, 400);
    }

    // Sign and set short-lived cookie (1 hour)
    const cookieValue = signCookieValue({
      email: userInfo.email,
      name: userInfo.name || userInfo.given_name || '',
      ts: Date.now()
    });

    const cookieOpts = [
      `md_signup_session=${cookieValue}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=3600',
      ...(APP_URL.startsWith('https') ? ['Secure'] : [])
    ].join('; ');

    c.header('Set-Cookie', cookieOpts);
    const redirectPlan = decoded.plan || 'monthly';
    return c.redirect(`${APP_URL}/start?authed=1${redirectPlan === 'annual' ? '&plan=annual' : ''}`);
  }

  // ── Connector flow: store Gmail/Calendar tokens ──
  const customerId = decoded.customerId;
  if (!customerId) {
    return c.json({ error: 'Invalid state: missing customerId' }, 400);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return c.html(`<p>Token exchange failed. Please try again. <a href="/">Go back</a></p>`, 400);
  }

  const tokens = loadTokens();
  tokens[customerId] = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + (tokenData.expires_in * 1000),
    scope: tokenData.scope,
    connectedAt: new Date().toISOString()
  };
  saveTokens(tokens);

  // Persist to Supabase — both customers table (backward compat) + customer_connectors
  if (supabaseOAuth) {
    const tokenExpiry = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
    const encryptedAccess = encryptToken(tokenData.access_token);
    const encryptedRefresh = tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null;

    // 1. Backward compat: update customers table columns (C1: tokens removed — stored encrypted in customer_connectors)
    const supabaseUpdate = {
      google_token_expiry: tokenExpiry,
      google_connected: true,
      connector_failures: {},
      google_last_verified: new Date().toISOString(),
    };
    await supabaseOAuth.from('customers').update(supabaseUpdate).eq('id', customerId).catch(e => {
      console.error('[oauth/google] Failed to update customers table:', e.message);
    });

    // 2. Upsert into customer_connectors (encrypted tokens) — gmail connector
    const gmailConnector = {
      customer_id: customerId,
      connector_type: 'gmail',
      connector_account: null,
      access_token: encryptedAccess,
      token_expiry: tokenExpiry,
      scope: tokenData.scope || null,
      connected: true,
      last_verified: new Date().toISOString(),
      consecutive_failures: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    };
    if (encryptedRefresh) gmailConnector.refresh_token = encryptedRefresh;

    await supabaseOAuth.from('customer_connectors')
      .upsert(gmailConnector, { onConflict: 'customer_id,connector_type,connector_account' })
      .catch(e => console.error('[oauth/google] Failed to upsert gmail connector:', e.message));

    // 3. Upsert google_calendar connector (same token, different type)
    const calConnector = { ...gmailConnector, connector_type: 'google_calendar' };
    await supabaseOAuth.from('customer_connectors')
      .upsert(calConnector, { onConflict: 'customer_id,connector_type,connector_account' })
      .catch(e => console.error('[oauth/google] Failed to upsert google_calendar connector:', e.message));

    console.log(`[oauth/google] Upserted gmail + google_calendar connectors for customer ${customerId}`);

    // Log activity
    await supabaseOAuth.from('activity_log').insert([{
      customer_id: customerId,
      event: 'google_connected',
      data: { connected_at: new Date().toISOString() },
    }]).catch(e => console.warn('[oauth/google] Failed to log activity:', e.message));
  }

  return c.html(`<!DOCTYPE html>
<html><head><title>Connected!</title>
<style>body{background:#050508;color:#f0eeff;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center}
h2{color:#10e87e;font-size:2rem;margin-bottom:8px}.sub{color:#6b6b8a;font-size:14px}</style>
</head><body>
<div><h2>✓ Google connected</h2>
<p class="sub">Gmail and Calendar are now linked to your agent.</p>
<p class="sub" style="margin-top:24px">You can close this window.</p></div>
</body></html>`);
});

// ── GET /api/oauth/google/status?customerId=xxx ────────────────────────────
oauthRoutes.get('/google/status', (c) => {
  const auth = requireCustomerMatch(c);
  if (auth.error) return auth.error;
  const { customerId } = auth;

  const tokens = loadTokens();
  const t = tokens[customerId];
  if (!t) return c.json({ connected: false });

  return c.json({
    connected: true,
    connectedAt: t.connectedAt,
    expired: Date.now() > t.expiresAt,
    scope: t.scope
  });
});

// ── POST /api/oauth/google/refresh?customerId=xxx ──────────────────────────
oauthRoutes.post('/google/refresh', async (c) => {
  const auth = requireCustomerMatch(c);
  if (auth.error) return auth.error;
  const { customerId } = auth;
  const tokens = loadTokens();
  const t = tokens[customerId];

  if (!t?.refreshToken) return c.json({ error: 'No refresh token stored' }, 400);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: t.refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });

  const data = await res.json();
  if (!data.access_token) return c.json({ error: 'Refresh failed' }, 500);

  tokens[customerId].accessToken = data.access_token;
  tokens[customerId].expiresAt = Date.now() + (data.expires_in * 1000);
  saveTokens(tokens);

  return c.json({ ok: true, expiresAt: tokens[customerId].expiresAt });
});

// ── GET /api/oauth/microsoft/connect?customerId=xxx ────────────────────────
oauthRoutes.get('/microsoft/connect', (c) => {
  if (!isMicrosoftOAuthConfigured()) {
    return c.json({ error: 'Microsoft OAuth not configured — set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET' }, 503);
  }

  // H3: Verify authenticated customer owns the customerId being connected
  const auth = requireCustomerMatch(c);
  if (auth.error) return auth.error;
  const { customerId } = auth;

  const state = signStateValue({
    customerId,
    provider: 'microsoft',
    ts: Date.now(),
  });

  return c.redirect(buildMicrosoftAuthUrl(state));
});

// ── GET /api/oauth/microsoft/callback ──────────────────────────────────────
oauthRoutes.get('/microsoft/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.html(
      buildOAuthStatusPage({
        title: 'Microsoft connection failed',
        subtitle: error === 'access_denied' ? 'You declined the connection.' : 'Something went wrong during Microsoft sign-in.',
        accent: '#ff6b6b',
      }),
      400
    );
  }

  if (!code || !stateParam) {
    return c.json({ error: 'Missing code or state' }, 400);
  }

  const decoded = verifyAndConsumeState(stateParam);
  if (!decoded || decoded.provider !== 'microsoft' || !decoded.customerId) {
    return c.json({ error: 'Invalid state parameter' }, 400);
  }

  if (!supabaseOAuth) {
    return c.html(
      buildOAuthStatusPage({
        title: 'Microsoft connection failed',
        subtitle: 'Supabase is not configured on this environment.',
        accent: '#ff6b6b',
      }),
      500
    );
  }

  try {
    const tokenData = await exchangeMicrosoftCode(code);
    let profile = jwt.decode(tokenData.id_token || '') || null;
    if (!profile?.oid && !profile?.sub && !profile?.preferred_username && !profile?.email) {
      profile = await fetchMicrosoftProfile(tokenData.access_token);
    }

    const profileId = profile?.oid || profile?.sub || profile?.id || null;
    const profileName = profile?.name || profile?.displayName || null;
    const profileMail = profile?.email || profile?.preferred_username || profile?.mail || null;
    const userPrincipalName = profile?.preferred_username || profile?.userPrincipalName || profileMail || null;
    const connectorAccount = profileMail || userPrincipalName;
    const tokenExpiry = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();

    const connectorRow = {
      customer_id: decoded.customerId,
      connector_type: 'outlook',
      connector_account: connectorAccount || profileMail || userPrincipalName,
      access_token: encryptToken(tokenData.access_token),
      refresh_token: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null,
      token_expiry: tokenExpiry,
      scope: tokenData.scope || null,
      connector_user_id: profileId,
      connector_metadata: {
        display_name: profileName,
        mail: profileMail,
        user_principal_name: userPrincipalName,
      },
      connected: true,
      last_verified: new Date().toISOString(),
      consecutive_failures: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await supabaseOAuth
      .from('customer_connectors')
      .upsert(connectorRow, { onConflict: 'customer_id,connector_type,connector_account' });

    if (upsertError) {
      throw upsertError;
    }

    console.log(`[oauth/microsoft] Upserted outlook connector for customer ${decoded.customerId}`);

    // Log activity
    await supabaseOAuth.from('activity_log').insert([{
      customer_id: decoded.customerId,
      event: 'outlook_connected',
      data: { connected_at: new Date().toISOString() },
    }]).catch(e => console.warn('[oauth/microsoft] Failed to log activity:', e.message));

    return c.html(
      buildOAuthStatusPage({
        title: 'Microsoft 365 connected',
        subtitle: 'Outlook mail and calendar access are now linked to your agent.',
      })
    );
  } catch (err) {
    console.error('[oauth/microsoft] Callback failed:', err.message);
    return c.html(
      buildOAuthStatusPage({
        title: 'Microsoft connection failed',
        subtitle: 'Could not finish the Microsoft token exchange. Please try again.',
        accent: '#ff6b6b',
      }),
      400
    );
  }
});

// ── POST /api/oauth/microsoft/refresh?customerId=xxx ───────────────────────
oauthRoutes.post('/microsoft/refresh', async (c) => {
  const auth = requireCustomerMatch(c);
  if (auth.error) return auth.error;
  const { customerId } = auth;

  if (!supabaseOAuth) return c.json({ error: 'Supabase OAuth client not configured' }, 503);

  const { data: connector, error } = await supabaseOAuth
    .from('customer_connectors')
    .select('id, customer_id, access_token, refresh_token, token_expiry, connector_type')
    .eq('customer_id', customerId)
    .eq('connector_type', 'outlook')
    .eq('connected', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return c.json({ error: error.message }, 500);
  if (!connector?.refresh_token) return c.json({ error: 'No Microsoft refresh token stored' }, 400);

  try {
    const { refreshToken: storedRefresh } = decryptConnectorTokens(connector, 'oauth-microsoft-refresh');
    if (!storedRefresh) return c.json({ error: 'Stored refresh token could not be decrypted' }, 400);

    const tokenData = await refreshMicrosoftToken(storedRefresh);
    const newExpiry = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
    const update = {
      access_token: encryptToken(tokenData.access_token),
      token_expiry: newExpiry,
      scope: tokenData.scope || null,
      connected: true,
      consecutive_failures: 0,
      last_error: null,
      last_verified: new Date().toISOString(),
      last_used: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (tokenData.refresh_token) {
      update.refresh_token = encryptToken(tokenData.refresh_token);
    } else {
      // H6: Microsoft sometimes rotates refresh tokens — log when it doesn't return a new one
      console.warn(`[oauth/microsoft] Microsoft did not return new refresh_token for customer ${customerId} — old token retained`);
    }

    await supabaseOAuth.from('customer_connectors').update(update).eq('id', connector.id);

    return c.json({ ok: true, expiresAt: newExpiry });
  } catch (err) {
    console.error('[oauth/microsoft] Refresh failed:', err.message);
    return c.json({ error: err.message }, 400);
  }
});

// ── GET /api/oauth/slack/start?customerId=xxx ──────────────────────────────
oauthRoutes.get('/slack/start', (c) => {
  if (!isSlackOAuthConfigured()) {
    return c.json({ error: 'Slack OAuth not configured — set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET' }, 503);
  }

  const auth = requireCustomerMatch(c);
  if (auth.error) return auth.error;
  const { customerId } = auth;

  const state = signStateValue({ customerId, provider: 'slack', ts: Date.now() });
  return c.redirect(buildSlackAuthUrl(state));
});

// ── GET /api/oauth/slack/callback ───────────────────────────────────────────
oauthRoutes.get('/slack/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.html(
      buildOAuthStatusPage({
        title: 'Slack connection failed',
        subtitle: error === 'access_denied' ? 'You declined the Slack connection.' : 'Something went wrong during Slack sign-in.',
        accent: '#ff6b6b',
      }),
      400
    );
  }

  if (!code || !stateParam) {
    return c.json({ error: 'Missing code or state' }, 400);
  }

  const decoded = verifyAndConsumeState(stateParam);
  if (!decoded || decoded.provider !== 'slack' || !decoded.customerId) {
    return c.json({ error: 'Invalid state parameter' }, 400);
  }

  if (!supabaseOAuth) {
    return c.html(
      buildOAuthStatusPage({
        title: 'Slack connection failed',
        subtitle: 'Supabase is not configured on this environment.',
        accent: '#ff6b6b',
      }),
      500
    );
  }

  try {
    const tokenData = await exchangeSlackCode(code);
    const userToken = tokenData.authed_user?.access_token || tokenData.access_token;
    const refreshToken = tokenData.authed_user?.refresh_token || tokenData.refresh_token || null;
    const expiresIn = tokenData.authed_user?.expires_in || tokenData.expires_in || null;

    if (!userToken) {
      throw new Error('Slack did not return a user access token');
    }

    const authInfo = await slackApi(userToken, 'auth.test');
    let userInfo = null;
    if (authInfo.user_id) {
      try {
        userInfo = await slackApi(userToken, 'users.info', { user: authInfo.user_id });
      } catch (err) {
        console.warn('[oauth/slack] users.info failed:', err.message);
      }
    }

    const connectorAccount =
      userInfo?.user?.profile?.email ||
      userInfo?.user?.real_name ||
      userInfo?.user?.name ||
      authInfo.user ||
      authInfo.user_id;

    const tokenExpiry = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    const connectorRow = {
      customer_id: decoded.customerId,
      connector_type: 'slack',
      connector_account: connectorAccount,
      access_token: encryptToken(userToken),
      refresh_token: refreshToken ? encryptToken(refreshToken) : null,
      token_expiry: tokenExpiry,
      scope: tokenData.authed_user?.scope || tokenData.scope || SLACK_USER_SCOPES,
      connector_user_id: authInfo.user_id || tokenData.authed_user?.id || null,
      connector_metadata: {
        team_id: authInfo.team_id || tokenData.team?.id || null,
        team_name: authInfo.team || tokenData.team?.name || null,
        slack_user_id: authInfo.user_id || tokenData.authed_user?.id || null,
        slack_user_name: userInfo?.user?.name || authInfo.user || null,
        display_name: userInfo?.user?.profile?.display_name || userInfo?.user?.real_name || null,
        email: userInfo?.user?.profile?.email || null,
        workspace_url: authInfo.url || null,
      },
      connected: true,
      last_verified: new Date().toISOString(),
      consecutive_failures: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await supabaseOAuth
      .from('customer_connectors')
      .upsert(connectorRow, { onConflict: 'customer_id,connector_type,connector_account' });

    if (upsertError) throw upsertError;

    await supabaseOAuth.from('activity_log').insert([{
      customer_id: decoded.customerId,
      event: 'slack_connected',
      data: {
        team_name: connectorRow.connector_metadata.team_name,
        slack_user_id: connectorRow.connector_metadata.slack_user_id,
        connected_at: new Date().toISOString(),
      },
    }]).catch((activityError) => {
      console.warn('[oauth/slack] Failed to log activity:', activityError.message);
    });

    const tokens = loadTokens();
    tokens[`slack_${decoded.customerId}`] = {
      accessToken: userToken,
      refreshToken,
      expiresAt: expiresIn ? Date.now() + (expiresIn * 1000) : null,
      connectedAt: new Date().toISOString(),
      workspace: connectorRow.connector_metadata.team_name,
      userId: connectorRow.connector_metadata.slack_user_id,
    };
    saveTokens(tokens);

    console.log(`[oauth/slack] Upserted slack connector for customer ${decoded.customerId}`);

    return c.html(
      buildOAuthStatusPage({
        title: 'Slack connected',
        subtitle: 'Unread DMs and @mentions are now linked to your agent.',
      })
    );
  } catch (err) {
    console.error('[oauth/slack] Callback failed:', err.message);
    return c.html(
      buildOAuthStatusPage({
        title: 'Slack connection failed',
        subtitle: 'Could not finish the Slack token exchange. Please try again.',
        accent: '#ff6b6b',
      }),
      400
    );
  }
});

// ── POST /api/oauth/slack/refresh?customerId=xxx ───────────────────────────
oauthRoutes.post('/slack/refresh', async (c) => {
  const auth = requireCustomerMatch(c);
  if (auth.error) return auth.error;
  const { customerId } = auth;

  if (!supabaseOAuth) return c.json({ error: 'Supabase OAuth client not configured' }, 503);

  const { data: connector, error } = await supabaseOAuth
    .from('customer_connectors')
    .select('id, customer_id, access_token, refresh_token, token_expiry, connector_type')
    .eq('customer_id', customerId)
    .eq('connector_type', 'slack')
    .eq('connected', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return c.json({ error: error.message }, 500);
  if (!connector?.refresh_token) return c.json({ error: 'No Slack refresh token stored' }, 400);

  try {
    const { refreshToken: storedRefresh } = decryptConnectorTokens(connector, 'oauth-slack-refresh');
    if (!storedRefresh) return c.json({ error: 'Stored refresh token could not be decrypted' }, 400);

    const tokenData = await refreshSlackToken(storedRefresh);
    const userToken = tokenData.authed_user?.access_token || tokenData.access_token;
    const refreshToken = tokenData.authed_user?.refresh_token || tokenData.refresh_token || storedRefresh;
    const expiresIn = tokenData.authed_user?.expires_in || tokenData.expires_in || null;
    const newExpiry = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    const update = {
      access_token: encryptToken(userToken),
      refresh_token: refreshToken ? encryptToken(refreshToken) : null,
      token_expiry: newExpiry,
      scope: tokenData.authed_user?.scope || tokenData.scope || null,
      connected: true,
      consecutive_failures: 0,
      last_error: null,
      last_verified: new Date().toISOString(),
      last_used: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await supabaseOAuth.from('customer_connectors').update(update).eq('id', connector.id);
    return c.json({ ok: true, expiresAt: newExpiry });
  } catch (err) {
    console.error('[oauth/slack] Refresh failed:', err.message);
    return c.json({ error: err.message }, 400);
  }
});

// ── GET /api/oauth/slack/status?customerId=xxx ─────────────────────────────
oauthRoutes.get('/slack/status', async (c) => {
  const auth = requireCustomerMatch(c);
  if (auth.error) return auth.error;
  const { customerId } = auth;

  if (!supabaseOAuth) return c.json({ connected: false, reason: 'no_supabase' });

  const { data, error } = await supabaseOAuth
    .from('customer_connectors')
    .select('connected, token_expiry, created_at, connector_metadata')
    .eq('customer_id', customerId)
    .eq('connector_type', 'slack')
    .eq('connected', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return c.json({ connected: false });

  return c.json({
    connected: true,
    connectedAt: data.created_at,
    workspace: data.connector_metadata?.team_name || null,
    userId: data.connector_metadata?.slack_user_id || null,
    expiresAt: data.token_expiry || null,
    expired: data.token_expiry ? Date.now() > new Date(data.token_expiry).getTime() : false,
  });
});

// ── GET /api/oauth/google/signup-session ──────────────────────────────────
// Read signup session cookie — used by onboarding page to pre-fill fields
oauthRoutes.get('/google/signup-session', (c) => {
  const raw = c.req.header('cookie') || '';
  const match = raw.match(/md_signup_session=([^;]+)/);
  if (!match) return c.json({ ok: false });

  const payload = verifyCookieValue(decodeURIComponent(match[1]));
  if (!payload) return c.json({ ok: false });

  return c.json({ ok: true, email: payload.email, name: payload.name });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── CALENDLY OAuth ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// Supabase client for storing Calendly tokens directly in the customers table
const SUPABASE_URL_OAUTH = process.env.SUPABASE_URL || 'https://mwsvekxgkjlmbglargmg.supabase.co';
const SUPABASE_KEY_OAUTH = process.env.SUPABASE_SERVICE_KEY;
const supabaseOAuth = (SUPABASE_URL_OAUTH && SUPABASE_KEY_OAUTH)
  ? createClient(SUPABASE_URL_OAUTH, SUPABASE_KEY_OAUTH)
  : null;

// ── GET /api/oauth/calendly/start?customerId=xxx ───────────────────────────
// Initiates Calendly OAuth flow for a customer
oauthRoutes.get('/calendly/start', (c) => {
  if (CALENDLY_CLIENT_ID === 'placeholder') {
    return c.json({ error: 'Calendly OAuth not configured yet — set CALENDLY_CLIENT_ID and CALENDLY_CLIENT_SECRET' }, 503);
  }

  const auth = requireCustomerMatch(c);
  if (auth.error) return auth.error;
  const { customerId } = auth;

  const state = signStateValue({ customerId, provider: 'calendly', ts: Date.now() });

  const authUrl = new URL('https://auth.calendly.com/oauth/authorize');
  authUrl.searchParams.set('client_id', CALENDLY_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', CALENDLY_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  // Calendly uses a single default scope — no scope param needed

  authUrl.searchParams.set('state', state);

  return c.redirect(authUrl.toString());
});

// ── GET /api/oauth/calendly/callback ───────────────────────────────────────
// Calendly redirects here after user grants permissions
oauthRoutes.get('/calendly/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.html(
      `<!DOCTYPE html><html><head><title>Connection Failed</title>
<style>body{background:#050508;color:#f0eeff;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center}
h2{color:#ff6b6b;font-size:1.5rem}.sub{color:#6b6b8a;font-size:14px}</style></head><body>
<div><h2>Calendly connection failed</h2>
<p class="sub">${error === 'access_denied' ? 'You declined the connection.' : 'Something went wrong.'}</p>
<p class="sub" style="margin-top:24px"><a href="/" style="color:#7c6bff">Go back</a></p></div></body></html>`,
      400
    );
  }

  const decoded = verifyAndConsumeState(stateParam);
  if (!decoded) {
    return c.json({ error: 'Invalid state parameter' }, 400);
  }

  if (decoded.provider !== 'calendly' || !decoded.customerId) {
    return c.json({ error: 'Invalid state: not a Calendly flow or missing customerId' }, 400);
  }

  const customerId = decoded.customerId;

  // Exchange code for tokens
  const tokenRes = await fetch('https://auth.calendly.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CALENDLY_CLIENT_ID,
      client_secret: CALENDLY_CLIENT_SECRET,
      redirect_uri: CALENDLY_REDIRECT_URI,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error('[oauth/calendly] Token exchange failed:', tokenData);
    return c.html(
      `<!DOCTYPE html><html><head><title>Failed</title>
<style>body{background:#050508;color:#f0eeff;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center}
h2{color:#ff6b6b;font-size:1.5rem}.sub{color:#6b6b8a;font-size:14px}</style></head><body>
<div><h2>Connection failed</h2><p class="sub">Could not connect to Calendly. Please try again.</p>
<p class="sub" style="margin-top:24px"><a href="/" style="color:#7c6bff">Go back</a></p></div></body></html>`,
      400
    );
  }

  // Get Calendly user URI
  let userUri = null;
  try {
    const meRes = await fetch('https://api.calendly.com/users/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const meData = await meRes.json();
    userUri = meData.resource?.uri || null;
  } catch (e) {
    console.warn('[oauth/calendly] Could not fetch user URI:', e.message);
  }

  // Store tokens — both customers table (backward compat) + customer_connectors
  if (supabaseOAuth) {
    const calendlyExpiry = new Date(Date.now() + (tokenData.expires_in || 7200) * 1000).toISOString();
    const encryptedAccess = encryptToken(tokenData.access_token);
    const encryptedRefresh = tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null;

    // 1. Backward compat: update customers table (C1: tokens removed — stored encrypted in customer_connectors)
    const { error: updateError } = await supabaseOAuth.from('customers').update({
      calendly_user_uri: userUri,
      calendly_token_expiry: calendlyExpiry,
      calendly_connected: true,
      connector_failures: {},
    }).eq('id', customerId);

    if (updateError) {
      console.error('[oauth/calendly] Failed to update customers table:', updateError.message);
    }

    // 2. Upsert into customer_connectors (encrypted)
    const calendlyConnector = {
      customer_id: customerId,
      connector_type: 'calendly',
      connector_account: null,
      access_token: encryptedAccess,
      token_expiry: calendlyExpiry,
      connector_user_id: userUri,
      connected: true,
      last_verified: new Date().toISOString(),
      consecutive_failures: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    };
    if (encryptedRefresh) calendlyConnector.refresh_token = encryptedRefresh;

    await supabaseOAuth.from('customer_connectors')
      .upsert(calendlyConnector, { onConflict: 'customer_id,connector_type,connector_account' })
      .catch(e => console.error('[oauth/calendly] Failed to upsert calendly connector:', e.message));

    console.log(`[oauth/calendly] Upserted calendly connector for customer ${customerId}`);
  }

  // Also store in local file for backward compat with Google token store
  const tokens = loadTokens();
  tokens[`calendly_${customerId}`] = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + (tokenData.expires_in || 7200) * 1000,
    userUri,
    connectedAt: new Date().toISOString(),
  };
  saveTokens(tokens);

  return c.html(`<!DOCTYPE html>
<html><head><title>Calendly Connected!</title>
<style>body{background:#050508;color:#f0eeff;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center}
h2{color:#10e87e;font-size:2rem;margin-bottom:8px}.sub{color:#6b6b8a;font-size:14px}
.features{text-align:left;max-width:320px;margin:20px auto}
.features li{margin:6px 0;color:#c0b8ff}</style>
</head><body>
<div><h2>\u2713 Calendly connected</h2>
<p class="sub">Your calendar is now linked to your OpenClaw instance.</p>
<ul class="features">
<li>\u{1F4CB} Prep briefs 30 min before each meeting</li>
<li>\u{2705} Post-meeting note prompts</li>
<li>\u{1F44B} No-show detection and follow-ups</li>
<li>\u{1F4C6} One-command scheduling links</li>
</ul>
<p class="sub" style="margin-top:24px">You can close this window.</p></div>
</body></html>`);
});

// ── GET /api/oauth/calendly/status?customerId=xxx ──────────────────────────
oauthRoutes.get('/calendly/status', async (c) => {
  const auth = requireCustomerMatch(c);
  if (auth.error) return auth.error;
  const { customerId } = auth;

  if (!supabaseOAuth) return c.json({ connected: false, reason: 'no_supabase' });

  const { data, error } = await supabaseOAuth
    .from('customers')
    .select('calendly_token, calendly_user_uri, calendly_token_expiry')
    .eq('id', customerId)
    .single();

  if (error || !data?.calendly_token) return c.json({ connected: false });

  const expired = data.calendly_token_expiry
    ? new Date(data.calendly_token_expiry) < new Date()
    : false;

  return c.json({
    connected: true,
    userUri: data.calendly_user_uri,
    expired,
  });
});
