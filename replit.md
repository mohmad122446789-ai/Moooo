# Bankai Discord Bot

بوت Discord عربي لإدارة السيرفر، الأرصدة، التحويلات، الرواتب، المهام، التحذيرات، والسجلات.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Secret: `DISCORD_BOT_TOKEN` — Bot token stored in Replit Secrets
- Optional env: `BOT_OWNER_ID` — Discord user ID allowed to grant/reset balances
- Optional env: `DISCORD_ENABLE_PRIVILEGED_INTENTS=true` — enable after turning on Server Members Intent and Message Content Intent in Discord Developer Portal

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/discord/bot.ts` — Discord client, slash commands, aliases, economy, moderation, welcome, auto-replies, and event logs
- `lib/db/src/schema/index.ts` — wallets, warnings, and per-server settings
- `artifacts/api-server/src/index.ts` — starts the API server and Discord client

## Architecture decisions

- The bot token is read only from Replit Secrets and is never committed to source.
- Slash commands are registered globally on startup so every server can discover the same command set.
- The optional privileged-intent flag prevents the whole bot from failing when Discord Developer Portal intents have not been enabled.
- Server state is stored in PostgreSQL and isolated by guild ID.

## Product

- Economy: `/balance`, `/pay`, `/salary`, `/task`
- Moderation: `/warn`, `/unwarn`, `/warnings`, `/kick`, `/ban`, `/clear`, `/nickname`
- Server setup: `/set-log`, `/set-welcome`, `/set-ban-role`, `/remove-ban-role`, `/alias`, `/customize`, `/admin-customize`, `/autoreply`, `/color`, `/request`, `/create-role`, `/create-channel`, `/hide-channel`, `/show-channel`
- Owner-only economy controls: `/grant`, `/reset-balance`

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Discord privileged intents must be enabled in the Developer Portal before setting `DISCORD_ENABLE_PRIVILEGED_INTENTS=true`.
- The bot needs the matching Discord permissions for moderation and channel/role commands.
- Aliases typed as normal chat messages require Message Content Intent in Discord Developer Portal and `DISCORD_ENABLE_PRIVILEGED_INTENTS=true`.
- `/ban-status` reports the bot's current Ban Members permission and the configured ban role.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
