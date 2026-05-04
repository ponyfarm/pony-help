#!/usr/bin/env node
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}
const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: "POST" });
console.log(JSON.stringify(await res.json(), null, 2));
