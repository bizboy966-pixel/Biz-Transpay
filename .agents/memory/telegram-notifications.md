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

Final payment and withdrawal alerts use a compact operational receipt format:
status title, gross/net amounts, wallet, provider/operator, internal/provider
references and time, followed by separated sender and recipient sections.

**Why:** The administrator chose a Telegram receipt-style reference because it
makes transaction verification faster than generic notification prose.

**How to apply:** Preserve this hierarchy for future final-state alerts, keep
all contact fields masked, and never change financial processing merely to
populate a notification field.

Security alerts must state what the controls actually prove: blocked requests
are reported as blocked, while a successful unusual login remains suspicious
but is not labeled as a confirmed compromise without stronger evidence.

**Why:** Operational alerts must support a fast response without creating false
claims about an attacker gaining access.

**How to apply:** Include the masked source, target, time, outcome and a specific
response recommendation. Deduplicate repeated alerts so an attack cannot flood
the Telegram channel.

Administrative authentication is the only successful login event sent to the
Telegram operations chat. User logins remain in-app security events; KYC
submission, approval, rejection, and resubmission decisions are admin-only
Telegram alerts with masked account details.

**Why:** The operations chat is for platform-owner actions and review queues,
not a feed of every customer session.

**How to apply:** Route admin login and KYC lifecycle alerts through the
allowlisted asynchronous queue, keep user notifications and SSE fan-out
separate, and mask IP addresses and contact fields.

Do not forward ordinary application rate-limit hits to the Telegram operations chat; retain the HTTP 429 protection and other security alerts.

**Why:** Normal repeated payment-status polling can exceed a tight endpoint rate limit and flood the operations chat with misleading automated-traffic warnings.

**How to apply:** Keep rate limiting independent of Telegram delivery. Preserve alerts for distinct security controls such as blocked IPs, oversized requests, and CSRF rejections.