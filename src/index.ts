import type { Env } from "./types";
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
      const issues = await listIssues(env);
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
    "  GET  /issues       — recent issues (debug)",
  ].join("\n");
}
