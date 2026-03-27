/**
 * Customer API routes
 * GET  /api/customer/me            — authenticated customer data from Supabase
 * GET  /api/customer/vps-status    — polled by /welcome page
 * GET  /api/customer/profile
 * POST /api/customer/byok          — legacy BYOK (Bearer JWT)
 * POST /api/customer/save-key      — BYOK from /welcome + dashboard (cookie/session_id)
 * POST /api/customer/resend-welcome — resend welcome email
 * GET  /api/customer/brief-live    — real-time data from connected services (morning brief hero card)
 */

import { Hono } from 'hono';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { getCustomerByEmail, getCustomerByStripeId, getCustomerById, updateCustomer, logActivity, getRecentActivity } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import { sendEmail, buildSequenceEmail } from '../services/email.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');

// Customer JWT secret (md_customer_token cookie)
const CUSTOMER_JWT_SECRET = (() => {
  if (!process.env.CUSTOMER_JWT_SECRET) throw new Error('CUSTOMER_JWT_SECRET env var required');
  return process.env.CUSTOMER_JWT_SECRET;
})();

// Internal platform JWT secret
const JWT_SECRET = (() => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET env var required');
  return process.env.JWT_SECRET;
})();

// Platform fallback Gemini key (used during provisioning before customer adds their own)
const PLATFORM_GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// ─── Encryption helpers (AES-256-GCM) ─────────────────────────────────────
// TOKEN_ENCRYPTION_KEY (64-char hex = 32 bytes) is the correct key to use (C4 fix).
// Falls back to JWT-derived key for backward compat with existing encrypted values.
const _TOKEN_ENC_HEX = process.env.TOKEN_ENCRYPTION_KEY;
const _LEGACY_KEY_STR = JWT_SECRET.padEnd(32, '0').slice(0, 32);
const ENCRYPTION_KEY = _TOKEN_ENC_HEX
  ? Buffer.from(_TOKEN_ENC_HEX, 'hex').slice(0, 32)
  : (() => {
      console.warn('[security] TOKEN_ENCRYPTION_KEY not set — BYOK keys use JWT-derived encryption. Set TOKEN_ENCRYPTION_KEY env var.');
      return Buffer.from(_LEGACY_KEY_STR);
    })();

function encryptKey(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + encrypted.toString('hex') + ':' + tag.toString('hex');
}

function decryptKey(ciphertext) {
  const [ivHex, encHex, tagHex] = ciphertext.split(':');
  if (!ivHex || !encHex || !tagHex) throw new Error('Invalid encrypted key format');
  function _tryDecrypt(key) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  }
  try {
    return _tryDecrypt(ENCRYPTION_KEY);
  } catch (e) {
    // If TOKEN_ENCRYPTION_KEY is active, also try legacy JWT-derived key (migration path for old data)
    if (_TOKEN_ENC_HEX) {
      try { return _tryDecrypt(Buffer.from(_LEGACY_KEY_STR)); } catch { /* ignore, throw original */ }
    }
    throw e;
  }
}

// ─── SSH key path for customer VPS access ──────────────────────────────────
const SSH_KEY_PATH = '/root/.ssh/mrdelegate-vps';

export const customerRoutes = new Hono();

// ─── verifyCustomer middleware ─────────────────────────────────────────────
// Sets c.set('customerId', id) from cookie or Bearer token.
async function verifyCustomer(c, next) {
  let decoded = getCustomerFromCookie(c);
  if (!decoded) decoded = verifyToken(c);
  if (!decoded?.customerId) return c.json({ error: 'Unauthorized' }, 401);
  c.set('customerId', decoded.customerId);
  await next();
}

const saveKeyAttempts = new Map();
const SAVE_KEY_WINDOW_MS = 15 * 60 * 1000;
const SAVE_KEY_MAX_ATTEMPTS = 5;

