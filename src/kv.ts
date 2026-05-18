import type { Account, AccountRecord, Env, Issue } from "./types";

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

export async function putAccount(env: Env, token: string, account: Account): Promise<void> {
  await env.PONY_KV.put(`${ACCOUNT_PREFIX}${token}`, JSON.stringify(account));
}

export async function deleteAccount(env: Env, token: string): Promise<void> {
  await env.PONY_KV.delete(`${ACCOUNT_PREFIX}${token}`);
}

export async function listAccountRecords(env: Env, limit = 1000): Promise<AccountRecord[]> {
  const records: AccountRecord[] = [];
  let cursor: string | undefined;

  while (records.length < limit) {
    const list = await env.PONY_KV.list({
      prefix: ACCOUNT_PREFIX,
      limit: Math.min(1000, limit - records.length),
      cursor,
    });
    for (const key of list.keys) {
      const raw = await env.PONY_KV.get(key.name);
      if (!raw) continue;
      records.push({
        token: key.name.slice(ACCOUNT_PREFIX.length),
        account: JSON.parse(raw) as Account,
      });
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }
  return records.sort((a, b) => a.account.name.localeCompare(b.account.name));
}

export async function listAccounts(env: Env, limit = 1000): Promise<Account[]> {
  const records = await listAccountRecords(env, limit);
  return records.map((record) => record.account);
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
