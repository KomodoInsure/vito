import { createHash } from "node:crypto";
import { existsSync, realpathSync, readdirSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize } from "node:path";
import { Database } from "bun:sqlite";
import { Temporal } from "@js-temporal/polyfill";

import type { Config } from "../config";
import type { Quality, UsageRecord } from "../contracts";
import type { CounterSnapshot, SessionRecord, SourceRecord } from "../store";
import type { AdapterBatch, AdapterContext, DiscoveryEntry, SourceAdapter } from "./types";

const SOURCE_KEY = "hermes";
const REQUIRED_SESSION_COLUMNS = ["id", "source", "started_at"] as const;
const TOKEN_COLUMNS = ["input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"] as const;
const MODEL_KEY_COLUMNS = ["session_id", "model"] as const;
const COST_KINDS = ["source-estimate", "provider-reported", "included", "unknown"] as const;
type CostKind = (typeof COST_KINDS)[number];
class UnsupportedHermesSchemaError extends Error {
  override readonly name = "UnsupportedHermesSchemaError";
}
type SqlRow = Record<string, unknown>;

export interface HermesCounters {
  uncachedInput: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
  costMicrousd: number | null;
}

export interface HermesCost {
  costMicrousd: number | null;
  costKind: CostKind;
  partial: boolean;
}

interface ProjectedSession {
  databasePath: string;
  rawId: string;
  parentId: string | null;
  startedMs: number;
  endedMs: number | null;
  lastActivityMs: number | null;
  workspace: string | null;
  repository: string | null;
  provider: string;
  routeDigest: string;
  counters: HermesCounters;
  rows: ProjectedCounter[];
  copyConflict: boolean;
}

interface ProjectedCounter {
  counterKey: string;
  sessionRawId: string;
  model: string;
  provider: string;
  task: string;
  firstSeenMs: number | null;
  lastSeenMs: number | null;
  counters: HermesCounters;
  costKind: CostKind;
  partial: boolean;
  duplicateAmbiguous: boolean;
  upstreamOwned: boolean;
  unresolvedRoute: boolean;
}

interface Projection {
  sessions: ProjectedSession[];
  schemaVersion: string;
  parseGaps: number;
}

interface SnapshotView extends HermesCounters {
  epoch: number;
  firstSeenMs: number | null;
  lastSeenMs: number | null;
  costKind: CostKind;
}

