---
name: Telegram command ownership
description: Why bot commands can stop arriving even though the polling worker is running
---

Telegram inbound commands must have exactly one receiving method: either a webhook or `getUpdates` long polling, never both. The published Biz-transPay VM uses polling; the development preview normally leaves command polling off.

**Why:** A stale webhook configuration made Telegram reject every production `getUpdates` call with HTTP 409, so commands such as `/total` never reached the handler. This conflict does not imply that a second process is running.

**How to apply:** When commands are silent, inspect webhook *status* without exposing its URL or bot token. Before removing a webhook, confirm the bot is not serving another application; use `deleteWebhook` without dropping pending updates. Do not turn preview polling on while production owns the bot.

The user confirmed that this bot is used exclusively by Biz-transPay.

**Why:** Ownership was explicitly confirmed before authorizing removal of the webhook conflicting with the application's polling receiver.

**How to apply:** Keep the production application as the sole command receiver. Do not attach an external webhook or enable a second polling worker for this bot.

The user explicitly requires deposit, withdrawal, exchange and all-type searches to accept provider/internal references, transaction IDs, payer phones, emails, usernames and full names. `/total <identifiant>` means a transaction search across types; `/total` without an argument must keep the existing provider-balance report.

**Why:** The user repeated this requirement after identity searches and the argument-taking form of `/total` were missing.

**How to apply:** Preserve both `/total` forms, accented command aliases and multi-result searches; never replace transaction lookup with an unrelated balance report when an identifier is supplied.