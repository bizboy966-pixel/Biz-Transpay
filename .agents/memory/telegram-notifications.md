---
name: Telegram notification delivery
description: Safety and reliability rules for the platform's Telegram alerts
---

Telegram alerts are an outbound fan-out of the existing in-app notification
system. Delivery must be asynchronous and best-effort so Telegram outages
cannot block authentication, payments, withdrawals, or webhook processing.

**Why:** Notifications are operationally useful but external messaging must
not become a financial dependency or a second path for leaking provider
credentials and customer data.

**How to apply:** Keep the bot token in Replit Secrets and the destination
chat identifier in environment configuration. Send only an allowlisted
summary of notification metadata; never forward raw event payloads, secrets,
provider responses, full phone numbers, full email addresses, or wallet
credentials. Operational sender/recipient contact fields may be included only
in masked form for the authorized chat.