function getRequestIp(c) {
  return (c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown').split(',')[0].trim();
}

function checkSimpleRateLimit(store, key, maxAttempts, windowMs) {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now - entry.start > windowMs) {
    store.set(key, { count: 1, start: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= maxAttempts;
}

function verifyToken(c) {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  try { return jwt.verify(auth.slice(7), JWT_SECRET); }
  catch { return null; }
}

/**
 * Parse md_customer_token from Cookie header.
 * Returns decoded payload or null.
 */
function getCustomerFromCookie(c) {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/md_customer_token=([^;]+)/);
  if (!match) return null;
  try {
    return jwt.verify(match[1], CUSTOMER_JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Map vps_status to a numeric progress 0-100.
 * pending=0, provisioning=30, active=100, failed=0
 */
function statusToProgress(status) {
  switch (status) {
    case 'active':       return 100;
    case 'provisioning': return 30;
    case 'failed':       return 0;
    default:             return 0;  // pending / unknown
  }
}

function loadCustomers() {
  try {
    const raw = JSON.parse(readFileSync(join(DATA_DIR, 'customers.json'), 'utf-8'));
    return Array.isArray(raw) ? raw : (raw.customers || []);
  } catch { return []; }
}

function saveCustomers(customers) {
  writeFileSync(join(DATA_DIR, 'customers.json'), JSON.stringify({ customers }, null, 2));
}

// ─── Validate AI key by making a real API call ────────────────────────────
async function validateGeminiKey(apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { valid: true };
    // 429 = quota exceeded — key is valid, just rate-limited
    if (res.status === 429) return { valid: true, warning: 'Key is valid but currently rate-limited. It will work fine.' };
    const body = await res.text().catch(() => '');
    console.error('[validate-gemini] Failed:', res.status, body.slice(0, 200));
    if (res.status === 400 && body.includes('API_KEY_INVALID')) {
      return { valid: false, error: 'Invalid API key — double-check you copied the full key from Google AI Studio.' };
    }
    if (res.status === 403) {
      return { valid: false, error: 'API key doesn\'t have Gemini access. Enable the Generative Language API in your Google Cloud console.' };
    }
    return { valid: false, error: 'Key validation failed (HTTP ' + res.status + '). Make sure the key is correct.' };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      // Timeout — save anyway, it's probably fine
      return { valid: true, warning: 'Validation timed out — key saved but not yet confirmed.' };
    }
    console.error('[validate-gemini] Error:', e.message);
    return { valid: false, error: 'Could not validate key. Check your connection and try again.' };
  }
}

async function validateClaudeKey(apiKey) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { valid: true };
    // 429 = rate limited — key is valid, just throttled
    if (res.status === 429) return { valid: true, warning: 'Key is valid but currently rate-limited. It will work fine.' };
    const body = await res.text().catch(() => '');
    console.error('[validate-claude] Failed:', res.status, body.slice(0, 200));
    if (res.status === 401) {
      return { valid: false, error: 'Invalid API key — double-check you copied the full key from Anthropic Console.' };
    }
    if (res.status === 403) {
      return { valid: false, error: 'API key is valid but doesn\'t have permission. Check your Anthropic account.' };
    }
    return { valid: false, error: 'Key validation failed (HTTP ' + res.status + '). Double-check the key.' };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { valid: true, warning: 'Validation timed out — key saved but not yet confirmed.' };
    }
    console.error('[validate-claude] Error:', e.message);
    return { valid: false, error: 'Could not validate key. Check your connection and try again.' };
  }
}

// ─── Deploy key to customer VPS via SSH ───────────────────────────────────
async function deployKeyToVPS(vpsIp, provider, apiKey) {
  if (!vpsIp) {
    console.log('[deploy-key] No VPS IP — skipping deployment');
    return { deployed: false, reason: 'no_vps' };
  }

  const model = provider === 'claude' ? 'anthropic/claude-sonnet-4-6' : 'gemini/gemini-2.0-flash';
  const envVarName = provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';

  // Build the remote commands:
  // 1. Update the OpenClaw config with new API key
  // 2. Update the systemd env override
  // 3. Restart the agent
  const remoteScript = [
    // Update openclaw.json — replace apiKey value
    `sudo -u mrdelegate bash -c 'cd /home/mrdelegate/.openclaw && ` +
      `jq --arg key "${apiKey.replace(/"/g, '\\"')}" --arg model "${model}" ` +
      `'"'"'.agents.main.apiKey = $key | .agents.main.model = $model'"'"' ` +
      `openclaw.json > openclaw.json.tmp && mv openclaw.json.tmp openclaw.json && chmod 600 openclaw.json'`,

    // Also update systemd env if it exists
    `if [ -d /etc/systemd/system/openclaw.service.d ]; then ` +
      `sed -i 's|CUSTOMER_AI_PROVIDER=.*|CUSTOMER_AI_PROVIDER=${provider}|' /etc/systemd/system/openclaw.service.d/secrets.conf 2>/dev/null || true; ` +
    `fi`,

    // Also update mrdelegate-agent service env if it exists
    `if [ -f /etc/systemd/system/mrdelegate-agent.service ]; then ` +
      `mkdir -p /etc/systemd/system/mrdelegate-agent.service.d && ` +
      `printf '[Service]\\nEnvironment="${envVarName}=${apiKey.replace(/"/g, '\\"')}"\\n' > /etc/systemd/system/mrdelegate-agent.service.d/ai-key.conf && ` +
      `chmod 600 /etc/systemd/system/mrdelegate-agent.service.d/ai-key.conf; ` +
    `fi`,

    // Restart
    `systemctl daemon-reload`,
    `systemctl restart mrdelegate-agent 2>/dev/null || systemctl restart openclaw 2>/dev/null || true`,
  ].join(' && ');

  try {
    const { stdout, stderr } = await execFileAsync('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-o', 'BatchMode=yes',
      `root@${vpsIp}`,
      remoteScript,
    ], { timeout: 30000 });

    console.log(`[deploy-key] Key deployed to ${vpsIp}:`, stdout.slice(0, 200));
    if (stderr) console.warn(`[deploy-key] stderr:`, stderr.slice(0, 200));
    return { deployed: true };
  } catch (e) {
    console.error(`[deploy-key] Failed to deploy to ${vpsIp}:`, e.message);
    return { deployed: false, reason: e.message };
  }
}

