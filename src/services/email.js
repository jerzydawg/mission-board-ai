// ═══════════════════════════════════════════════════════════════════
// EMAIL AGENT REVIEW CHECKLIST — run weekly (every Sunday)
// ═══════════════════════════════════════════════════════════════════
//
// DELIVERABILITY
//   [ ] Check Resend dashboard for bounce rate (must stay < 2%)
//   [ ] Check unsubscribe rate (> 0.5% = copy problem)
//   [ ] Verify SPF/DKIM/DMARC still passing on mrdelegate.ai
//   [ ] Confirm RESEND_API_KEY is valid (test send if needed)
//
// QUEUE HEALTH
//   [ ] SELECT status, count(*) FROM email_queue GROUP BY status
//       — "pending" stuck > 1h = cron broken
//       — "failed" count spiking = template or Resend issue
//   [ ] Tail /var/log/mrdelegate-email-queue.log — confirm runs every 5min
//   [ ] Check email_failures table for patterns
//
// LINKS (verify these pages still return 200)
//   [ ] https://mrdelegate.ai/welcome         — new signup onboarding
//   [ ] https://mrdelegate.ai/cancel          — cancel page (404 as of audit!)
//   [ ] https://mrdelegate.ai/billing         — billing portal (404 as of audit!)
//   [ ] https://mrdelegate.ai/unsubscribe     — unsubscribe endpoint
//   [ ] https://mrdelegate.ai/dashboard       — customer dashboard
//
// COPY REVIEW
//   [ ] Read every active template out loud — does it still sound right?
//   [ ] Subject lines < 50 chars? (check audit output)
//   [ ] All CTAs point to correct URLs?
//   [ ] Greeting uses safeName() — no "undefined" or "Customer" renders
//   [ ] bot_username fallback fires correctly when null
//
// SEQUENCE COVERAGE
//   [ ] welcome        — fires immediately on checkout.session.completed
//   [ ] onboardingNudge — 24h nudge, queued via queueSequenceEmails
//   [ ] valueReinforcement — 48h, reinforces product value
//   [ ] trialEnding    — 48h (trial ends at 72h, 24h warning)
//   [ ] weekOneStats   — day 7 retention recap with real stats when available
//   [ ] featureSpotlight — day 14 spotlight with server optimization features
//   [ ] monthOneSummary — day 30 retention recap with real stats when available
//   [ ] day60CheckIn   — day 60 member check-in
//   [ ] atRiskCheckIn  — queued after 7 days of inactivity
//   [ ] conversionCelebration — fires on invoice.paid (non-create)
//   [ ] paymentFailed  — fires on invoice.payment_failed
//   [ ] cancelled      — fires on customer.subscription.deleted
//   [ ] resendWelcome  — manual trigger for stranded users
//   [ ] provisionFailed — fires when VPS setup fails
//
// STRIPE WEBHOOK → SEQUENCE MAPPING
//   [ ] stripe.js queues: onboardingNudge[0], valueReinforcement[0],
//       trialEnding[0], (trialEngagement + onboardingTips kept as legacy)
//   [ ] conversionCelebration sends immediately on invoice.paid
//   [ ] cancelled sends immediately (queued +1h) on subscription.deleted
//   [ ] paymentFailed sends immediately on invoice.payment_failed
//
// LAST AUDIT: 2026-03-20 by Email Agent
// ═══════════════════════════════════════════════════════════════════

import { Resend } from 'resend';

let resend = null;

