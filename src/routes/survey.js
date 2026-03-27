/**
 * survey.js — Cancellation Feedback Survey
 *
 * GET  /survey/cancel?token=<jwt>  — serves the survey HTML form
 * POST /api/survey/cancel          — records reason, updates cancellation_feedback
 */

import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import supabase from '../services/supabase.js';

export const surveyRoutes = new Hono();

const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET || process.env.JWT_SECRET || '';

// ─── Survey HTML ──────────────────────────────────────────────────────────────

function surveyHtml(token, customerName, error = null) {
  const name = customerName ? customerName.split(' ')[0] : 'there';
  const errorHtml = error
    ? `<div class="error">${error}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Quick question before you go — MrDelegate</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0A0A0F;
    color: #E0E0F0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    background: #111118;
    border: 1px solid #2A2A3A;
    border-radius: 16px;
    padding: 40px;
    max-width: 520px;
    width: 100%;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 28px;
  }
  .logo-mark {
    width: 36px; height: 36px;
    background: linear-gradient(135deg, #6366F1, #8B5CF6);
    border-radius: 9px;
    display: grid; place-items: center;
  }
  .logo-mark svg { width: 18px; height: 18px; }
  .logo-name { font-size: 16px; font-weight: 700; color: #F0F0FF; }
  h1 { font-size: 22px; font-weight: 700; color: #F0F0FF; margin-bottom: 8px; }
  .subtitle { font-size: 14px; color: #9090AA; margin-bottom: 28px; line-height: 1.5; }
  .options { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
  label.option {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 16px;
    border: 1px solid #2A2A3A;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
    font-size: 14px;
    color: #D0D0E8;
  }
  label.option:hover { border-color: #6366F1; background: rgba(99,102,241,0.06); }
  label.option input[type=radio] { accent-color: #6366F1; width: 16px; height: 16px; flex-shrink: 0; }
  label.option.selected { border-color: #6366F1; background: rgba(99,102,241,0.10); color: #F0F0FF; }
  .text-area {
    width: 100%; padding: 12px 14px;
    background: #1A1A24; border: 1px solid #2A2A3A;
    border-radius: 10px; color: #D0D0E8;
    font-size: 14px; font-family: inherit;
    resize: vertical; min-height: 80px;
    margin-bottom: 20px;
    transition: border-color 0.15s;
  }
  .text-area:focus { outline: none; border-color: #6366F1; }
  .btn {
    width: 100%; padding: 14px;
    background: linear-gradient(135deg, #6366F1, #8B5CF6);
    border: none; border-radius: 10px;
    color: white; font-size: 15px; font-weight: 600;
    cursor: pointer; transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.9; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .skip { text-align: center; margin-top: 16px; }
  .skip a { color: #5A5A7A; font-size: 13px; text-decoration: none; }
  .skip a:hover { color: #9090AA; }
  .error { background: rgba(220,38,38,0.1); border: 1px solid rgba(220,38,38,0.3); color: #FCA5A5; padding: 12px 14px; border-radius: 8px; margin-bottom: 20px; font-size: 13px; }
  .thank-you { text-align: center; }
  .thank-you .checkmark { font-size: 48px; margin-bottom: 16px; }
  .thank-you h2 { font-size: 22px; font-weight: 700; color: #F0F0FF; margin-bottom: 10px; }
  .thank-you p { color: #9090AA; font-size: 14px; line-height: 1.6; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-mark">
      <svg viewBox="0 0 16 16" fill="none">
        <rect x="1" y="1" width="6" height="6" rx="1.5" fill="white" opacity="0.9"/>
        <rect x="9" y="1" width="6" height="6" rx="1.5" fill="white" opacity="0.5"/>
        <rect x="1" y="9" width="6" height="6" rx="1.5" fill="white" opacity="0.5"/>
        <rect x="9" y="9" width="6" height="6" rx="1.5" fill="white" opacity="0.9"/>
      </svg>
    </div>
    <span class="logo-name">MrDelegate</span>
  </div>

  <h1>One quick question, ${name}</h1>
  <p class="subtitle">We're sorry to see you go. Your honest feedback helps us build something better. Takes 30 seconds.</p>

  ${errorHtml}

  <form method="POST" action="/api/survey/cancel" id="survey-form">
    <input type="hidden" name="token" value="${token}">

    <div class="options">
      <label class="option" onclick="selectOption(this)">
        <input type="radio" name="reason_category" value="too_expensive" required>
        It was too expensive
      </label>
      <label class="option" onclick="selectOption(this)">
        <input type="radio" name="reason_category" value="didnt_work">
        It didn't work as expected
      </label>
      <label class="option" onclick="selectOption(this)">
        <input type="radio" name="reason_category" value="not_using">
        I'm not using it enough
      </label>
      <label class="option" onclick="selectOption(this)">
        <input type="radio" name="reason_category" value="competitor">
        Switching to a competitor
      </label>
      <label class="option" onclick="selectOption(this)">
        <input type="radio" name="reason_category" value="missing_feature">
        A feature I need is missing
      </label>
      <label class="option" onclick="selectOption(this)">
        <input type="radio" name="reason_category" value="other">
        Something else
      </label>
    </div>

    <textarea class="text-area" name="reason_text" placeholder="Tell us more (optional) — what could we have done better?"></textarea>

    <button type="submit" class="btn" id="submit-btn">Send Feedback</button>
  </form>

  <div class="skip">
    <a href="https://mrdelegate.ai">Skip — take me home</a>
  </div>
</div>

<script>
function selectOption(label) {
  document.querySelectorAll('.option').forEach(l => l.classList.remove('selected'));
  label.classList.add('selected');
}
document.getElementById('survey-form').addEventListener('submit', function(e) {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
});
</script>
</body>
</html>`;
}

function thankYouHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Thank you — MrDelegate</title>
<style>
  * { margin:0;padding:0;box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0A0A0F;color:#E0E0F0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px; }
  .card { background:#111118;border:1px solid #2A2A3A;border-radius:16px;padding:48px 40px;max-width:480px;width:100%;text-align:center; }
  .checkmark { font-size:52px;margin-bottom:20px; }
  h2 { font-size:24px;font-weight:700;color:#F0F0FF;margin-bottom:12px; }
  p { color:#9090AA;font-size:14px;line-height:1.7;margin-bottom:24px; }
  a { display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#6366F1,#8B5CF6);border-radius:8px;color:white;font-size:14px;font-weight:600;text-decoration:none; }
</style>
</head>
<body>
<div class="card">
  <div class="checkmark">🙏</div>
  <h2>Thank you for your feedback</h2>
  <p>Every piece of feedback makes us better. We read every response personally.<br><br>If your reason was a missing feature or a bug, we may reach out when it's fixed — we'd love to have you back.</p>
  <a href="https://mrdelegate.ai">Back to MrDelegate</a>
</div>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /survey/cancel?token=<jwt>
surveyRoutes.get('/cancel', async (c) => {
  const token = c.req.query('token');
  if (!token) {
    return c.html('<h2>Invalid survey link.</h2>', 400);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, CUSTOMER_JWT_SECRET);
  } catch {
    return c.html('<h2>This survey link has expired or is invalid.</h2>', 400);
  }

  return c.html(surveyHtml(token, decoded.name || ''));
});

// POST /api/survey/cancel
surveyRoutes.post('/submit', async (c) => {
  let body;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.html(surveyHtml('', '', 'Could not parse form. Please try again.'), 400);
  }

  const { token, reason_category, reason_text } = body;

  if (!token) return c.html('<h2>Missing token.</h2>', 400);

  let decoded;
  try {
    decoded = jwt.verify(token, CUSTOMER_JWT_SECRET);
  } catch {
    return c.html('<h2>This survey link has expired.</h2>', 400);
  }

  if (!reason_category) {
    return c.html(surveyHtml(token, decoded.name || '', 'Please select a reason before submitting.'), 400);
  }

  // Update the cancellation_feedback row
  try {
    const { error } = await supabase
      .from('cancellation_feedback')
      .update({
        reason_category,
        reason_text: reason_text || null,
        survey_completed: true,
        survey_completed_at: new Date().toISOString(),
      })
      .eq('survey_token', token);

    if (error) {
      console.error('[survey] Supabase update error:', error.message);
    }
  } catch (err) {
    console.error('[survey] DB update failed:', err.message);
  }

  // Notify founder via Telegram
  try {
    const founderChatId = process.env.FOUNDER_TELEGRAM_ID;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (founderChatId && botToken) {
      const name = decoded.name || decoded.email || 'unknown';
      const reasonLabel = reason_category.replace(/_/g, ' ');
      const textNote  = reason_text ? `\n"${reason_text}"` : '';
      const msg = `📋 <b>Churn Survey Response</b>\n\n<b>${name}</b> cancelled — reason: <b>${reasonLabel}</b>${textNote}`;
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: founderChatId, text: msg, parse_mode: 'HTML' }),
      });
    }
  } catch (err) {
    console.error('[survey] Telegram notify error:', err.message);
  }

  return c.html(thankYouHtml());
});
