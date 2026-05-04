# pony-help

A remote MCP server that lets Mickey's Claude escalate issues to Sam over Telegram, then fetch Sam's reply asynchronously and present it to Mickey for approval.

```
Mickey's Claude  ──/mcp──▶  Cloudflare Worker  ──Telegram API──▶  Sam (DM)
                                   ▲                                  │
                                   └──── /tg/webhook  ◀───────────────┘
```

The worker hosts:
- `POST /mcp` — JSON-RPC MCP endpoint exposing 4 tools
- `POST /tg/webhook` — Telegram bot webhook
- `GET /health`, `GET /issues` — debug

State lives in Workers KV.

## Tools exposed to Mickey's Claude

| Tool | Purpose |
| --- | --- |
| `escalate_issue` | Auto-escalate when stuck, blocked, or about to do something destructive. Returns `issue_id` immediately. |
| `ask_sam` | Explicit "ask Sam" — same plumbing, framed as a Mickey-initiated question. |
| `check_responses` | Poll for Sam's replies. Should be called between steps after escalating. |
| `mark_resolved` | Tell Sam the loop closed. Sends a ✅ Telegram follow-up. |

After `check_responses` returns a reply, Claude is instructed to present Sam's words verbatim to Mickey and ask for approval before acting.

## Setup (Sam, one-time)

### 1. Install + log in

```bash
npm install
npx wrangler login
```

### 2. Create KV namespace

```bash
npx wrangler kv namespace create PONY_KV
```

Copy the returned `id` into `wrangler.jsonc` (replace `REPLACE_WITH_KV_ID`).

### 3. Set secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# paste the token from @BotFather

npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# paste any random string (e.g. `openssl rand -hex 32`)

npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
# paste another random string — you'll DM this to the bot once to claim it
```

### 4. Deploy

```bash
npx wrangler deploy
```

Note the URL printed at the end (`https://pony-help.<account>.workers.dev`).

### 5. Register the Telegram webhook

```bash
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_WEBHOOK_SECRET=... \
WORKER_URL=https://pony-help.<account>.workers.dev \
npm run tg:set-webhook
```

### 6. Claim the bot from your Telegram account

Open Telegram, message `@pony_help_bot`:

```
/start <ADMIN_BOOTSTRAP_TOKEN>
```

The bot replies `✅ Bot claimed.` Your chat_id is now stored in KV. From then on, replies you send are routed back to whichever issue you're replying to.

### 7. Sanity check

```bash
curl https://pony-help.<account>.workers.dev/health
# {"ok":true,"claimed":true}
```

## Granting access (Sam mints a per-user token)

Each user (Mickey, anyone else) gets their own bearer token. Mint one with:

```bash
npm run accounts:mint -- "Mickey"
```

It prints a token — copy it once; it's stored only as the KV key and can't be recovered. Send it to Mickey over a secure channel.

To revoke later:

```bash
npx wrangler kv key delete --binding=PONY_KV --remote "account:<token>"
```

## Setup (Mickey, one-time)

```bash
claude mcp add --transport http pony-help https://pony-help.<account>.workers.dev/mcp \
  --header "Authorization: Bearer <her-token>"
```

That's it. No install, no local server. Her token authenticates every MCP call, and her name (set when Sam minted the token) appears on every escalation in Telegram so Sam knows who's asking.

Optional — drop this into Mickey's `~/.claude/CLAUDE.md` to make auto-escalation more reliable:

> If you get stuck, hit a blocker you can't resolve, or are about to do something destructive,
> call the `escalate_issue` tool from `pony-help`. After escalating, call `check_responses`
> between steps to pick up Sam's guidance, present it verbatim, and ask me to approve before acting.
> When the situation is handled, call `mark_resolved`.

## How replies are routed

When Sam replies in Telegram:
- **Replying to an escalation message** → reply attaches to that issue (best UX; uses Telegram's reply threading).
- **Plain message** → attaches to the most recent open issue.

Each new reply is delivered exactly once via `check_responses`.

## Local development

```bash
cp .dev.vars.example .dev.vars
# fill in the three values
npx wrangler dev
```

For local Telegram testing you'll need to expose `wrangler dev` via a tunnel (e.g. cloudflared) and point the webhook at the tunnel URL — or just test the MCP endpoint with curl:

```bash
# Mint a local account token first:
node scripts/mint-account.mjs "test" --local
# then:
curl -s http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

## Security notes

- The Telegram bot token, webhook secret, and bootstrap token are all stored as Wrangler secrets (never committed).
- Telegram webhook calls are verified via the `X-Telegram-Bot-Api-Secret-Token` header.
- `chat_id` is locked on first successful `/start <token>`. Subsequent claim attempts are rejected.
- `/mcp` requires `Authorization: Bearer <token>` matching a minted account. Each user has their own token; revoke individually via `wrangler kv key delete`.
- Tokens are stored as the literal KV key (`account:<token>`). If Cloudflare KV at-rest secrecy ever matters more, switch to storing only `sha256(token)` and hashing on lookup.
- Per-account scope: `check_responses` and `mark_resolved` only see issues the calling account created.
