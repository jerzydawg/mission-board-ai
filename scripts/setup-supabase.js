#!/usr/bin/env node
// Setup Supabase schema for MrDelegate
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || (() => { throw new Error('SUPABASE_URL not set'); })();
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || (() => { throw new Error('SUPABASE_SERVICE_KEY not set'); })();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const schema = `
-- Customers
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  status TEXT DEFAULT 'trial' CHECK (status IN ('trial','active','cancelled','past_due')),
  plan TEXT DEFAULT 'starter',
  trial_ends_at TIMESTAMPTZ,
  channel TEXT DEFAULT 'telegram' CHECK (channel IN ('telegram','discord','whatsapp','slack')),
  channel_id TEXT,
  ai_provider TEXT DEFAULT 'gemini' CHECK (ai_provider IN ('gemini','claude')),
  byok_key_encrypted TEXT,
  byok_provider TEXT,
  vps_id TEXT,
  vps_ip TEXT,
  vps_status TEXT DEFAULT 'pending' CHECK (vps_status IN ('pending','provisioning','active','suspended','terminated')),
  vps_region TEXT DEFAULT 'ewr',
  onboarding_complete BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subscriptions log
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Magic link tokens
CREATE TABLE IF NOT EXISTS magic_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- OAuth tokens
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','notion','slack','hubspot','linear','github')),
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  scope TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, provider)
);

-- Email queue
CREATE TABLE IF NOT EXISTS email_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  template TEXT NOT NULL,
  subject TEXT,
  data JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  scheduled_for TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- VPS fleet
CREATE TABLE IF NOT EXISTS vps_fleet (
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
);

-- Activity log
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Waitlist
CREATE TABLE IF NOT EXISTS waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- NJ Electric leads
CREATE TABLE IF NOT EXISTS nj_electric_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  service TEXT,
  message TEXT,
  status TEXT DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','converted','closed')),
  contacted_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_stripe ON customers(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_token ON magic_tokens(token);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);
CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue(status);
CREATE INDEX IF NOT EXISTS idx_activity_log_customer ON activity_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_customer ON oauth_tokens(customer_id);
CREATE INDEX IF NOT EXISTS idx_nj_electric_leads_created_at ON nj_electric_leads(created_at);
CREATE INDEX IF NOT EXISTS idx_nj_electric_leads_status ON nj_electric_leads(status);
CREATE INDEX IF NOT EXISTS idx_nj_electric_leads_email ON nj_electric_leads(email);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER oauth_tokens_updated_at
  BEFORE UPDATE ON oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER vps_fleet_updated_at
  BEFORE UPDATE ON vps_fleet
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER nj_electric_leads_updated_at
  BEFORE UPDATE ON nj_electric_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Cleanup expired magic tokens (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
RETURNS void AS $$
BEGIN
  DELETE FROM magic_tokens WHERE expires_at < NOW() OR used = TRUE AND created_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;
`;

console.log('Creating Supabase schema...');

// Execute via REST API since supabase-js doesn't support raw DDL directly
const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
  method: 'POST',
  headers: {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ sql: schema }),
});

// Use the management API instead
const mgmtResponse = await fetch(`https://api.supabase.com/v1/projects/mwsvekxgkjlmbglargmg/database/query`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: schema }),
});

if (mgmtResponse.ok) {
  console.log('✅ Schema created successfully');
} else {
  const err = await mgmtResponse.text();
  console.log('Management API response:', mgmtResponse.status, err);
  console.log('Will use direct PostgreSQL connection instead...');
}
