-- ─── Churn Feedback Loop Schema ───────────────────────────────────────────────
-- Run in Supabase Dashboard → SQL Editor → Run All

-- cancellation_feedback: one row per cancellation, updated when survey submitted
CREATE TABLE IF NOT EXISTS cancellation_feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  email TEXT,
  cancel_date TIMESTAMPTZ DEFAULT now(),
  reason_category TEXT CHECK (reason_category IN (
    'too_expensive', 'didnt_work', 'not_using', 'competitor', 'missing_feature', 'other'
  )),
  reason_text TEXT,
  days_active INTEGER,
  plan TEXT,
  features_used JSONB DEFAULT '[]',
  last_activity TIMESTAMPTZ,
  survey_token TEXT UNIQUE,
  survey_completed BOOLEAN DEFAULT FALSE,
  survey_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cancellation_feedback_customer  ON cancellation_feedback(customer_id);
CREATE INDEX IF NOT EXISTS idx_cancellation_feedback_date      ON cancellation_feedback(cancel_date DESC);
CREATE INDEX IF NOT EXISTS idx_cancellation_feedback_reason    ON cancellation_feedback(reason_category);
CREATE INDEX IF NOT EXISTS idx_cancellation_feedback_token     ON cancellation_feedback(survey_token);

ALTER TABLE cancellation_feedback ENABLE ROW LEVEL SECURITY;
