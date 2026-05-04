import type { Env, Issue } from "./types";
import {
  getRegisteredChatId,
  indexTelegramMessage,
  lookupIssueByTelegramMessage,
  getLatestOpenIssue,
  putIssue,
  setRegisteredChatId,
} from "./kv";

const TG_API = "https://api.telegram.org";

interface TelegramSendResult {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
    reply_to_message?: { message_id: number };
  };
}

export async function tgSendMessage(
  env: Env,
  chatId: string,
  text: string,
  opts: { reply_to_message_id?: number; parse_mode?: "MarkdownV2" | "HTML" } = {},
): Promise<TelegramSendResult> {
  const res = await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...opts,
    }),
  });
  return (await res.json()) as TelegramSendResult;
}

export function formatEscalation(issue: Issue): string {
  const sev = issue.severity ? ` [${issue.severity.toUpperCase()}]` : "";
  const verb = issue.kind === "explicit" ? "asks" : "auto-escalation";
  const icon = issue.kind === "explicit" ? "❓" : "🚨";
  const lines = [
    `${icon} ${issue.account} ${verb}${sev}`,
    ``,
    issue.summary,
  ];
  if (issue.context) {
    lines.push(``, `— context —`, issue.context);
  }
  lines.push(``, `↩️ Reply to this message to respond. id: ${issue.id}`);
  return lines.join("\n");
}

export function formatResolution(issue: Issue): string {
  const lines = [
    `✅ Resolved: ${issue.summary}`,
  ];
  if (issue.outcome) lines.push(``, issue.outcome);
  lines.push(``, `id: ${issue.id}`);
  return lines.join("\n");
}

export async function handleTelegramWebhook(req: Request, env: Env): Promise<Response> {
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || got !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const update = (await req.json()) as TelegramUpdate;
  const msg = update.message;
  if (!msg || !msg.text) return new Response("ok");

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const fromName = msg.from?.username || msg.from?.first_name || "user";

  if (text.startsWith("/start")) {
    return await handleStart(env, chatId, text);
  }

  const registered = await getRegisteredChatId(env);
  if (!registered) {
    await tgSendMessage(env, chatId, "Bot not yet claimed. Send `/start <bootstrap-token>` to claim.");
    return new Response("ok");
  }
  if (chatId !== registered) {
    return new Response("ok");
  }

  if (text === "/status" || text === "/help") {
    await tgSendMessage(env, chatId, helpText());
    return new Response("ok");
  }

  let issue: Issue | null = null;
  if (msg.reply_to_message) {
    issue = await lookupIssueByTelegramMessage(env, msg.reply_to_message.message_id);
  }
  if (!issue) {
    issue = await getLatestOpenIssue(env);
  }
  if (!issue) {
    await tgSendMessage(env, chatId, "No open issue to attribute this reply to. Mickey will need to escalate first.");
    return new Response("ok");
  }

  issue.replies.push({
    text,
    from: fromName,
    telegram_message_id: msg.message_id,
    ts: Date.now(),
    delivered: false,
  });
  await putIssue(env, issue);

  await tgSendMessage(env, chatId, `📥 Saved reply for ${issue.id}. Mickey's Claude will pick it up on the next check.`, {
    reply_to_message_id: msg.message_id,
  });

  return new Response("ok");
}

async function handleStart(env: Env, chatId: string, text: string): Promise<Response> {
  const existing = await getRegisteredChatId(env);
  const parts = text.split(/\s+/);
  const token = parts[1];

  if (existing) {
    if (existing === chatId) {
      await tgSendMessage(env, chatId, "Already claimed by you. " + helpText());
    } else {
      await tgSendMessage(env, chatId, "This bot is already claimed.");
    }
    return new Response("ok");
  }

  if (!token || token !== env.ADMIN_BOOTSTRAP_TOKEN) {
    await tgSendMessage(env, chatId, "Send `/start <bootstrap-token>` with the token from your worker config to claim this bot.");
    return new Response("ok");
  }

  await setRegisteredChatId(env, chatId);
  await tgSendMessage(env, chatId, "✅ Bot claimed. " + helpText());
  return new Response("ok");
}

function helpText(): string {
  return [
    "I'll forward escalations from Mickey's Claude here.",
    "",
    "• Reply to any escalation to send guidance back.",
    "• A plain message attaches to the most recent open issue.",
    "• /help — this message",
  ].join("\n");
}

export async function notifyEscalation(env: Env, issue: Issue): Promise<void> {
  const chatId = await getRegisteredChatId(env);
  if (!chatId) return;
  const result = await tgSendMessage(env, chatId, formatEscalation(issue));
  if (result.ok && result.result) {
    issue.telegram_message_id = result.result.message_id;
    await putIssue(env, issue);
    await indexTelegramMessage(env, result.result.message_id, issue.id);
  }
}

export async function notifyResolution(env: Env, issue: Issue): Promise<void> {
  const chatId = await getRegisteredChatId(env);
  if (!chatId) return;
  const opts: { reply_to_message_id?: number } = {};
  if (issue.telegram_message_id) opts.reply_to_message_id = issue.telegram_message_id;
  await tgSendMessage(env, chatId, formatResolution(issue), opts);
}
