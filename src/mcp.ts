import type { Account, Env } from "./types";
import { TOOL_DEFS, callTool } from "./tools";
import { getAccountByToken } from "./kv";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SERVER_INFO = {
  name: "pony-help",
  version: "0.1.0",
};

export async function handleMcpRequest(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") {
    return methodNotAllowed();
  }
  if (req.method !== "POST") {
    return methodNotAllowed();
  }

  const account = await authenticate(req, env);
  if (!account) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="pony-help"',
      },
    });
  }

  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = (await req.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const requests = Array.isArray(payload) ? payload : [payload];
  const responses: JsonRpcResponse[] = [];
  for (const r of requests) {
    const resp = await dispatch(r, env, account);
    if (resp) responses.push(resp);
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }

  const body = Array.isArray(payload) ? responses : responses[0];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": env.PROTOCOL_VERSION,
    },
  });
}

function methodNotAllowed(): Response {
  return new Response("method not allowed", {
    status: 405,
    headers: { allow: "POST", "content-type": "text/plain" },
  });
}

async function dispatch(
  req: JsonRpcRequest,
  env: Env,
  account: Account,
): Promise<JsonRpcResponse | null> {
  if (req.method.startsWith("notifications/")) {
    return null;
  }

  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: env.PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: TOOL_DEFS });
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const result = await callTool(env, name, args, account);
        return ok(id, result);
      }
      default:
        return err(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return err(id, -32603, message);
  }
}

async function authenticate(req: Request, env: Env): Promise<Account | null> {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  return getAccountByToken(env, match[1].trim());
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcError(id: string | number | null, code: number, message: string): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
