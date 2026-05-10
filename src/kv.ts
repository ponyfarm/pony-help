import type { Account, Env, Issue } from "./types";

const ISSUE_PREFIX = "issue:";
const TG_MSG_INDEX_PREFIX = "tgmsg:";
const ACCOUNT_PREFIX = "account:";
const CHAT_ID_KEY = "chat_id";
const LATEST_OPEN_KEY = "latest_open_issue";

export async function getAccountByToken(env: Env, token: string): Promise<Account | null> {
  if (!token) return null;
  const raw = await env.PONY_KV.get(`${ACCOUNT_PREFIX}${token}`);
  return raw ? (JSON.parse(raw) as Account) : null;
}

export async function listAccounts(env: Env, limit = 100): Promise<Account[]> {
  const list = await env.PONY_KV.list({ prefix: ACCOUNT_PREFIX, limit });
  const accounts: Account[] = [];
  for (const key of list.keys) {
    const raw = await env.PONY_KV.get(key.name);
    if (raw) accounts.push(JSON.parse(raw) as Account);
  }
  return accounts.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRegisteredChatId(env: Env): Promise<string | null> {
  return env.PONY_KV.get(CHAT_ID_KEY);
}

export async function setRegisteredChatId(env: Env, chatId: string): Promise<void> {
  await env.PONY_KV.put(CHAT_ID_KEY, chatId);
}

export async function getIssue(env: Env, id: string): Promise<Issue | null> {
  const raw = await env.PONY_KV.get(`${ISSUE_PREFIX}${id}`);
  return raw ? (JSON.parse(raw) as Issue) : null;
}

export async function putIssue(env: Env, issue: Issue): Promise<void> {
  await env.PONY_KV.put(`${ISSUE_PREFIX}${issue.id}`, JSON.stringify(issue));
}

export async function indexTelegramMessage(
  env: Env,
  telegramMessageId: number,
  issueId: string,
): Promise<void> {
  await env.PONY_KV.put(`${TG_MSG_INDEX_PREFIX}${telegramMessageId}`, issueId);
}

export async function lookupIssueByTelegramMessage(
  env: Env,
  telegramMessageId: number,
): Promise<Issue | null> {
  const id = await env.PONY_KV.get(`${TG_MSG_INDEX_PREFIX}${telegramMessageId}`);
  if (!id) return null;
  return getIssue(env, id);
}

export async function setLatestOpenIssue(env: Env, issueId: string): Promise<void> {
  await env.PONY_KV.put(LATEST_OPEN_KEY, issueId);
}

export async function getLatestOpenIssue(env: Env): Promise<Issue | null> {
  const id = await env.PONY_KV.get(LATEST_OPEN_KEY);
  if (!id) return null;
  return getIssue(env, id);
}

export async function listIssues(env: Env, limit = 50): Promise<Issue[]> {
  const list = await env.PONY_KV.list({ prefix: ISSUE_PREFIX, limit });
  const issues: Issue[] = [];
  for (const key of list.keys) {
    const raw = await env.PONY_KV.get(key.name);
    if (raw) issues.push(JSON.parse(raw) as Issue);
  }
  return issues.sort((a, b) => b.created_at - a.created_at);
}
