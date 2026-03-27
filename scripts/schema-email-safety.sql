-- Email Safety System — schema migration
-- Run in Supabase SQL editor (safe to re-run: all IF NOT EXISTS)
-- Implement: edit/discard/undo, rate limiting, kill switch, audit log

-- ── triaged_emails: add safety columns ───────────────────────────────────
ALTER TABLE triaged_emails
  ADD COLUMN IF NOT EXISTS sent_at           TIMESTAMPTZ,       -- when email was actually sent
  ADD COLUMN IF NOT EXISTS edited_reply      TEXT,              -- customer-edited version of draft
  ADD COLUMN IF NOT EXISTS discarded_at      TIMESTAMPTZ,       -- when customer discarded this draft
  ADD COLUMN IF NOT EXISTS scheduled_send_at TIMESTAMPTZ;       -- set when send is scheduled (30s window)

-- ── customers: kill switch ────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS email_paused BOOLEAN DEFAULT false;  -- /stop emails kill switch

-- ── email_sends: rate limiting (10/hour per customer) ────────────────────
CREATE TABLE IF NOT EXISTS email_sends (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id      UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  triaged_email_id UUID        REFERENCES triaged_emails(id) ON DELETE SET NULL,
  sent_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_sends_customer_time
  ON email_sends(customer_id, sent_at DESC);

-- ── email_audit_log: full audit trail ────────────────────────────────────
-- action values:
--   draft_created | draft_viewed | draft_edited | draft_discarded
--   send_scheduled | send_cancelled | send_completed | send_failed
CREATE TABLE IF NOT EXISTS email_audit_log (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id      UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  triaged_email_id UUID        REFERENCES triaged_emails(id) ON DELETE SET NULL,
  action           TEXT        NOT NULL,
  metadata         JSONB       DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_audit_customer
  ON email_audit_log(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_audit_triaged
  ON email_audit_log(triaged_email_id, action);

-- ── Clean up scheduled_send_at for crashed/stale sends (manual) ──────────
-- Run if server crashes mid-undo-window:
-- UPDATE triaged_emails SET scheduled_send_at = NULL
-- WHERE scheduled_send_at < NOW() - INTERVAL '5 minutes'
-- AND sent_at IS NULL AND discarded_at IS NULL;
