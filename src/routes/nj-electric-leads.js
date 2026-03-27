// NJ Electric leads API endpoint
import { Hono } from 'hono';
import { createNJElectricLead, getNJElectricLeads } from '../services/supabase.js';

export const njElectricLeadsRoutes = new Hono();

// POST /api/nj-electric-leads - Submit lead form
njElectricLeadsRoutes.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { name, phone, email, service, message } = body;

    // Validation
    if (!name || !phone) {
      return c.json({ error: 'Name and phone are required' }, 400);
    }

    if (name.length < 2 || name.length > 255) {
      return c.json({ error: 'Name must be between 2 and 255 characters' }, 400);
    }

    if (phone.length < 10) {
      return c.json({ error: 'Please enter a valid phone number' }, 400);
    }

    // Optional email validation
    if (email && !email.includes('@')) {
      return c.json({ error: 'Invalid email format' }, 400);
    }

    // Create lead in database
    const leadData = {
      name: name.trim(),
      phone: phone.trim(),
      email: email ? email.toLowerCase().trim() : null,
      service: service || null,
      message: message ? message.trim() : null,
    };

    const lead = await createNJElectricLead(leadData);

    console.log('[nj-electric] New lead created:', { id: lead.id, name: leadData.name, phone: leadData.phone });

    return c.json({
      message: 'Thank you for your request! We will contact you within 2 hours during business hours.',
      status: 'success',
      leadId: lead.id
    });
  } catch (err) {
    console.error('[nj-electric] Lead submission error:', err.message);
    return c.json({ error: 'Failed to submit lead. Please try again.' }, 500);
  }
});

// GET /api/nj-electric-leads - Get all leads (for admin panel)
njElectricLeadsRoutes.get('/', async (c) => {
  try {
    const leads = await getNJElectricLeads();
    return c.json({ leads, count: leads.length });
  } catch (err) {
    console.error('[nj-electric] Error fetching leads:', err.message);
    return c.json({ error: 'Failed to fetch leads' }, 500);
  }
});

// GET /api/nj-electric-leads/stats - Get lead stats
njElectricLeadsRoutes.get('/stats', async (c) => {
  try {
    const leads = await getNJElectricLeads();

    // Calculate basic stats
    const total = leads.length;
    const today = new Date().toISOString().split('T')[0];
    const todayLeads = leads.filter(lead =>
      lead.created_at.startsWith(today)
    ).length;

    const thisWeek = new Date();
    thisWeek.setDate(thisWeek.getDate() - 7);
    const weeklyLeads = leads.filter(lead =>
      new Date(lead.created_at) >= thisWeek
    ).length;

    const statusCounts = leads.reduce((acc, lead) => {
      acc[lead.status] = (acc[lead.status] || 0) + 1;
      return acc;
    }, {});

    return c.json({
      total,
      today: todayLeads,
      thisWeek: weeklyLeads,
      statusCounts,
      recentLeads: leads.slice(0, 5)
    });
  } catch (err) {
    console.error('[nj-electric] Error fetching stats:', err.message);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});