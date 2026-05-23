import type { Env, IssueStatus } from "./types";
import { handleMcpRequest } from "./mcp";
import { handleTelegramWebhook } from "./telegram";
import { listIssues, getRegisteredChatId } from "./kv";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      return handleMcpRequest(req, env);
    }
    if (url.pathname === "/tg/webhook") {
      return handleTelegramWebhook(req, env);
    }
    if (url.pathname === "/health") {
      const claimed = await getRegisteredChatId(env);
      return Response.json({ ok: true, claimed: !!claimed });
    }
    if (url.pathname === "/issues") {
      const issues = await listIssues(
        env,
        parseLimitParam(url.searchParams.get("limit"), 50, 200),
        parseIssueStatus(url.searchParams.get("status")),
      );
      return Response.json(issues);
    }
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(landing(), { headers: { "content-type": "text/plain" } });
    }
    return new Response("not found", { status: 404 });
  },
};

function landing(): string {
  return [
    "pony-help",
    "",
    "Endpoints:",
    "  POST /mcp          — MCP JSON-RPC endpoint (point Claude Code here)",
    "  POST /tg/webhook   — Telegram bot webhook (configured once)",
    "  GET  /health       — health + claim status",
    "  GET  /issues       — recent issues (debug; optional ?status=open|resolved&limit=50)",
  ].join("\n");
}

function parseIssueStatus(raw: string | null): IssueStatus | undefined {
  const clean = raw?.trim().toLowerCase();
  if (clean === "open" || clean === "resolved") return clean;
  return undefined;
}

function parseLimitParam(raw: string | null, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), max);
}
