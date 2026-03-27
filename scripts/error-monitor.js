// Error Monitor - Watches platform logs and alerts on patterns
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_TELEGRAM_CHAT_ID || '262207319';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Track error patterns
const errorPatterns = {
  'supabase': { count: 0, lastSeen: null, threshold: 3 },
  'oauth': { count: 0, lastSeen: null, threshold: 2 },
  'stripe': { count: 0, lastSeen: null, threshold: 1 },
  'vultr': { count: 0, lastSeen: null, threshold: 2 },
  '502': { count: 0, lastSeen: null, threshold: 1 },
  '500': { count: 0, lastSeen: null, threshold: 3 },
};

async function sendAlert(message) {
  if (!TELEGRAM_BOT) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: `🚨 ERROR ALERT\n\n${message}`, parse_mode: 'HTML' })
  });
}

async function logError(type, message, stack) {
  await supabase.from('error_log').insert({
    error_type: type,
    message: message.slice(0, 500),
    stack: stack?.slice(0, 2000),
    created_at: new Date().toISOString()
  }).catch(() => {});
  
  // Check threshold
  if (errorPatterns[type]) {
    errorPatterns[type].count++;
    errorPatterns[type].lastSeen = Date.now();
    
    if (errorPatterns[type].count >= errorPatterns[type].threshold) {
      await sendAlert(`${type.toUpperCase()} errors: ${errorPatterns[type].count}x in last hour\n\nLatest: ${message}`);
      errorPatterns[type].count = 0; // Reset after alert
    }
  }
}

export { logError, sendAlert };
