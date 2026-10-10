---
name: Provider treasury by country
description: Defines the balance source and currency grouping for admin country-level treasury reporting.
---

For dedicated provider-liquidity and country-treasury views, “available balance” means the combined treasury balances actually reported by payment providers in that country, not customer wallet balances. Keep currencies separate unless a conversion rate is explicitly configured, and make missing providers or estimates visible.

The Admin Statistics dashboard's “Solde total disponible — Tous les comptes utilisateurs” is an explicit exception: it totals customer XOF, XAF, and crypto wallets across all accounts and presents their equivalent in XOF using configured conversion rates. If a held asset has no configured rate, show the calculable subtotal as partial and identify the missing rate; never substitute provider treasury.

**Why:** The user first selected provider treasury for country-level liquidity, then specified that this dashboard card must instead represent every user's own wallet balances. Mixing the two would misstate both provider liquidity and customer funds.

**How to apply:** Keep provider treasury data in provider-specific liquidity views. For the all-user Statistics card, aggregate customer wallets, convert to XOF only with configured rates, refresh at the requested cadence, and state when the result is partial.
