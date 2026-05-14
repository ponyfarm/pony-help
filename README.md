# pony-help

A Cloudflare Worker that exposes a remote MCP server. When the connected user's Claude session hits trouble, it escalates to a human reviewer over Telegram, fetches the reviewer's reply asynchronously, and presents it back to the user for approval.

Use case: you (the reviewer) want to stay in the loop while someone you're helping uses Claude — without sitting next to them. Their Claude pages you on Telegram when it's stuck or about to do something risky. You answer when you have a moment. Their Claude relays your guidance and asks them to approve before acting.

```
User's Claude  ──/mcp──▶  Cloudflare Worker  ──Telegram API──▶  Reviewer
                                ▲                                    │
                                └──── /tg/webhook  ◀─────────────────┘
                                            (replies)
```

## What it does

Four MCP tools, exposed at `https://<worker>/mcp`:

| Tool | When the LLM should call it |
| --- | --- |
| `escalate_issue` | Auto-fired when stuck, blocked, ambiguous, or about to do something destructive. Returns an `issue_id` immediately. |
| `ask_reviewer` | Explicit, user-initiated — "ask my reviewer". Same plumbing as `escalate_issue`. |
| `check_responses` | Polls for new replies. Should be called between steps after escalating. |
| `mark_resolved` | Closes the loop and sends a ✅ Telegram follow-up. |

The Telegram bot side: each escalation arrives as a message tagged with the user's account name. The reviewer replies (Telegram reply threading is honored — replying to a specific escalation routes the answer to that issue). Replies are delivered to the user's Claude on its next `check_responses` call, exactly once.

State lives in Workers KV. No databases, no servers to run.

## Quick deploy (clone → live in ~5 minutes)

Prereqs: a Cloudflare account, a Telegram account, Node 20+, and `gh`/`git`.

### 1. Talk to BotFather, get a bot token

1. Open Telegram, message `@BotFather`.
2. Send `/newbot`, pick a name and username.
3. Save the bot token it gives you (looks like `12345:ABC...`). Keep it secret.

### 2. Clone, install, log in

```bash
git clone https://github.com/ponyfarm/pony-help.git
cd pony-help
npm install
npx wrangler login
```

If you have multiple Cloudflare accounts, pick the right one by exporting:

```bash
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
```

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create PONY_KV
```

Copy the returned `id` into `wrangler.jsonc` (replace the placeholder).

### 4. Generate and store secrets

```bash
WEBHOOK_SECRET=$(openssl rand -hex 32)
BOOTSTRAP_TOKEN=$(openssl rand -hex 16)

printf '%s' '<YOUR_BOT_TOKEN>'    | npx wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' "$WEBHOOK_SECRET"     | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
printf '%s' "$BOOTSTRAP_TOKEN"    | npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN

echo "BOOTSTRAP_TOKEN: $BOOTSTRAP_TOKEN"      # save this for step 6
echo "WEBHOOK_SECRET: $WEBHOOK_SECRET"        # save this for step 5
```

### 5. Deploy and register the Telegram webhook

Optional: edit `wrangler.jsonc` and set `vars.REVIEWER_NAME` to your name (e.g. `"Sam"`). It's used in the framing the user's Claude shows when relaying your replies — `Sam: "<reply>"` reads better than `the reviewer: "<reply>"`.

```bash
npx wrangler deploy
# note the URL it prints, e.g. https://pony-help.<subdomain>.workers.dev

