import type { Account, Env, Issue } from "./types";
import {
  getIssue,
  getRegisteredChatId,
  listIssues,
  putIssue,
  setLatestOpenIssue,
} from "./kv";
import { notifyEscalation, notifyResolution } from "./telegram";

const ESCALATE_DESCRIPTION = [
  "Escalate the current situation to Sam (the human supervisor) via Telegram.",
  "",
  "CALL THIS WHEN ANY of:",
  "• You are stuck or have tried 2+ approaches that haven't worked.",
  "• You're about to do something destructive, irreversible, or expensive.",
  "• A user request is ambiguous in a way that materially affects the result.",
  "• You hit an authentication, permission, or external-system boundary you can't cross.",
  "• You suspect data loss, a regression, or a security concern.",
  "",
  "Write `summary` and `context` in English. If the user is communicating in another language, translate to English before calling — the reviewer reads English.",
  "",
  "Returns immediately with an issue_id. Sam will reply asynchronously via Telegram.",
  "After escalating, call `check_responses` between steps to pick up Sam's guidance.",
  "When the situation is handled, call `mark_resolved` so Sam knows it landed.",
].join("\n");

const ASK_SAM_DESCRIPTION = [
  "Forward an explicit question from Mickey (the user) to Sam via Telegram.",
  "Use when Mickey says things like 'ask Sam', 'check with Sam', 'get Sam's opinion'.",
  "Translate the question to English before calling if it's in another language — the reviewer reads English.",
  "Returns immediately with an issue_id. Poll `check_responses` for Sam's answer.",
].join("\n");

const CHECK_RESPONSES_DESCRIPTION = [
  "Fetch any new replies Sam has sent since the last check.",
  "Call this between steps after escalating, before asking the user to wait, or whenever you think Sam may have responded.",
  "Returns only undelivered replies and marks them delivered.",
  "When a reply arrives, present it to Mickey and ASK her to approve, modify, or reject before acting.",
  "Feel free to translate the reply into the user's language and rephrase it simply/clearly while preserving the reviewer's intent.",
].join("\n");

const MARK_RESOLVED_DESCRIPTION = [
  "Tell Sam an issue is resolved. Sends a Telegram follow-up so Sam knows the loop closed.",
  "Always call this after acting on Sam's guidance (or after Mickey decides to move on without it).",
].join("\n");

export const TOOL_DEFS = [
  {
    name: "escalate_issue",
    description: ESCALATE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One- to three-sentence description of the problem. What's stuck and what you've tried.",
        },
        context: {
          type: "string",
          description: "Optional. Relevant code, error messages, file paths, or links Sam needs to weigh in.",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Optional. high = blocking or potentially destructive; medium = need direction soon; low = sanity-check.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "ask_sam",
    description: ASK_SAM_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Mickey's question, in her words where possible." },
        context: { type: "string", description: "Optional supporting context." },
      },
      required: ["question"],
    },
  },
  {
    name: "check_responses",
    description: CHECK_RESPONSES_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        issue_id: {
          type: "string",
          description: "Optional. Limit to a single issue. Omit to fetch replies across all open issues.",
        },
      },
    },
  },
  {
    name: "mark_resolved",
    description: MARK_RESOLVED_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        issue_id: { type: "string", description: "The id returned by escalate_issue or ask_sam." },
        outcome: { type: "string", description: "One sentence on how it was resolved." },
      },
      required: ["issue_id", "outcome"],
    },
  },
] as const;

export async function callTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
  account: Account,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  switch (name) {
    case "escalate_issue":
      return await escalateIssue(env, args, "auto", account);
    case "ask_sam":
      return await escalateIssue(
        env,
        { summary: args.question, context: args.context },
        "explicit",
        account,
      );
    case "check_responses":
      return await checkResponses(env, args, account);
    case "mark_resolved":
      return await markResolved(env, args, account);
    default:
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
  }
}

async function ensureRegistered(env: Env): Promise<string | null> {
  return getRegisteredChatId(env);
}

async function escalateIssue(
  env: Env,
  args: Record<string, unknown>,
  kind: "auto" | "explicit",
  account: Account,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const chatId = await ensureRegistered(env);
  if (!chatId) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "The reviewer hasn't claimed the bot yet. Tell the user: 'pony-help is not yet configured — the reviewer needs to send /start <bootstrap-token> to the bot in Telegram.'",
        },
      ],
    };
  }

  const summary = String(args.summary ?? "").trim();
  if (!summary) {
    return { isError: true, content: [{ type: "text", text: "summary is required" }] };
  }

  const issue: Issue = {
    id: makeId(),
    account: account.name,
    summary,
    context: typeof args.context === "string" ? args.context : undefined,
    severity:
      args.severity === "low" || args.severity === "medium" || args.severity === "high"
        ? args.severity
        : undefined,
    kind,
    status: "open",
    created_at: Date.now(),
    replies: [],
  };

  await putIssue(env, issue);
  await setLatestOpenIssue(env, issue.id);
  await notifyEscalation(env, issue);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            issue_id: issue.id,
            status: "sent",
            note: "The reviewer was notified via Telegram. Continue working if you can; call check_responses between steps.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function checkResponses(
  env: Env,
  args: Record<string, unknown>,
  account: Account,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const filterId = typeof args.issue_id === "string" ? args.issue_id : undefined;
  const issues = filterId
    ? ([await getIssue(env, filterId)].filter(Boolean) as Issue[])
    : await listIssues(env);

  const owned = issues.filter((i) => i.account === account.name);

  const newReplies: Array<{
    issue_id: string;
    summary: string;
    status: string;
    reply: { from: string; text: string; ts: number };
  }> = [];

  for (const issue of owned) {
    let mutated = false;
    for (const reply of issue.replies) {
      if (!reply.delivered) {
        newReplies.push({
          issue_id: issue.id,
          summary: issue.summary,
          status: issue.status,
          reply: { from: reply.from, text: reply.text, ts: reply.ts },
        });
        reply.delivered = true;
        mutated = true;
      }
    }
    if (mutated) await putIssue(env, issue);
  }

  if (newReplies.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({ new_replies: [] }, null, 2) }],
    };
  }

  const reviewerName = env.REVIEWER_NAME || "the reviewer";
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            new_replies: newReplies,
            instruction: `Present each reply to the user verbatim, attributed as '${reviewerName}: "<reply text>"'. Ask them to approve, modify, or reject before acting.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function markResolved(
  env: Env,
  args: Record<string, unknown>,
  account: Account,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const id = String(args.issue_id ?? "");
  const outcome = String(args.outcome ?? "").trim();
  if (!id || !outcome) {
    return {
      isError: true,
      content: [{ type: "text", text: "issue_id and outcome are required" }],
    };
  }
  const issue = await getIssue(env, id);
  if (!issue) {
    return { isError: true, content: [{ type: "text", text: `No such issue: ${id}` }] };
  }
  if (issue.account !== account.name) {
    return { isError: true, content: [{ type: "text", text: `Not your issue: ${id}` }] };
  }
  issue.status = "resolved";
  issue.outcome = outcome;
  issue.resolved_at = Date.now();
  await putIssue(env, issue);
  await notifyResolution(env, issue);

  return {
    content: [{ type: "text", text: JSON.stringify({ issue_id: id, status: "resolved" }, null, 2) }],
  };
}

function makeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
