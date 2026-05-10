import type { Env, Issue } from "./types";
import {
  getIssue,
  getRegisteredChatId,
  indexTelegramMessage,
  lookupIssueByTelegramMessage,
  getLatestOpenIssue,
  listAccounts,
  listIssues,
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

  if (text.startsWith("/") && await handleCommand(env, chatId, text)) {
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
    await tgSendMessage(env, chatId, "No open issue to attribute this reply to. The user will need to escalate first.");
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

  await tgSendMessage(env, chatId, `📥 Saved reply for ${issue.id}. ${issue.account}'s Claude will pick it up on the next check.`, {
    reply_to_message_id: msg.message_id,
  });

  return new Response("ok");
}

async function handleCommand(env: Env, chatId: string, text: string): Promise<boolean> {
  const [rawCommand, arg] = text.split(/\s+/, 2);
  const command = rawCommand.split("@", 1)[0].toLowerCase();

  switch (command) {
    case "/help":
      await tgSendMessage(env, chatId, helpText());
      return true;
    case "/status":
      await tgSendMessage(env, chatId, await statusText(env));
      return true;
    case "/issues":
      await tgSendMessage(env, chatId, await issuesText(env, parseLimit(arg)));
      return true;
    case "/issue":
      await tgSendMessage(env, chatId, await issueText(env, arg));
      return true;
    case "/accounts":
      await tgSendMessage(env, chatId, await accountsText(env));
      return true;
    default:
      return false;
  }
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
    "I'll forward escalations from connected users' Claude sessions here.",
    "",
    "• Reply to any escalation to send guidance back.",
    "• A plain message attaches to the most recent open issue.",
    "• /status — current bot and issue state",
    "• /issues [limit] — recent issues",
    "• /issue <id> — one issue's detail",
    "• /accounts — registered account names",
    "• /help — this message",
  ].join("\n");
}

async function statusText(env: Env): Promise<string> {
  const [issues, accounts, latestOpen] = await Promise.all([
    listIssues(env),
    listAccounts(env),
    getLatestOpenIssue(env),
  ]);
  const open = issues.filter((issue) => issue.status === "open");
  const resolved = issues.filter((issue) => issue.status === "resolved");
  const pendingReplies = issues.reduce(
    (sum, issue) => sum + issue.replies.filter((reply) => !reply.delivered).length,
    0,
  );
  const latestIssue = issues[0];

  const lines = [
    "pony-help status",
    "",
    `protocol: ${env.PROTOCOL_VERSION}`,
    `reviewer: ${env.REVIEWER_NAME || "the reviewer"}`,
    `accounts: ${accounts.length}`,
    `issues: ${issues.length} total, ${open.length} open, ${resolved.length} resolved`,
    `pending replies: ${pendingReplies}`,
  ];

  if (latestOpen) {
    lines.push("", `latest open: ${issueLine(latestOpen)}`);
  }
  if (latestIssue && latestIssue.id !== latestOpen?.id) {
    lines.push(`latest issue: ${issueLine(latestIssue)}`);
  }

  return lines.join("\n");
}

async function issuesText(env: Env, limit: number): Promise<string> {
  const issues = await listIssues(env, limit);
  if (issues.length === 0) return "No issues found.";

  return [
    `recent issues (${issues.length})`,
    "",
    ...issues.map(issueLine),
  ].join("\n");
}

async function issueText(env: Env, id?: string): Promise<string> {
  const cleanId = id?.trim();
  if (!cleanId) return "Usage: /issue <id>";

  const issue = await getIssue(env, cleanId);
  if (!issue) return `No such issue: ${cleanId}`;

  const pendingReplies = issue.replies.filter((reply) => !reply.delivered).length;
  const lines = [
    `issue ${issue.id}`,
    "",
    `account: ${issue.account}`,
    `status: ${issue.status}`,
    `kind: ${issue.kind}`,
    `severity: ${issue.severity || "none"}`,
    `created: ${formatTs(issue.created_at)}`,
    `resolved: ${issue.resolved_at ? formatTs(issue.resolved_at) : "no"}`,
    `telegram message: ${issue.telegram_message_id ?? "none"}`,
    `replies: ${issue.replies.length} total, ${pendingReplies} pending delivery`,
    "",
    `summary: ${clip(issue.summary, 600)}`,
  ];

  if (issue.outcome) lines.push("", `outcome: ${clip(issue.outcome, 600)}`);
  if (issue.context) lines.push("", "context:", clip(issue.context, 1200));

  return lines.join("\n");
}

async function accountsText(env: Env): Promise<string> {
  const accounts = await listAccounts(env);
  if (accounts.length === 0) return "No accounts found.";

  return [
    `accounts (${accounts.length})`,
    "",
    ...accounts.map((account) => `• ${account.name} — created ${formatTs(account.created_at)}`),
  ].join("\n");
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(Math.floor(parsed), 1), 10);
}

function issueLine(issue: Issue): string {
  const sev = issue.severity ? `/${issue.severity}` : "";
  const pending = issue.replies.filter((reply) => !reply.delivered).length;
  const replyState = issue.replies.length ? `, ${issue.replies.length} replies/${pending} pending` : "";
  return `• ${issue.id} ${issue.status}${sev} ${issue.account} — ${clip(issue.summary, 96)} (${formatTs(issue.created_at)}${replyState})`;
}

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace(".000Z", "Z");
}

function clip(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
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
