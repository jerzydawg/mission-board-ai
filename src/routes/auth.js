import { Hono } from 'hono';
import { loginAdmin } from '../middleware/auth.js';

export const authRoutes = new Hono();

// Login endpoint — sets httpOnly cookie on success
authRoutes.post('/login', async (c) => {
  const { email, password } = await c.req.json();
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  const result = loginAdmin(email, password, ip);
  if (!result) return c.json({ error: 'Invalid credentials' }, 401);
  if (result && result.error === 'rate_limited') return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);

  const token = result;
  // Set httpOnly cookie — browser sends automatically on every request
  c.header('Set-Cookie', `md_admin_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`);
  return c.json({ token, email });
});

// Logout
authRoutes.post('/logout', (c) => {
  c.header('Set-Cookie', 'md_admin_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  return c.json({ ok: true });
});
