# CLI integration and publication contract

> Historical record; current behavior and commands: [CLI guide](../README.md), [integrations](integrations.md), [wire contract](../CONTRACT.md), [verification](verification.md).

PR checks now run offline contract tests on the existing Node 20/24 matrix for
Linux, macOS and native Windows. They do not hide production contract failures
with `continue-on-error`. Main's deployment check requires the wire version and
every unconditional scanner. Tag publication additionally requires every gated
scanner and the `billing-route` field. Both policies derive their surface lists
from the parser registry's `requiresSurfaceCapability` marker.

This permits integrating Pi/Gemini scanners before the server deployment without
shipping them to npm. Existing sync tests verify that unsupported or unconsented
Pi/Gemini logs are skipped without advancing their watermarks. Publication still
requires the server deployment first.

Reproduce after installing dependencies:

```sh
npm run build
npm run test:server-contract
```

Local Node 24.21 verification passed all 11 contract assertions/subtests against
synthetic local HTTP endpoints using the real exporter/checker commands. Negative
controls cover missing unconditional surfaces, missing gated surfaces, missing
billing-route, incompatible wire version, malformed capabilities, HTTP 503 and an
empty expectation. An invalid exporter mode is also rejected.

The existing CLI sync harness and migration suites passed 23 tests, including
old-server, missing-route and unanswered-consent watermark preservation and
successful Pi/Gemini upload after consent. `git diff --check` passed. Node 20 and
the macOS/Windows executions remain hosted CI checks; this local receipt does not
claim those runs or a production capability probe.