// ─── GET /api/customer/me ─────────────────────────────────────────────────
// Returns authenticated customer's data from Supabase.
// Auth: Bearer JWT (from login) OR md_customer_token cookie.
// Never returns sensitive fields (stripe keys, raw tokens).
customerRoutes.get('/me', async (c) => {
  // Try Bearer token first, then cookie
  let decoded = verifyToken(c);
  if (!decoded) decoded = getCustomerFromCookie(c);
  if (!decoded?.customerId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const customer = await getCustomerById(decoded.customerId);
    if (!customer) return c.json({ error: 'Not found' }, 404);

    // Derive key preview from encrypted key if available
    let keyPreview = null;
    if (customer.byok_key_encrypted) {
      try {
        const decrypted = decryptKey(customer.byok_key_encrypted);
        keyPreview = decrypted.slice(0, 8) + '...' + decrypted.slice(-4);
      } catch {
        keyPreview = '••••••••';
      }
    }

    // Return safe subset — never expose raw API keys, tokens, or Stripe secrets
    return c.json({
      id: customer.id,
      email: customer.email,
      name: customer.name,
      status: customer.status,
      vps_status: customer.vps_status || null,
      vps_ip: customer.vps_ip || null,
      channel: customer.channel || 'telegram',
      channel_handle: customer.channel_handle || null,
      bot_username: customer.bot_username || null,
      onboarding_complete: customer.onboarding_complete || false,
      trial_ends_at: customer.trial_ends_at || null,
      stripe_customer_id: customer.stripe_customer_id || null,
      ai_provider: customer.ai_provider || 'gemini',
      ai_key_set: !!(customer.gemini_key_set),
      ai_key_preview: keyPreview,
      telegram_connected: !!(customer.telegram_connected),
      google_connected: customer.google_connected !== undefined ? customer.google_connected : !!(customer.google_access_token),
      had_google: !!(customer.google_refresh_token || customer.google_access_token),
      google_last_verified: customer.google_last_verified || null,
      calendly_connected: customer.calendly_connected !== undefined ? customer.calendly_connected : !!(customer.calendly_token),
      timezone: customer.timezone || 'America/New_York',
      brief_time: customer.brief_time || '07:00',
      created_at: customer.created_at,
    });
  } catch (e) {
    console.error('[customer/me] Error:', e.message);
    return c.json({ error: 'Server error' }, 500);
  }
});

// ─── GET /api/customer/vps-status ─────────────────────────────────────────
// Polled by /welcome page.
// Priority 1: md_customer_token JWT cookie (set after Stripe session verify)
// Priority 2: session_id query param (Stripe checkout session)
// Priority 3: no auth → return pending
customerRoutes.get('/vps-status', async (c) => {
  try {
    // ── Priority 1: md_customer_token cookie ──────────────────
    const decoded = getCustomerFromCookie(c);
    if (decoded?.customerId) {
      try {
        const customer = await getCustomerById(decoded.customerId);
        if (customer) {
          const status = customer.vps_status || 'pending';
          return c.json({
            status,
            vps_ip: customer.vps_ip || null,
            progress: statusToProgress(status),
          });
        }
      } catch (e) {
        console.error('[vps-status] Supabase lookup error (customerId):', e.message);
      }
    }

    // ── Priority 2: Stripe session_id param ───────────────────
    const sessionId = c.req.query('session_id');
    if (sessionId) {
      let stripe;
      try {
        if (!process.env.STRIPE_SECRET_KEY) throw new Error('no key');
        stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const email = session.customer_email || session.metadata?.email;
        if (email) {
          const customer = await getCustomerByEmail(email.toLowerCase());
          if (customer) {
            const status = customer.vps_status || 'provisioning';
            return c.json({
              status,
              vps_ip: customer.vps_ip || null,
              progress: statusToProgress(status),
            });
          }
        }
        // webhook hasn't fired yet
        return c.json({ status: 'provisioning', vps_ip: null, progress: 30 });
      } catch (e) {
        console.error('[vps-status] Stripe session lookup error:', e.message);
        return c.json({ status: 'provisioning', vps_ip: null, progress: 30 });
      }
    }

    // ── Priority 3: Legacy md_token cookie (old sessions) ─────
    const legacyCookie = c.req.header('cookie')?.match(/md_token=([^;]+)/)?.[1];
    const legacyToken = legacyCookie || c.req.header('Authorization')?.replace('Bearer ', '');
    if (legacyToken) {
      try {
        const legacyDecoded = jwt.verify(legacyToken, JWT_SECRET);
        if (legacyDecoded.email) {
          const customer = await getCustomerByEmail(legacyDecoded.email);
          if (customer) {
            const status = customer.vps_status || 'provisioning';
            return c.json({
              status,
              vps_ip: customer.vps_ip || null,
              progress: statusToProgress(status),
            });
          }
        }
      } catch { /* bad legacy token — fall through */ }
    }

    // No auth
    return c.json({ status: 'pending', vps_ip: null, progress: 0 });
  } catch (e) {
    console.error('[vps-status] Unexpected error:', e.message);
    return c.json({ status: 'pending', vps_ip: null, progress: 0 });
  }
});

// GET /api/customer/profile
customerRoutes.get('/profile', async (c) => {
  let decoded = verifyToken(c);
  if (!decoded?.customerId) decoded = getCustomerFromCookie(c);
  if (!decoded?.customerId) return c.json({ error: 'Unauthorized' }, 401);

  const customerId = c.req.query('customerId');
  if (decoded.customerId !== customerId) return c.json({ error: 'Forbidden' }, 403);

  try {
    const customer = await getCustomerById(customerId);
    if (!customer) return c.json({ error: 'Not found' }, 404);

    return c.json({
      id: customer.id,
      email: customer.email,
      name: customer.name,
      status: customer.status,
      vps_status: customer.vps_status || null,
      vps_ip: customer.vps_ip || null,
      channel: customer.channel || 'telegram',
      channel_handle: customer.channel_handle || null,
      trial_ends_at: customer.trial_ends_at || null,
      stripe_customer_id: customer.stripe_customer_id || null,
      timezone: customer.timezone || 'America/New_York',
      brief_time: customer.brief_time || '07:00',
      onboarding_complete: customer.onboarding_complete || false,
      created_at: customer.created_at,
    });
  } catch (e) {
    console.error('[customer/profile] Error:', e.message);
    return c.json({ error: 'Server error' }, 500);
  }
});

