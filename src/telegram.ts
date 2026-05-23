import type { Env, Issue, IssueStatus } from "./types";
import {
  deleteAccount,
  getIssue,
  getRegisteredChatId,
  indexTelegramMessage,
  listAccountRecords,
  lookupIssueByTelegramMessage,
  getLatestOpenIssue,
  listIssues,
  putAccount,
  putIssue,
  setRegisteredChatId,
} from "./kv";

const TG_API = "https://api.telegram.org";
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CHUNK_BODY_LIMIT = 3900;

interface TelegramSendResult {
  ok: boolean;
  result?: { message_id: number };
  results?: Array<{ message_id: number }>;
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
  const chunks = splitTelegramText(text);
  const results: Array<{ message_id: number }> = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkText = chunks.length === 1
      ? chunks[i]
      : `Part ${i + 1}/${chunks.length}\n\n${chunks[i]}`;
    const result = await tgSendSingleMessage(env, chatId, chunkText, opts);
    if (!result.ok) {
      return {
        ok: false,
        result: results[0],
        results,
        description: result.description,
      };
    }
    if (result.result) results.push(result.result);
  }

  return { ok: true, result: results[0], results };
}

async function tgSendSingleMessage(
  env: Env,
  chatId: string,
  text: string,
  opts: { reply_to_message_id?: number; parse_mode?: "MarkdownV2" | "HTML" },
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

function splitTelegramText(text: string): string[] {
  if (text.length === 0) return [" "];
  if (text.length <= TELEGRAM_TEXT_LIMIT) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const maxEnd = Math.min(start + TELEGRAM_CHUNK_BODY_LIMIT, text.length);
    const end = findTelegramChunkEnd(text, start, maxEnd);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function findTelegramChunkEnd(text: string, start: number, maxEnd: number): number {
  if (maxEnd >= text.length) return text.length;

  const minUsefulEnd = start + Math.floor((maxEnd - start) / 2);
  const newline = text.lastIndexOf("\n", maxEnd);
  if (newline > minUsefulEnd) return newline + 1;

  const space = text.lastIndexOf(" ", maxEnd);
  if (space > minUsefulEnd) return space + 1;

  return maxEnd;
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
  const mcpUrl = deriveMcpUrl(req.url);

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

  if (text.startsWith("/") && await handleCommand(env, chatId, text, mcpUrl)) {
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

async function handleCommand(env: Env, chatId: string, text: string, mcpUrl: string): Promise<boolean> {
  const { command, arg } = parseCommand(text);

  switch (command) {
    case "/help":
      await tgSendMessage(env, chatId, helpText());
      return true;
    case "/manage":
      await tgSendMessage(env, chatId, manageText());
      return true;
    case "/status":
      await tgSendMessage(env, chatId, await statusText(env));
      return true;
    case "/issues":
      await tgSendMessage(env, chatId, await issuesText(env, parseIssuesArgs(arg)));
      return true;
    case "/issue":
      await tgSendMessage(env, chatId, await issueText(env, arg));
      return true;
    case "/accounts":
      await tgSendMessage(env, chatId, await accountsText(env));
      return true;
    case "/connect":
      await tgSendMessage(env, chatId, await connectText(env, arg, mcpUrl));
      return true;
    case "/reconnect":
      await tgSendMessage(env, chatId, await reconnectText(env, arg, mcpUrl));
      return true;
    case "/revoke":
      await tgSendMessage(env, chatId, await revokeText(env, arg));
      return true;
    default:
      return false;
  }
}

function parseCommand(text: string): { command: string; arg: string | undefined } {
  const trimmed = text.trim();
  const splitAt = firstWhitespaceIndex(trimmed);
  const rawCommand = splitAt === -1 ? trimmed : trimmed.slice(0, splitAt);
  const arg = splitAt === -1 ? undefined : trimmed.slice(splitAt).trim();
  return {
    command: rawCommand.split("@", 1)[0].toLowerCase(),
    arg,
  };
}

function firstWhitespaceIndex(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    if (isAsciiWhitespace(value.charCodeAt(i))) return i;
  }
  return -1;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

function deriveMcpUrl(webhookUrl: string): string {
  const url = new URL(webhookUrl);
  const suffix = "/tg/webhook";
  url.pathname = url.pathname.endsWith(suffix)
    ? `${url.pathname.slice(0, -suffix.length)}/mcp`
    : "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function handleStart(env: Env, chatId: string, text: string): Promise<Response> {
  const existing = await getRegisteredChatId(env);
  const { arg: token } = parseCommand(text);

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
    "• /issues [status] [limit] — recent issues",
    "• /issue <id> — one issue's detail",
    "• /accounts — registered account names",
    "• /connect <name> — mint a Claude connection message",
    "• /reconnect <name> — rotate a helpee's connection message",
    "• /revoke <name> — revoke a helpee's active tokens",
    "• /manage — account management commands",
    "• /help — this message",
  ].join("\n");
}

function manageText(): string {
  return [
    "pony-help management",
    "",
    "• /connect <name> — mint a new connection message. Existing tokens stay active.",
    "• /reconnect <name> — revoke existing tokens for that exact name and mint a fresh connection message.",
    "• /revoke <name> — revoke all active tokens for that exact name.",
    "• /accounts — list helpees and active token counts.",
    "",
    "Names can include spaces. Send generated connection messages to helpees over a secure channel.",
  ].join("\n");
}

async function statusText(env: Env): Promise<string> {
  const [issues, accountRecords, latestOpen] = await Promise.all([
    listIssues(env),
    listAccountRecords(env),
    getLatestOpenIssue(env),
  ]);
  const open = issues.filter((issue) => issue.status === "open");
  const resolved = issues.filter((issue) => issue.status === "resolved");
  const pendingReplies = issues.reduce(
    (sum, issue) => sum + issue.replies.filter((reply) => !reply.delivered).length,
    0,
  );
  const latestIssue = issues[0];
  const helpeeCount = groupAccountRecords(accountRecords).length;

  const lines = [
    "pony-help status",
    "",
    `protocol: ${env.PROTOCOL_VERSION}`,
    `reviewer: ${env.REVIEWER_NAME || "the reviewer"}`,
    `accounts: ${helpeeCount} helpees, ${accountRecords.length} active tokens`,
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

async function issuesText(env: Env, args: IssuesArgs): Promise<string> {
  const issues = await listIssues(env, args.limit, args.status);
  const statusLabel = args.status ? `${args.status} ` : "";
  if (issues.length === 0) return `No ${statusLabel}issues found.`;

  return [
    `recent ${statusLabel}issues (${issues.length})`,
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
    `summary: ${issue.summary}`,
  ];

  if (issue.outcome) lines.push("", `outcome: ${issue.outcome}`);
  if (issue.context) lines.push("", "context:", issue.context);

  return lines.join("\n");
}

async function accountsText(env: Env): Promise<string> {
  const records = await listAccountRecords(env);
  if (records.length === 0) return "No accounts found.";

  const groups = groupAccountRecords(records);

  return [
    `accounts (${groups.length} helpees, ${records.length} active tokens)`,
    "",
    ...groups.map((group) => {
      const plural = group.count === 1 ? "token" : "tokens";
      return `• ${group.name} — ${group.count} active ${plural}, newest ${formatTs(group.newestCreatedAt)}`;
    }),
  ].join("\n");
}

async function connectText(env: Env, rawName: string | undefined, mcpUrl: string): Promise<string> {
  const name = cleanAccountName(rawName);
  if (!name) return "Usage: /connect <name>";

  const { token } = await mintAccount(env, name);
  return [
    `Minted a new pony-help connection for ${name}. Existing tokens for this name are still active.`,
    "",
    connectionMessage(name, token, mcpUrl),
  ].join("\n");
}

async function reconnectText(env: Env, rawName: string | undefined, mcpUrl: string): Promise<string> {
  const name = cleanAccountName(rawName);
  if (!name) return "Usage: /reconnect <name>";

  const revoked = await revokeAccountsByName(env, name);
  const { token } = await mintAccount(env, name);
  const tokenWord = revoked === 1 ? "token" : "tokens";
  return [
    `Rotated pony-help for ${name}. Revoked ${revoked} old ${tokenWord}.`,
    "",
    connectionMessage(name, token, mcpUrl),
  ].join("\n");
}

async function revokeText(env: Env, rawName: string | undefined): Promise<string> {
  const name = cleanAccountName(rawName);
  if (!name) return "Usage: /revoke <name>";

  const revoked = await revokeAccountsByName(env, name);
  if (revoked === 0) return `No active tokens found for ${name}.`;
  const tokenWord = revoked === 1 ? "token" : "tokens";
  return `Revoked ${revoked} active ${tokenWord} for ${name}.`;
}

async function mintAccount(env: Env, name: string): Promise<{ token: string }> {
  const token = makeToken();
  await putAccount(env, token, { name, created_at: Date.now() });
  return { token };
}

async function revokeAccountsByName(env: Env, name: string): Promise<number> {
  const target = normalizeAccountName(name);
  const records = await listAccountRecords(env);
  const matches = records.filter((record) => normalizeAccountName(record.account.name) === target);
  await Promise.all(matches.map((record) => deleteAccount(env, record.token)));
  return matches.length;
}

function connectionMessage(name: string, token: string, mcpUrl: string): string {
  return [
    "Send this to the helpee:",
    "",
    "Hey Claude — please set up the `pony-help` MCP server so you can escalate issues to my reviewer over Telegram.",
    "",
    "Run this command:",
    "```",
    `claude mcp add --transport http pony-help ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    "```",
    "",
    "Then list the tools from `pony-help` and confirm you see `escalate_issue`, `ask_reviewer`, `check_responses`, and `mark_resolved`.",
    "",
    "If `pony-help` already exists on this Claude instance, remove it first with `claude mcp remove pony-help`, then run the add command again.",
    "",
    `Connection owner: ${name}`,
  ].join("\n");
}

function groupAccountRecords(records: Awaited<ReturnType<typeof listAccountRecords>>): Array<{
  name: string;
  count: number;
  newestCreatedAt: number;
}> {
  const groups = new Map<string, { name: string; count: number; newestCreatedAt: number }>();
  for (const record of records) {
    const normalized = normalizeAccountName(record.account.name);
    const existing = groups.get(normalized);
    if (existing) {
      existing.count += 1;
      existing.newestCreatedAt = Math.max(existing.newestCreatedAt, record.account.created_at);
    } else {
      groups.set(normalized, {
        name: record.account.name,
        count: 1,
        newestCreatedAt: record.account.created_at,
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function cleanAccountName(rawName: string | undefined): string | null {
  const name = rawName?.trim().replace(/\s+/g, " ");
  if (!name) return null;
  return name.slice(0, 80);
}

function normalizeAccountName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

interface IssuesArgs {
  limit: number;
  status?: IssueStatus;
}

function parseIssuesArgs(raw: string | undefined): IssuesArgs {
  const args = splitFields(raw ?? "");
  let limit = 5;
  let status: IssueStatus | undefined;

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === "open" || lower === "resolved") {
      status = lower;
      continue;
    }
    if (lower === "all") {
      status = undefined;
      continue;
    }
    const parsed = Number(arg);
    if (Number.isFinite(parsed)) limit = Math.min(Math.max(Math.floor(parsed), 1), 10);
  }

  return { limit, status };
}

function splitFields(value: string): string[] {
  const fields: string[] = [];
  let start: number | undefined;

  for (let i = 0; i < value.length; i += 1) {
    if (isAsciiWhitespace(value.charCodeAt(i))) {
      if (start !== undefined) {
        fields.push(value.slice(start, i));
        start = undefined;
      }
    } else if (start === undefined) {
      start = i;
    }
  }

  if (start !== undefined) fields.push(value.slice(start));
  return fields;
}

function makeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const messageIds = result.results?.map((message) => message.message_id) ?? [];
  if (messageIds.length > 0) {
    issue.telegram_message_id = messageIds[0];
    await putIssue(env, issue);
    await Promise.all(messageIds.map((messageId) => indexTelegramMessage(env, messageId, issue.id)));
  }
}

export async function notifyResolution(env: Env, issue: Issue): Promise<void> {
  const chatId = await getRegisteredChatId(env);
  if (!chatId) return;
  const opts: { reply_to_message_id?: number } = {};
  if (issue.telegram_message_id) opts.reply_to_message_id = issue.telegram_message_id;
  await tgSendMessage(env, chatId, formatResolution(issue), opts);
}
