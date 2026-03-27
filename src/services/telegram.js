/**
 * Telegram Bot API service
 * Used to send first-contact message to customers after VPS provisioning.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Send a message to a Telegram chat_id.
 * Returns true on success, false on failure (non-fatal).
 */
export async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) {
    console.error('[telegram] TELEGRAM_BOT_TOKEN not configured');
    return false;
  }
  if (!chatId) {
    console.log('[telegram] No chat_id — cannot send message. Customer must start bot first.');
    return false;
  }
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('[telegram] sendMessage failed:', data.description);
      return false;
    }
    console.log('[telegram] Message sent to chat_id:', chatId);
    return true;
  } catch (err) {
    console.error('[telegram] sendMessage error:', err.message);
    return false;
  }
}

/**
 * Send the first "I'm alive" message to a new customer after provisioning.
 * If no chat_id yet, logs a pending note to Supabase (caller handles that).
 */
export async function sendProvisioningWelcome(customer) {
  const name = customer.name || 'there';
  const message =
    `Hey ${name}! 👋 Your OpenClaw hosting is live and ready. ` +
    `What timezone are you in? (I'll optimize server maintenance windows accordingly.)`;

  if (!customer.telegram_chat_id) {
    console.log(`[telegram] No chat_id for ${customer.email} — welcome message pending until they start the bot.`);
    return { sent: false, pending: true };
  }

  const sent = await sendTelegramMessage(customer.telegram_chat_id, message);
  return { sent, pending: !sent };
}

/**
 * Send a welcome message to a new customer by channel handle.
 * Telegram requires the customer to message the bot first to get their chat_id.
 * This looks up the chat_id from Supabase if the customer has already started the bot,
 * otherwise logs that the welcome is pending until they send /start to the bot.
 * The /api/telegram/webhook endpoint handles first contact and sends the welcome automatically.
 */
export async function sendWelcomeMessage({ name, channelHandle, botToken }) {
  if (!channelHandle) {
    console.log('[telegram] sendWelcomeMessage: no channelHandle — skipping');
    return { pending: true };
  }

  try {
    // Dynamic import to avoid circular deps at module load time
    const { default: supabase } = await import('./supabase.js');
    const handle = channelHandle.replace(/^@/, '');
    const { data: customer } = await supabase
      .from('customers')
      .select('telegram_chat_id, email, name')
      .or(`channel_handle.eq.@${handle},channel_handle.eq.${handle}`)
      .maybeSingle();

    if (customer?.telegram_chat_id) {
      // Customer has already started the bot — send immediately
      const welcomeName = name || customer.name || 'there';
      const text =
        `Hey ${welcomeName}! 👋 Your OpenClaw hosting is live and ready. ` +
        `What timezone are you in? (I'll optimize server maintenance windows accordingly.)`;
      const sent = await sendTelegramMessage(customer.telegram_chat_id, text);
      return { sent, pending: false };
    }
  } catch (err) {
    console.error('[telegram] sendWelcomeMessage lookup error:', err.message);
  }

  // No chat_id yet — customer needs to send /start to the bot first.
  // The /api/telegram/webhook endpoint will fire when they do and send the welcome automatically.
  console.log(`[telegram] Welcome pending for @${channelHandle} — customer must send /start to the bot`);
  return { pending: true };
}
