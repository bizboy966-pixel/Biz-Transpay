---
name: Database query safety
description: Safe query construction and least-privilege boundaries for Biz-transPay's MongoDB access.
---

The backend uses Motor/MongoDB rather than SQL. Queries are built from static collection names, allowlisted field names, structured filters, and Pydantic-validated values. User-controlled search terms must be length-bounded and escaped before being placed in MongoDB `$regex`; arbitrary Mongo operators are never accepted as filters.

**Why:** MongoDB avoids SQL string-concatenation injection, but unescaped regex input can still create expensive patterns or alter search semantics.

**How to apply:** Keep query fields and update operators server-defined, scope authenticated filters by owner, validate enum-like inputs, escape literal search terms, and run the app with a dedicated MongoDB user restricted to the required database/collections and operations.