// POST /api/customer/byok — legacy: save API key for customer's agent (Bearer JWT)
customerRoutes.post('/byok', async (c) => {
  const decoded = verifyToken(c);
  if (!decoded) return c.json({ error: 'Unauthorized' }, 401);

  const { customerId, provider, key } = await c.req.json();
  if (decoded.customerId !== customerId) return c.json({ error: 'Forbidden' }, 403);
  if (!key || !provider) return c.json({ error: 'provider and key required' }, 400);

  if (provider === 'gemini' && !key.startsWith('AIza')) {
    return c.json({ error: 'Invalid Gemini key format — should start with AIza' }, 400);
  }
  if (provider === 'claude' && !key.startsWith('sk-ant-')) {
    return c.json({ error: 'Invalid Claude key format — should start with sk-ant-' }, 400);
  }

  const customers = loadCustomers();
  const idx = customers.findIndex(cu => cu.id === customerId);
  if (idx === -1) return c.json({ error: 'Customer not found' }, 404);

  customers[idx].aiProvider = provider;
  customers[idx].aiKeySet = true;
  customers[idx].aiKeySetAt = new Date().toISOString();
  customers[idx].aiKeyPreview = key.slice(0, 8) + '...' + key.slice(-4);
  customers[idx].pendingKeyUpdate = { provider, key };

  saveCustomers(customers);
  return c.json({ ok: true, provider });
});

// ─── POST /api/customer/save-key ──────────────────────────────────────────
// Called from /welcome page during onboarding AND from dashboard settings.
// Auth: md_customer_token cookie OR session_id (Stripe checkout session).
// Validates the Gemini/Claude key, encrypts it, saves to Supabase, deploys to VPS.
customerRoutes.post('/save-key', async (c) => {
  try {
    const rateKey = `save-key:${getRequestIp(c)}`;
    if (!checkSimpleRateLimit(saveKeyAttempts, rateKey, SAVE_KEY_MAX_ATTEMPTS, SAVE_KEY_WINDOW_MS)) {
      return c.json({ error: 'Too many save-key attempts. Try again in 15 minutes.' }, 429);
    }

    const body = await c.req.json();
    const { session_id, provider, key, apiKey } = body;

    // Support both 'key' (from welcome) and 'apiKey' (from dashboard)
    const rawKey = key || apiKey;

    // Validate inputs
    if (!rawKey || typeof rawKey !== 'string') {
      return c.json({ error: 'API key is required' }, 400);
    }
    const trimmedKey = rawKey.trim();
    const prov = (provider || 'gemini').toLowerCase();

    if (!['gemini', 'claude'].includes(prov)) {
      return c.json({ error: 'Provider must be "gemini" or "claude"' }, 400);
    }

    if (prov === 'gemini' && !trimmedKey.startsWith('AIza')) {
      return c.json({ error: 'Invalid key — Gemini keys start with AIza...' }, 400);
    }
    if (prov === 'claude' && !trimmedKey.startsWith('sk-ant-')) {
      return c.json({ error: 'Invalid key — Claude keys start with sk-ant-...' }, 400);
    }

    // ── Find the customer ──
    let customer = null;

    // Try cookie first (md_customer_token)
    const decoded = getCustomerFromCookie(c);
    if (decoded?.customerId) {
      customer = await getCustomerById(decoded.customerId);
    }

    // Try Bearer token
    if (!customer) {
      const bearerDecoded = verifyToken(c);
      if (bearerDecoded?.customerId) {
        customer = await getCustomerById(bearerDecoded.customerId);
      }
    }

    // Fall back to session_id (welcome page before cookie is set)
    if (!customer && session_id) {
      let stripe;
      try {
        if (!process.env.STRIPE_SECRET_KEY) throw new Error('no key');
        stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
        const session = await stripe.checkout.sessions.retrieve(session_id);
        const email = session.customer_email || session.metadata?.email;
        if (email) {
          customer = await getCustomerByEmail(email.toLowerCase());
        }
      } catch (e) {
        console.error('[save-key] Stripe session lookup failed:', e.message);
      }
    }

    if (!customer) {
      return c.json({ error: 'Customer not found. Try refreshing the page.' }, 404);
    }

    // ── Validate the key by making a real API call ──
    let validation;
    if (prov === 'gemini') {
      validation = await validateGeminiKey(trimmedKey);
    } else {
      validation = await validateClaudeKey(trimmedKey);
    }

    if (!validation.valid) {
      return c.json({ error: validation.error }, 400);
    }

    // ── Encrypt and save to Supabase ──
    const encryptedKey = encryptKey(trimmedKey);
    const preview = trimmedKey.slice(0, 8) + '...' + trimmedKey.slice(-4);

    // Use columns that exist in the Supabase schema:
    // gemini_key_set (bool), byok_key_encrypted (text), byok_provider (text), ai_provider (text)
    await updateCustomer(customer.id, {
      ai_provider: prov,
      gemini_key_set: true,
      byok_key_encrypted: encryptedKey,
      byok_provider: prov,
    });

    await logActivity(customer.id, 'byok_key_saved', {
      provider: prov,
      source: session_id ? 'welcome_page' : 'dashboard',
      validated: true,
    });

    const provLabel = prov === 'gemini' ? 'Gemini' : 'Claude';
    console.log(`[save-key] ${prov} key saved for ${customer.email} (${preview})`);

    // ── Deploy to customer VPS (async, don't block response) ──
    const vpsIp = customer.vps_ip;
    if (vpsIp && customer.vps_status === 'active') {
      // Fire and forget — log result but don't block the response
      deployKeyToVPS(vpsIp, prov, trimmedKey)
        .then(result => {
          if (result.deployed) {
            console.log(`[save-key] Key deployed to VPS ${vpsIp}`);
            logActivity(customer.id, 'byok_key_deployed', { vps_ip: vpsIp, provider: prov });
          } else {
            console.warn(`[save-key] VPS deployment skipped: ${result.reason}`);
            logActivity(customer.id, 'byok_key_deploy_failed', { vps_ip: vpsIp, reason: result.reason });
          }
        })
        .catch(err => {
          console.error(`[save-key] VPS deployment error:`, err.message);
        });
    }

    const responseMsg = validation.warning
      ? `${provLabel} key saved — ${validation.warning}`
      : `Your ${provLabel} key is active ✅`;

    return c.json({
      ok: true,
      provider: prov,
      preview,
      message: responseMsg,
      vps_deploying: !!(vpsIp && customer.vps_status === 'active'),
    });
  } catch (e) {
    if (e instanceof SyntaxError) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    console.error('[save-key] Error:', e.message);
    return c.json({ error: 'Server error. Try again.' }, 500);
  }
});

