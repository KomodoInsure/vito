# Tasks 1–3 implementation report

## Implementation commit

`0a81d26` — `feat: persist native input ledger`

## Files changed

- `src/contracts.ts`
- `src/inputs.ts`
- `src/store.ts`
- `src/sources/types.ts`
- `src/sources/codex.ts`
- `src/sources/omp.ts`
- `src/sources/claude.ts`
- `src/sources/opencode.ts`
- `src/sources/hermes.ts`
- `src/ingest.ts`
- `test/inputs.test.ts`
- `test/store.test.ts`
- `test/ingest.test.ts`
- `test/codex.test.ts`
- `test/omp.test.ts`
- `test/claude.test.ts`
- `test/opencode.test.ts`
- `test/hermes.test.ts`

## Key decisions

- Added a schema-version-3 private input ledger with strict event, source-state, and provenance-claim tables and indexes. Provenance claim keys are recomputed from the normalized native tuple rather than caller offsets.
- Kept input identity and quality separate from token accounting. Stable input ownership is deterministic, retained ownership wins rescans, incompatible copy timestamps become partial unknown-kind observations, and explicit origin conflict is sticky without degrading volume quality.
- Implemented native metadata-only extraction for Codex, OMP, Claude, legacy OpenCode, and Hermes. No prompt body or controller-specific actor classifier is retained.
- Changed only Codex and OMP session origin keys to native-session-unique digests; accounting usage identities and lineage metadata remain unchanged.
- Preserved adapter-specific replay behavior: OMP family observations keep per-native keys and stored replay status; OpenCode uses its proven full-prefix lineage and persists private prefix ownership so a later-discovered older original reclassifies retained copies transactionally.
- Forced full input backfill when parser state is absent/incomplete, retained diagnosed gaps across incremental or unavailable scans, and kept successful scan state atomic with facts and cursors.
- Scoped input facts with the same absolute-attribution/session-inheritance resolver used by usage. Scope reconciliation updates retained input rows without adding input values to token-specific scope evidence.

## Verification

`bun test test/inputs.test.ts test/codex.test.ts test/omp.test.ts test/claude.test.ts test/opencode.test.ts test/hermes.test.ts test/store.test.ts test/ingest.test.ts`

Result: **84 pass, 0 fail, 336 assertions**.

`git diff --check` and `git diff --cached --check` completed with no findings before the implementation commit.

## Remaining concerns

- Per assignment, no formatter, linter, typecheck, build, or project-wide test suite was run; those remain integration-owner validation.
- Generic provenance ingestion, public metrics/schema, and widget work are intentionally not included because they are plan steps 4–6.
- Existing uncommitted changes in `web/widget.ts`, `web/styles.css`, and `test/widget.test.ts` were left untouched and unstaged.
