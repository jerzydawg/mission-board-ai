import { Hono } from "hono";
import { handleUpdate } from "../services/shared-bot.js";

export const webhookRoutes = new Hono();

// Shared Telegram Bot Webhook
webhookRoutes.post("/telegram/shared", async (c) => {
  try {
    const update = await c.req.json();
    await handleUpdate(update);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[webhook] Telegram shared bot error:", err.message);
    return c.json({ ok: false });
  }
});
