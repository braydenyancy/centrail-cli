# Interpreting reviewed differences

The source fixture defines expected accounting. A reviewed competitor observation
records what that exact executable did; it does not make disagreement correct or
turn an aggregate report into request evidence.

## Bucket semantics before bug labels

- **Cache writes:** the common projection is total cache creation. For Pi's
  Anthropic records, `cacheWrite1h` is a subset of `cacheWrite`. Centrail's generic
  `cacheWriteTokens` is only the unknown-duration residual when an explicit 1h
  split exists; `cacheCreationTokens` retains the total. The partial/full 1h
  fixture guards this distinction. Raw observations retain the duration fields
  separately; agreement on totals alone cannot establish correct tariff choice.
- **Gemini thoughts:** source `output` means candidates; source `thoughts` is
  separate. Centrail's normalized output includes both. The pinned ccusage daily
  report exposes `outputTokens` without a separate reasoning field, while its
  `totalTokens` can include additional tokens. For the duplicated Gemini fixture,
  ccusage reports input140 + output40 + cached60, yet total260. The extra20 is
  observable, but the adapter does not silently reconstruct or name an omitted
  bucket. Describe this as report-bucket non-equivalence alongside the independent
  duplicate-record difference, not simply a proven loss of reasoning tokens.
- **Pi and Codex reasoning:** reasoning is a subset of source output. A tool that
  splits reasoning into another additive normalized bucket must be projected by
  adding those two normalized output fields, exactly once. It must not be added
  again to inclusive source output.
- **Copilot:** shutdown-model segments are aggregate evidence. The `requests.count`
  field does not establish individual request timestamps, identities or equal
  token sizes. Source expected records represent segments; competitors that split
  them into reconstructed requests must remain visibly different even when sums
  happen to match.

## Coverage and provenance limits

The four Claude regressions are hand-authored synthetic records, including a
deliberate valid-JSON whitespace variant. The compact and spaced variants carry
the same accounting; a parser rejecting one is a formatting/discovery result,
not evidence of zero usage. Other fixtures identify their own generated or
upstream-test origins. None is claimed to be a real user session merely because
it follows a real transcript schema.

ccusage exposes aggregates through this adapter; its missing event identities
are recorded explicitly. The monitor adapter invokes its actual reader, not its
terminal dashboard. Tokscale invokes its pinned parser helper without prices.
These execution boundaries define what agreement can prove. No comparison here
validates invoices, provider-side billing, production authorization or runtime
price accuracy.
