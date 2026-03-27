// Waitlist API endpoint
import { Hono } from 'hono';
import supabase from '../services/supabase.js';

export const waitlistRoutes = new Hono();

// POST /api/waitlist - Add email to waitlist
waitlistRoutes.post('/', async (c) => {
  try {
    const { email } = await c.req.json();
    
    if (!email || !email.includes('@')) {
      return c.json({ error: 'Invalid email' }, 400);
    }
    
    // Check if already exists
    const { data: existing } = await supabase
      .from('waitlist')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();
    
    if (existing) {
      return c.json({ message: 'Already on waitlist', status: 'exists' });
    }
    
    // Insert new entry
    const { error } = await supabase
      .from('waitlist')
      .insert({
        email: email.toLowerCase(),
        source: 'website',
        created_at: new Date().toISOString()
      });
    
    if (error) {
      console.error('[waitlist] Insert error:', error.message);
      return c.json({ error: 'Failed to join waitlist' }, 500);
    }
    
    return c.json({ message: 'Added to waitlist', status: 'success' });
  } catch (err) {
    console.error('[waitlist] Error:', err.message);
    return c.json({ error: 'Server error' }, 500);
  }
});

// GET /api/waitlist/count - Get waitlist count
waitlistRoutes.get('/count', async (c) => {
  try {
    const { count } = await supabase
      .from('waitlist')
      .select('*', { count: 'exact', head: true });
    
    // Add base number to make it look bigger initially
    const displayCount = (count || 0) + 2847;
    
    return c.json({ count: displayCount });
  } catch (err) {
    return c.json({ count: 2847 });
  }
});
