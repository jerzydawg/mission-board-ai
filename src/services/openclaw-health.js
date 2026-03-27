/**
 * OpenClaw Health Monitoring & Auto-Recovery System
 * 
 * Prevents the "stuck in error state" issue that requires manual bot recreation.
 * Monitors customer instances and auto-recovers from billing errors.
 */

const { createSupabaseClient } = require('./supabase');
const axios = require('axios');

class OpenClawHealthMonitor {
  constructor() {
    this.supabase = createSupabaseClient();
    this.checkInterval = 2 * 60 * 1000; // Check every 2 minutes
    this.recoveryAttempts = new Map(); // Track recovery attempts per customer
  }

  /**
   * Start health monitoring for all active customers
   */
  async startMonitoring() {
    console.log('[HEALTH] Starting OpenClaw health monitoring...');
    
    setInterval(async () => {
      await this.checkAllCustomerInstances();
    }, this.checkInterval);

    // Initial check
    await this.checkAllCustomerInstances();
  }

  /**
   * Check health of all active customer OpenClaw instances
   */
  async checkAllCustomerInstances() {
    try {
      const { data: customers } = await this.supabase
        .from('customers')
        .select('id, vps_ip, status, email, telegram_chat_id, last_health_check, consecutive_failures')
        .in('status', ['active', 'trial']);

      console.log(`[HEALTH] Checking ${customers.length} customer instances...`);

      for (const customer of customers) {
        if (customer.vps_ip) {
          await this.checkCustomerHealth(customer);
        }
      }
    } catch (error) {
      console.error('[HEALTH] Error in health check cycle:', error);
    }
  }

  /**
   * Check individual customer instance health
   */
  async checkCustomerHealth(customer) {
    const healthUrl = `http://${customer.vps_ip}:18789/health`;
    const startTime = Date.now();

    try {
      // Check OpenClaw gateway health
      const response = await axios.get(healthUrl, { 
        timeout: 10000,
        headers: {
          'User-Agent': 'MrDelegate-HealthCheck/1.0'
        }
      });

      const responseTime = Date.now() - startTime;
      const isHealthy = response.status === 200 && response.data;

      if (isHealthy) {
        await this.recordHealthyCheck(customer.id, responseTime);
      } else {
        await this.handleUnhealthyInstance(customer, 'invalid_response', response.data);
      }

    } catch (error) {
      await this.handleUnhealthyInstance(customer, 'connection_failed', error.message);
    }
  }

  /**
   * Record successful health check
   */
  async recordHealthyCheck(customerId, responseTime) {
    await this.supabase
      .from('customers')
      .update({
        last_health_check: new Date().toISOString(),
        consecutive_failures: 0,
        last_response_time_ms: responseTime
      })
      .eq('id', customerId);

    // Clear recovery attempts
    this.recoveryAttempts.delete(customerId);
  }

  /**
   * Handle unhealthy instance - attempt auto-recovery
   */
  async handleUnhealthyInstance(customer, errorType, errorMessage) {
    const failures = customer.consecutive_failures || 0;
    const newFailures = failures + 1;

    console.log(`[HEALTH] ${customer.id} unhealthy (${newFailures} failures): ${errorType}`);

    // Update failure count
    await this.supabase
      .from('customers')
      .update({
        last_health_check: new Date().toISOString(),
        consecutive_failures: newFailures,
        last_error: errorMessage
      })
      .eq('id', customer.id);

    // Log the incident
    await this.supabase.from('system_errors').insert({
      customer_id: customer.id,
      error_type: errorType,
      channel: 'health_check',
      error_message: errorMessage,
      occurred_at: new Date().toISOString()
    });

    // Trigger recovery based on failure count
    if (newFailures === 2) {
      await this.attemptSoftRecovery(customer);
    } else if (newFailures === 4) {
      await this.attemptHardRecovery(customer);
    } else if (newFailures >= 6) {
      await this.escalateToSupport(customer, errorType, errorMessage);
    }
  }