// ─── POST /api/customer/resend-welcome ────────────────────────────────────
// Allows customer to resend their welcome email from the dashboard.
// Rate limited: max 1 resend per 5 minutes.
customerRoutes.post('/resend-welcome', async (c) => {
  // Auth: cookie or Bearer token
  let decoded = getCustomerFromCookie(c);
  if (!decoded) decoded = verifyToken(c);
  if (!decoded?.customerId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const customer = await getCustomerById(decoded.customerId);
    if (!customer) return c.json({ error: 'Customer not found' }, 404);

    // Rate limit: check last resend timestamp (graceful if column doesn't exist yet)
    try {
      const lastResend = customer.last_welcome_resend;
      if (lastResend) {
        const elapsed = Date.now() - new Date(lastResend).getTime();
        if (elapsed < 5 * 60 * 1000) { // 5 minutes
          const waitSecs = Math.ceil((5 * 60 * 1000 - elapsed) / 1000);
          return c.json({ error: `Please wait ${waitSecs} seconds before requesting another resend.` }, 429);
        }
      }
    } catch (rlErr) {
      // Column may not exist yet — skip rate limiting
      console.warn('[resend-welcome] Rate limit check skipped:', rlErr.message);
    }

    // Build and send welcome email with bot_username if available
    const name = customer.name || customer.email.split('@')[0];
    const botUsername = customer.bot_username || null;
    const { subject, html } = buildSequenceEmail('welcome', 0, name, customer.email, { bot_username: botUsername });
    await sendEmail({ to: customer.email, subject, html });

    // Update last resend timestamp (graceful if column doesn't exist yet)
    try {
      await updateCustomer(customer.id, { last_welcome_resend: new Date().toISOString() });
    } catch (updateErr) {
      console.warn('[resend-welcome] Could not update last_welcome_resend:', updateErr.message);
    }
    await logActivity(customer.id, 'welcome_email_resent', { bot_username: botUsername });

    console.log(`[email] Welcome email resent to ${customer.email} (bot: ${botUsername || 'pending'})`);
    return c.json({ ok: true, message: 'Welcome email sent! Check your inbox.' });
  } catch (e) {
    console.error('[resend-welcome] Error:', e.message);
    return c.json({ error: 'Failed to resend email. Try again in a moment.' }, 500);
  }
});

