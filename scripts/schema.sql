-- MrDelegate — Supabase Schema
-- Run this in Supabase Dashboard → SQL Editor → Run All

-- Customers table
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
  ai_provider TEXT DEFAULT 'gemini' CHECK (ai_provider IN ('gemini','claude','kimi')),
  byok_key_encrypted TEXT,
  byok_provider TEXT,
  vps_id TEXT,
  vps_ip TEXT,
  vps_status TEXT DEFAULT 'pending' CHECK (vps_status IN ('pending','provisioning','active','suspended','terminated','failed','deprovisioned')),
  vps_region TEXT DEFAULT 'ewr',
  onboarding_complete BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subscriptions
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_stripe ON customers(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_vps ON customers(vps_id);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_token ON magic_tokens(token);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);
CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_activity_log_customer ON activity_log(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_customer ON oauth_tokens(customer_id);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER oauth_tokens_updated_at
  BEFORE UPDATE ON oauth_tokens FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER vps_fleet_updated_at
  BEFORE UPDATE ON vps_fleet FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS policies (service role bypasses these, anon/customer keys respect them)
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE vps_fleet ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

-- Support tickets table
CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id uuid REFERENCES customers(id),
  email text,
  subject text NOT NULL,
  message text NOT NULL,
  status text DEFAULT 'open' CHECK (status IN ('open', 'auto_resolved', 'escalated', 'closed')),
  tier integer DEFAULT 1,
  resolution text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer ON support_tickets(customer_id);

-- ─── Schema migrations (safe to re-run) ───────────────────────────────────────

-- Add lead status and payment_failed to customers
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_status_check
  CHECK (status IN ('lead','trial','active','cancelled','payment_failed','past_due'));

-- Add missing columns (safe if already exist via IF NOT EXISTS workaround)
DO $$ BEGIN
  BEGIN ALTER TABLE customers ADD COLUMN vultr_instance_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE customers ADD COLUMN mrr INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE customers ADD COLUMN cancelled_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE customers ADD COLUMN provisioned_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
END $$;


-- ─── Timezone and brief_time columns ─────────────────────────────────────────
DO $$ BEGIN
  BEGIN ALTER TABLE customers ADD COLUMN timezone TEXT DEFAULT 'America/New_York'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE customers ADD COLUMN city TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE customers ADD COLUMN brief_time TEXT DEFAULT '07:00'; EXCEPTION WHEN duplicate_column THEN NULL; END;
END $$;

-- ─── Schema audit fixes 2026-03-19 ───────────────────────────────────────────

-- Health monitoring columns on customers
DO $$ BEGIN
  BEGIN ALTER TABLE customers ADD COLUMN consecutive_failures INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE customers ADD COLUMN last_health_check TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE customers ADD COLUMN last_response_time_ms INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END;
END $$;

-- system_errors: health check error logging (openclaw-health.js)
CREATE TABLE IF NOT EXISTS system_errors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  error_type TEXT,
  channel TEXT,
  error_message TEXT,
  occurred_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_system_errors_customer ON system_errors(customer_id, occurred_at DESC);
ALTER TABLE system_errors ENABLE ROW LEVEL SECURITY;

-- email_failures: tracks welcome emails that exhausted retries (process-email-queue.js)
CREATE TABLE IF NOT EXISTS email_failures (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  to_email TEXT,
  template TEXT,
  error TEXT,
  retry_count INTEGER DEFAULT 0,
  failed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_failures_customer ON email_failures(customer_id, failed_at DESC);
ALTER TABLE email_failures ENABLE ROW LEVEL SECURITY;
