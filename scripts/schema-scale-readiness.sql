-- Scale-readiness indexes for 500-1000 customers.
-- Run in Supabase SQL editor during the next migration window.

CREATE INDEX IF NOT EXISTS idx_customer_connectors_worker_scan
  ON customer_connectors (connector_type, customer_id)
  WHERE connected = true;

CREATE INDEX IF NOT EXISTS idx_customers_status_channel_ready
  ON customers (status, channel)
  WHERE channel_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_triaged_emails_customer_message
  ON triaged_emails (customer_id, gmail_message_id);
