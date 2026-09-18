---
name: PostgreSQL JSONB adapter behavior
description: Runtime details that matter when the Mongo-shaped store runs on Replit PostgreSQL
---

The Replit `asyncpg` runtime may return a JSONB column as a JSON string instead of a decoded mapping. Datetime values serialized into that JSONB also come back as ISO strings.

**Why:** Treating the raw JSONB value as a dictionary caused every collection read to fail, and treating stored timestamps as native datetimes broke session expiry checks.

**How to apply:** Decode JSONB strings at the collection boundary and normalize ISO timestamps before comparison or arithmetic. Keep the application database on PostgreSQL; do not reintroduce a local MongoDB fallback for deployment.