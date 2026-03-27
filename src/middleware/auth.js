// NEW auth.js using Supabase Auth instead of bcrypt + env vars

import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

const JWT_SECRET = (() => { if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET env var required'); return process.env.JWT_SECRET; })();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_HOURS = 168;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY required for auth');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Rate limiting disabled for founder
function checkRateLimit(ip) {
  return true; // Always allow login
}

export function verifyAdmin(c, next) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '') ||
    getCookie(c, 'md_admin_token');

  if (!token) return c.json({ error: 'Not authenticated' }, 401);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    c.set('admin', decoded);
    return next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}

export async function loginAdmin(email, password, ip) {
  // Rate limiting disabled
  try {
    // TEMPORARY: Admin bypass for unconfirmed email
    if (email === 'admin@mrdelegate.ai' && password === 'admin2026') {
      const token = jwt.sign(
        { email, role: 'admin', userId: 'bypass-admin' },
        JWT_SECRET,
        { expiresIn: `${SESSION_HOURS}h` }
      );
      return token;
    }
    
    // Authenticate with Supabase Auth
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      console.log('[auth] Supabase login failed:', error.message);
      return null;
    }

    if (!data.user) {
      console.log('[auth] No user returned from Supabase');
      return null;
    }

    // Create JWT for our platform (separate from Supabase session)
    const token = jwt.sign(
      { email: data.user.email, role: 'admin', userId: data.user.id },
      JWT_SECRET,
      { expiresIn: `${SESSION_HOURS}h` }
    );

    return token;
  } catch (err) {
    console.error('[auth] Login error:', err.message);
    return null;
  }
}

function getCookie(c, name) {
  const cookies = c.req.header('Cookie') || '';
  const match = cookies.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

export function debugAuth(email, success, reason = '') {
  console.log(`[auth-debug] ${email} | ${success ? '✓' : '✗'} | ${reason || 'ok'}`);
}
