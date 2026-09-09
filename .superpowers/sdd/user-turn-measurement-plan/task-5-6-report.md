# Steps 5–6 implementation report

## Result

DONE

Implementation commit: `a569383` (`feat: add human input cadence metrics`)

## Files changed

- `src/contracts.ts`
  - Cut the public snapshot over to schema version 5.
  - Added `InputStats`, `HumanCadenceStats`, `HumanCadenceCoverage`, `PublicInputGroup`, `PublicInputRange`, and required `inputRanges` contracts.
  - Added strict Zod schemas for the four exact range keys and all nested input/cadence data.
  - Enforced safe nonnegative counters, nonempty valid cadence cohorts, input/cadence population bounds, complete cohort classification, AGENTS-order unique harnesses, and all-harness conservation across available harness groups.
- `src/metrics.ts`
  - Loads input events and input source states once inside the existing public-snapshot read transaction, alongside the existing maximum-window work read.
  - Computes the 7/30/90/365 ranges from timezone-local midnight boundaries without daily distinct-session summation.
  - Applies the required supporting-record priority: undated, context, replay, unknown kind, subagent, unknown lane.
  - Applies the required mutually exclusive session priority: input history, mixed scope, unknown origin, no human input, no recorded work.
  - Clips included work to each eligible native session’s first in-window human input and cutoff, then reuses `aggregateWorkIntervals().value.agentMs` so same-lane overlaps are unioned and concurrent native sessions are summed.
  - Keeps unknown origins in supporting totals, keeps empty cohorts unavailable, keeps input quality independent from work quality, and includes enabled plus retained contributing harnesses in AGENTS order.
- `web/widget.ts`
  - Added the four input reason codes to the independent browser allowlist.
  - Added a strict browser-side schema-5 validator mirroring the central input/cadence invariants and all-harness conservation checks.
  - Added `renderInputs`, selected only from precomputed `inputRanges` by range and harness; resource/model/provider state is not used.
  - Places the panel immediately after activity cards only in `view=all`.
  - Adds input-range harnesses to harness availability.
  - Renders the two shared-cohort headline cards, supporting frequency/origin data, partial/unavailable status, all required explanatory copy, all five session exclusions, all six record exclusions, and per-harness input/timing status without private fields.
- `web/styles.css`
  - Added neutral, responsive two-card cadence and three-item supporting layouts, partial-state labeling, totals, and disclosure spacing.
- `test/metrics.test.ts`
  - Added source-shaped input helpers and behavior coverage for exclusion priority, matched cohorts, scope ambiguity, origin ambiguity, automated-only and no-work sessions, first-input clipping, same-lane overlap union, concurrent-lane summation, native session reuse, range recomputation, DST-local boundaries, known-empty behavior, and retained input-only harness visibility.
- `test/config.test.ts`
  - Added schema-5 fixtures and central-validator rejection cases for missing/extra ranges, private fields, unsafe counters, inconsistent populations/coverage/all-harness sums, invalid cadence, and duplicate harnesses.
- `test/widget.test.ts`
  - Added schema-5 fixtures, browser-validator rejection cases, and DOM-level panel assertions for range/harness selection, shared ratios/totals, unavailable values, exact explanatory copy, exclusions, and source status disclosure.
- `test/cli-integration.test.ts`, `test/export.test.ts`, `test/publish.test.ts`
  - Updated named public snapshot fixtures and expected publication schema version to 5.

## Key decisions

1. Input facts, input source state, and work intervals are read once for the maximum public period in the existing transaction. Each range filters the loaded arrays; no per-event or per-range database query was added.
2. Public session identity remains the native `(agent, sessionKey)` lane. Canonical, family, root, controller, and native input identifiers never enter public data or work matching.
3. A retained observation makes a disabled harness visible only when it is included and contributes to the selected dated range or undated coverage. Enabled harnesses remain present even with unavailable input data.
4. Supporting counts remain available as partial when retained facts exist despite coverage gaps. A harness with neither a successful compatible scan nor retained included observations is unavailable rather than a guessed zero. A successful recorded scan with no observations produces known zero counts.
5. Cadence quality is partial when the measured subset has exclusions, input coverage is not recorded, or eligible work-source evidence is not recorded. With no eligible session, cadence is null/unavailable rather than zero or infinity.
6. The UI gives both headline ratios the same cadence object and uses no directional success color or composite score.

## Test-driven evidence

Expected red runs:

- `bun test test/metrics.test.ts`
  - Result: 15 passed, 5 failed because `inputRanges` did not yet exist.
- `bun test test/config.test.ts`
  - Result: 13 passed, 1 failed because schema 5 with `inputRanges` was not yet accepted.
- `bun test test/widget.test.ts`
  - Result: expected module error because `renderInputs` was not yet exported.

Focused green runs during implementation:

- `bun test test/config.test.ts`
  - Result: 14 passed, 0 failed.
- `bun test test/metrics.test.ts`
  - Result after the final metrics cases: 21 passed, 0 failed.
- `bun test test/widget.test.ts`
  - Result: 12 passed, 0 failed.
- `bun test test/export.test.ts test/cli-integration.test.ts test/publish.test.ts`
  - Result: 29 passed, 0 failed.

Fresh final verification after self-review:

```text
bun test test/metrics.test.ts test/config.test.ts test/widget.test.ts test/export.test.ts test/cli-integration.test.ts test/publish.test.ts
```

Result: 76 passed, 0 failed, 460 assertions, 6 files.

Per assignment constraints, no formatter, lint, typecheck, build, full suite, collector smoke, or browser smoke was run in this worker session.

## Self-review

- Confirmed all four exact range keys are required by both validators.
- Confirmed no ratio is serialized and no controller/native/session identifiers are present in the public contracts or panel.
- Confirmed work matching uses exact native session lanes and excludes child/unmatched work, work before the first in-period human input, and work from excluded sessions.
- Confirmed supporting excluded-record and cadence excluded-session counters are mutually exclusive by the specified priority.
- Confirmed all-harness values and exclusion/coverage counters are safe sums of the published harness groups.
- Confirmed the four required explanatory sentences are verbatim.

## Preservation of pre-existing user hunks

Before editing, the uncommitted user diff was captured for exactly:

- `web/widget.ts`
- `web/styles.css`
- `test/widget.test.ts`

It contained 21 insertions and 26 deletions: the model-series cutover, removal of `--series-other`, and its widget tests. For the implementation commit, all task files were staged and the captured user patch was reverse-applied to the index only. The staged web diff contained none of those model-series or `--series-other` hunks. After commit, those same three files are the only modified working-tree files and still show exactly 21 insertions and 26 deletions. A changed-row comparison between the original captured diff and the post-commit working diff returned `true`; only hunk line numbers moved because this commit inserted earlier code.

## Concerns

None within the assigned scope. Project-wide typecheck/build/full-suite and collector/browser smoke remain intentionally deferred to the integration owner, as required by the assignment constraints.