  /**
   * Soft recovery - restart OpenClaw service
   */
  async attemptSoftRecovery(customer) {
    const attempts = this.recoveryAttempts.get(customer.id) || 0;
    if (attempts >= 3) {
      console.log(`[RECOVERY] Skipping soft recovery for ${customer.id} - max attempts reached`);
      return;
    }

    console.log(`[RECOVERY] Attempting soft recovery for ${customer.id}...`);
    
    try {
      // SSH to customer VPS and restart OpenClaw
      const sshCommand = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=1 root@${customer.vps_ip} "systemctl restart openclaw && sleep 3 && systemctl is-active openclaw"`;
      
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      const result = await execAsync(sshCommand);
      
      if (result.stdout.trim() === 'active') {
        console.log(`[RECOVERY] Soft recovery successful for ${customer.id}`);
        
        // Notify customer
        await this.notifyCustomer(customer, 'recovery_success', 'Your agent has been automatically restarted and is now working normally.');
        
        // Reset failure count
        await this.supabase
          .from('customers')
          .update({ consecutive_failures: 0 })
          .eq('id', customer.id);
          
      } else {
        console.log(`[RECOVERY] Soft recovery failed for ${customer.id}:`, result.stderr);
        this.recoveryAttempts.set(customer.id, attempts + 1);
      }

    } catch (error) {
      console.error(`[RECOVERY] Soft recovery error for ${customer.id}:`, error.message);
      this.recoveryAttempts.set(customer.id, attempts + 1);
    }
  }

  /**
   * Hard recovery - full system restart + config reset
   */
  async attemptHardRecovery(customer) {
    console.log(`[RECOVERY] Attempting hard recovery for ${customer.id}...`);
    
    try {
      // More aggressive recovery - restart Docker, clear caches, restart OpenClaw
      const hardRestartCommand = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=1 root@${customer.vps_ip} "
        systemctl stop openclaw
        docker system prune -f
        rm -rf ~/.openclaw/cache/*
        rm -rf ~/.openclaw/tmp/*
        systemctl start openclaw
        sleep 10
        systemctl is-active openclaw
      "`;

      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      const result = await execAsync(hardRestartCommand);
      
      if (result.stdout.trim() === 'active') {
        console.log(`[RECOVERY] Hard recovery successful for ${customer.id}`);
        
        // Notify customer
        await this.notifyCustomer(customer, 'recovery_success', 'Your agent experienced a temporary issue but has been fully restored. All services are working normally.');
        
        // Reset failure count
        await this.supabase
          .from('customers')
          .update({ consecutive_failures: 0 })
          .eq('id', customer.id);
          
      } else {
        console.log(`[RECOVERY] Hard recovery failed for ${customer.id}:`, result.stderr);
        // Will escalate on next health check
      }

    } catch (error) {
      console.error(`[RECOVERY] Hard recovery error for ${customer.id}:`, error.message);
    }
  }

  /**
   * Escalate to human support when auto-recovery fails
   */
  async escalateToSupport(customer, errorType, errorMessage) {
    console.log(`[ESCALATION] Creating support ticket for ${customer.id}`);

    await this.supabase.from('support_tickets').insert({
      customer_id: customer.id,
      subject: `Critical: Customer instance down - auto-recovery failed`,
      description: `Customer: ${customer.email}
VPS IP: ${customer.vps_ip}
Error Type: ${errorType}
Error Message: ${errorMessage}
Consecutive Failures: ${customer.consecutive_failures}

Auto-recovery (soft + hard) failed. Manual intervention required.`,
      priority: 'critical',
      status: 'open',
      created_at: new Date().toISOString()
    });

    // Notify customer about the escalation
    await this.notifyCustomer(customer, 'escalation', 'We\'re investigating an issue with your agent. Our team has been notified and will resolve this within 2 hours. We\'ll update you as soon as it\'s fixed.');

    // Also alert the founder immediately
    console.log(`[ALERT] Critical escalation for customer ${customer.id} - ${customer.email}`);
  }

  /**
   * Send notification to customer
   */
  async notifyCustomer(customer, type, message) {
    if (!customer.telegram_chat_id) {
      console.log(`[NOTIFY] No Telegram ID for ${customer.id}, skipping notification`);
      return;
    }

    const icons = {
      recovery_success: '✅',
      escalation: '🔧',
      warning: '⚠️'
    };

    const fullMessage = `${icons[type] || 'ℹ️'} **MrDelegate Status Update**\n\n${message}`;

    // TODO: Integrate with actual message service
    console.log(`[NOTIFY] Would send to ${customer.telegram_chat_id}:`, fullMessage);
  }

  /**
   * Get health status for all customers (for admin dashboard)
   */
  async getHealthStatus() {
    const { data: customers } = await this.supabase
      .from('customers')
      .select('id, email, status, vps_ip, last_health_check, consecutive_failures, last_response_time_ms')
      .in('status', ['active', 'trial'])
      .order('consecutive_failures', { ascending: false });

    const healthy = customers.filter(c => (c.consecutive_failures || 0) === 0).length;
    const unhealthy = customers.filter(c => (c.consecutive_failures || 0) > 0).length;
    const critical = customers.filter(c => (c.consecutive_failures || 0) >= 4).length;

    return {
      total: customers.length,
      healthy,
      unhealthy,
      critical,
      customers: customers.map(c => ({
        id: c.id,
        email: c.email,
        status: c.status,
        health: (c.consecutive_failures || 0) === 0 ? 'healthy' : 
                (c.consecutive_failures >= 4) ? 'critical' : 'unhealthy',
        last_check: c.last_health_check,
        response_time: c.last_response_time_ms,
        failures: c.consecutive_failures || 0
      }))
    };
  }
}

module.exports = { OpenClawHealthMonitor };