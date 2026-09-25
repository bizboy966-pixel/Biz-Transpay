---
name: Telegram command ownership
description: Why bot commands can stop arriving even though the polling worker is running
---

Telegram inbound commands must have exactly one receiving method: either a webhook or `getUpdates` long polling, never both. The published Biz-transPay VM uses polling; the development preview normally leaves command polling off.

**Why:** A stale webhook configuration made Telegram reject every production `getUpdates` call with HTTP 409, so commands such as `/total` never reached the handler. This conflict does not imply that a second process is running.

**How to apply:** When commands are silent, inspect webhook *status* without exposing its URL or bot token. Before removing a webhook, confirm the bot is not serving another application; use `deleteWebhook` without dropping pending updates. Do not turn preview polling on while production owns the bot.