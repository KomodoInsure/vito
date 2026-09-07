# VITO

VITO—**Vibe in the Open**—turns local coding-agent usage and Git history into a private activity ledger and an aggregate-only dashboard. It runs locally, reads supported accounting sources in place, and can publish static widgets to a dedicated GitHub Pages repository.

**See it live:** [Komodo's public VITO dashboard](https://komodoinsure.github.io/stats/)

The dashboard tracks daily token volume, model and harness mix, measured active time, inference streaks, concurrency, work rhythm, API-equivalent cost, source-reported cost, and commits reachable from configured repositories' remote default branches.

Raw prompts, messages, tool inputs and outputs, local paths, repository names, session identifiers, commit hashes, and credentials are excluded from public exports.

**Maintainer disclosure:** VITO is open-source software maintained by Komodo Risk Inc.

## Requirements

- macOS only for launchd scheduling; collection, export, and preview use Bun APIs
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

Create a private configuration for one or more workspace roots. Relative paths resolve from the invocation directory and are stored as canonical absolute paths:

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

VITO never overwrites an existing configuration. Workspace paths must already exist. The Pages repository must use `owner/name` syntax, but `init` does not contact GitHub or publish anything.

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

Accounting and measured work are separate. VITO counts an agent as active only when a source records inference or tool execution—not while a terminal, process, session, or generic turn remains open.

Collection is idempotent. Semantic origin keys, cumulative-counter baselines, JSONL cursors, and SQLite watermarks prevent unchanged or replayed records from being counted twice.

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
LICENSE
NOTICE
styles.css
THIRD_PARTY_NOTICES
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

Publication uses a VITO-owned checkout under `<stateDir>/pages`. It refuses dirty contents, remote divergence, unrelated Pages settings, and repositories not marked as managed. It never force-pushes.

### `pages setup`

```bash
bun run vito pages setup
```

This is the explicit first-publication operation. Before running it:

1. Create the configured repository yourself.
2. Make it public and dedicate it to VITO output.
3. Authenticate `gh` for the intended GitHub account.

Setup verifies the repository, publishes the generated files under `/docs`, adds the fixed `.vito-pages.json` ownership marker, pushes `main` without force, and configures branch-based GitHub Pages for `/docs`.

VITO does not create a repository under a guessed owner or replace unrelated repository contents or Pages settings.

### `tick`

```bash
bun run vito tick
```

Runs one collection pass. It exports and publishes only when the last successful publication is at least 15 minutes old. Failed publication never discards a successful local collection.

### Scheduling

```bash
bun run vito schedule install
bun run vito schedule status
bun run vito schedule uninstall
```

On macOS, installation creates this managed launch agent:

```text
~/Library/LaunchAgents/com.komodorisk.vito.plist
```

It runs `tick` every 60 seconds and at login, while publication remains limited to once every 15 minutes. Uninstall removes only the managed job and plist; private data and exports remain.

VITO does not change coding-agent configurations, install hooks, poll agent processes, or copy the full user environment into launchd.

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

`companyName` controls the dashboard eyebrow. It defaults to `"Komodo Risk Inc"`.

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
  "companyName": "Komodo Risk Inc",
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

Without `defaultBranch`, VITO resolves `refs/remotes/<remote>/HEAD`. It never guesses `main` or `master`, treats the checked-out feature branch as the default, or fetches remote changes.

## Supported sources

| Source | Tokens | Measured work | Notes |
| --- | --- | --- | --- |
| Codex | Yes | Partial/recorded when item timings exist | Reconciles modern usage with cumulative legacy mirrors |
| Claude Code | Yes | Unavailable | Turn duration is not treated as exact active work |
| OMP | Yes | Recorded inference intervals where available | Excludes parent task usage projections |
| OpenCode | Yes | Inference and completed/error tool intervals | Reads the source SQLite database in readonly mode with live WAL visibility |
| Hermes | Yes | Unavailable | Diffs cumulative snapshots and excludes mirrored Codex accounting |
| Kimi Code | Unsupported when no standalone history exists | Unsupported | Inventory only |
| Grok Bot | Unsupported | Unsupported | Persisted transcripts expose no usable scoped accounting/work intervals |

Unsupported or missing sources remain visible as coverage gaps. VITO never replaces missing evidence with zeroes or process-liveness estimates.

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

VITO counts unique commits reachable from each configured repository's locally known remote default-branch tip and groups them by committer date. Merge commits count once; feature-branch-only commits do not count.

VITO never fetches, checks out, stashes, resets, or rewrites developer repositories. Git metrics can therefore lag the remote.

### Costs

**API-equivalent cost** values recorded token usage at pinned first-party standard API prices. It is not actual spend, a subscription allocation, or an invoice.

VITO prices uncached input, cache reads, cache writes, and output separately. Reasoning is already part of output and is never billed twice. Context-dependent tariffs use each request's full prompt size, including cached tokens. Claude cache writes use the standard five-minute tariff. The calculation excludes batch and fast-mode adjustments, regional pricing, storage, tools, taxes, and negotiated rates.

Rates and explicit model aliases live in `src/pricing.ts`. The catalog is pinned as of **2026-09-06** using published prices from [OpenAI](https://developers.openai.com/api/docs/pricing), [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing), [Kimi](https://platform.kimi.ai/docs/pricing/chat-k3), [Z.AI](https://docs.z.ai/guides/overview/pricing), and [Google](https://ai.google.dev/gemini-api/docs/pricing). Historical usage is valued at this pinned rate set. Updating the catalog and re-exporting revalues existing records without recollection or a network pricing lookup.

Coverage distinguishes priced and unpriced records and tokens. Missing model rates, missing rates for nonzero buckets, incomplete token breakdowns, and inconsistent totals remain unpriced; VITO does not guess. A partial population reports a partial dollar total, while a wholly unpriced population reports cost as unavailable.

Source-estimated and provider-reported USD remain separate evidence. They are never added to API-equivalent cost or used as a fallback.

Public snapshots use **schema version 3**, including pricing basis, rate date, source URLs, and daily scope-accounting coverage. Rebuild the web assets and re-export together when upgrading; older snapshots are not accepted by the new viewer.

## Widgets and embedding

The token-mix area chart and parallel-work donut use modular [Apache ECharts](https://echarts.apache.org/) with SVG rendering. Both charts expose keyboard-accessible values and tooltips. Hiding a series does not change full-population percentage denominators.

The local preview permits inline **style attributes** only for ECharts' native tooltip markup. Scripts and stylesheets remain same-origin; inline scripts are blocked.

The standalone page is `index.html`. Embeddable widgets use `widget.html`:

```html
<iframe
  src="https://OWNER.github.io/REPOSITORY/widget.html?view=all&range=30&theme=auto"
  title="VITO coding-agent activity"
  loading="lazy"
></iframe>
```

Supported query parameters:

- `view`: `calendar`, `models`, `uptime`, `concurrency`, `agent-hours`, `parallelism`, `rhythm`, `cache`, `commits`, `cost`, or `all`
- `range`: `7`, `30`, `90`, or `365`
- `theme`: `auto`, `light`, or `dark`
- `harness`: `all`, `codex`, `claude`, `omp`, `opencode`, or `hermes`

Invalid values fall back to `all`, `30`, `auto`, and `all`. Harness filtering applies to usage and work panels; commits remain company-wide. Provider and model selection affects resource panels only.

The widget loads only same-origin `activity.json`, includes no analytics or telemetry beacon, supports keyboard navigation, honors reduced-motion preferences, and adapts to 320px-wide embeds.

## Privacy and safety

Collection and aggregation run locally. Adapters read supported source records to extract usage, timing, cost, and attribution metadata; those upstream records may also contain conversation content.

VITO does not copy raw prompts, messages, or tool inputs and results into its normalized ledger or public exports. OpenCode deduplication stores content-derived SHA-256 fingerprints in private state. Hermes task labels are hashed before storage. Neither value is exported.

Private local state may contain:

- source and workspace paths
- repository and session attribution
- request, turn, route, and deduplication hashes
- source cursors and cumulative baselines
- commit object identifiers
- detailed collection diagnostics

Public artifacts contain the configured organization name, sanitized provider/model/harness labels, dated aggregates, fixed pricing-source URLs, and fixed coverage reason codes. Export construction is field-by-field and deeply schema-validated.

Public exports exclude:

- raw prompts, messages, and conversation titles
- tool arguments and results
- credentials and provider URLs
- source, workspace, and repository paths or identifiers
- session and request identifiers
- commit messages, hashes, and author identities

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
- Locally known Git remote refs may be stale because VITO deliberately does not fetch.
- Cost data is shown only when the source exposes usable dated evidence.
- Live Pages setup and scheduling are explicit user operations, never automatic initialization side effects.

## License

VITO is licensed under the [Apache License 2.0](LICENSE). The project
[NOTICE](NOTICE) and required attributions and license texts for bundled
third-party software in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) are included
in every generated static export.
