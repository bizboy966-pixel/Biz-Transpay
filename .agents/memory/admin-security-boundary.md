---
name: Admin security boundary
description: Additional protections applied to the Biz-transPay administrative panel and high-impact staff actions.
---

The admin panel is a critical zone: admins must enroll MFA, but may opt into a personal six-digit PIN as an alternative login check after their password (see admin-pin-security.md). High-impact actions still require recent password-plus-MFA authentication and an explicit confirmation phrase, and every admin endpoint request is written to the audit log, including denied attempts. MFA is reserved for admin and super-admin accounts; ordinary users and merchants must never be offered or prompted for it. The first platform account is the permanent owner and super administrator. Owner recovery must be bound to an already-existing, authenticated account using a server-side cutoff; a public email submission alone must never grant authority. Once claimed, the owner cannot be demoted, transferred, blocked, deleted, or removed by cleanup/reset operations.

**Why:** A valid administrator session alone is not enough protection for balance changes, transaction decisions, account administration, or platform reset operations. Email-only owner promotion is vulnerable to public account claiming, while a mutable owner can be removed by another privileged account and leave the platform without its designated controller.

**How to apply:** Keep the server authoritative. Use the optional `ADMIN_ALLOWED_IPS` allowlist with `ADMIN_TRUST_PROXY_HEADERS=true` only when the deployment proxy is trusted; otherwise use the direct client address. Preserve the 24-hour absolute session limit, 30-minute idle expiry, 15-minute step-up window, MFA enrollment and sensitive-action requirements, brute-force controls, unusual-login alerts, and explicit confirmation for destructive or financial actions. Any user mutation, deletion, cleanup, or reset path must preserve the marked platform owner.

For admin panel entry, sign-in with an admin PIN returns to the ordinary user dashboard. The panel entry is hidden; four clicks on the username prompt for the authenticator code. A successful check unlocks the panel for 15 minutes, and every admin API request must enforce that server-side session state. Direct `/admin` visits and expired unlocks must not bypass it. This panel unlock does not satisfy the separate password-plus-MFA check for sensitive operations.

**Why:** The user requested that admins with a configured PIN sign in to the ordinary dashboard after password and PIN checks, with the admin panel hidden behind authenticator verification.

**How to apply:** Keep the username gesture in the signed-in dashboard, rotate the authenticated session after TOTP verification, and preserve the 15-minute expiry. Continue to enforce the unlock in shared admin authorization middleware rather than relying on route guards in the browser.

The platform reset, user cleanup, and user deletion routes are to remain available only with strengthened, action-specific confirmation and fresh password-plus-MFA step-up. Preserve the platform owner and keep an audit record of every attempt; never execute these actions during migration work.

**Why:** The user chose to keep these administrative operations while requiring stronger confirmation.

**How to apply:** Require a separate exact confirmation for each destructive route, audit success and denial, preserve owner protection, and do not call the routes while porting or testing them.