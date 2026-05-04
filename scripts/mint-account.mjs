#!/usr/bin/env node
// Mints an account token and stores it in the deployed Worker's KV.
// Usage:
//   node scripts/mint-account.mjs <name> [--remote|--local] [--env=<wrangler-env>]
//
// Prints the token to stdout. Save it — it's not retrievable later.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
if (!name) {
  console.error("Usage: node scripts/mint-account.mjs <name> [--remote|--local] [--env=<wrangler-env>]");
  process.exit(1);
}

const isLocal = args.includes("--local");
const wranglerEnv = args.find((a) => a.startsWith("--env="));

const token = randomBytes(32).toString("hex");
const value = JSON.stringify({ name, created_at: Date.now() });
const key = `account:${token}`;

const wranglerArgs = [
  "wrangler",
  "kv",
  "key",
  "put",
  "--binding=PONY_KV",
  key,
  value,
];
if (isLocal) wranglerArgs.push("--local");
if (wranglerEnv) wranglerArgs.push(wranglerEnv);

const res = spawnSync("npx", wranglerArgs, { stdio: ["inherit", "pipe", "inherit"] });
if (res.status !== 0) {
  console.error("wrangler kv key put failed");
  process.exit(res.status ?? 1);
}

console.log(`\n✅ Minted account "${name}"`);
console.log(`Token: ${token}`);
console.log(`\nGive this to the user. They configure Claude Code with:`);
console.log(`  claude mcp add --transport http pony-help <WORKER_URL>/mcp \\`);
console.log(`    --header "Authorization: Bearer ${token}"`);
console.log(`\nThis token cannot be recovered — store it now.`);
