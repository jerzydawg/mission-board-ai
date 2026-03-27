// Clear rate limit for admin login
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Test login
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'jerzydawgg@gmail.com',
  password: 'mary123'
});

if (error) {
  console.log('Error:', error.message);
} else {
  console.log('✅ Login works - user:', data.user.email);
}
