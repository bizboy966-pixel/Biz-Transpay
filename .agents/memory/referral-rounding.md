---
name: Referral rounding
description: Why the referral payout retains two decimals for XOF/XAF
---

Referral commissions use the configured percentage of the chosen net operation and round to two decimal places, even when the operation is in XOF or XAF.

**Why:** There is no minimum eligible operation amount in the referral rule. Whole-unit rounding would reduce the commission on a valid small operation to zero, violating the promised percentage and one-time payout. The wallet already accepts fractional balances.

**How to apply:** Preserve decimal-precise calculations and display fractional balances in referral and transaction views. If whole-unit settlement becomes a product requirement, agree on a minimum qualifying amount and rounding rule before changing payouts.