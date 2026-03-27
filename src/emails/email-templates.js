/**
 * MrDelegate Trial→Paid Conversion Email Templates
 * 5-email sequence for converting trial users to paid subscribers
 * 
 * Usage: import { getEmailTemplate } from './email-templates.js'
 * Provider: Resend (https://resend.com) — set RESEND_API_KEY in env
 */

const BRAND = {
  name: 'MrDelegate',
  url: 'https://mrdelegate.ai',
  upgradeUrl: 'https://mrdelegate.ai/start',
  supportEmail: 'support@mrdelegate.ai',
  color: '#6366f1',
  logo: 'https://mrdelegate.ai/og-image.png',
};

function baseTemplate(content, preheader = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${BRAND.name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; color: #18181b; line-height: 1.6; }
    .wrapper { max-width: 600px; margin: 32px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .header { background: #09090b; padding: 28px 32px; text-align: center; }
    .header a { color: #fff; font-size: 22px; font-weight: 700; text-decoration: none; }
    .header span { color: ${BRAND.color}; }
    .body { padding: 36px 32px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 16px; color: #09090b; }
    p { color: #52525b; margin-bottom: 16px; font-size: 15px; }
    .cta { display: block; text-align: center; margin: 28px 0; }
    .cta a { background: ${BRAND.color}; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px; }
    .features { background: #f4f4f5; border-radius: 10px; padding: 20px 24px; margin: 20px 0; }
    .features li { list-style: none; padding: 6px 0; color: #3f3f46; font-size: 14px; }
    .features li::before { content: "✓ "; color: ${BRAND.color}; font-weight: 700; }
    .footer { background: #f4f4f5; padding: 20px 32px; text-align: center; font-size: 12px; color: #a1a1aa; border-top: 1px solid #e4e4e7; }
    .footer a { color: #6366f1; text-decoration: none; }
    .urgency { background: #fef3c7; border: 1px solid #fbbf24; border-radius: 8px; padding: 14px 20px; margin: 20px 0; color: #92400e; font-size: 14px; font-weight: 600; }
  </style>
</head>
<body>
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden">${preheader}</div>` : ''}
  <div class="wrapper">
    <div class="header">
      <a href="${BRAND.url}">Mr<span>Delegate</span></a>
    </div>
    <div class="body">
      ${content}
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} MrDelegate · <a href="${BRAND.url}/unsubscribe">Unsubscribe</a> · <a href="${BRAND.url}/privacy">Privacy</a></p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Day 1 — Welcome: "Your OpenClaw agent is ready"
 */
export function email1_welcome({ firstName = 'there', plan = 'Starter' } = {}) {
  const subject = `Welcome to MrDelegate, ${firstName} — your AI assistant is live`;
  const preheader = 'Your OpenClaw agent is running. Here\'s how to get the most out of it today.';
  const html = baseTemplate(`
    <h1>Your AI assistant is live, ${firstName} 🎉</h1>
    <p>Welcome to MrDelegate. Your managed OpenClaw instance is up and running on your <strong>${plan}</strong> plan. This is day 1 of your 14-day trial — and we want to make sure you get real value from it.</p>
    <p><strong>What you can do right now:</strong></p>
    <ul class="features">
      <li>Connect your Telegram account — message your assistant directly</li>
      <li>Set up a morning brief (weather + calendar + emails every morning)</li>
      <li>Ask your assistant to check your inbox and summarize unread messages</li>
      <li>Schedule tasks and reminders that run automatically</li>
    </ul>
    <p>Your dashboard is where you manage everything — API keys, integrations, and usage logs.</p>
    <div class="cta">
      <a href="${BRAND.url}/dashboard">Open My Dashboard →</a>
    </div>
    <p>If anything isn't working or you have questions, just reply to this email — we respond within a few hours.</p>
    <p style="margin-top:24px">— The MrDelegate Team</p>
  `, preheader);
  return { subject, html, day: 1 };
}

/**
 * Day 3 — Feature highlight: heartbeats & scheduling
 */
export function email2_feature({ firstName = 'there' } = {}) {
  const subject = `${firstName}, have you tried heartbeats yet?`;
  const preheader = 'The most powerful feature most trial users miss — automated proactive checks.';
  const html = baseTemplate(`
    <h1>The feature that changes everything</h1>
    <p>Hi ${firstName},</p>
    <p>You're on day 3 of your trial. Most people who stick with MrDelegate long-term have one thing in common: they've set up <strong>heartbeat checks</strong>.</p>
    <p>Here's what that means: instead of you asking your assistant things, it checks in on you. Every 30 minutes (or whatever interval you set), it scans for anything that needs your attention — urgent emails, upcoming meetings, weather that might affect your day — and only interrupts you if something actually matters.</p>
    <p><strong>To set up your first heartbeat:</strong></p>
    <ul class="features">
      <li>Open your HEARTBEAT.md file in the workspace</li>
      <li>Add the checks you want (email, calendar, Slack, weather)</li>
      <li>Your assistant will run them automatically every cycle</li>
    </ul>
    <p>The result: your assistant works in the background all day, and you only get notified when something actually needs you.</p>
    <div class="cta">
      <a href="${BRAND.url}/docs#heartbeats">Set Up My First Heartbeat →</a>
    </div>
    <p>Questions? Reply here — happy to help you configure it.</p>
    <p style="margin-top:24px">— The MrDelegate Team</p>
  `, preheader);
  return { subject, html, day: 3 };
}

/**
 * Day 7 — Check-in: how's it going?
 */
export function email3_checkin({ firstName = 'there' } = {}) {
  const subject = `${firstName}, how's your AI assistant doing?`;
  const preheader = 'You\'re at the halfway point of your trial. Let\'s make sure you\'re getting value.';
  const html = baseTemplate(`
    <h1>You're at the halfway mark</h1>
    <p>Hi ${firstName},</p>
    <p>7 days in. We wanted to check in and make sure your OpenClaw assistant is actually saving you time — not just sitting there looking impressive.</p>
    <p><strong>What other MrDelegate customers are using their assistant for right now:</strong></p>
    <ul class="features">
      <li>Automatic daily briefings (weather, calendar, top emails) at 8am</li>
      <li>Monitoring their company's X/Twitter mentions and alerting on important ones</li>
      <li>Running cron jobs to check on deployed services and send Telegram alerts if anything breaks</li>
      <li>Drafting email replies to their inbox using context from previous messages</li>
      <li>Summarizing Slack threads they missed overnight</li>
    </ul>
    <p>If your assistant isn't doing at least one of these things yet, let's fix that. Reply to this email and tell me where you're stuck — I'll send you a working config in under 10 minutes.</p>
    <div class="cta">
      <a href="${BRAND.url}/dashboard">Check My Assistant's Activity →</a>
    </div>
    <p style="margin-top:24px">— The MrDelegate Team</p>
  `, preheader);
  return { subject, html, day: 7 };
}

/**
 * Day 10 — Urgency: 4 days left
 */
export function email4_urgency({ firstName = 'there', plan = 'Starter', upgradePrice = 29 } = {}) {
  const subject = `${firstName} — 4 days left in your MrDelegate trial`;
  const preheader = 'Your AI assistant keeps running after the trial. Here\'s what happens at day 14.';
  const html = baseTemplate(`
    <h1>4 days left in your trial</h1>
    <p>Hi ${firstName},</p>
    <div class="urgency">⏳ Your trial ends in 4 days. Upgrade now to keep your assistant running without interruption.</div>
    <p>When your trial ends, your assistant goes into standby mode. It stops running heartbeats, stops responding to messages, and stops monitoring anything you've set up.</p>
    <p><strong>When you upgrade to ${plan} ($${upgradePrice}/mo), you keep:</strong></p>
    <ul class="features">
      <li>All your current configurations and memory files</li>
      <li>Every skill and integration you've set up</li>
      <li>Your assistant's full history and learned context</li>
      <li>Continuous 24/7 operation with no interruptions</li>
    </ul>
    <p>Starting over from scratch after a lapse is painful. Your assistant's value compounds over time — the context it builds, the patterns it learns, the automations it runs. Don't reset that.</p>
    <div class="cta">
      <a href="${BRAND.upgradeUrl}?plan=${plan.toLowerCase()}">Upgrade Now — $${upgradePrice}/mo →</a>
    </div>
    <p>Questions about the plans or what's included? Just reply — happy to help you pick the right one.</p>
    <p style="margin-top:24px">— The MrDelegate Team</p>
  `, preheader);
  return { subject, html, day: 10 };
}

/**
 * Day 14 — Final push: trial ending today
 */
export function email5_final({ firstName = 'there', plan = 'Starter', upgradePrice = 29 } = {}) {
  const subject = `Last chance, ${firstName} — trial ends today`;
  const preheader = 'Your OpenClaw assistant goes offline tonight unless you upgrade.';
  const html = baseTemplate(`
    <h1>Your trial ends today</h1>
    <p>Hi ${firstName},</p>
    <div class="urgency">🔴 This is your last day. Your assistant goes into standby tonight.</div>
    <p>14 days ago, you spun up a managed OpenClaw assistant on MrDelegate. Today is the last day of your trial.</p>
    <p>After tonight, without upgrading, your assistant will stop running. Heartbeats stop. Automations pause. Integrations go quiet. Any context and memory your assistant has built over the past two weeks stays saved — but it won't be active.</p>
    <p>To keep everything running without any gaps, upgrade before midnight tonight:</p>
    <div class="cta">
      <a href="${BRAND.upgradeUrl}?plan=${plan.toLowerCase()}&ref=final-email">Keep My Assistant Running — $${upgradePrice}/mo →</a>
    </div>
    <p>If you've decided MrDelegate isn't for you right now, no worries — no hard feelings and no hidden fees. If you want to talk through whether it's a fit, reply to this email and I'll call or message you directly.</p>
    <p>Either way, thank you for trying it.</p>
    <p style="margin-top:24px">— Bart & The MrDelegate Team</p>
  `, preheader);
  return { subject, html, day: 14 };
}

/**
 * Get email for a specific day
 */
export function getEmailTemplate(day, customerData = {}) {
  const map = { 1: email1_welcome, 3: email2_feature, 7: email3_checkin, 10: email4_urgency, 14: email5_final };
  if (!map[day]) throw new Error(`No email template for day ${day}. Valid days: 1, 3, 7, 10, 14`);
  return map[day](customerData);
}

export const SEQUENCE_DAYS = [1, 3, 7, 10, 14];
