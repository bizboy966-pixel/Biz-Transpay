---
name: Provider treasury by country
description: Defines the balance source and currency grouping for admin country-level treasury reporting.
---

In Biz-transPay, “available balance” by country means the combined treasury balances actually reported by payment providers in that country, not customer wallet balances. Show each currency separately; do not add or rank amounts across currencies without an explicit conversion rate. Make missing providers and estimated amounts visible.

**Why:** The user specified provider treasury as the source. Provider availability varies, so silently substituting customer funds or implying complete, exact balances would misrepresent liquidity.

**How to apply:** For country-level admin statistics and liquidity views, use only live provider balance data, group totals by currency, rank within each currency, and state when provider coverage is incomplete or estimated.
