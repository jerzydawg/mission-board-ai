import { Hono } from 'hono';
import { verifyAdmin } from '../middleware/auth.js';
import { provisionVPS } from '../services/provisioner.js';
import { getAllCustomers, updateCustomer, logActivity } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import { getInstance } from '../services/vultr-api.js';

export const opsRoutes = new Hono();

// POST /ops/api/vps/provision — Manual VPS provision for testing/demo
opsRoutes.post('/vps/provision', verifyAdmin, async (c) => {
  try {
    // Create a test customer entry or provision for an existing customer without VPS
    const customers = await getAllCustomers();
    const needsVps = customers.find(cust => !cust.vps_ip && !cust.vultr_instance_id && cust.status !== 'cancelled');
    
    if (!needsVps) {
      return c.json({ 
        error: 'No customers need VPS provisioning. All active customers already have instances.' 
      }, 400);
    }

    console.log(`[ops] Manual provision for customer: ${needsVps.email}`);

    // Claim provisioning slot
    const { data: claimed } = await supabase
      .from('customers')
      .update({ vps_status: 'provisioning' })
      .eq('id', needsVps.id)
      .eq('vps_status', 'pending')
      .select()
      .single();

    if (!claimed) {
      return c.json({ error: 'Could not claim provisioning slot' }, 409);
    }

    // Provision async
    (async () => {
      try {
        const instance = await provisionVPS(needsVps);
        await updateCustomer(needsVps.id, {
          vps_status: 'active',
          vps_ip: instance.main_ip,
          vultr_instance_id: instance.id,
          provisioned_at: new Date().toISOString(),
        });
        await logActivity(needsVps.id, 'vps_provisioned', { 
          source: 'ops_manual', 
          instance_id: instance.id, 
          ip: instance.main_ip 
        });
        console.log(`[ops] VPS provisioned: ${instance.id} (${instance.main_ip})`);
      } catch (err) {
        console.error(`[ops] Provision failed:`, err.message);
        await supabase.from('customers')
          .update({ vps_status: 'failed' })
          .eq('id', needsVps.id)
          .catch(() => {});
      }
    })();

    return c.json({ 
      ok: true, 
      message: 'Provisioning started',
      customer: needsVps.email 
    });
  } catch (e) {
    console.error('[ops] Provision error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// GET /ops/api/vps/list — List all VPS instances
opsRoutes.get('/vps/list', verifyAdmin, async (c) => {
  try {
    const customers = await getAllCustomers();
    const vpsInstances = [];

    for (const customer of customers) {
      if (customer.vps_ip || customer.vultr_instance_id) {
        let uptime = '—';
        let status = customer.vps_status || 'unknown';

        // Try to fetch live status from Vultr
        if (customer.vultr_instance_id) {
          try {
            const instance = await getInstance(customer.vultr_instance_id);
            status = instance.power_status === 'running' ? 'active' : instance.power_status;
            // Calculate uptime from created date
            if (instance.date_created) {
              const created = new Date(instance.date_created);
              const days = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
              uptime = days > 0 ? `${days}d` : '<1d';
            }
          } catch (err) {
            console.error(`[ops] Could not fetch instance ${customer.vultr_instance_id}:`, err.message);
          }
        }

        vpsInstances.push({
          id: customer.id,
          hostname: `md-${customer.stripe_customer_id?.slice(-8) || 'unknown'}`,
          ip: customer.vps_ip || '—',
          status,
          uptime,
          customer: customer.name || customer.email,
          region: customer.vps_region || 'ewr',
        });
      }
    }

    return c.json({ instances: vpsInstances });
  } catch (e) {
    console.error('[ops] VPS list error:', e);
    return c.json({ error: e.message }, 500);
  }
});