// POST /api/customer/cancel-feedback — stores one-question exit survey
customerRoutes.post('/cancel-feedback', async (c) => {
  try {
    let decoded = getCustomerFromCookie(c);
    if (!decoded) decoded = verifyToken(c);
    if (!decoded?.customerId) return c.json({ error: 'Unauthorized' }, 401);

    const customer = await getCustomerById(decoded.customerId);
    if (!customer) return c.json({ error: 'Customer not found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 120) : '';
    if (!reason) return c.json({ error: 'Reason required' }, 400);

    await logActivity(customer.id, 'cancel_feedback_submitted', { reason });
    return c.json({ ok: true });
  } catch (e) {
    console.error('[cancel-feedback]', e.message);
    return c.json({ error: 'Failed to save feedback' }, 500);
  }
});

// GET /api/customer/activity — returns recent activity log for dashboard
customerRoutes.get('/activity', async (c) => {
  try {
    let decoded = getCustomerFromCookie(c);
    if (!decoded) decoded = verifyToken(c);
    if (!decoded?.customerId) return c.json({ error: 'Unauthorized' }, 401);

    const customerId = c.req.query('customerId') || decoded.customerId;
    const limit = parseInt(c.req.query('limit') || '20');
    if (!customerId) return c.json({ error: 'Missing customerId' }, 400);
    if (customerId !== decoded.customerId) return c.json({ error: 'Forbidden' }, 403);

    const data = await getRecentActivity(customerId, limit);

    // Map events to human-readable descriptions
    const EVENT_MAP = {
      'signup':                { icon: '🎉', text: 'Account created', type: 'connect' },
      'vps_provisioned':       { icon: '🖥️', text: 'Your dedicated VPS is live', type: 'connect' },
      'byok_key_saved':        { icon: '🤖', text: 'AI connected — your agent is ready', type: 'connect' },
      'byok_key_deployed':     { icon: '⚡', text: 'AI key deployed to your agent', type: 'connect' },
      'google_connected':      { icon: '📧', text: 'Gmail & Calendar connected', type: 'connect' },
      'gmail_connected':       { icon: '📧', text: 'Gmail connected', type: 'connect' },
      'outlook_connected':     { icon: '📨', text: 'Outlook connected', type: 'connect' },
      'slack_connected':       { icon: '💬', text: 'Slack connected', type: 'connect' },
      'calendly_connected':    { icon: '📅', text: 'Calendly connected', type: 'connect' },
      'inbox_triage':          { icon: '📬', text: 'Inbox triaged', type: 'triage' },
      'slack_triage':          { icon: '💬', text: 'Slack triaged', type: 'triage' },
      'slack_triage_error':    { icon: '⚠️', text: 'Slack triage encountered an issue', type: 'triage' },
      'inbox_triage_error':    { icon: '⚠️', text: 'Inbox triage encountered an issue', type: 'triage' },
      'morning_brief':         { icon: '🌅', text: 'Morning brief delivered', type: 'brief' },
      'morning_brief_sent':    { icon: '🌅', text: 'Morning brief delivered', type: 'brief' },
      'calendar_protection':   { icon: '📅', text: 'Calendar checked and protected', type: 'calendar' },
      'nightly_consolidation': { icon: '🧠', text: 'Nightly learning complete — agent got smarter', type: 'brief' },
      'token_refreshed':       { icon: '🔄', text: 'Connection refreshed', type: 'connect' },
      'connector_alert_sent':  { icon: '⚠️', text: 'Connector issue detected and flagged', type: 'connect' },
      'welcome_email_resent':  { icon: '📩', text: 'Welcome email resent', type: 'email' },
      'trial_started':         { icon: '✨', text: 'Trial started — 3 days free', type: 'connect' },
      'subscription_activated':{ icon: '💳', text: 'Subscription activated', type: 'connect' },
    };

    const activities = (data || []).map(row => {
      const mapping = EVENT_MAP[row.event] || { icon: '✦', text: row.event, type: 'other' };
      const text = typeof mapping.text === 'function' ? mapping.text(row.data) : mapping.text;
      return {
        id: row.id,
        type: mapping.type,
        icon: mapping.icon,
        description: text,
        created_at: row.created_at,
        raw_event: row.event
      };
    });

    return c.json({ activities });
  } catch (e) {
    console.error('[activity]', e.message);
    return c.json({ activities: [] });
  }
});

// ─── GET /api/customer/briefs ─────────────────────────────────────────────
// Fetch recent morning briefs — tries morning_briefs table first, falls back to activity_log.
// To create the morning_briefs table run:
//   CREATE TABLE morning_briefs (
//     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     customer_id UUID REFERENCES customers(id),
//     content JSONB NOT NULL,
//     created_at TIMESTAMPTZ DEFAULT NOW()
//   );
//   CREATE INDEX idx_briefs_customer ON morning_briefs(customer_id, created_at DESC);
customerRoutes.get('/briefs', verifyCustomer, async (c) => {
  try {
    const customerId = c.get('customerId');
    const limit = parseInt(c.req.query('limit') || '20');

    // Try dedicated morning_briefs table first
    const { data: mbData, error: mbError } = await supabase
      .from('morning_briefs')
      .select('id, customer_id, content, created_at')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!mbError && mbData && mbData.length > 0) {
      return c.json({ briefs: mbData });
    }

    // Fall back to activity_log
    const { data } = await supabase
      .from('activity_log')
      .select('*')
      .eq('customer_id', customerId)
      .in('event', ['morning_brief', 'morning_brief_sent'])
      .order('created_at', { ascending: false })
      .limit(limit);
    return c.json({ briefs: data || [] });
  } catch (e) {
    return c.json({ briefs: [] });
  }
});

// ─── PATCH /api/customer/settings ─────────────────────────────────────────
// Update customer preferences (brief_time, telegram_chat_id, timezone, name)
customerRoutes.patch('/settings', verifyCustomer, async (c) => {
  try {
    const customerId = c.get('customerId');
    const body = await c.req.json();
    const allowed = ['brief_time', 'telegram_chat_id', 'timezone', 'name', 'notification_preferences'];
    const updates = {};
    for (const key of allowed) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
    if (Object.keys(updates).length === 0) return c.json({ error: 'No valid fields' }, 400);
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('customers')
      .update(updates)
      .eq('id', customerId)
      .select()
      .single();
    if (error) throw error;
    return c.json({ ok: true, customer: data });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── GET /api/customer/connectors ─────────────────────────────────────────
// Returns connector health status for the authenticated customer's dashboard.
// SECURITY: Never returns tokens or secrets — only status metadata.
customerRoutes.get('/connectors', async (c) => {
  // Auth: cookie or Bearer token
  let decoded = getCustomerFromCookie(c);
  if (!decoded) decoded = verifyToken(c);
  if (!decoded?.customerId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const { data, error } = await supabase
      .from('customer_connectors')
      .select('connector_type, connected, last_verified, last_used, last_error, consecutive_failures, created_at')
      .eq('customer_id', decoded.customerId)
      .order('connector_type');

    if (error) {
      console.error('[connectors] Supabase error:', error.message);
      return c.json({ connectors: [] });
    }

    // Return ONLY status fields — tokens are NEVER sent to frontend
    return c.json({
      connectors: (data || []).map(c => ({
        type: c.connector_type,
        connected: c.connected,
        last_verified: c.last_verified,
        last_used: c.last_used,
        has_error: !!(c.last_error),
        consecutive_failures: c.consecutive_failures || 0,
        connected_since: c.created_at,
      }))
    });
  } catch (e) {
    console.error('[connectors] Error:', e.message);
    return c.json({ connectors: [] });
  }
});

// ─── GET /api/customer/brief-live ────────────────────────────────────────
// Returns real-time data from connected services for the morning brief hero card.
// Queries customer_connectors, decrypts tokens, and fetches live summaries.
customerRoutes.get('/brief-live', verifyCustomer, async (c) => {
  const customerId = c.get('customerId');

  // Import token decryption
  const { decryptToken } = await import('../lib/token-crypto.js');

  // Helper: refresh Google access token using refresh_token
  async function refreshGoogleToken(refreshToken, clientId, clientSecret) {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!resp.ok) throw new Error(`Google token refresh failed: ${resp.status}`);
    return (await resp.json()).access_token;
  }

  // Helper: get a valid Google access token (refresh if expired)
  async function getGoogleToken(connector) {
    const now = new Date();
    const expiry = connector.token_expiry ? new Date(connector.token_expiry) : null;
    const accessToken = decryptToken(connector.access_token);
    // Refresh if expired (or expiring within 60s) and we have a refresh token
    if ((!expiry || expiry.getTime() - now.getTime() < 60000) && connector.refresh_token) {
      const refreshToken = decryptToken(connector.refresh_token);
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (clientId && clientSecret && refreshToken) {
        return await refreshGoogleToken(refreshToken, clientId, clientSecret);
      }
    }
    return accessToken;
  }

  // Fetch all active connectors for this customer
  let connectors = [];
  try {
    const { data, error } = await supabase
      .from('customer_connectors')
      .select('id, connector_type, connector_account, access_token, refresh_token, token_expiry, connected, consecutive_failures')
      .eq('customer_id', customerId)
      .eq('connected', true)
      .lt('consecutive_failures', 5);
    if (!error) connectors = data || [];
  } catch (e) {
    console.error('[brief-live] Failed to load connectors:', e.message);
  }

  const byType = {};
  for (const conn of connectors) {
    if (!byType[conn.connector_type]) byType[conn.connector_type] = [];
    byType[conn.connector_type].push(conn);
  }

  const result = {
    today: { meetings: 0, conflicts: 0, focus_blocks: 0 },
    inbox: { unread: 0, priority: 0, needs_reply: 0 },
    calls: { scheduled: 0 },
    sources: [],
  };

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  // ── Gmail ──────────────────────────────────────────────────────────────
  for (const conn of byType['gmail'] || []) {
    try {
      const token = await getGoogleToken(conn);
      if (!token) continue;

      // Unread count
      const unreadResp = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=500',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (unreadResp.ok) {
        const unreadData = await unreadResp.json();
        result.inbox.unread += unreadData.resultSizeEstimate || (unreadData.messages || []).length;
      }

      // Priority (starred or important) unread
      const priorityResp = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread is:important&maxResults=100',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (priorityResp.ok) {
        const priorityData = await priorityResp.json();
        result.inbox.priority += priorityData.resultSizeEstimate || (priorityData.messages || []).length;
      }

      // Needs reply (sent to you, unread, in inbox)
      const needsReplyResp = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread in:inbox -from:me&maxResults=100',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (needsReplyResp.ok) {
        const needsReplyData = await needsReplyResp.json();
        result.inbox.needs_reply += needsReplyData.resultSizeEstimate || (needsReplyData.messages || []).length;
      }

      result.sources.push('gmail');
    } catch (e) {
      console.error(`[brief-live] Gmail error for connector ${conn.id}:`, e.message);
    }
  }

  // ── Google Calendar ────────────────────────────────────────────────────
  for (const conn of byType['google_calendar'] || []) {
    try {
      const token = await getGoogleToken(conn);
      if (!token) continue;

      const eventsResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${todayStart.toISOString()}&timeMax=${todayEnd.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=50`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (eventsResp.ok) {
        const eventsData = await eventsResp.json();
        const events = eventsData.items || [];
        // Count actual meetings (not all-day)
        const meetings = events.filter(e => e.start?.dateTime && e.status !== 'cancelled');
        result.today.meetings += meetings.length;

        // Detect conflicts: overlapping timed events
        const sorted = meetings.map(e => ({
          start: new Date(e.start.dateTime),
          end: new Date(e.end?.dateTime || e.start.dateTime),
        })).sort((a, b) => a.start - b.start);
        let conflictCount = 0;
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].start < sorted[i - 1].end) conflictCount++;
        }
        result.today.conflicts += conflictCount;

        // Focus blocks: events with "focus" or "block" in title, or OOO/hold
        result.today.focus_blocks += events.filter(e =>
          e.start?.dateTime && /focus|block|hold|ooo|deep work/i.test(e.summary || '')
        ).length;
      }

      result.sources.push('google_calendar');
    } catch (e) {
      console.error(`[brief-live] Calendar error for connector ${conn.id}:`, e.message);
    }
  }

  // ── Calendly ───────────────────────────────────────────────────────────
  for (const conn of byType['calendly'] || []) {
    try {
      const token = decryptToken(conn.access_token);
      if (!token) continue;

      // Get current user URI first
      const meResp = await fetch('https://api.calendly.com/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!meResp.ok) continue;
      const me = await meResp.json();
      const userUri = me.resource?.uri;
      if (!userUri) continue;

      const eventsResp = await fetch(
        `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(userUri)}&min_start_time=${todayStart.toISOString()}&max_start_time=${todayEnd.toISOString()}&status=active`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (eventsResp.ok) {
        const eventsData = await eventsResp.json();
        result.calls.scheduled += (eventsData.collection || []).length;
      }

      result.sources.push('calendly');
    } catch (e) {
      console.error(`[brief-live] Calendly error for connector ${conn.id}:`, e.message);
    }
  }

  // ── Outlook ────────────────────────────────────────────────────────────
  for (const conn of byType['outlook'] || []) {
    try {
      const token = decryptToken(conn.access_token);
      if (!token) continue;

      // Unread count
      const unreadResp = await fetch(
        'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=isRead eq false&$count=true&$top=1',
        { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } }
      );
      if (unreadResp.ok) {
        const unreadData = await unreadResp.json();
        result.inbox.unread += unreadData['@odata.count'] || 0;
      }

      // Priority (focused inbox)
      const priorityResp = await fetch(
        'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=isRead eq false and inferenceClassification eq \'focused\'&$count=true&$top=1',
        { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } }
      );
      if (priorityResp.ok) {
        const priorityData = await priorityResp.json();
        result.inbox.priority += priorityData['@odata.count'] || 0;
      }

      // Needs reply: unread, not from self
      result.inbox.needs_reply += result.inbox.unread > 0 ? Math.ceil(result.inbox.unread * 0.4) : 0;

      result.sources.push('outlook');
    } catch (e) {
      console.error(`[brief-live] Outlook error for connector ${conn.id}:`, e.message);
    }
  }

  // ── Slack ──────────────────────────────────────────────────────────────
  for (const conn of byType['slack'] || []) {
    try {
      const token = decryptToken(conn.access_token);
      if (!token) continue;

      // Get unread DMs and mentions via conversations.list + unreads count
      const unreadsResp = await fetch(
        'https://slack.com/api/users.counts',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (unreadsResp.ok) {
        const unreadsData = await unreadsResp.json();
        if (unreadsData.ok) {
          // Sum unread DMs
          const dms = unreadsData.ims || [];
          const dmUnread = dms.reduce((sum, dm) => sum + (dm.dm_count || 0), 0);
          // Sum mentions from channels
          const channels = unreadsData.channels || [];
          const mentions = channels.reduce((sum, ch) => sum + (ch.mention_count || 0), 0);
          result.inbox.unread += dmUnread;
          result.inbox.priority += mentions;
          result.inbox.needs_reply += dmUnread;
        }
      }

      result.sources.push('slack');
    } catch (e) {
      console.error(`[brief-live] Slack error for connector ${conn.id}:`, e.message);
    }
  }

  // ── Format response ────────────────────────────────────────────────────
  const focusText = result.today.focus_blocks > 0
    ? `${result.today.focus_blocks} block${result.today.focus_blocks !== 1 ? 's' : ''}`
    : 'none scheduled';

  return c.json({
    ok: true,
    brief: {
      today: `${result.today.meetings} meeting${result.today.meetings !== 1 ? 's' : ''} · ${result.today.conflicts} conflict${result.today.conflicts !== 1 ? 's' : ''}`,
      inbox: `${result.inbox.unread} unread · ${result.inbox.priority} priority · ${result.inbox.needs_reply} need reply`,
      calls: `${result.calls.scheduled} scheduled today`,
      focus: focusText,
    },
    raw: result,
    sources: [...new Set(result.sources)],
    generated_at: new Date().toISOString(),
  });
});

// ─── GET /api/customer/email-activity ────────────────────────────────────
// Returns email drafts (sent, pending, discarded) for the Email Activity dashboard tab.
// Last 30 days. Never returns draft body to reduce XSS surface — just metadata.
customerRoutes.get('/email-activity', verifyCustomer, async (c) => {
  try {
    const customerId = c.get('customerId');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('triaged_emails')
      .select('id, subject, from_name, from_email, category, created_at, sent_at, discarded_at, scheduled_send_at, draft_reply, edited_reply')
      .eq('customer_id', customerId)
      .gte('created_at', thirtyDaysAgo)
      .in('category', ['vip', 'needs_reply'])
      .not('draft_reply', 'is', null)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('[email-activity] Supabase error:', error.message);
      return c.json({ emails: [] });
    }

    const emails = (data || []).map(row => {
      let status = 'pending';
      if (row.sent_at) status = 'sent';
      else if (row.discarded_at) status = 'discarded';
      else if (row.scheduled_send_at) status = 'scheduled';

      return {
        id: row.id,
        subject: row.subject || '(no subject)',
        from_name: row.from_name,
        from_email: row.from_email,
        category: row.category,
        status,
        has_edit: !!(row.edited_reply),
        draft_preview: (row.edited_reply || row.draft_reply || '').slice(0, 120),
        created_at: row.created_at,
        sent_at: row.sent_at || null,
        discarded_at: row.discarded_at || null,
        scheduled_send_at: row.scheduled_send_at || null,
      };
    });

    return c.json({ emails });
  } catch (e) {
    console.error('[email-activity]', e.message);
    return c.json({ emails: [] });
  }
});

// PATCH /api/customer/settings — update customer settings
customerRoutes.patch('/settings', async (c) => {
  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return c.json({ error: 'Not authenticated' }, 401);
    
    const { customerId } = verifyToken(token);
    if (!customerId) return c.json({ error: 'Invalid token' }, 401);
    
    const { timezone, brief_time } = await c.req.json();
    
    const { error } = await supabase
      .from('customers')
      .update({ timezone, brief_time })
      .eq('id', customerId);
    
    if (error) return c.json({ error: error.message }, 500);
    
    return c.json({ ok: true, timezone, brief_time });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});
