# Repeatable CLI verification

After `npm ci`, run the collected local checks with:

```sh
npm run verify
```

This builds the parsers, CLI and plugin, typechecks both packages, runs all parser
and CLI fixture tests, tests contract policies against synthetic HTTP servers,
and runs the comparison gate's self-tests. A failing stage stops the suite with
a nonzero exit. It installs no dependencies, calls no production endpoints and
uses no personal usage logs. It works with the CLI's Node 20+ requirement on
Linux, macOS and native Windows; Git is needed for the repository fixtures.

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