interface AllocationResult {
  usage: UsageRecord | null;
  snapshot: CounterSnapshot;
  unallocated: boolean;
  discontinuity: boolean;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableDigest(parts: readonly unknown[]): string {
  return digest(JSON.stringify(parts));
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonnegativeInteger(value: unknown): number | null {
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function secondsToMilliseconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const milliseconds = Math.round(value * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function dollarsToMicrousd(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const microusd = Math.round(value * 1_000_000);
  return Number.isSafeInteger(microusd) ? microusd : null;
}

export function normalizeHermesCost(row: SqlRow): HermesCost {
  const status = text(row.cost_status).toLowerCase();
  if (status === "actual") {
    const costMicrousd = dollarsToMicrousd(row.actual_cost_usd);
    return { costMicrousd, costKind: costMicrousd === null ? "unknown" : "provider-reported", partial: costMicrousd === null };
  }
  if (status === "estimated") {
    const costMicrousd = dollarsToMicrousd(row.estimated_cost_usd);
    return { costMicrousd, costKind: costMicrousd === null ? "unknown" : "source-estimate", partial: costMicrousd === null };
  }
  if (status === "included") return { costMicrousd: null, costKind: "included", partial: false };
  return { costMicrousd: null, costKind: "unknown", partial: false };
}

export function normalizeHermesCounters(row: SqlRow, cost = normalizeHermesCost(row)): { counters: HermesCounters; partial: boolean } {
  const values = TOKEN_COLUMNS.map((column) => nonnegativeInteger(row[column]));
  let partial = values.some((value) => value === null);
  let [uncachedInput, cacheRead, cacheWrite, output, reasoning] = values;
  if (output !== null && reasoning !== null && reasoning > output) {
    reasoning = null;
    partial = true;
  }
  const visible = [uncachedInput, cacheRead, cacheWrite, output];
  const total = visible.every((value) => value !== null)
    ? visible.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  return {
    counters: { uncachedInput, cacheRead, cacheWrite, output, reasoning, total, costMicrousd: cost.costMicrousd },
    partial,
  };
}

function reportingDate(milliseconds: number, timezone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(milliseconds).toZonedDateTimeISO(timezone).toPlainDate().toString();
}

function sameReportingDate(firstMs: number | null, lastMs: number | null, timezone: string): boolean {
  return firstMs !== null && lastMs !== null && firstMs <= lastMs && reportingDate(firstMs, timezone) === reportingDate(lastMs, timezone);
}

function costKindFromReasons(raw: unknown): CostKind {
  if (typeof raw !== "string") return "unknown";
  try {
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values)) return "unknown";
    for (const kind of COST_KINDS) if (values.includes(`cost-kind:${kind}`)) return kind;
  } catch {
    return "unknown";
  }
  return "unknown";
}

function snapshotFromRow(row: Record<string, unknown> | null): SnapshotView | null {
  if (row === null) return null;
  return {
    epoch: nonnegativeInteger(row.epoch) ?? 0,
    firstSeenMs: nonnegativeInteger(row.first_seen_ms),
    lastSeenMs: nonnegativeInteger(row.last_seen_ms),
    uncachedInput: nonnegativeInteger(row.uncached_input),
    cacheRead: nonnegativeInteger(row.cache_read),
    cacheWrite: nonnegativeInteger(row.cache_write),
    output: nonnegativeInteger(row.output),
    reasoning: nonnegativeInteger(row.reasoning),
    total: nonnegativeInteger(row.total),
    costMicrousd: nonnegativeInteger(row.cost_microusd),
    costKind: costKindFromReasons(row.reasons_json),
  };
}

function counterValues(counters: HermesCounters): Array<number | null> {
  return [counters.uncachedInput, counters.cacheRead, counters.cacheWrite, counters.output, counters.reasoning, counters.total, counters.costMicrousd];
}

function hasCounterActivity(counters: HermesCounters): boolean {
  return counterValues(counters).some((value) => value !== null && value > 0);
}

function changedCounters(current: HermesCounters, previous: SnapshotView): boolean {
  return counterValues(current).some((value, index) => value !== counterValues(previous)[index]);
}

function hasDecrease(current: HermesCounters, previous: SnapshotView): boolean {
  return counterValues(current).some((value, index) => {
    const before = counterValues(previous)[index];
    return value !== null && before !== null && value < before;
  });
}

function subtractCounters(current: HermesCounters, previous: SnapshotView): HermesCounters {
  const subtract = (value: number | null, before: number | null): number | null =>
    value === null || before === null ? null : value - before;
  return {
    uncachedInput: subtract(current.uncachedInput, previous.uncachedInput),
    cacheRead: subtract(current.cacheRead, previous.cacheRead),
    cacheWrite: subtract(current.cacheWrite, previous.cacheWrite),
    output: subtract(current.output, previous.output),
    reasoning: subtract(current.reasoning, previous.reasoning),
    total: subtract(current.total, previous.total),
    costMicrousd: subtract(current.costMicrousd, previous.costMicrousd),
  };
}

function usageRecord(
  projected: ProjectedCounter,
  counters: HermesCounters,
  epoch: number,
  previous: SnapshotView | null,
  workspace: string,
  repository: string | null,
  atMs: number | null,
  quality: Quality,
  reasons: string[],
): UsageRecord {
  const originKey = `hermes-usage:${stableDigest([
    projected.counterKey,
    epoch,
    previous === null ? "initial" : counterValues(previous),
    counterValues(counters),
    atMs,
  ])}`;
  return {
    originKey,
    agent: "hermes",
    sessionKey: `hermes:${projected.sessionRawId}`,
    workspaceKey: workspace,
    repositoryKey: repository,
    turnKey: projected.task.length > 0 ? `task:${stableDigest([projected.task])}` : null,
    requestKey: null,
    atMs,
    provider: projected.provider,
    model: projected.model,
    uncachedInput: counters.uncachedInput,
    cacheRead: counters.cacheRead,
    cacheWrite: counters.cacheWrite,
    output: counters.output,
    reasoning: counters.reasoning,
    total: counters.total,
    costMicrousd: counters.costMicrousd,
    costKind: counters.costMicrousd === null && projected.costKind !== "included" ? "unknown" : projected.costKind,
    quality,
    reasons,
  };
}

function allocateCounter(
  projected: ProjectedCounter,
  previousRow: Record<string, unknown> | null,
  timezone: string,
  cutoffMs: number,
  workspace: string,
  repository: string | null,
): AllocationResult {
  const previous = snapshotFromRow(previousRow);
  const baseReasons = [
    ...(projected.partial ? ["parse-gap"] : []),
    ...(projected.duplicateAmbiguous ? ["duplicate-ambiguity"] : []),
  ];
  let epoch = previous?.epoch ?? 0;
  let counters: HermesCounters | null = null;
  let atMs: number | null = projected.lastSeenMs;
  let unallocated = false;
  let discontinuity = false;
  let partial = projected.partial || projected.duplicateAmbiguous;

  if (projected.upstreamOwned || projected.unresolvedRoute) {
    unallocated = projected.unresolvedRoute;
  } else if (previous === null) {
    if (hasCounterActivity(projected.counters)) {
      if (sameReportingDate(projected.firstSeenMs, projected.lastSeenMs, timezone)) counters = projected.counters;
      else unallocated = true;
    }
  } else if (hasDecrease(projected.counters, previous)) {
    epoch += 1;
    discontinuity = true;
    partial = true;
    unallocated = true;
  } else if (changedCounters(projected.counters, previous)) {
    if (
      previous.lastSeenMs !== null &&
      projected.lastSeenMs !== null &&
      previous.lastSeenMs <= projected.lastSeenMs &&
      sameReportingDate(previous.lastSeenMs, projected.lastSeenMs, timezone)
    ) {
      counters = subtractCounters(projected.counters, previous);
      if (previous.costKind !== projected.costKind) counters.costMicrousd = null;
    } else {
      unallocated = hasCounterActivity(projected.counters);
    }
  }

  const reasons = [...baseReasons];
  if (discontinuity) reasons.push("counter-discontinuity");

  const snapshotReasons = [...reasons, `cost-kind:${projected.costKind}`];
  const snapshot: CounterSnapshot = {
    sourceKey: SOURCE_KEY,
    counterKey: projected.counterKey,
    epoch,
    sessionKey: `hermes:${projected.sessionRawId}`,
    provider: projected.provider,
    model: projected.model,
    observedAtMs: cutoffMs,
    firstSeenMs: projected.firstSeenMs,
    lastSeenMs: projected.lastSeenMs,
    uncachedInput: projected.counters.uncachedInput,
    cacheRead: projected.counters.cacheRead,
    cacheWrite: projected.counters.cacheWrite,
    output: projected.counters.output,
    reasoning: projected.counters.reasoning,
    total: projected.counters.total,
    costMicrousd: projected.counters.costMicrousd,
    quality: partial ? "partial" : "recorded",
    reasons: snapshotReasons,
  };

  const usageReasons = [...reasons];
  if (unallocated) usageReasons.push("unallocated-history");
  const retainedCounters = counters ?? (unallocated && !discontinuity ? (
    previous === null ? projected.counters : subtractCounters(projected.counters, previous)
  ) : null);
  const usage = retainedCounters !== null && hasCounterActivity(retainedCounters)
    ? usageRecord(
      projected,
      retainedCounters,
      epoch,
      previous,
      workspace,
      repository,
      unallocated ? null : atMs,
      partial || unallocated ? "partial" : "recorded",
      usageReasons,
    )
    : null;
  return { usage, snapshot, unallocated, discontinuity };
}

function tableNames(database: Database): Set<string> {
  return new Set((database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
}

function columnNames(database: Database, table: string): Set<string> {
  if (table !== "sessions" && table !== "session_model_usage" && table !== "schema_version") return new Set();
  return new Set((database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function selectProjection(database: Database, databasePath: string): Projection {
  const tables = tableNames(database);
  if (!tables.has("sessions")) throw new UnsupportedHermesSchemaError("unsupported-schema");
  const sessionColumns = columnNames(database, "sessions");
  if (REQUIRED_SESSION_COLUMNS.some((column) => !sessionColumns.has(column))) {
    throw new UnsupportedHermesSchemaError("unsupported-schema");
  }

  const sessionAllowlist = [
    "id", "source", "parent_session_id", "model", "started_at", "ended_at", "last_activity_at", "cwd", "git_repo_root",
    ...TOKEN_COLUMNS, "estimated_cost_usd", "actual_cost_usd", "cost_status", "cost_source",
  ];
  const selectedSessionColumns = sessionAllowlist.filter((column) => sessionColumns.has(column));
  const sessionRows = database.query(`SELECT ${selectedSessionColumns.join(", ")} FROM sessions`).all() as SqlRow[];

  const hasModelTable = tables.has("session_model_usage");
  const modelColumns = hasModelTable ? columnNames(database, "session_model_usage") : new Set<string>();
  if (hasModelTable && MODEL_KEY_COLUMNS.some((column) => !modelColumns.has(column))) {
    throw new UnsupportedHermesSchemaError("unsupported-schema");
  }
  const modelAllowlist = [
    "session_id", "model", "billing_provider", "billing_base_url", "billing_mode", "task", ...TOKEN_COLUMNS,
    "estimated_cost_usd", "actual_cost_usd", "cost_status", "cost_source", "first_seen", "last_seen",
  ];
  const selectedModelColumns = modelAllowlist.filter((column) => modelColumns.has(column));
  const modelRows = hasModelTable && selectedModelColumns.length > 0
    ? database.query(`SELECT ${selectedModelColumns.join(", ")} FROM session_model_usage`).all() as SqlRow[]
    : [];

  const rowsBySession = new Map<string, SqlRow[]>();
  for (const row of modelRows) {
    const sessionId = text(row.session_id);
    if (sessionId.length === 0) continue;
    const rows = rowsBySession.get(sessionId) ?? [];
    rows.push(row);
    rowsBySession.set(sessionId, rows);
  }

  let parseGaps = 0;
  const sessions: ProjectedSession[] = [];
  for (const row of sessionRows) {
    const rawId = text(row.id);
    const startedMs = secondsToMilliseconds(row.started_at);
    if (rawId.length === 0 || startedMs === null) {
      parseGaps += 1;
      continue;
    }
    const sessionCost = normalizeHermesCost(row);
    const normalizedSession = normalizeHermesCounters(row, sessionCost);
    if (normalizedSession.partial) parseGaps += 1;
    const projectedRows: ProjectedCounter[] = [];
    for (const usageRow of rowsBySession.get(rawId) ?? []) {
      const cost = normalizeHermesCost(usageRow);
      const normalized = normalizeHermesCounters(usageRow, cost);
      const providerValue = text(usageRow.billing_provider).trim();
      const provider = providerValue.length > 0 ? providerValue : "unknown";
      const model = text(usageRow.model).trim() || "unknown";
      const task = text(usageRow.task).trim();
      const routeDigest = stableDigest([
        rawId,
        model,
        providerValue,
        text(usageRow.billing_base_url),
        text(usageRow.billing_mode),
        task,
      ]);
      const firstSeenMs = secondsToMilliseconds(usageRow.first_seen);
      const lastSeenMs = secondsToMilliseconds(usageRow.last_seen);
      const missingBounds = usageRow.first_seen !== undefined && firstSeenMs === null || usageRow.last_seen !== undefined && lastSeenMs === null;
      const unresolvedRoute = task.length > 0 && (providerValue.length === 0 || providerValue.toLowerCase() === "auto");
      projectedRows.push({
        counterKey: `model:${routeDigest}`,
        sessionRawId: rawId,
        model,
        provider,
        task,
        firstSeenMs,
        lastSeenMs,
        counters: normalized.counters,
        costKind: cost.costKind,
        partial: normalized.partial || missingBounds,
        duplicateAmbiguous: false,
        upstreamOwned: providerValue.toLowerCase() === "openai-codex",
        unresolvedRoute,
      });
      if (normalized.partial || missingBounds) parseGaps += 1;
    }
    const providerValue = text(row.billing_provider).trim();
    sessions.push({
      databasePath,
      rawId,
      parentId: nullableText(row.parent_session_id),
      startedMs,
      endedMs: secondsToMilliseconds(row.ended_at),
      lastActivityMs: secondsToMilliseconds(row.last_activity_at),
      workspace: nullableText(row.cwd) ?? nullableText(row.git_repo_root),
      repository: nullableText(row.git_repo_root),
      provider: providerValue || "unknown",
      routeDigest: stableDigest([
        rawId,
        providerValue,
        text(row.billing_base_url),
        text(row.billing_mode),
        "main-residual",
      ]),
      counters: normalizedSession.counters,
      rows: projectedRows,
      copyConflict: false,
    });
  }

  let schemaVersion = "unknown";
  if (tables.has("schema_version") && columnNames(database, "schema_version").has("version")) {
    const version = database.query("SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1").get() as { version?: unknown } | null;
    if (version?.version !== undefined) schemaVersion = String(version.version);
  }
  return { sessions, schemaVersion, parseGaps };
}

function projectDatabase(databasePath: string): Projection {
  const database = new Database(databasePath, { readonly: true });
  try {
    database.exec("BEGIN");
    try {
      const projection = selectProjection(database, databasePath);
      database.exec("COMMIT");
      return projection;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function probeDatabase(databasePath: string): string {
  const database = new Database(databasePath, { readonly: true });
  try {
    const tables = tableNames(database);
    if (!tables.has("sessions")) throw new UnsupportedHermesSchemaError("unsupported-schema");
    const sessionColumns = columnNames(database, "sessions");
    if (REQUIRED_SESSION_COLUMNS.some((column) => !sessionColumns.has(column))) {
      throw new UnsupportedHermesSchemaError("unsupported-schema");
    }
    if (tables.has("session_model_usage")) {
      const modelColumns = columnNames(database, "session_model_usage");
      if (MODEL_KEY_COLUMNS.some((column) => !modelColumns.has(column))) {
        throw new UnsupportedHermesSchemaError("unsupported-schema");
      }
    }
    if (!tables.has("schema_version") || !columnNames(database, "schema_version").has("version")) return "unknown";
    const version = database.query("SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1").get() as { version?: unknown } | null;
    return version?.version === undefined ? "unknown" : String(version.version);
  } finally {
    database.close();
  }
}

function counterComparable(first: HermesCounters, second: HermesCounters): boolean {
  return counterValues(first).every((value, index) => {
    const other = counterValues(second)[index];
    return value === null || other === null || value >= other;
  });
}

function candidateDominates(first: ProjectedSession, second: ProjectedSession): boolean {
  if (!counterComparable(first.counters, second.counters)) return false;
  const firstRows = new Map(first.rows.map((row) => [row.counterKey, row]));
  for (const row of second.rows) {
    const candidate = firstRows.get(row.counterKey);
    if (candidate === undefined || !counterComparable(candidate.counters, row.counters)) return false;
  }
  return true;
}

function latestObservation(session: ProjectedSession): number {
  return Math.max(session.lastActivityMs ?? 0, session.endedMs ?? 0, ...session.rows.map((row) => row.lastSeenMs ?? 0));
}

function selectMigratedCopies(sessions: ProjectedSession[]): { sessions: ProjectedSession[]; conflicts: number; excluded: number } {
  const groups = new Map<string, ProjectedSession[]>();
  for (const session of sessions) {
    const key = stableDigest([session.rawId, session.startedMs]);
    const values = groups.get(key) ?? [];
    values.push(session);
    groups.set(key, values);
  }
  const selected: ProjectedSession[] = [];
  let conflicts = 0;
  let excluded = 0;
  for (const candidates of groups.values()) {
    if (candidates.length === 1) {
      selected.push(candidates[0]!);
      continue;
    }
    const ordered = [...candidates].sort((left, right) => latestObservation(right) - latestObservation(left) || left.databasePath.localeCompare(right.databasePath));
    const dominant = ordered.find((candidate) =>
      ordered.every((other) => candidate === other || candidateDominates(candidate, other)));
    if (dominant !== undefined) selected.push(dominant);
    else {
      conflicts += 1;
      const chosen = ordered[0]!;
      chosen.rows = chosen.rows.map((row) => ({ ...row, duplicateAmbiguous: true }));
      chosen.copyConflict = true;
      selected.push(chosen);
    }
    excluded += candidates.length - 1;
  }
  return { sessions: selected, conflicts, excluded };
}

interface ResidualResult {
  counter: ProjectedCounter | null;
  inconsistent: boolean;
}

function positiveResidual(session: ProjectedSession): ResidualResult {
  const mainRows = session.rows.filter((row) => row.task.length === 0);
  const sum = (key: keyof HermesCounters): number | null => {
    const values = mainRows.map((row) => row.counters[key]);
    return values.every((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
  };
  const residual = (key: keyof HermesCounters): number | null => {
    const sessionValue = session.counters[key];
    const rowValue = sum(key);
    return sessionValue === null || rowValue === null ? null : sessionValue - rowValue;
  };
  const counters: HermesCounters = {
    uncachedInput: residual("uncachedInput"),
    cacheRead: residual("cacheRead"),
    cacheWrite: residual("cacheWrite"),
    output: residual("output"),
    reasoning: residual("reasoning"),
    total: residual("total"),
    costMicrousd: null,
  };
  const inconsistent = counterValues(counters).some((value) => value !== null && value < 0);
  if (inconsistent) return { counter: null, inconsistent: true };
  if (!hasCounterActivity(counters)) return { counter: null, inconsistent: false };
  const firstSeenMs = session.startedMs;
  const lastSeenMs = session.endedMs ?? session.lastActivityMs;
  return {
    counter: {
      counterKey: `residual:${session.routeDigest}`,
      sessionRawId: session.rawId,
      model: "unknown",
      provider: session.provider,
      task: "",
      firstSeenMs,
      lastSeenMs,
      counters,
      costKind: "unknown",
      partial: [
        counters.uncachedInput,
        counters.cacheRead,
        counters.cacheWrite,
        counters.output,
        counters.reasoning,
        counters.total,
      ].some((value) => value === null),
      duplicateAmbiguous: false,
      upstreamOwned: false,
      unresolvedRoute: false,
    },
    inconsistent: false,
  };
}

function rootsFromConfig(config?: Config): string[] {
  if (config !== undefined && Object.prototype.hasOwnProperty.call(config.sources, "hermes")) return config.sources.hermes ?? [];
  return [join(homedir(), ".hermes")];
}

function addDatabaseIfPresent(path: string, result: Set<string>): void {
  if (!existsSync(path)) return;
  try {
    if (statSync(path).isFile()) result.add(normalize(realpathSync.native(path)));
  } catch {
    // Discovery reports unreadable candidates through diagnostics without exposing errors.
  }
}

function databasesUnderRoot(root: string, result: Set<string>): void {
  if (!existsSync(root)) return;
  let stats: Stats;
  try {
    stats = statSync(root);
  } catch {
    return;
  }
  if (stats.isFile()) {
    addDatabaseIfPresent(root, result);
    return;
  }
  if (!stats.isDirectory()) return;
  addDatabaseIfPresent(join(root, "state.db"), result);
  const profiles = basename(root) === "profiles" ? root : join(root, "profiles");
  if (!existsSync(profiles)) return;
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) addDatabaseIfPresent(join(profiles, entry.name, "state.db"), result);
    }
  } catch {
    // The aggregate discovery result records an unreadable root count.
  }
}

export function discoverHermesDatabases(config?: Config): string[] {
  const result = new Set<string>();
  for (const root of rootsFromConfig(config)) databasesUnderRoot(root, result);
  return [...result].sort();
}

async function discover(config?: Config): Promise<DiscoveryEntry[]> {
  const configuredDisabled = config !== undefined && Object.prototype.hasOwnProperty.call(config.sources, "hermes") && (config.sources.hermes?.length ?? 0) === 0;
  const paths = discoverHermesDatabases(config);
  if (paths.length === 0) {
    return [{
      agent: "hermes",
      state: "not-found",
      capabilities: { tokens: "unavailable", work: "unavailable" },
      paths: [],
      diagnosticCounts: configuredDisabled ? { disabled: 1 } : { missing: 1 },
      reasons: ["missing-source", "timing-unavailable"],
    }];
  }

  let supported = 0;
  let unsupported = 0;
  let unreadable = 0;
  for (const path of paths) {
    try {
      probeDatabase(path);
      supported += 1;
    } catch (error) {
      if (error instanceof UnsupportedHermesSchemaError) unsupported += 1;
      else unreadable += 1;
    }
  }
  const onlyUnsupported = supported === 0 && unsupported > 0 && unreadable === 0;
  const state = onlyUnsupported ? "unsupported-schema" : supported === paths.length ? "available" : "partial";
  return [{
    agent: "hermes",
    state,
    capabilities: { tokens: supported > 0 ? supported === paths.length ? "recorded" : "partial" : "unavailable", work: "unavailable" },
    paths,
    diagnosticCounts: { databases: paths.length, supported, unsupported, unreadable },
    reasons: [
      ...(unsupported > 0 ? ["unsupported-schema"] : []),
      ...(unreadable > 0 ? ["parse-gap"] : []),
      "timing-unavailable",
    ],
  }];
}

async function collect(context: AdapterContext): Promise<AdapterBatch> {
  const paths = discoverHermesDatabases(context.config);
  const projections: Projection[] = [];
  let unsupported = 0;
  let unreadable = 0;
  for (const path of paths) {
    try {
      projections.push(projectDatabase(path));
    } catch (error) {
      if (error instanceof UnsupportedHermesSchemaError) unsupported += 1;
      else unreadable += 1;
    }
  }

  const copies = selectMigratedCopies(projections.flatMap((projection) => projection.sessions));
  const sessions: SessionRecord[] = [];
  const usage: UsageRecord[] = [];
  const counterSnapshots: CounterSnapshot[] = [];
  let parseGaps = projections.reduce((sum, projection) => sum + projection.parseGaps, 0);
  let unallocatedUsageRecords = 0;
  let discontinuities = 0;
  let upstreamOwned = 0;
  let lastSeenMs: number | null = null;

  for (const session of copies.sessions) {
    const sessionKey = `hermes:${session.rawId}`;
    const sessionReasons = session.copyConflict ? ["duplicate-ambiguity"] : [];
    sessions.push({
      agent: "hermes",
      sessionKey,
      originKey: `hermes-session:${stableDigest([session.rawId, session.startedMs])}`,
      sourceKey: SOURCE_KEY,
      canonicalSessionKey: sessionKey,
      parentSessionKey: session.parentId === null ? null : `hermes:${session.parentId}`,
      rootSessionKey: null,
      workspaceKey: session.workspace,
      repositoryKey: session.repository,
      startedAtMs: session.startedMs,
      endedAtMs: session.endedMs,
      quality: sessionReasons.length > 0 ? "partial" : "recorded",
      reasons: sessionReasons,
    });

    const residual = positiveResidual(session);
    if (residual.inconsistent || residual.counter?.partial) parseGaps += 1;
    const projectedRows = residual.counter === null ? session.rows : [...session.rows, residual.counter];
    for (const row of projectedRows) {
      if (row.lastSeenMs !== null && row.lastSeenMs > context.cutoffMs) continue;
      if (row.lastSeenMs !== null && row.lastSeenMs > (lastSeenMs ?? -1)) lastSeenMs = row.lastSeenMs;
      if (row.upstreamOwned) upstreamOwned += 1;
      const allocation = allocateCounter(
        row,
        context.store.getCounterSnapshot(SOURCE_KEY, row.counterKey),
        context.config.timezone,
        context.cutoffMs,
        session.workspace ?? session.repository ?? "unattributed:hermes",
        session.repository,
      );
      if (allocation.usage !== null && !row.upstreamOwned) usage.push(allocation.usage);
      counterSnapshots.push(allocation.snapshot);
      if (allocation.unallocated) unallocatedUsageRecords += 1;
      if (allocation.discontinuity) discontinuities += 1;
    }
  }

  const reasons = new Set<string>(["timing-unavailable"]);
  if (unsupported > 0) reasons.add("unsupported-schema");
  if (unreadable > 0) reasons.add("parse-gap");
  if (parseGaps > 0) reasons.add("parse-gap");
  if (unallocatedUsageRecords > 0) reasons.add("unallocated-history");
  if (discontinuities > 0) reasons.add("counter-discontinuity");
  if (copies.conflicts > 0) reasons.add("duplicate-ambiguity");
  if (upstreamOwned > 0) reasons.add("upstream-owned");
  if (paths.length === 0) reasons.add("missing-source");

  const tokenProblem = unsupported > 0 || unreadable > 0 || parseGaps > 0 || unallocatedUsageRecords > 0 || discontinuities > 0 || copies.conflicts > 0 || upstreamOwned > 0;
  const onlyUnsupported = projections.length === 0 && unsupported > 0 && unreadable === 0;
  const state: SourceRecord["state"] = paths.length === 0
    ? "not-found"
    : onlyUnsupported
      ? "unsupported-schema"
      : tokenProblem || projections.length === 0
        ? "partial"
        : "available";
  const tokenQuality: Quality = projections.length === 0 ? "unavailable" : tokenProblem ? "partial" : "recorded";
  const source: SourceRecord = {
    sourceKey: SOURCE_KEY,
    agent: "hermes",
    kind: "sqlite-cumulative",
    sourcePath: paths.length === 1 ? paths[0] : null,
    state,
    tokenQuality,
    workQuality: "unavailable",
    reasons: [...reasons].sort(),
    diagnosticCounts: {
      databases: paths.length,
      supportedDatabases: projections.length,
      unsupportedDatabases: unsupported,
      unreadableDatabases: unreadable,
      sessions: sessions.length,
      cumulativeRows: counterSnapshots.length,
      allocatedRows: usage.length,
      unallocatedUsageRecords,
      upstreamOwned,
      copyConflicts: copies.conflicts,
      excludedCopies: copies.excluded,
      parseGaps,
      counterDiscontinuities: discontinuities,
    },
    schemaVersion: [...new Set(projections.map((projection) => projection.schemaVersion))].sort().join(",") || null,
    lastSeenMs,
    lastSuccessfulScanMs: projections.length > 0 ? context.cutoffMs : null,
    cutoffMs: context.cutoffMs,
    updatedAtMs: context.cutoffMs,
  };

  return {
    source,
    sessions,
    usage,
    workIntervals: [],
    counterSnapshots,
    fileCursors: [],
    unallocatedUsageRecords,
    excludedAmbiguousRecords: copies.conflicts > 0 ? copies.excluded : 0,
  };
}

export const hermesAdapter: SourceAdapter = { agent: "hermes", discover, collect };
