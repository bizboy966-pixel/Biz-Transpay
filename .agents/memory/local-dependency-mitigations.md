---
name: Local dependency mitigations
description: Interpreting security findings when upstream has no released fix
---

Local source mitigations must preserve the dependency's real name and version.
Do not rename packages, invent patched release versions, or suppress advisories
just to produce a clean dependency scan.

**Why:** The upstream `braces` advisory had no patched release available on
2026-10-07. A bounded parser-depth guard protects the actual executed code,
but version-only dependency scanners still report the advisory.

**How to apply:** Treat remaining version-based findings as requiring explicit
mitigation verification, not as proof that the guard is absent. Keep install,
build and setup paths covered until a verified upstream fix replaces the local
mitigation. State the scanner limitation clearly in delivery summaries.