WORKER_URL=https://pony-help.<subdomain>.workers.dev \
TELEGRAM_BOT_TOKEN='<YOUR_BOT_TOKEN>' \
TELEGRAM_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  npm run tg:set-webhook
```

### 6. Claim the bot from your Telegram

In Telegram, open your bot's chat. **Type the message manually** (don't tap the Start button — it sends `/start` with no argument):

```
/start <BOOTSTRAP_TOKEN>
```

The bot replies `✅ Bot claimed.` From now on, your Telegram chat is the only one allowed to receive escalations. Verify:

```bash
curl https://pony-help.<subdomain>.workers.dev/health
# {"ok":true,"claimed":true}
```

### 7. Mint a token for the user

Each user (e.g. someone you're helping) gets their own bearer token:

```bash
npm run accounts:mint -- "<their-name>"
```

It prints a token. **Copy it now — it can't be recovered.** This token is what their Claude uses to authenticate. Their name appears on every escalation in your Telegram so you know who's asking.

After the Telegram bot is claimed, you can also mint or rotate a helpee connection directly from Telegram:

```text
/connect <their-name>    # mint a fresh connection message
/reconnect <their-name>  # revoke existing tokens for that name, then mint a fresh connection message
```

To revoke later, either use Telegram (`/revoke <their-name>`) or delete a specific token key:

```bash
npx wrangler kv key delete --binding=PONY_KV "account:<token>"
```

## Connect the user's Claude to the bot

Send the user this message — they paste it into a Claude Code session:

> Hey Claude — please set up the `pony-help` MCP server so you can escalate issues to my reviewer over Telegram.
>
> 1. Run this command:
>    ```
>    claude mcp add --transport http pony-help https://pony-help.<subdomain>.workers.dev/mcp --header "Authorization: Bearer <USER_TOKEN>"
>    ```
>
> 2. List the tools from `pony-help` and confirm you see `escalate_issue`, `ask_reviewer`, `check_responses`, and `mark_resolved`.
>
> 3. Test it: call `ask_reviewer` with the question *"Setting up pony-help — please reply so we know it works."* Wait a moment, then call `check_responses`. Show me the reply verbatim and ask whether to proceed.
>
> Going forward:
> - If you get stuck, blocked, or are about to do something destructive, call `escalate_issue` automatically.
> - After escalating (or whenever I say "ask Sam"), call `check_responses` between steps to pick up guidance.
> - When a reply arrives, present it verbatim — *`<reviewer-name>: "<reply>"`* — and ask me to approve, modify, or reject before acting.
> - When the situation is resolved, call `mark_resolved`.

Replace `<subdomain>` and `<USER_TOKEN>` before sending. Use a secure channel — the token authenticates every call.

## How replies route

When you reply in Telegram:

- **Replying to a specific escalation message** — answer attaches to that issue (best UX).
- **Plain message** — attaches to the most recent open issue across all users.

Each new reply is delivered exactly once, the next time the user's Claude calls `check_responses`.

## Operations

```bash
# Mint another user's token
npm run accounts:mint -- "Alex"

# See recent issues (debug)
curl -s https://pony-help.<subdomain>.workers.dev/issues | jq

# Health check
curl -s https://pony-help.<subdomain>.workers.dev/health

# Tail live logs
npx wrangler tail
```

Telegram admin commands from the claimed reviewer chat:

```text
/status          # bot state, issue counts, pending replies
/issues [limit]  # recent issues, default 5, max 10
/issue <id>      # full state for one issue
/accounts        # registered account names and active token counts, without bearer tokens
/connect <name>  # mint a Claude connection message; existing tokens stay active
/reconnect <name> # revoke tokens for that exact name and mint a fresh connection message
/revoke <name>   # revoke all active tokens for that exact name
/manage          # account management command summary
/help            # command list
```

Revoke a user:

```bash
npx wrangler kv key delete --binding=PONY_KV "account:<their-token>"
```

## Local development

```bash
cp .dev.vars.example .dev.vars
# fill in TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ADMIN_BOOTSTRAP_TOKEN
npx wrangler dev

# in another shell, mint a local account
node scripts/mint-account.mjs "test" --local

# hit the MCP endpoint directly
curl -s http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <local-token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

For end-to-end Telegram testing, expose `wrangler dev` via a tunnel (e.g. `cloudflared tunnel`) and point the webhook at the tunnel URL.

## Architecture

```
src/
├── index.ts       # routes: /mcp, /tg/webhook, /health, /issues
├── mcp.ts         # JSON-RPC handler + Bearer auth
├── tools.ts       # 4 MCP tools
├── telegram.ts    # bot webhook + helpers
├── kv.ts          # storage helpers
└── types.ts       # shared types
scripts/
├── mint-account.mjs        # generate per-user token
├── set-telegram-webhook.mjs
└── delete-telegram-webhook.mjs
```

KV layout:

| Key | Value |
| --- | --- |
| `chat_id` | Reviewer's Telegram chat id (set on first valid `/start`) |
| `account:<token>` | `{ name, created_at }` |
| `issue:<id>` | Full issue blob with replies |
| `tgmsg:<message_id>` | Issue id, for routing reply threads |
| `latest_open_issue` | id of most recent open issue (fallback for plain replies) |

## Security notes

- `/mcp` requires `Authorization: Bearer <token>` matching a minted account. Each user has their own token.
- Tokens are stored as the literal KV key (`account:<token>`). If at-rest secrecy ever matters more, hash on store and compare hashes.
- Per-account scope: `check_responses` and `mark_resolved` only see issues that account created.
- Telegram webhook calls are verified via the `X-Telegram-Bot-Api-Secret-Token` header.
- `chat_id` is locked on first successful `/start <bootstrap-token>`. Subsequent claim attempts are rejected.
- Once production-stable, rotate the bot token via `@BotFather` → `/revoke` and re-set the secret + webhook.
