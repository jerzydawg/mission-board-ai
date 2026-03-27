#!/usr/bin/env node
/**
 * Cleanup Cancelled VPS
 * Runs daily, deletes VPS where delete_after has passed
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VULTR_API_KEY = process.env.VULTR_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function deleteVultrInstance(instanceId) {
  const res = await fetch(`https://api.vultr.com/v2/instances/${instanceId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${VULTR_API_KEY}` }
  });
  return res.ok;
}

async function main() {
  console.log('[cleanup] Starting VPS cleanup...');
  
  const { data: toDelete, error } = await supabase
    .from('customers')
    .select('id, email, vultr_instance_id, delete_after')
    .eq('status', 'cancelled')
    .not('vultr_instance_id', 'is', null)
    .lte('delete_after', new Date().toISOString());

  if (error) {
    console.error('[cleanup] Query failed:', error.message);
    process.exit(1);
  }

  console.log(`[cleanup] Found ${toDelete?.length || 0} VPS to delete`);

  for (const customer of (toDelete || [])) {
    console.log(`[cleanup] Deleting VPS for ${customer.email}: ${customer.vultr_instance_id}`);
    
    const deleted = await deleteVultrInstance(customer.vultr_instance_id);
    
    if (deleted) {
      await supabase
        .from('customers')
        .update({ 
          vultr_instance_id: null, 
          vps_ip: null, 
          vps_status: 'deleted' 
        })
        .eq('id', customer.id);
      
      console.log(`[cleanup] ✓ Deleted ${customer.vultr_instance_id}`);
    } else {
      console.error(`[cleanup] ✗ Failed to delete ${customer.vultr_instance_id}`);
    }
  }

  console.log('[cleanup] Done');
}

main().catch(console.error);
