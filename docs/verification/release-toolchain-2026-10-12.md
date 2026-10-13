# Release toolchain repair — 2026-10-12

The release candidate's hosted tests correctly rejected Codex plugin metadata that still
said `0.7.5-account-local.0` while the CLI said `0.8.0`. The metadata is now aligned, included
in Release Please's actual updates and checked alongside the Claude metadata, marketplace,
workspace lock versions and runtime header. Linux24/Windows20 reported the same failure in
`plugin.test.ts`; the assertion was preserved.

A separate dependency audit found nine vulnerable development-package groups (two critical,
four high, three moderate); the runtime-only audit was clean. Published CLI/parser packages
have no runtime dependencies and their built outputs contain none of this tooling.
Vitest's UI issue requires an exposed UI/API, which these `vitest run` configurations do not
enable. Tinypool's execution gadget requires another prototype-pollution primitive; no live
exploit was established. Tests/builds already run before the npm credentialed job.

Both workspaces now use Vitest 4.1.11; Vite 6.4.3 is selected explicitly to preserve Node 20.0
compatibility, and the CLI bundler uses esbuild 0.25.12. Compatible lockfile updates select
PostCSS 8.5.30, nanoid 3.3.20 and source-map-js 1.2.2. Tinypool is removed. Full and runtime-only
isolated npm audits report zero vulnerabilities at verification time; this is a dated audit,
not a guarantee against future advisories. `npm audit fix --force` would choose Vitest 5 and
drop Node 20 support, so it was not used.

The upgraded runner exposed one fixture's standalone fetch mock retaining earlier calls.
`beforeEach` now explicitly clears that mock's call history; production code is unchanged.
The rebuilt plugin has the same parse/reprint representation after comments are removed;
its large text diff reflects bundler formatting. This is supplementary evidence, not a
general semantic-equivalence proof. Full collection/real-git suites and packed consumers
verify the behavior independently. The parser comparator corpus and baseline are unchanged.

Rerun `npm run verify`, `npm audit`, `npm audit --omit=dev`, and the optional SDK rehearsal
documented in [releases](../releases.md). The accompanying JSON records versions, counts,
audit results and bundle hashes. Hosted macOS/Windows checks remain necessary on the new head.

Primary sources: [Vitest UI advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp),
[Vitest mocker advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9),
[Tinypool advisory](https://github.com/tinylibs/tinypool/security/advisories/GHSA-85c8-ppgw-ccpr),
[Vite Windows advisory](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff),
[esbuild advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99).
