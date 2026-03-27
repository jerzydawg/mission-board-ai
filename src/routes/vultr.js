import { Hono } from 'hono';
import { listInstances, getInstance } from '../services/vultr-api.js';
import { verifyAdmin } from '../middleware/auth.js';
import { db } from '../services/db.js';

export const vultrRoutes = new Hono();

// List all customer VPS instances
vultrRoutes.get('/instances', verifyAdmin, async (c) => {
  try {
    const instances = await listInstances();
    return c.json({ instances });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Get specific instance status
vultrRoutes.get('/instances/:id', verifyAdmin, async (c) => {
  const { id } = c.req.param();
  try {
    const instance = await getInstance(id);
    return c.json({ instance });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Fleet health overview
vultrRoutes.get('/fleet', async (c) => {
  const customers = db.getAllCustomers();
  const fleet = [];

  for (const customer of customers) {
    if (customer.vultrInstanceId) {
      try {
        const instance = await getInstance(customer.vultrInstanceId);
        fleet.push({
          email: customer.email,
          status: customer.status,
          ip: instance.main_ip,
          vcpu: instance.vcpu_count,
          ram: instance.ram,
          disk: instance.disk,
          region: instance.region,
          power: instance.power_status,
          server_status: instance.server_status,
        });
      } catch (err) {
        fleet.push({
          email: customer.email,
          status: 'unreachable',
          error: err.message,
        });
      }
    }
  }

  return c.json({ fleet, total: fleet.length });
});
