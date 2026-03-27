#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || (() => { throw new Error('SUPABASE_URL not set'); })();
const KEY = process.env.SUPABASE_SERVICE_KEY || (() => { throw new Error('SUPABASE_SERVICE_KEY not set'); })();

const supabase = createClient(URL, KEY);

// Execute SQL via Supabase's SQL API
async function sql(query) {
  const res = await fetch(`${URL}/rest/v1/rpc/exec`, {
    method: 'POST',
    headers: {
      'apikey': KEY,
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  return res;
}

// Tables to create one by one
const statements = [
  // customers
  `CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT,
    status TEXT DEFAULT 'trial',
    plan TEXT DEFAULT 'starter',
    trial_ends_at TIMESTAMPTZ,
    channel TEXT DEFAULT 'telegram',
    channel_id TEXT,
    ai_provider TEXT DEFAULT 'gemini',
    byok_key_encrypted TEXT,
    byok_provider TEXT,
    vps_id TEXT,
    vps_ip TEXT,
    vps_status TEXT DEFAULT 'pending',
    vps_region TEXT DEFAULT 'ewr',
    onboarding_complete BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // magic_tokens
  `CREATE TABLE IF NOT EXISTS magic_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // oauth_tokens
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    expires_at TIMESTAMPTZ,
    scope TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(customer_id, provider)
  )`,
  // email_queue
  `CREATE TABLE IF NOT EXISTS email_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    to_email TEXT NOT NULL,
    template TEXT NOT NULL,
    subject TEXT,
    data JSONB DEFAULT '{}',
    status TEXT DEFAULT 'pending',
    scheduled_for TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // vps_fleet
  `CREATE TABLE IF NOT EXISTS vps_fleet (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    vultr_id TEXT UNIQUE,
    ip TEXT,
    hostname TEXT,
    region TEXT DEFAULT 'ewr',
    plan TEXT DEFAULT 'vc2-2c-4gb',
    status TEXT DEFAULT 'pending',
    openclaw_version TEXT,
    last_health_check TIMESTAMPTZ,
    health_status JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // activity_log
  `CREATE TABLE IF NOT EXISTS activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // waitlist
  `CREATE TABLE IF NOT EXISTS waitlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    source TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // subscriptions
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    stripe_subscription_id TEXT NOT NULL,
    status TEXT NOT NULL,
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
];

// Use supabase-js to insert test and verify tables exist
// Since we can't run raw DDL via REST, use the pg endpoint
async function createViaAPI(stmt) {
  const res = await fetch(`${URL}/pg/query`, {
    method: 'POST',
    headers: {
      'apikey': KEY,
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: stmt }),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

// Try inserting into customers to verify it exists
const { data, error } = await supabase.from('customers').select('count').limit(1);
if (error && error.code === '42P01') {
  console.log('Tables do not exist yet — need to create via Supabase dashboard SQL editor');
  console.log('\nCopy this SQL into Supabase Dashboard → SQL Editor → Run:\n');
  console.log(statements.join(';\n\n') + ';');
} else if (error) {
  console.log('Error:', error.message);
} else {
  console.log('✅ Tables already exist! Customer count:', data);
}
