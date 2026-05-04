#!/usr/bin/env node
// Sets the Telegram webhook to point at your deployed Worker.
// Usage:
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... WORKER_URL=https://pony-help.<acct>.workers.dev \
//     node scripts/set-telegram-webhook.mjs

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const workerUrl = process.env.WORKER_URL;

if (!token || !secret || !workerUrl) {
  console.error("Missing TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, or WORKER_URL");
  process.exit(1);
}

const url = `${workerUrl.replace(/\/$/, "")}/tg/webhook`;
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  }),
});
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
if (!body.ok) process.exit(1);
