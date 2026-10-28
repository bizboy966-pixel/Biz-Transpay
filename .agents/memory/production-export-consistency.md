---
name: Production export consistency
description: Constraints for exporting production data safely when reads are paginated.
---

Do not present a paginated export from a live production database as a complete point-in-time backup unless the exported rows reconcile exactly to a stable source snapshot.

**Why:** Production data changed between separate read-only queries during an attempted export, including row counts and transaction-related records, which made a no-loss guarantee impossible.

**How to apply:** For full production migrations, obtain a consistent database backup or snapshot first; if only independent live reads are available, stop before packaging and explain the limitation.
