---
name: Referral invite codes
description: Why referral links use immutable account IDs instead of usernames
---

Referral invitation codes are the sponsoring account's immutable UUID, not its username or a separately generated vanity string.

**Why:** The PostgreSQL-backed document store's Mongo-shaped `create_index` compatibility call does not create a unique index. Application-level username checks are not a sufficient uniqueness guarantee under concurrent registration, and editable display names would also make link attribution unstable.

**How to apply:** Keep the code-to-sponsor lookup server-side and immutable. If introducing friendlier codes, first provide database-enforced uniqueness and a stable mapping; never silently reinterpret an existing invite link.