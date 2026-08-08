---
name: Discord bot intents
description: Discord gateway intent behavior for this bot
---

Privileged Discord gateway intents must remain opt-in. The bot can register and run slash commands with the standard guild intents, while member joins, message content, auto-replies, and message-content logging require the matching intents to be enabled in Discord Developer Portal first.

**Why:** Discord closes the gateway with “Used disallowed intents” when a bot requests privileged intents that are not approved.

**How to apply:** Only set `DISCORD_ENABLE_PRIVILEGED_INTENTS=true` after enabling Server Members Intent and Message Content Intent for the bot application.