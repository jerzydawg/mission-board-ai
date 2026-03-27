import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const publicStatsRoutes = new Hono();

// Public stats - no auth required, shows real metrics
publicStatsRoutes.get('/', async (c) => {
  try {
    // Get customer counts
    const { data: customers } = await supabase
      .from('customers')
      .select('status, plan');
    
    const stats = {
      totalCustomers: customers?.length || 0,
      activeCustomers: customers?.filter(c => c.status === 'active').length || 0,
      trialCustomers: customers?.filter(c => c.status === 'trial').length || 0,
      leads: customers?.filter(c => c.status === 'lead').length || 0,
      mrr: 0, // Calculate from active subscriptions
      plans: {
        starter: customers?.filter(c => c.plan === 'starter').length || 0,
        pro: customers?.filter(c => c.plan === 'pro').length || 0,
        business: customers?.filter(c => c.plan === 'business').length || 0,
        enterprise: customers?.filter(c => c.plan === 'enterprise').length || 0
      }
    };
    
    // Calculate MRR
    const pricing = { starter: 29, pro: 49, business: 99, enterprise: 199 };
    stats.mrr = (stats.plans.starter * 29) + (stats.plans.pro * 49) + 
                (stats.plans.business * 99) + (stats.plans.enterprise * 199);
    
    return c.json(stats);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});
