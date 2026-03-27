// Shared Telegram Bot - Routes messages to customer VPS
import supabase from "./supabase.js";

const BOT_TOKEN = process.env.SHARED_BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

export async function sendMessage(chatId, text, options = {}) {
  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...options }),
  });
  return res.json();
}

export async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();
  const firstName = msg.from.first_name || "there";

  console.log(`[shared-bot] Message from ${userId}: ${text.slice(0, 50)}`);

  // Find customer by telegram_chat_id
  const { data: customer } = await supabase
    .from("customers")
    .select("*")
    .eq("telegram_chat_id", String(chatId))
    .single();

  // /start command - link account or welcome back
  if (text === "/start") {
    if (customer) {
      await sendMessage(chatId, `Welcome back, ${firstName}! 👋\n\nI'm your OpenClaw instance. How can I help you today?`);
    } else {
      await sendMessage(chatId, 
        `Hey ${firstName}! 👋\n\n` +
        `I'm Mr. Delegate, your OpenClaw hosting platform.\n\n` +
        `To get started, I need to link your account.\n\n` +
        `<b>Enter your email address</b> (the one you signed up with):`
      );
    }
    return;
  }

  // Check if this is an email for linking
  if (!customer && text.includes("@")) {
    const email = text.toLowerCase().trim();
    const { data: found } = await supabase
      .from("customers")
      .select("*")
      .eq("email", email)
      .is("telegram_chat_id", null)
      .single();

    if (found) {
      // Link account
      await supabase
        .from("customers")
        .update({ telegram_chat_id: String(chatId) })
        .eq("id", found.id);

      await sendMessage(chatId,
        `✅ Account linked!\n\n` +
        `Welcome aboard, ${found.name || firstName}!\n\n` +
        `I'm now your OpenClaw instance. Here's what I can do:\n\n` +
        `📧 <b>Inbox Triage</b> - I'll summarize important emails\n` +
        `📅 <b>Calendar Protection</b> - I'll guard your focus time\n` +
        `☀️ <b>Morning Brief</b> - Daily summary at 7am\n\n` +
        `Next step: Connect your Gmail in the dashboard.\n` +
        `Your first morning brief arrives tomorrow at 7am!`
      );
      return;
    } else {
      await sendMessage(chatId, 
        `I couldn't find an account with that email.\n\n` +
        `Make sure you've signed up at mrdelegate.ai first, then try again.`
      );
      return;
    }
  }

  // No customer linked
  if (!customer) {
    await sendMessage(chatId, 
      `I don't recognize your account yet.\n\n` +
      `Send /start to begin, or enter your signup email.`
    );
    return;
  }

  // Customer found - route to their VPS
  if (customer.vps_ip && customer.vps_status === "active") {
    try {
      // Forward to customer VPS OpenClaw gateway
      const vpsResponse = await fetch(`http://${customer.vps_ip}:3377/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, userId, chatId }),
      });
      
      if (vpsResponse.ok) {
        const data = await vpsResponse.json();
        if (data.reply) {
          await sendMessage(chatId, data.reply);
        }
      } else {
        await sendMessage(chatId, "I'm having trouble connecting right now. Try again in a moment.");
      }
    } catch (err) {
      console.error(`[shared-bot] VPS error for ${customer.email}:`, err.message);
      await sendMessage(chatId, "I'm temporarily unavailable. Please try again shortly.");
    }
  } else {
    await sendMessage(chatId, 
      "Your OpenClaw instance is still being set up. Please check back in a few minutes!"
    );
  }
}

// Set webhook
export async function setWebhook(url) {
  const res = await fetch(`${API}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, allowed_updates: ["message"] }),
  });
  return res.json();
}
