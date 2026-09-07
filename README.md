# VITO

VITO—**Vibe in the Open**—is a local coding-agent activity collector for **Agent Native**. It reads supported agent accounting sources and locally known Git history, stores normalized facts in a private SQLite ledger, and exports aggregate-only static widgets.

The public output includes daily token volume, model and harness mix, measured active time, hourly and daily inference streaks, concurrency, work rhythm, computed API-equivalent cost, separate source-reported costs, and commits reachable from configured repositories' remote default branches.

Vito does not export prompts, messages, tool inputs or outputs, workspace paths, repository names, session identifiers, commit hashes, or credentials.

## Requirements

- macOS for launchd scheduling; collection and export use Bun APIs
- [Bun](https://bun.sh/) 1.4 or newer
- Git
- GitHub CLI (`gh`) for publication
- A dedicated public GitHub repository if publishing with GitHub Pages

## Install

```bash
bun install
bun run build
```

## Quick start

Create a private configuration for one or more company workspace roots. Relative workspace paths resolve from the invocation directory and are persisted as canonical absolute paths:

```bash
bun run vito init \
  --workspace . \
  --pages-repo OWNER/REPOSITORY
```

Multiple roots are supported:

```bash
bun run vito init \
  --workspace /absolute/path/to/workspace-one \
  --workspace /absolute/path/to/workspace-two \
  --pages-repo OWNER/REPOSITORY
```

Defaults:

- Configuration: `~/.config/vito/config.json`
- Private state: `~/.local/share/vito`
- Timezone: the runtime's resolved IANA timezone

Vito never overwrites an existing configuration. Workspace paths must already exist; relative paths resolve against the current working directory. The Pages repository must use `owner/name` syntax, but `init` does not contact GitHub or publish anything.

All CLI path arguments accept absolute or relative values. Relative paths resolve against the invocation directory before use:

```bash
bun run vito --config .vito/config.json collect
```

## How it works

```text
Agent histories + local Git refs
              │
              ▼
   Source-specific adapters
              │
              ▼
 Private normalized SQLite ledger
              │
              ▼
 DST-aware aggregate calculations
              │
              ▼
 Aggregate-only activity.json
              │
              ▼
 Static HTML/CSS/JS widgets
              │
              ▼
 Optional dedicated GitHub Pages repo
```

Accounting and measured work intervals are separate facts. A running agent means a source recorded active inference or tool execution; an open terminal, idle process, session lifetime, or generic turn envelope is not treated as uptime.

Collection is idempotent. Semantic origin keys, cumulative counter baselines, JSONL cursors, and SQLite watermarks prevent unchanged or replayed source records from being counted again.

## Commands

### `init`

```bash
bun run vito init \
  --workspace . \
  --pages-repo OWNER/REPOSITORY
```

Repeat `--workspace` for additional roots. All path arguments—including `--config`, `--workspace`, `--state-dir`, `--out`, and `--dir`—may be absolute or relative to the invocation directory. Optional initialization flags are `--timezone <IANA>` and `--state-dir <path>`.

Creates the private configuration and owned state directory. It does not scan conversations or contact GitHub.

### `discover`

```bash
bun run vito discover
```

Inspects recognized source locations and schema metadata. It reports source state, supported capabilities, private paths, and diagnostic counts without ingesting conversation content. It can run without a company configuration.

### `collect`

```bash
bun run vito collect
bun run vito collect --rebuild
```

Collects supported activity, records one explicit scope decision per canonical usage origin, and refreshes locally known default-branch commit membership. Workspace roots preserve broad containment semantics; live linked worktrees also count when their Git common directory matches an included repository.

`--rebuild` reparses available sources and recomputes derived allocations while preserving configuration, retained cumulative observations, missing-source partitions, prior scope evidence, and the last published artifact. Source logs are never deleted. Scope contraction reclassifies retained usage, sessions, and work intervals instead of deleting evidence.

### `export`

```bash
bun run vito export --out ./public
```

For reproducible output, fix the cutoff:

```bash
bun run vito export \
  --out ./public \
  --at 2026-09-06T12:00:00Z
```

`--at` excludes later records. It does not manufacture historical observations.

Each export contains exactly:

```text
.nojekyll
activity.json
index.html
styles.css
widget.html
widget.js
```

The exporter validates the complete public snapshot, rejects unsafe or source-overlapping destinations, stages files privately, and replaces `activity.json` last so readers never receive a partial JSON file.

### `scope`

```bash
bun run vito scope \
  --days 30 \
  --at 2026-09-06T12:00:00Z
```

Reads the private ledger without collecting, exporting, publishing, or changing configuration. The report prints exact window boundaries, timezone, collection freshness, included/excluded/unattributed known tokens, unknown-total records, and private harness/provider/reason/workspace breakdowns. Use the same `--at` cutoff as an export when comparing totals.

### `preview`

```bash
bun run vito preview \
  --dir ./public \
  --port 4173
```

Serves only the static export on `127.0.0.1`. The preview server blocks path traversal and symlink escape and exposes no configuration, source, or state routes.

Open:

```text
http://127.0.0.1:4173/
```

### `publish`

Prepare and validate a publication without remote mutation:

```bash
bun run vito publish --dry-run
```

Perform a normal update after Pages setup:

```bash
bun run vito publish
```

Publication uses an owned checkout under `<stateDir>/pages`. It refuses unexpected dirty contents, remote divergence, unrelated Pages settings, and non-managed repositories. It never force-pushes.

### `pages setup`

```bash
bun run vito pages setup
```

This is the explicit first-publication operation. Before running it:

1. Create the configured repository yourself.
2. Make it public and dedicated to Vito output.
3. Authenticate `gh` for the intended GitHub account.

Setup verifies the repository, publishes the generated files under `/docs`, adds the fixed `.vito-pages.json` ownership marker, pushes `main` without force, and configures branch-based GitHub Pages for `/docs`.

Vito does not create a repository under a guessed owner and does not replace unrelated repository contents or Pages settings.

### `tick`

```bash
bun run vito tick
```

Runs one collection pass. It exports and publishes only when the last successful publication is at least 15 minutes old. A publication failure does not discard successful local collection.

### Scheduling

```bash
bun run vito schedule install
bun run vito schedule status
bun run vito schedule uninstall
```

On macOS, installation creates the managed launch agent:

```text
~/Library/LaunchAgents/com.agentnative.vito.plist
```

It invokes `tick` every 60 seconds and at login. Publication remains limited to once every 15 minutes. Uninstall removes only the managed job and plist; private data and exported artifacts remain.

Vito does not edit coding-agent configurations, install hooks, poll agent processes, or copy the user's full environment into launchd.

## Configuration

The private configuration has this shape:

```ts
interface Config {
  version: 1;
  companyName?: string;
  workspaceRoots: string[];
  timezone: string;
  stateDir: string;
  sources: Partial<Record<
    "codex" | "claude" | "omp" | "opencode" | "hermes",
    string[]
  >>;
  repositories: Array<{
    path: string;
    remote: string;
    defaultBranch?: string;
  }>;
  historicalWorkspaces?: Array<{
    path: string;
    repositoryPath: string;
    match: "exact" | "descendants";
  }>;
  publication: {
    repository: string;
    branch: "main";
  };
}
```

`companyName` controls the dashboard eyebrow. It defaults to `"Agent Native"` for existing configurations.

### Source overrides

For each accounting adapter:

- Missing `sources.<agent>`: use recognized conventional locations.
- Non-empty array: replace conventional locations with those files or directories.
- Empty array: disable that adapter explicitly.

Fixtures and isolated installations should set every adapter key so Vito cannot accidentally collect from the user's home directory.

Example:

```json
{
  "version": 1,
  "companyName": "Komodo",
  "workspaceRoots": ["/absolute/company/workspace"],
  "timezone": "America/New_York",
  "stateDir": "/absolute/private/vito-state",
  "sources": {
    "codex": [],
    "claude": [],
    "omp": [],
    "opencode": [],
    "hermes": []
  },
  "repositories": [],
  "publication": {
    "repository": "OWNER/REPOSITORY",
    "branch": "main"
  }
}
```

`historicalWorkspaces` defaults to `[]`, so existing version-1 configurations load unchanged. It authorizes a deleted workspace path explicitly:

```json
{
  "path": "/absolute/private/symphony-workspaces",
  "repositoryPath": "/absolute/company/repository",
  "match": "descendants"
}
```

Use `exact` for one deleted workspace and `descendants` only for a dedicated historical workspace container. Targets must remain included by `workspaceRoots` or `repositories`. Overlapping mappings, private source/state overlaps, prefix lookalikes, and symlink escapes are rejected. A directory or branch name is never treated as repository ownership evidence.

### Repository overrides

Repositories under workspace roots are discovered automatically. Explicit entries may include a repository outside those roots and select its remote and default branch:

```json
{
  "path": "/absolute/company/workspace/repository",
  "remote": "origin",
  "defaultBranch": "main"
}
```

Without `defaultBranch`, Vito resolves `refs/remotes/<remote>/HEAD`. It never guesses `main` or `master`, uses a checked-out feature branch as the default, or fetches remote changes.

## Supported sources

| Source | Tokens | Measured work | Notes |
| --- | --- | --- | --- |
| Codex | Yes | Partial/recorded when item timings exist | Reconciles modern usage with cumulative legacy mirrors |
| Claude Code | Yes | Unavailable | Turn duration is not treated as exact active work |
| OMP | Yes | Recorded inference intervals where available | Excludes parent task usage projections |
| OpenCode | Yes | Inference and completed/error tool intervals | Reads the source SQLite database in readonly mode with live WAL visibility |
| Hermes | Yes | Unavailable | Diffs cumulative snapshots and excludes mirrored Codex accounting |
| Blume | Excluded | Excluded | Wrapper importing upstream histories |
| Kimi Code | Unsupported when no standalone history exists | Unsupported | Inventory only |
| Grok Bot | Unsupported | Unsupported | Persisted transcripts expose no usable scoped accounting/work intervals |

Unsupported or missing sources remain visible as coverage gaps. Vito does not replace missing evidence with zeroes or process-liveness estimates.

## Metrics

### Tokens

- Total canonical token traffic, counting cache tokens once
- Uncached input
- Cache read
- Cache write
- Output
- Reasoning as a non-additive subset of output
- Other recorded tokens when a complete component breakdown leaves a nonnegative residual
- Token-weighted model and harness mix
- Cache-read share using paired eligible prompt observations

Cache-read share is not a request cache-hit rate. Token share is not compute share or productivity.

### Scope accounting

Every canonical normalized usage origin is classified once as `included`, `out-of-scope`, or `unattributed`. Public snapshots retain date-aligned aggregate accounting for auditability, while the dashboard presents only included usage. The private `scope` command provides decision, reason, provider, and workspace diagnostics. Included usage, work intervals, and sessions use the same ownership decision.

### Work

For an elapsed window:

- **Active hours:** measured union-active time
- **Measured uptime:** union-active time divided by the full elapsed window
- **Inference streaks:** longest run of consecutive elapsed hourly slots containing recorded inference, plus consecutive local calendar days containing recorded inference
- **Agent-hours:** summed time across independently active agent lanes
- **Average concurrency:** agent time divided by the full elapsed window
- **Concurrency while busy:** agent time divided by measured active time
- **Parallel-work share:** time with at least two measured agents divided by measured active time
- **Concurrency distribution:** time-weighted exact agent counts plus separate unavailable time
- **Work rhythm:** weekday × local hour active fraction or agent-hours

Overlapping inference and tool intervals within one agent lane do not create a second agent. Independently executing children do. Unavailable timing is distinct from “no recorded work.”

### Commits

Vito counts unique commits reachable from each configured repository's locally known remote default-branch tip, grouped by committer date. Merge commits count once; feature-branch-only commits do not count.

Vito does not fetch, checkout, stash, reset, or rewrite developer repositories. Git metrics can therefore be stale relative to the remote; collection time is not presented as remote freshness.

### Costs

**API-equivalent cost** is the primary dollar metric: recorded token usage valued at pinned, first-party standard API prices, regardless of the harness, subscription plan, or whether the source reports a dollar amount. It is not actual spend, a subscription allocation, or an invoice.

For each dated usage record, Vito prices uncached input, cache reads, cache writes, and output separately. Reasoning is already included in output and is never billed twice. Context-dependent tariffs are selected per request from the full prompt size, including cached tokens—not from daily totals. Claude cache writes use the standard five-minute tariff. The valuation excludes batch/fast-mode discounts or premiums, regional adjustments, storage, tools, taxes, and negotiated pricing.

Rates and explicit model aliases live in `src/pricing.ts`. The catalog is pinned as of **2026-09-06**, using [OpenAI](https://developers.openai.com/api/docs/pricing), [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing), [Kimi](https://platform.kimi.ai/docs/pricing/chat-k3), [Z.AI](https://docs.z.ai/guides/overview/pricing), and [Google](https://ai.google.dev/gemini-api/docs/pricing) API prices. Coding-plan aliases such as Kimi `k3` are valued at the corresponding model's API tariff, not the plan catalog's zero. Historical usage is valued at this pinned rate set; these are not historical prices. Updating the catalog and re-exporting revalues existing ledger records without recollection or a network pricing lookup.

Coverage includes priced/unpriced records and tokens. Missing model rates, missing bucket rates for nonzero usage, incomplete token breakdowns, and inconsistent totals remain unpriced; Vito does not guess a model family or fill missing buckets with zero. Token coverage uses known totals only; records with unknown totals still count as unpriced records. Complete zero-token records have a genuine zero valuation. A partially priced population reports a partial dollar total; a wholly unpriced population reports unavailable.

Source-estimated and provider-reported USD remain separate secondary evidence and are never added to API-equivalent cost or used as its fallback. Source **No cost evidence** and **Included plan** counts describe that secondary evidence only; included-plan usage still receives an API-equivalent valuation when its token breakdown and model rate are known.

Public snapshots use **schema version 3**, including pricing basis, rate date, source URLs, and daily scope-accounting coverage. Rebuild the web assets and re-export together when upgrading; older snapshots are not accepted by the new viewer.

## Widgets and embedding

The token-mix stacked area chart and parallel-work donut use modular [Apache ECharts](https://echarts.apache.org/) with SVG rendering. The area chart uses straight segments rather than custom smoothing and leaves unavailable days as gaps. Built-in tooltips provide color markers matching the series/slice legends, with wrapping on narrow screens. Keyboard controls inspect daily values and donut slices; hiding a series does not change full-population percentage denominators.

The local preview allows inline **style attributes** for ECharts' native HTML tooltip markup. Scripts and stylesheets remain same-origin; inline scripts are not allowed.

The standalone page is `index.html`. Embeddable widgets use `widget.html`:

```html
<iframe
  src="https://OWNER.github.io/REPOSITORY/widget.html?view=all&range=30&theme=auto"
  title="Agent Native coding-agent activity"
  loading="lazy"
></iframe>
```

Supported query parameters:

- `view`: `calendar`, `models`, `uptime`, `concurrency`, `agent-hours`, `parallelism`, `rhythm`, `cache`, `commits`, `cost`, or `all`
- `range`: `7`, `30`, `90`, or `365`
- `theme`: `auto`, `light`, or `dark`
- `harness`: `all`, `codex`, `claude`, `omp`, `opencode`, or `hermes`

Invalid values fall back to `all`, `30`, `auto`, and `all` respectively. Harness filtering applies to usage and work panels; commits remain company-wide. Provider/model selection affects resource panels only, not work or commits.

The widget uses only same-origin `activity.json`, has no analytics SDK or telemetry beacon, supports keyboard-accessible values and tables, honors reduced-motion preferences, and adapts to 320px-wide embeds.

## Privacy and safety

Private local state may contain:

- source and workspace paths
- repository and session attribution
- request/turn lineage hashes
- source cursors and cumulative baselines
- commit object identifiers
- detailed collection diagnostics

Public artifacts contain only allowlisted aggregates and fixed coverage reason codes. Export construction is field-by-field and deeply schema-validated.

Vito never intentionally persists or exports:

- prompts or message text
- tool arguments or results
- conversation titles
- credentials or provider URLs
- workspace or repository identifiers
- commit messages, hashes, or author identities

The writer lock prevents overlapping mutations. Source SQLite databases are opened readonly. Publisher and export destinations are checked against protected source and repository trees.

## Development

```bash
bun run build
bun run typecheck
bun test
```

The test suite uses synthetic JSONL, synthetic SQLite databases, temporary Git repositories, a local bare publication remote, fixture Pages API transports, and temporary launchd paths. It does not require live publication or installation of a real launch agent.

## Important limitations

- Initial scope is one computer; this is not a multi-machine ingestion service.
- The dashboard covers selected local workspaces, not an entire provider or billing account.
- Historical work timing remains unavailable where upstream sources do not record exact intervals.
- Locally known Git remote refs may be stale because Vito deliberately does not fetch.
- Cost data is shown only when the source exposes usable dated evidence.
- Live Pages setup and scheduling are explicit user operations, never automatic initialization side effects.
