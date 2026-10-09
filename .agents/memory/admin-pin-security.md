---
name: Administrator PIN boundary
description: Personal six-digit PINs are an optional admin login check, not genuine MFA or sensitive-action authorization.
---

Administrators may choose an authenticator code or a personal six-digit PIN after entering their identifier and password. MFA enrollment remains required. Ordinary users do not get a PIN login prompt.

**Why:** The user asked to keep the authenticator while offering administrators a personal PIN as an alternative at login.

**How to apply:** Keep the choice per account and offer PIN only after that administrator has configured it. Never treat a PIN as a password replacement, recovery credential, or proof of possessing a separate device.

PIN enrollment, changes, and removal require the current password and a valid authenticator code. Sensitive administrative actions still require password-plus-authenticator step-up, even immediately after a successful PIN login. Session rotation must not promote PIN authentication to MFA.

**Why:** A short fixed PIN is another knowledge factor, so it cannot provide the same assurance as genuine two-factor authentication. The less restrictive login option must not weaken financial or administrative approval rules.

**How to apply:** Preserve the authentication assurance level across refreshes. Keep PIN hashing account-bound and server-peppered, enforce persistent account-level attempt limits independent of username/email aliases, and never expose PIN material in account views or logs.
