/**
 * OpenClaw Webhook Handler with Channel Failover
 * 
 * Receives errors from customer OpenClaw instances and triggers
 * automatic failover to prevent customer churn.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { ChannelFailover } = require('../middleware/channel-failover');
const { createSupabaseClient } = require('../services/supabase');

const OPENCLAW_WEBHOOK_SECRET = process.env.OPENCLAW_WEBHOOK_SECRET;

const supabase = createSupabaseClient();
const failover = new ChannelFailover(supabase);

// Start cleanup timer
failover.startCleanupTimer();

/**
 * POST /api/webhook/openclaw
 * 
 * Receives error notifications from customer OpenClaw instances
 * Format:
 * {
 *   "customer_id": "uuid",
 *   "error_type": "billing_error|rate_limit|connection_timeout",
 *   "channel": "telegram|discord|whatsapp",
 *   "error_message": "detailed error",
 *   "timestamp": "2026-03-19T16:30:00Z"
 * }
 */
router.post('/openclaw', async (req, res) => {
  // C3: Verify HMAC-SHA256 signature
  if (OPENCLAW_WEBHOOK_SECRET) {
    const signature = req.headers['x-openclaw-signature'];
    if (!signature) {
      return res.status(401).json({ error: 'Missing X-OpenClaw-Signature header' });
    }
    const payload = JSON.stringify(req.body);
    const expected = 'sha256=' + crypto.createHmac('sha256', OPENCLAW_WEBHOOK_SECRET).update(payload).digest('hex');
    let valid = false;
    try {
      valid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch { valid = false; }
    if (!valid) {
      console.warn('[WEBHOOK] Invalid OpenClaw signature — request rejected');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else {
    console.warn('[WEBHOOK] OPENCLAW_WEBHOOK_SECRET not configured — signature validation skipped (set this env var)');
  }

  try {
    const { customer_id, error_type, channel, error_message, timestamp } = req.body;

    if (!customer_id || !error_type || !channel) {
      return res.status(400).json({ 
        error: 'Missing required fields: customer_id, error_type, channel' 
      });
    }

    console.log(`[WEBHOOK] OpenClaw error from ${customer_id} on ${channel}:`, error_type);

    // Log error to database
    await supabase.from('system_errors').insert({
      customer_id,
      error_type, 
      channel,
      error_message,
      occurred_at: timestamp || new Date().toISOString(),
      handled: false
    });

    // Check if this is a critical error that needs failover
    if (error_type === 'billing_error' || error_type === 'rate_limit') {
      try {
        const result = await failover.handleFailure(
          customer_id, 
          channel, 
          { message: error_message }, 
          req.body
        );

        console.log(`[WEBHOOK] Failover result:`, result);

        // Mark error as handled
        await supabase.from('system_errors')
          .update({ handled: true, failover_result: result })
          .eq('customer_id', customer_id)
          .eq('error_message', error_message);

        return res.json({ success: true, failover: result });

      } catch (failoverError) {
        console.error(`[WEBHOOK] Failover failed:`, failoverError);
        
        // Escalate to support if failover fails
        await supabase.from('support_tickets').insert({
          customer_id,
          subject: `Critical: Auto-failover failed for ${channel} error`,
          description: `Original error: ${error_message}\nFailover error: ${failoverError.message}`,
          priority: 'critical',
          status: 'open',
          created_at: new Date().toISOString()
        });

        return res.status(500).json({ 
          error: 'Failover failed', 
          details: failoverError.message 
        });
      }
    }

    // For non-critical errors, just log and continue
    res.json({ success: true, logged: true });

  } catch (error) {
    console.error('[WEBHOOK] Error processing OpenClaw webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/webhook/openclaw/health
 * Health check endpoint for OpenClaw instances
 */
router.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    failover_active: true 
  });
});

module.exports = router;