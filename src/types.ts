export interface Env {
  PONY_KV: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_BOOTSTRAP_TOKEN: string;
  PROTOCOL_VERSION: string;
  REVIEWER_NAME?: string;
}

export type IssueStatus = "open" | "resolved";

export interface Reply {
  text: string;
  from: string;
  telegram_message_id: number;
  ts: number;
  delivered: boolean;
}

export interface Issue {
  id: string;
  account: string;
  summary: string;
  context?: string;
  severity?: "low" | "medium" | "high";
  kind: "auto" | "explicit";
  status: IssueStatus;
  created_at: number;
  resolved_at?: number;
  outcome?: string;
  telegram_message_id?: number;
  replies: Reply[];
}

export interface Account {
  name: string;
  created_at: number;
}
