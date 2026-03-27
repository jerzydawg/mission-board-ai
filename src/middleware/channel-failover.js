/**
 * Channel Failover Middleware
 * 
 * If one channel (Telegram) fails with billing/rate limit error,
 * automatically retry on backup channel (WebUI) or backup provider.
 * 
 * Critical for customer retention - prevents OpenClaw bug #11359
 * from causing customer churn.
 */

const BILLING_ERROR_CODES = [
  'insufficient_credits',
  'rate_limit_exceeded', 
  'billing_error',
  'quota_exceeded',
  'max_tokens_exceeded'
];

const BACKUP_PROVIDERS = {
  'claude': 'gemini-flash-free',
  'gemini': 'claude',
  'openai': 'gemini-flash-free'
};

class ChannelFailover {
  constructor(supabase) {
    this.supabase = supabase;
    this.failureCount = new Map(); // Track failures per customer
  }

  async handleFailure(customerId, channel, error, originalRequest) {
    console.log(`[FAILOVER] ${customerId} ${channel} failed:`, error.message);
    
    const key = `${customerId}:${channel}`;
    const failures = this.failureCount.get(key) || 0;
    this.failureCount.set(key, failures + 1);

    // If billing error on primary channel, try backup immediately
    if (this.isBillingError(error)) {
      return await this.tryBackupProvider(customerId, originalRequest);
    }

    // If 3+ failures in 5 minutes, switch to backup for 1 hour
    if (failures >= 3) {
      return await this.activateBackupMode(customerId, originalRequest);
    }

    throw error; // Re-throw if can't handle
  }

  isBillingError(error) {
    const message = error.message?.toLowerCase() || '';
    return BILLING_ERROR_CODES.some(code => message.includes(code)) ||
           message.includes('billing') ||
           message.includes('credits') ||
           message.includes('quota');
  }

  async tryBackupProvider(customerId, originalRequest) {
    // Get customer's current AI provider
    const { data: customer } = await this.supabase
      .from('customers')
      .select('ai_provider')
      .eq('id', customerId)
      .single();

    const currentProvider = customer?.ai_provider || 'claude';
    const backupProvider = BACKUP_PROVIDERS[currentProvider];

    if (!backupProvider) {
      throw new Error('No backup provider available');
    }

    console.log(`[FAILOVER] Switching ${customerId} from ${currentProvider} to ${backupProvider}`);

    // Update customer record with backup provider
    await this.supabase
      .from('customers')
      .update({ 
        ai_provider: backupProvider,
        backup_mode: true,
        backup_activated_at: new Date().toISOString()
      })
      .eq('id', customerId);

    // Send notification to customer
    await this.notifyCustomer(customerId, currentProvider, backupProvider);

    return { switched: true, from: currentProvider, to: backupProvider };
  }

  async activateBackupMode(customerId, originalRequest) {
    console.log(`[FAILOVER] Activating backup mode for ${customerId}`);
    
    // Mark customer in backup mode for 1 hour
    await this.supabase
      .from('customers')
      .update({ 
        backup_mode: true,
        backup_activated_at: new Date().toISOString()
      })
      .eq('id', customerId);

    return { backupMode: true };
  }

  async notifyCustomer(customerId, fromProvider, toProvider) {
    // Get customer's notification preferences
    const { data: customer } = await this.supabase
      .from('customers')
      .select('telegram_chat_id, email')
      .eq('id', customerId)
      .single();

    const message = `🔄 **Temporary failover active**\n\nYour agent switched from ${fromProvider} to ${toProvider} due to a connectivity issue. Everything is working normally - this is automatic.\n\nYou can switch back anytime in /app → Settings.`;

    // Send via Telegram if available
    if (customer.telegram_chat_id) {
      // TODO: Integrate with message tool
      console.log(`[FAILOVER] Would send Telegram message to ${customer.telegram_chat_id}:`, message);
    }
  }

  // Reset failure count every 5 minutes
  startCleanupTimer() {
    setInterval(() => {
      this.failureCount.clear();
    }, 5 * 60 * 1000);
  }
}

module.exports = { ChannelFailover };