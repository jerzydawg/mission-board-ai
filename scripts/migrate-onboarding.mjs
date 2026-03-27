#!/usr/bin/env node
/**
 * Migration: Add onboarding support tables/columns
 * - customers.last_welcome_resend (timestamptz)
 * - email_failures table
 * 
 * Run: node /root/mrdelegate/platform/scripts/migrate-onboarding.mjs
 * Safe to run multiple times (uses IF NOT EXISTS / upsert patterns).
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function migrate() {
  // Test 1: Check if last_welcome_resend column exists
  const { error: colErr } = await supabase
    .from('customers')
    .select('last_welcome_resend')
    .limit(1);
  
  if (colErr && colErr.message.includes('does not exist')) {
    console.log('[migrate] Column last_welcome_resend missing — needs manual SQL via Supabase dashboard:');
    console.log('  ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_welcome_resend timestamptz;');
    console.log('');
  } else {
    console.log('[migrate] ✓ customers.last_welcome_resend exists');
  }

  // Test 2: Check if email_failures table exists  
  const { error: tableErr } = await supabase
    .from('email_failures')
    .select('*')
    .limit(1);
  
  if (tableErr && tableErr.message.includes('Could not find')) {
    console.log('[migrate] Table email_failures missing — needs manual SQL via Supabase dashboard:');
    console.log(`  CREATE TABLE IF NOT EXISTS email_failures (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    customer_id uuid REFERENCES customers(id),
    to_email text NOT NULL,
    template text NOT NULL,
    error text,
    retry_count integer DEFAULT 0,
    failed_at timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now()
  );`);
    console.log('');
  } else {
    console.log('[migrate] ✓ email_failures table exists');
  }

  console.log('[migrate] Done. Apply any missing SQL in Supabase Dashboard > SQL Editor.');
}

migrate().catch(err => {
  console.error('[migrate] Fatal:', err);
  process.exit(1);
});
