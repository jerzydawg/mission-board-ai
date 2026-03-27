-- Triaged emails tracking table
-- Prevents re-processing and stores draft replies for send-on-approval
CREATE TABLE IF NOT EXISTS triaged_emails (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  thread_id TEXT,
  from_name TEXT,
  from_email TEXT,
  subject TEXT,
  category TEXT NOT NULL DEFAULT 'unknown', -- vip, needs_reply, fyi, archive
  draft_reply TEXT,
  reply_sent BOOLEAN DEFAULT false,
  reply_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_triaged_customer_date 
  ON triaged_emails(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_triaged_message_id 
  ON triaged_emails(gmail_message_id);

-- Activity log (if not already created)
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_customer_type 
  ON activity_log(customer_id, type, created_at DESC);

-- Clean up old triaged emails (keep 30 days)
-- Run via pg_cron or manually: DELETE FROM triaged_emails WHERE created_at < NOW() - INTERVAL '30 days';