function getResend() {
  if (!resend) {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// Strip HTML tags to produce a plain text fallback for spam filters and accessibility
function htmlToPlainText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<\/div>/gi, '\n')
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ( $1 )')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x2192;/g, '->')
    .replace(/&#x2714;/g, '✓')
    .replace(/&#x2014;/g, '—')
    .replace(/&middot;/g, '·')
    .replace(/&rarr;/g, '->')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function sendEmail({ to, subject, html, text, from = 'MrDelegate <team@mrdelegate.ai>', replyTo = 'team@mrdelegate.ai' }) {
  const r = getResend();

  // Always send a plain text version alongside HTML — improves deliverability
  const plainText = text || (html ? htmlToPlainText(html) : undefined);

  // List-Unsubscribe header: RFC 2369 / RFC 8058 — required by Gmail/Yahoo bulk sender rules
  // Use the recipient address in the unsubscribe URL so the link works without login
  const encodedTo = encodeURIComponent(to);
  const unsubscribeUrl = `https://mrdelegate.ai/unsubscribe?email=${encodedTo}`;
  const headers = {
    'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:team@mrdelegate.ai?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };

  const result = await r.emails.send({ from, to, subject, html, text: plainText, replyTo, headers });
  console.log(`[email] Sent "${subject}" to ${to} — id: ${result.data?.id || 'unknown'}`);
  return result;
}

// ── Branded HTML Email Wrapper ──────────────────────────────────
function brandedEmail(bodyContent, email, options = {}) {
  const { showUnsubscribe = true } = options;
  const unsubUrl = `https://mrdelegate.ai/unsubscribe?email=${encodeURIComponent(email)}`;

  const unsubBlock = showUnsubscribe
    ? `<a href="${unsubUrl}" style="color:#999;text-decoration:underline;">Unsubscribe</a> &nbsp;&middot;&nbsp; <a href="https://mrdelegate.ai" style="color:#999;text-decoration:none;">mrdelegate.ai</a>`
    : `<a href="https://mrdelegate.ai" style="color:#999;text-decoration:none;">mrdelegate.ai</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>MrDelegate</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;">
    <!-- Header -->
    <div style="background:#111111;padding:24px 32px;">
      <span style="color:#F76707;font-weight:800;font-size:18px;letter-spacing:-0.5px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">MrDelegate</span>
    </div>
    <!-- Body -->
    <div style="padding:40px 32px;color:#1a1a1a;font-size:16px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      ${bodyContent}
    </div>
    <!-- Footer -->
    <div style="padding:24px 32px;border-top:1px solid #eeeeee;font-size:12px;color:#999999;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      MrDelegate &middot; 6 Sycamore Way, Mount Arlington, NJ 07856<br>
      ${unsubBlock}
    </div>
  </div>
</body>
</html>`;
}

// CTA button helper — plain text link style (improves deliverability, avoids spam filters)
function ctaButton(text, url) {
  return `<p style="margin:24px 0;">→ ${text}: <a href="${url}" target="_blank" style="color:#F76707;text-decoration:underline;">${url}</a></p>`;
}

// Safe name replacement — fallback to "there" if name is missing/empty
function safeName(name) {
  const n = (name || '').trim();
  return (n && n !== 'Customer') ? n : 'there';
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function hoursSavedLine(hoursSaved) {
  if (typeof hoursSaved !== 'number' || Number.isNaN(hoursSaved) || hoursSaved < 1) {
    return 'Your OpenClaw hosting has been running reliably with optimal performance.';
  }
  return `Your server handled workloads equivalent to about <strong>${hoursSaved.toFixed(1)} hours</strong> of processing this week.`;
}

// ── Email Sequences ────────────────────────────────────────────
// Structure: arrays of { delayHours, subject, buildHtml(name, email, context) }

export const SEQUENCES = {

  // ─── 1. Welcome — fires immediately on signup ─────────────────
  welcome: [
    {
      delayHours: 0,
      subject: "You're all set",
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Your server is ready to go. Just got your setup completed.</p>

<p style="margin:0 0 20px;">Next step is connecting through Telegram so you can manage everything. It takes about 30 seconds.</p>

<p style="margin:0 0 20px;">Go to t.me/MrDelegateBot and send /start when you're ready. That links your server to your Telegram account.</p>

<p style="margin:0 0 20px;">Did the connection work? Hit reply and let me know.</p>

<p style="margin:0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── 2. Day 1 — Onboarding nudge (24h after signup) ──────────
  onboardingNudge: [
    {
      delayHours: 24,
      subject: "Did you get connected?",
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Just checking in on your setup. Did the Telegram connection work yesterday?</p>

<p style="margin:0 0 20px;">Sometimes the first message takes a minute to go through. If you haven't tried yet, head to t.me/MrDelegateBot and send /start.</p>

<p style="margin:0 0 20px;">Your server has been running smoothly since yesterday. Full access is waiting once you connect.</p>

<p style="margin:0 0 20px;">Let me know if you hit any snags?</p>

<p style="margin:0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── 3. Day 2 — Value reinforcement ──────────────────────────
  valueReinforcement: [
    {
      delayHours: 48,
      subject: "Quick question",
      buildHtml: (name, email) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Been watching your server metrics for the past two days. Everything looks solid.</p>

<p style="margin:0 0 20px;">I optimized a few settings last night while you were sleeping. Should notice faster response times today.</p>

<p style="margin:0 0 20px;">How's it feeling so far? Is the Telegram interface working the way you expected?</p>

<p style="margin:0 0 20px;">If something feels off, just hit reply. I check these myself.</p>

<p style="margin:0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── 4. Day 3 — Trial ending reminder ────────────────────────
  trialEnding: [
    {
      delayHours: 48,
      subject: (name) => `Hey ${safeName(name)}, your trial is ending`,
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Your trial wraps up tomorrow. Just wanted to give you a heads up before billing starts.</p>

<p style="margin:0 0 20px;">If you want to keep going, nothing to do. If you want to pause or change anything, just hit reply.</p>

<p style="margin:0 0 20px;">Your server has been solid these past few days. How has the experience been?</p>

<p style="margin:0 0 20px;">Let me know if you need anything sorted before tomorrow.</p>

<p style="margin:0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── Day 7 — Stats recap ──────────────────────────────────────
  weekOneStats: [
    {
      delayHours: 168,
      subject: "One week down",
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);
        const stats = context.stats || {};

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Your server hit the one week mark. Been pretty smooth sailing so far.</p>

<p style="margin:0 0 20px;">I've been tracking some basic metrics on my end. Everything looks healthy - good uptime, reasonable resource usage.</p>

<p style="margin:0 0 20px;">How are you finding the setup? Is it working the way you hoped?</p>

<p style="margin:0 0 20px;">Let me know if anything needs tweaking.</p>

<p style="margin:0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── Day 14 — Feature spotlight / server optimization ────────
  featureSpotlight: [
    {
      delayHours: 336,
      subject: "Thought you'd want to know",
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);
        const serverOptimized = !!context.serverOptimized;

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Two weeks in and I noticed something. You've got a lot more server capacity than you're using.</p>

<p style="margin:0 0 20px;">Not a problem, just wanted you to know it's there. You could run pretty much anything on this setup.</p>

<p style="margin:0 0 20px;">Are you thinking about deploying other stuff? Or is the current setup exactly what you need?</p>

<p style="margin:0 0 20px;">Either way is fine. Just curious how it's working out.</p>

<p style="margin:0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── Day 30 — Monthly summary ────────────────────────────────
  monthOneSummary: [
    {
      delayHours: 720,
      subject: "One month",
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);
        const stats = context.stats || {};

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Can't believe it's been a month already. Time flies when your server is just working.</p>

<p style="margin:0 0 20px;">Looking back at your metrics, everything has been pretty stable. Good uptime, consistent performance.</p>

<p style="margin:0 0 20px;">How do you feel about the setup now? Different from what you expected when you started?</p>

<p style="margin:0 0 20px;">Always curious to hear how the first month goes for people.</p>

<p style="margin:0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── Day 60 — Member check-in ────────────────────────────────
  day60CheckIn: [
    {
      delayHours: 1440,
      subject: "Just checking in",
      buildHtml: (name, email) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Two months in. How's it going?</p>

<p style="margin:0 0 20px;">Your server has been humming along nicely. But I'm more interested in how it feels from your end.</p>

<p style="margin:0 0 20px;">Is there anything that still feels clunky or could work better?</p>

<p style="margin:0 0 20px;">No pressure, just genuinely curious.</p>

<p style="margin:0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── 5. Trial Expired — payment confirmation ──────────────────
  conversionCelebration: [
    {
      delayHours: 0,
      subject: "Welcome",
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Trial ended and you decided to stick around. Good to have you.</p>

<p style="margin:0 0 20px;">Nothing changes on your end. Same server, same access, same everything.</p>

<p style="margin:0 0 20px;">Billing just started running in the background. You'll get a receipt but otherwise it should be invisible.</p>

<p style="margin:0 0 20px;">Let me know if you run into any issues.</p>

<p style="margin:0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── 6. Payment Failed ─────────────────────────────────────────
  paymentFailed: [
    {
      delayHours: 0,
      subject: "Payment issue",
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);
        const attemptCount = Number(context.attemptCount || 1);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Your payment didn't go through. Could be an expired card, bank security thing, or just insufficient funds.</p>

<p style="margin:0 0 20px;">Your server is still running for now. But I need you to update your payment info so we don't have to pause anything.</p>

<p style="margin:0 0 20px;">Can you check your billing page when you get a chance? Link: mrdelegate.ai/app#billing</p>

<p style="margin:0 0 20px;">Let me know if you need help figuring it out.</p>

<p style="margin:0;">— Bart</p>
`, email, { showUnsubscribe: false });
      },
    }
  ],

  // ─── 7. Cancellation Confirmation ─────────────────────────────
  cancelled: [
    {
      delayHours: 0,
      subject: "All set",
      buildHtml: (name, email) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Got your cancellation. No more charges from us.</p>

<p style="margin:0 0 20px;">Your server will stay up until the end of this billing period. After that, everything gets wiped.</p>

<p style="margin:0 0 20px;">If you want to come back later, just reach out. We can get you set up again.</p>

<p style="margin:0 0 20px;">Take care.</p>

<p style="margin:0;">— Bart</p>
`, email, { showUnsubscribe: false });
      },
    }
  ],

  // ─── 8. Resend Welcome ────────────────────────────────────────
  resendWelcome: [
    {
      delayHours: 0,
      subject: "Your Telegram link (if it got buried)",
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);
        const telegramLink = 'https://t.me/MrDelegateBot';
        const telegramLabel = 'Open @MrDelegateBot on Telegram';

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Resending your setup link in case the first email got buried.</p>

<p style="margin:0 0 20px;">Your OpenClaw hosting is live on a dedicated server — it just needs you to connect Telegram to start managing it. Takes 2 minutes:</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;width:100%;">
  <tr>
    <td style="padding:8px 0;font-size:16px;line-height:1.5;color:#1a1a1a;">
      <span style="color:#F76707;font-weight:700;margin-right:8px;">1.</span> Click the button below
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;font-size:16px;line-height:1.5;color:#1a1a1a;">
      <span style="color:#F76707;font-weight:700;margin-right:8px;">2.</span> Send <strong>/start</strong> to your server manager in Telegram
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;font-size:16px;line-height:1.5;color:#1a1a1a;">
      <span style="color:#F76707;font-weight:700;margin-right:8px;">3.</span> Configure your server settings — full access to your hosting environment
    </td>
  </tr>
</table>

${ctaButton(telegramLabel, telegramLink)}

<p style="margin:24px 0 0;font-size:14px;color:#666666;">Trouble connecting? Reply to this email — we'll sort it out in minutes.</p>
`, email);
      },
    }
  ],

  // ─── 9. Abandoned Checkout Recovery ──────────────────────────
  abandonedCheckout: [
    {
      delayHours: 0,
      subject: "You were 1 minute away from finishing setup",
      buildHtml: (name, email) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">You started setting up MrDelegate but didn't finish checkout, so your trial never began.</p>

<p style="margin:0 0 20px;">When you come back, here's exactly what happens next:</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;width:100%;">
  <tr>
    <td style="padding:8px 0;font-size:16px;line-height:1.5;color:#1a1a1a;">
      <span style="color:#F76707;font-weight:700;margin-right:8px;">1.</span> Start your 3-day trial for <strong>$0 today</strong>
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;font-size:16px;line-height:1.5;color:#1a1a1a;">
      <span style="color:#F76707;font-weight:700;margin-right:8px;">2.</span> We spin up your dedicated server
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;font-size:16px;line-height:1.5;color:#1a1a1a;">
      <span style="color:#F76707;font-weight:700;margin-right:8px;">3.</span> You connect Telegram to manage your server
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;font-size:16px;line-height:1.5;color:#1a1a1a;">
      <span style="color:#F76707;font-weight:700;margin-right:8px;">4.</span> Your first charge is <strong>$47/mo after the 3-day trial</strong>
    </td>
  </tr>
</table>

<p style="margin:0 0 8px;">If you still want your dedicated OpenClaw hosting, pick it back up here:</p>

${ctaButton('Finish Your Trial Setup', 'https://mrdelegate.ai/start')}

<p style="margin:24px 0 0;font-size:14px;color:#666666;">Questions before you start? Reply to this email.</p>
`, email);
      },
    }
  ],

  // ─── At-risk check-in — queued by inactivity detector ────────
  atRiskCheckIn: [
    {
      delayHours: 0,
      subject: "Everything ok?",
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);
        const inactiveDays = context.inactiveDays || 7;
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Haven't seen you around for a while. Your server is still running fine.</p>

<p style="margin:0 0 20px;">Did something break? Or just not using it as much as expected?</p>

<p style="margin:0 0 20px;">Either way is totally fine. Just wanted to check in.</p>

<p style="margin:0 0 20px;">Let me know if you need anything.</p>

<p style="margin:0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── Provision Failed — VPS setup error ──────────────────────
  provisionFailed: [
    {
      delayHours: 0,
      subject: "Quick hiccup",
      buildHtml: (name, email) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Hit a snag setting up your server. Not sure what happened but I'm looking into it.</p>

<p style="margin:0 0 20px;">Should have it sorted in the next hour or so. I'll send you another email once everything is running.</p>

<p style="margin:0 0 20px;">No charges until it's all working properly.</p>

<p style="margin:0 0 20px;">Sorry about the delay.</p>

<p style="margin:0;">— Bart</p>
`, email, { showUnsubscribe: false });
      },
    }
  ],



  // ─── Legacy sequences (kept for backward compat) ─────────────
  // ─── Magic Link Login ──────────────────────────────────────
  magicLink: [
    {
      delayHours: 0,
      subject: "Your login link",
      buildHtml: (name, email, context = {}) => {
        const n = safeName(name);
        const loginUrl = context.loginUrl || 'https://mrdelegate.ai/dashboard';

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Click here to sign in. Link expires in 15 minutes.</p>

${ctaButton('Sign In', loginUrl)}

<p style="margin:24px 0 0;">— Bart</p>
`, email, { showUnsubscribe: false });
      },
    }
  ],

  // ─── Trial Expired (No Conversion) ────────────────────────
  trialExpired: [
    {
      delayHours: 0,
      subject: "Your trial ended",
      buildHtml: (name, email) => {
        const n = safeName(name);

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Your trial wrapped up. If you want to keep your assistant running, here's the link. No hard feelings either way.</p>

${ctaButton('Continue with MrDelegate', 'https://mrdelegate.ai/start')}

<p style="margin:24px 0 0;">— Bart</p>
`, email);
      },
    }
  ],

  // ─── Cancel Intent (Before They Cancel) ──────────────────
  cancelIntent: [
    {
      delayHours: 0,
      subject: "Before you go",
      buildHtml: (name, email) => {
        const n = safeName(name);

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Saw you were thinking about canceling. Is something not working? Hit reply - I'd rather fix it than lose you.</p>

<p style="margin:0 0 20px;">Whatever's not clicking, let me know. Takes 2 minutes to fix most things.</p>

<p style="margin:0;">— Bart</p>
`, email, { showUnsubscribe: false });
      },
    }
  ],

  // ─── Win Back 30 Days Post-Cancel ────────────────────────
  winBack30: [
    {
      delayHours: 720,
      subject: "Quick update",
      buildHtml: (name, email) => {
        const n = safeName(name);

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">We shipped some stuff since you left. Thought you might want to know.</p>

<p style="margin:0 0 20px;">Better performance monitoring, faster setup, cleaner Telegram interface. The usual improvements.</p>

${ctaButton('Take Another Look', 'https://mrdelegate.ai/start')}

<p style="margin:24px 0 0;">— The MrDelegate Team</p>
`, email);
      },
    }
  ],

  // ─── Win Back 60 Days Post-Cancel ────────────────────────
  winBack60: [
    {
      delayHours: 1440,
      subject: "Still here if you need us",
      buildHtml: (name, email) => {
        const n = safeName(name);

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Not trying to spam you. Just wanted you to know the door's open if you ever want to come back.</p>

<p style="margin:0 0 20px;">Your setup doesn't have to start from scratch - just reach out.</p>

<p style="margin:0;">— The MrDelegate Team</p>
`, email);
      },
    }
  ],

  // ─── Support Ticket Received ──────────────────────────────
  ticketReceived: [
    {
      delayHours: 0,
      subject: "Got your message",
      buildHtml: (name, email) => {
        const n = safeName(name);

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Got your note. I'll get back to you within 24 hours (usually faster). Hang tight.</p>

<p style="margin:0;">— Bart</p>
`, email, { showUnsubscribe: false });
      },
    }
  ],

  // ─── Support Ticket Resolved ──────────────────────────────
  ticketResolved: [
    {
      delayHours: 0,
      subject: "Should be fixed now",
      buildHtml: (name, email) => {
        const n = safeName(name);

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">I think we got that sorted. Let me know if it's still acting up.</p>

<p style="margin:0;">— Bart</p>
`, email, { showUnsubscribe: false });
      },
    }
  ],

  // ─── Payment Recovered ────────────────────────────────────
  paymentRecovered: [
    {
      delayHours: 0,
      subject: "We're good",
      buildHtml: (name, email) => {
        const n = safeName(name);

        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>

<p style="margin:0 0 20px;">Payment went through - you're all set. Your assistant is still running. Thanks for sorting that out.</p>

<p style="margin:0;">— Bart</p>
`, email, { showUnsubscribe: false });
      },
    }
  ],  trialEngagement: [
    {
      delayHours: 6,
      subject: "Connect your applications — unlock 10x more value",
      buildHtml: (name, email) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>
<p style="margin:0 0 20px;">Your server is running, but it gets <strong>dramatically better</strong> when you deploy your applications. Right now you're working with basic hosting — deploy your custom applications and unlock the full potential of dedicated infrastructure.</p>
<p style="margin:0 0 8px;">Takes 30 seconds:</p>
${ctaButton('Deploy Applications Now', 'https://mrdelegate.ai/dashboard')}
<p style="margin:24px 0 0;font-size:14px;color:#666666;">— MrDelegate Team</p>
`, email);
      },
    },
    {
      delayHours: 23,
      subject: "Your server metrics are ready",
      buildHtml: (name, email) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>
<p style="margin:0 0 20px;">Check Telegram — your first server performance report is available.</p>
<p style="margin:0 0 20px;">This is the kind of monitoring that enterprise hosting providers charge thousands for. Your dedicated infrastructure provides it automatically, with reports available anytime.</p>
<p style="margin:0;font-size:14px;color:#666666;">How'd it look? Hit reply — I read every one.</p>
`, email);
      },
    },
    {
      delayHours: 48,
      subject: "Your server optimized itself overnight",
      buildHtml: (name, email) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>
<p style="margin:0 0 20px;">Last night at 2am, your server analyzed performance from the past 48 hours and optimized resource allocation. This happens automatically every single night.</p>
<p style="margin:0 0 20px;">Check today's performance metrics. They should be better than yesterday's.</p>
${ctaButton('Open Telegram', 'https://mrdelegate.ai/dashboard')}
<p style="margin:24px 0 0;font-size:14px;color:#666666;">— MrDelegate Team</p>
`, email);
      },
    }
  ],

  onboardingTips: [
    {
      delayHours: 72,
      subject: "3 things power users do in week one",
      buildHtml: (name, email) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>
<p style="margin:0 0 16px;">Most users deploy basic applications. The power users go further:</p>
<p style="margin:0 0 8px;"><strong>1. Set automated deployments</strong> — configure CI/CD pipelines for seamless updates.</p>
<p style="margin:0 0 8px;"><strong>2. Customize resource allocation</strong> — allocate CPU and memory based on your specific workloads.</p>
<p style="margin:0 0 20px;"><strong>3. Monitor directly through Telegram</strong> — "What's my server load?" Get real-time answers.</p>
${ctaButton('Open Your Dashboard', 'https://mrdelegate.ai/dashboard')}
<p style="margin:24px 0 0;font-size:14px;color:#666666;">— MrDelegate Team</p>
`, email);
      },
    },
    {
      delayHours: 168,
      subject: "One week in — here's what your server has accomplished",
      buildHtml: (name, email) => {
        const n = safeName(name);
        return brandedEmail(`
<p style="margin:0 0 20px;">Hey ${n},</p>
<p style="margin:0 0 20px;">One week. Seven performance reports. Seven nightly optimizations. Your server has been learning your usage patterns every day.</p>
<p style="margin:0 0 12px;">At this point your hosting environment optimizes for:</p>
<p style="margin:0 0 6px;">— Which applications require the most resources</p>
<p style="margin:0 0 6px;">— When you have peak traffic vs. low usage periods</p>
<p style="margin:0 0 20px;">— What kind of workloads to prioritize vs. deprioritize</p>
<p style="margin:0;font-size:14px;color:#666666;">And it's still getting better. Every single night. That's the compound effect — month one is good, month three is enterprise-level.</p>
`, email);
      },
    }
  ],
};

// ── Legacy compatibility ────────────────────────────────────────
export function withFooter(html, email) {
  const unsubUrl = `https://mrdelegate.ai/unsubscribe?email=${encodeURIComponent(email)}`;
  return `${html}
<div style="margin-top:40px;padding-top:20px;border-top:1px solid #eeeeee;font-size:12px;color:#999999;font-family:sans-serif">
  <p style="margin:0">MrDelegate &middot; 6 Sycamore Way, Mount Arlington, NJ 07856</p>
  <p style="margin:4px 0 0">You're receiving this because you signed up for MrDelegate. <a href="${unsubUrl}" style="color:#999999">Unsubscribe</a></p>
</div>`;
}

// ── Build email from sequence ───────────────────────────────────
// Used by both direct send and queue processor
// `context` is optional extra data (e.g. { bot_username }) for dynamic emails
export function buildSequenceEmail(sequenceName, stepIndex, name, email, context = {}) {
  const seq = SEQUENCES[sequenceName];
  if (!seq || !seq[stepIndex]) {
    throw new Error(`Unknown sequence/step: ${sequenceName}[${stepIndex}]`);
  }
  const step = seq[stepIndex];
  // Null-guard context — templates access context.bot_username etc. directly
  const safeContext = context != null && typeof context === 'object' ? context : {};
  return {
    subject: typeof step.subject === 'function' ? step.subject(name) : step.subject,
    html: step.buildHtml(name, email, safeContext),
  };
}
