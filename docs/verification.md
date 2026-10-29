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
uses no personal usage logs. Use a Node version accepted by [package.json](../package.json). The default
suite runs on Linux, macOS and native Windows with these prerequisites: Git for
repository fixtures and Python 3 available as `python3` for the comparison
gate self-tests. The optional full comparison suite has stricter Linux requirements.

The committed tests cover wire/export allowlists and privacy, compiler-generated
plugin bundle equality, actual hook subprocess dispatch, generated file trees,
worktree moves/deletion/copies, capability/consent and watermark behavior. Browser
opening is mocked at the spawn boundary, so pairing tests open no desktop browser.

## Optional pinned competitor suite

Prepare the pinned tools and run all checks with the explicit networked option:

```sh
npm run verify -- --comparisons-setup
```

This prepares pinned tools before running the offline suite. It requires Linux
x64 with bubblewrap namespaces and Python 3.12; see the
[comparison instructions](../tools/tokscale-compare/README.md#prepare-once-then-run-offline)
for all prerequisites, pins and isolation behavior. Set `CENTRAIL_COMPARISON_PYTHON`
to choose the provisioning Python executable. Native macOS/Windows hosts can use
the [Linux comparison workflow](../.github/workflows/comparisons.yml).

Once prepared, rerun offline with `npm run verify -- --comparisons`. To run only
comparisons and choose the report directory:

```sh
npm run test:comparisons -- --out <new-directory>
```

The runner fails closed if tools or isolation are unavailable. Each report records
coverage, repeated executions, source-oracle checks and reviewed baseline differences.

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
mismatch and modified artifacts. The [CI workflow](../.github/workflows/ci.yml) declares the Node/platform matrix.

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
without rewriting history.

The locked toolchain and root overrides live in [package.json](../package.json)
and [package-lock.json](../package-lock.json). Bundler upgrades require rebuilding
and reviewing the committed plugin bundle. Preserve the supported Node floor
when changing test tooling; development dependency upgrades must not silently
raise the installed CLI’s runtime requirement.

Publication and owner-side verification are covered in [releases](releases.md).
