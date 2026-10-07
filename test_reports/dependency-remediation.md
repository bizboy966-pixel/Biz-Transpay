# Dependency security remediation

The requested 51 findings were addressed with compatible dependency updates,
removal of unused vulnerable lockfile entries, and one local source mitigation.
No application payment, account, or authorization behavior was changed.

## Released fixes

| Dependency | Selected version |
| --- | --- |
| axios | 1.20.0 |
| fast-uri | 3.1.8 |
| source-map-js | 1.2.2 |
| brace-expansion | 2.1.7 |
| shell-quote | 1.12.0 |
| proxy-addr | 2.0.8 |
| postcss | 8.5.23 |
| postcss-selector-parser | 7.1.6 |
| @grpc/grpc-js | 1.14.5 |
| PyJWT | 2.15.1 |
| pymongo | 4.18.2 |
| motor (compatible MongoDB parent) | 3.7.1 |
| multidict | 6.9.1 |
| oauthlib | 4.0.0 |
| urllib3 | 2.8.0 |

`sprintf-js` is removed by using the compatible legacy CLI aliases in
`argparse` 2.0.1. The unused `node-forge` resolution is removed; the existing
development server uses `selfsigned` 5.5.0, which no longer depends on it.
Both npm lockfiles and the frontend Yarn lockfile track the fixes.

## Unreleased upstream fix: braces

`braces` 3.0.3 has no patched release for GHSA-vfj7-8cjw-p6xm. A local guard
limits parser-generated ASTs to 64 nested brace/parenthesis blocks, rejecting
hostile patterns with `SyntaxError` before recursive compilation, expansion
or stringification can exhaust the stack.

The guard is applied by `scripts/patch-braces.cjs` at frontend postinstall,
start, build, test and post-merge setup. It patches all installed copies and
checks the exact original parser hash, failing explicitly if the source or
version is unexpected. It is idempotent and cannot be disabled by caller options.
Normal quoted/escaped braces and character classes are not counted as blocks.

**Scanner limitation:** package metadata remains honestly labeled `braces`
3.0.3. The dependency scanner still reports this advisory twice (once per
frontend lockfile), even though the tested local source guard mitigates it.
This is not an upstream upgrade and is not a claim of a zero-finding audit.
Replace the local mitigation with the upstream fix when a verified release
becomes available.

Run `yarn --cwd frontend test:dependency-security` to verify the attack cases,
normal glob behavior, the depth boundary, and the legacy parser compatibility.
Production publication uses the regular frontend install/build hooks; it
does not run the frontend tooling during the Python server's startup.

## Verification

- Dependency scan: zero critical, moderate or low findings; two high entries
  represent the same locally mitigated `braces` advisory in both frontend locks.
- Frontend regression tests: 44 passed across eight suites.
- Selected backend payment, authentication/email, referral, KYC, push,
  developer-API and document-store regression tests: 190 passed, one skipped.
- Dependency security regressions: four passed, including after a frozen-lockfile
  install reapplied the guard.
- Frozen Yarn install, production frontend build and Python dependency checks
  passed. JWT valid/invalid signature checks and Motor/PyMongo imports passed.
- The application workflow restarted and the public homepage rendered correctly.
  Signed-in pages were covered by tests, not verified through a signed-in browser.
