# Repeatable CLI verification

After `npm ci`, run the collected local checks with:

```sh
npm run verify
node scripts/check-doc-links.mjs
```

This builds the parsers, CLI and plugin, typechecks both packages, runs all parser
and CLI fixture tests, tests contract policies against synthetic HTTP servers,
checks coordinated release versions and offline packed consumers,
and runs the comparison gate's self-tests. A failing stage stops the suite with
a nonzero exit. It installs no dependencies, calls no production endpoints and
uses no personal usage logs. It works with the CLI's Node 20+ requirement on
Linux, macOS and native Windows when its prerequisites are installed: Git for
repository fixtures and Python 3 available as `python3` for the comparison
gate self-tests. The optional full comparison suite has stricter Linux requirements.

The committed tests cover wire/export allowlists and privacy, compiler-generated
plugin bundle equality, actual hook subprocess dispatch, generated file trees,
worktree moves/deletion/copies, capability/consent and watermark behavior. Browser
opening is mocked at the spawn boundary, so pairing tests open no desktop browser.
These checks previously listed in dated receipts remain runnable tests.

## Optional pinned competitor suite

Prepare the pinned tools and run all checks with the explicit networked option:

```sh
npm run verify -- --comparisons-setup
```

That invokes `tools/tokscale-compare/provision.py` with Python 3.12, fetching the
pinned checkouts, compiler, executable and hashed wheel into a fresh temporary
directory, and writing the ignored local tool config. It fails before downloads
when prerequisites or isolation are unavailable. It does not install system
packages or relax host namespace policy. Set `CENTRAIL_COMPARISON_PYTHON` to choose
a system Python 3.12 executable when `python3.12` is unavailable. For the full
prerequisites see [the comparison instructions](../tools/tokscale-compare/README.md).

Once tools are prepared, rerun offline with:

```sh
npm run verify -- --comparisons
```

The fixture comparison runner requires Linux, Python 3.12 and bubblewrap network
and mount namespaces; native macOS/Windows hosts can use the dedicated Linux CI
workflow. Tool provisioning is explicit and occurs before the offline runner.
The runner fails closed if tools or isolation are unavailable. Its fresh report
contains fixture/tool coverage, two repeated executions per case, source-oracle
checks and reviewed baseline differences. Run just the comparisons with
`npm run test:comparisons -- --out <new-directory>` to choose the report directory.

No Docker image is needed for this existing isolation contract. Containers that
disable user namespaces cannot run bubblewrap without additional privileges;
adding a generic container wrapper would not itself reproduce the proven gate.
The pinned preparation is a runnable script; the dedicated
[Linux comparison workflow](../.github/workflows/comparisons.yml) supplies an
ephemeral host with the needed packages and namespace policy.

## Optional installed Codex runtime probe

Set `CENTRAIL_CODEX_BIN` to a local Codex executable, then run:

```sh
npm run verify -- --codex-discovery
```

The existing discovery script uses a disposable home and config with provider
credentials omitted, installs the local plugin in that scratch runtime, and
compares old duplicate Stop registration with current single registration. It
does not run a model turn. Codex is supplied by the caller rather than downloaded
by verification. This optional installed-runtime probe is distinct from the
portable hook subprocess tests in the default suite.

## Optional release preparation rehearsal

`npm run verify` includes release-policy tests and offline installation of both packed
consumers. The release-policy fixtures reject branch publication, malformed tags, version
mismatch and modified artifacts. Hosted checks run on Node 20/24 across all three platforms.

To rehearse the actual pinned Release Please SDK without creating a PR, tag or release:

```text
npm install --prefix .release-artifacts/release-sdk --ignore-scripts --no-audit --no-fund release-please@17.3.0
npm run release:rehearse -- <absolute SDK package directory> braydenyancy/centrail-cli <absolute checkout directory> <absolute disposable output directory>
```

The SDK package directory is `.release-artifacts/release-sdk/node_modules/release-please`.
The helper uses the existing `gh` login in memory for read-only GitHub history calls. It overlays
candidate main-file reads with the local checkout and applies the SDK's real file updaters only
to the disposable output directory. It writes the proposed PR/version/files as `receipt.json`.
This is a preparation rehearsal, not proof that owner-side settings permit a real publication.

Merged PRs without Conventional Commit squash titles may supply Release Please's supported
`BEGIN_COMMIT_OVERRIDE` / `END_COMMIT_OVERRIDE` body block. This records intended release notes
without rewriting history; the dated rehearsal records PR15 using that correction for the proposed 0.8.0 release.

The verification toolchain uses Vitest 4.1.11 and Vite 6.4.3 to retain Node 20.0 support.
The root Vite override is intentional; bundler upgrades require rebuilding and reviewing the
committed plugin bundle. See the [toolchain receipt](verification/release-toolchain-2026-10-12.md).

## Publishing credential boundary

The estate auth atlas §2 row 7/§14 and D40 describe GitHub OIDC into OpenBao for infrastructure
provisioning. This publisher talks directly to npm's external OIDC verifier; it does not use
OpenBao, Zitadel, an estate CI role or human pairing credentials. Existing estate flows are
unchanged. The old workflow used the long-lived `NPM_TOKEN`; the replacement permits only
GitHub's scoped workflow token plus npm's short-lived environment-bound credential. Local verification does not inspect npm's owner-side trust settings; publication
and its retained receipts provide the end-to-end evidence.
