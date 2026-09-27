---
name: Crypto benefit accounting
description: Rules for reporting cryptocurrency platform fees in the admin benefits totals.
---

Report a crypto platform fee in USDT only from the USDT equivalent stored at settlement or from the transaction's stored USDT rate and native fee.

**Why:** Recalculating historical fees with today's market rate makes reported platform profit change after the transaction and breaks reconciliation.

**How to apply:** Store native fee, platform fee, and the settlement-time USDT conversion together when possible. For older records, use only a recorded transaction rate; do not infer a rate from current market data.