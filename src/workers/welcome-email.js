/**
 * Welcome Email Worker
 * Sends onboarding emails to new customers after signup
 */

import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendWelcomeEmail({ email, name, plan }) {
  const firstName = name?.split(' ')[0] || 'there';
  
  const { data, error } = await resend.emails.send({
    from: 'MrDelegate <team@mrdelegate.ai>',
    to: email,
    subject: `Welcome to OpenClaw hosting! Your server is deploying 🚀`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0a0a0f; color: #e4e4e7; margin: 0; padding: 40px 20px; }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { color: #fff; margin-bottom: 24px; }
    p { color: #a1a1aa; line-height: 1.8; margin-bottom: 16px; }
    .highlight { color: #6366f1; font-weight: 600; }
    .cta { display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0; }
    .steps { background: #12121a; border-radius: 12px; padding: 24px; margin: 24px 0; }
    .step { display: flex; gap: 16px; margin-bottom: 16px; }
    .step-num { background: #6366f1; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; }
    .footer { border-top: 1px solid rgba(255,255,255,0.1); margin-top: 40px; padding-top: 24px; color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Hey ${firstName}! 👋</h1>
    <p>Welcome to OpenClaw hosting! Your <span class="highlight">${plan || 'dedicated'}</span> server is being deployed right now.</p>
    <p>In about 60 seconds, you'll have your own private hosting environment running on dedicated infrastructure.</p>
    <a href="https://mrdelegate.ai/welcome" class="cta">Check Deployment Status →</a>
    <div class="steps">
      <p style="color: #fff; font-weight: 600; margin-bottom: 16px;">What's happening now:</p>
      <div class="step"><div class="step-num">1</div><div><p style="color: #fff; margin: 0 0 4px;">Server provisioning</p><p style="margin: 0; font-size: 14px;">We're spinning up your dedicated VPS</p></div></div>
      <div class="step"><div class="step-num">2</div><div><p style="color: #fff; margin: 0 0 4px;">OpenClaw installation</p><p style="margin: 0; font-size: 14px;">Installing and configuring your OpenClaw platform</p></div></div>
      <div class="step"><div class="step-num">3</div><div><p style="color: #fff; margin: 0 0 4px;">Ready to connect</p><p style="margin: 0; font-size: 14px;">You'll get a QR code to connect via Telegram/Discord</p></div></div>
    </div>
    <p>Questions? Just reply to this email — a real human will help you out.</p>
    <p>— The MrDelegate Team</p>
    <div class="footer"><p>MrDelegate · Managed OpenClaw Hosting</p></div>
  </div>
</body>
</html>
    `,
  });

  if (error) {
    console.error('[welcome-email] Failed to send:', error);
    throw error;
  }
  console.log(`[welcome-email] Sent to ${email}, id: ${data.id}`);
  return data;
}

export default sendWelcomeEmail;
