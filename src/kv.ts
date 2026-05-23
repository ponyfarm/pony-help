import type { Account, AccountRecord, Env, Issue, IssueStatus } from "./types";

const ISSUE_PREFIX = "issue:";
const TG_MSG_INDEX_PREFIX = "tgmsg:";
const ACCOUNT_PREFIX = "account:";
const CHAT_ID_KEY = "chat_id";
const LATEST_OPEN_KEY = "latest_open_issue";
const ISSUE_COUNTER_KEY = "issue_counter";

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
  const candidates = issueIdCandidates(id);
  for (const candidate of candidates) {
    const raw = await env.PONY_KV.get(`${ISSUE_PREFIX}${candidate}`);
    if (raw) return JSON.parse(raw) as Issue;
  }
  return null;
}

export async function putIssue(env: Env, issue: Issue): Promise<void> {
  await env.PONY_KV.put(`${ISSUE_PREFIX}${issue.id}`, JSON.stringify(issue));
}

export async function nextIssueId(env: Env): Promise<string> {
  const [counterRaw, issues] = await Promise.all([
    env.PONY_KV.get(ISSUE_COUNTER_KEY),
    listIssues(env, 1000, undefined, 1000),
  ]);
  let max = parsePositiveInteger(counterRaw) ?? 0;
  for (const issue of issues) {
    max = Math.max(max, parseHelpIssueNumber(issue.id) ?? 0);
  }

  for (let offset = 1; offset <= 1000; offset += 1) {
    const candidateNumber = max + offset;
    const candidate = formatIssueId(candidateNumber);
    if (!(await getIssue(env, candidate))) {
      await env.PONY_KV.put(ISSUE_COUNTER_KEY, String(candidateNumber));
      return candidate;
    }
  }

  throw new Error("Could not allocate a new HELP issue id.");
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

export async function listIssues(
  env: Env,
  limit = 50,
  status?: IssueStatus,
  scanLimit = 1000,
): Promise<Issue[]> {
  const issues: Issue[] = [];
  let cursor: string | undefined;
  let scanned = 0;

  while (scanned < scanLimit) {
    const list = await env.PONY_KV.list({
      prefix: ISSUE_PREFIX,
      limit: Math.min(1000, scanLimit - scanned),
      cursor,
    });
    scanned += list.keys.length;
    for (const key of list.keys) {
      const raw = await env.PONY_KV.get(key.name);
      if (!raw) continue;
      const issue = JSON.parse(raw) as Issue;
      if (!status || issue.status === status) issues.push(issue);
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  return issues.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
}

function issueIdCandidates(id: string): string[] {
  const clean = id.trim();
  const normalized = normalizeIssueId(clean);
  if (normalized === clean) return [clean];
  return [normalized, clean];
}

function normalizeIssueId(id: string): string {
  const clean = id.trim();
  const numberOnly = parsePositiveInteger(clean);
  if (numberOnly !== undefined) return formatIssueId(numberOnly);

  const prefix = "help-";
  if (clean.length > prefix.length && clean.slice(0, prefix.length).toLowerCase() === prefix) {
    const number = parsePositiveInteger(clean.slice(prefix.length));
    if (number !== undefined) return formatIssueId(number);
  }
  return clean;
}

function formatIssueId(value: number): string {
  return `HELP-${value}`;
}

function parseHelpIssueNumber(id: string): number | undefined {
  const clean = id.trim();
  const prefix = "help-";
  if (clean.length <= prefix.length || clean.slice(0, prefix.length).toLowerCase() !== prefix) {
    return undefined;
  }
  return parsePositiveInteger(clean.slice(prefix.length));
}

function parsePositiveInteger(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 48 || code > 57) return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}
