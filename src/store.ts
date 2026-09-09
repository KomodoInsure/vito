import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  inputProvenanceRecordSchema,
  inputRecordSchema,
  inputSourceStateSchema,
  type Agent,
  type InputProvenanceRecord,
  type InputRecord,
  type InputSourceState,
  type Quality,
  type UsageRecord,
  type WorkInterval,
} from "./contracts";

const SCHEMA_VERSION = 3;
const DATABASE_FILENAME = "activity.sqlite";

const schemaSql = `
CREATE TABLE IF NOT EXISTS sources (
  source_key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_path TEXT,
  state TEXT NOT NULL CHECK (state IN ('available','partial','not-found','installed-no-history','excluded-wrapper','unsupported-schema')),
  token_quality TEXT NOT NULL CHECK (token_quality IN ('recorded','partial','unavailable')),
  work_quality TEXT NOT NULL CHECK (work_quality IN ('recorded','partial','unavailable')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  diagnostic_counts_json TEXT NOT NULL DEFAULT '{}',
  schema_version TEXT,
  last_seen_ms INTEGER,
  last_successful_scan_ms INTEGER,
  cutoff_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  agent TEXT NOT NULL CHECK (agent IN ('codex','claude','omp','opencode','hermes')),
  session_key TEXT NOT NULL,
  origin_key TEXT NOT NULL UNIQUE,
  source_key TEXT NOT NULL,
  canonical_session_key TEXT,
  parent_session_key TEXT,
  root_session_key TEXT,
  workspace_key TEXT,
  repository_key TEXT,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  quality TEXT NOT NULL CHECK (quality IN ('recorded','partial','unavailable')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  scope_decision TEXT NOT NULL DEFAULT 'included' CHECK (scope_decision IN ('included','out-of-scope','unattributed')),
  scope_reason TEXT NOT NULL DEFAULT 'configured-root',
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (agent, session_key),
  CHECK (started_at_ms IS NULL OR ended_at_ms IS NULL OR ended_at_ms >= started_at_ms)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage (
  origin_key TEXT PRIMARY KEY,
  agent TEXT NOT NULL CHECK (agent IN ('codex','claude','omp','opencode','hermes')),
  session_key TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  repository_key TEXT,
  turn_key TEXT,
  request_key TEXT,
  at_ms INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  uncached_input INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  output INTEGER,
  reasoning INTEGER,
  total INTEGER,
  cost_microusd INTEGER,
  cost_kind TEXT NOT NULL CHECK (cost_kind IN ('source-estimate','provider-reported','included','unknown')),
  quality TEXT NOT NULL CHECK (quality IN ('recorded','partial','unavailable')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  scope_decision TEXT NOT NULL DEFAULT 'included' CHECK (scope_decision IN ('included','out-of-scope','unattributed')),
  scope_reason TEXT NOT NULL DEFAULT 'configured-root',
  updated_at_ms INTEGER NOT NULL,
  CHECK (uncached_input IS NULL OR uncached_input >= 0),
  CHECK (cache_read IS NULL OR cache_read >= 0),
  CHECK (cache_write IS NULL OR cache_write >= 0),
  CHECK (output IS NULL OR output >= 0),
  CHECK (reasoning IS NULL OR reasoning >= 0),
  CHECK (total IS NULL OR total >= 0),
  CHECK (cost_microusd IS NULL OR cost_microusd >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS work_intervals (
  origin_key TEXT PRIMARY KEY,
  agent TEXT NOT NULL CHECK (agent IN ('codex','claude','omp','opencode','hermes')),
  session_key TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  repository_key TEXT,
  provider TEXT,
  model TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('inference','tool')),
  updated_at_ms INTEGER NOT NULL,
  scope_decision TEXT NOT NULL DEFAULT 'included' CHECK (scope_decision IN ('included','out-of-scope','unattributed')),
  scope_reason TEXT NOT NULL DEFAULT 'configured-root',
  CHECK (start_ms >= 0),
  CHECK (end_ms > start_ms)
) STRICT;

CREATE TABLE IF NOT EXISTS counter_snapshots (
  source_key TEXT NOT NULL,
  counter_key TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  session_key TEXT,
  workspace_key TEXT,
  repository_key TEXT,
  provider TEXT,
  model TEXT,
  observed_at_ms INTEGER NOT NULL,
  first_seen_ms INTEGER,
  last_seen_ms INTEGER,
  uncached_input INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  output INTEGER,
  reasoning INTEGER,
  total INTEGER,
  cost_microusd INTEGER,
  quality TEXT NOT NULL CHECK (quality IN ('recorded','partial','unavailable')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (source_key, counter_key),
  CHECK (uncached_input IS NULL OR uncached_input >= 0),
  CHECK (cache_read IS NULL OR cache_read >= 0),
  CHECK (cache_write IS NULL OR cache_write >= 0),
  CHECK (output IS NULL OR output >= 0),
  CHECK (reasoning IS NULL OR reasoning >= 0),
  CHECK (total IS NULL OR total >= 0),
  CHECK (cost_microusd IS NULL OR cost_microusd >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS file_cursors (
  source_key TEXT NOT NULL,
  path_key TEXT NOT NULL,
  source_path TEXT NOT NULL,
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
  prefix_fingerprint TEXT NOT NULL,
  tail_fingerprint TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (source_key, path_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS collection_runs (
  run_key TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  cutoff_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  successful_scan_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  rebuild INTEGER NOT NULL CHECK (rebuild IN (0, 1)),
  diagnostic_counts_json TEXT NOT NULL DEFAULT '{}',
  CHECK (completed_at_ms IS NULL OR completed_at_ms >= started_at_ms)
) STRICT;

CREATE TABLE IF NOT EXISTS commits (
  repository_key TEXT NOT NULL,
  oid TEXT NOT NULL,
  committer_ms INTEGER NOT NULL CHECK (committer_ms >= 0),
  tip_oid TEXT,
  collected_at_ms INTEGER NOT NULL CHECK (collected_at_ms >= 0),
  shallow INTEGER NOT NULL CHECK (shallow IN (0, 1)),
  PRIMARY KEY (repository_key, oid)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS workspace_attributions (
  agent TEXT NOT NULL CHECK (agent IN ('codex','claude','omp','opencode','hermes')),
  session_key TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  repository_key TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('repository-identity','historical-exact','historical-descendants')),
  verified_at_ms INTEGER NOT NULL CHECK (verified_at_ms >= 0),
  PRIMARY KEY (agent, session_key, workspace_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS scope_evidence (
  origin_key TEXT PRIMARY KEY,
  source_key TEXT,
  agent TEXT NOT NULL CHECK (agent IN ('codex','claude','omp','opencode','hermes')),
  session_key TEXT NOT NULL,
  workspace_key TEXT,
  repository_key TEXT,
  at_ms INTEGER,
  provider TEXT,
  known_total INTEGER,
  decision TEXT NOT NULL CHECK (decision IN ('included','out-of-scope','unattributed')),
  reason TEXT NOT NULL,
  last_seen_ms INTEGER NOT NULL CHECK (last_seen_ms >= 0),
  CHECK (at_ms IS NULL OR at_ms >= 0),
  CHECK (known_total IS NULL OR known_total >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS input_events (
  origin_key TEXT PRIMARY KEY CHECK (length(origin_key) > 0),
  source_key TEXT NOT NULL CHECK (length(source_key) > 0),
  agent TEXT NOT NULL CHECK (agent IN ('codex','claude','omp','opencode','hermes')),
  session_key TEXT NOT NULL CHECK (length(session_key) > 0),
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) > 0),
  native_input_id TEXT NOT NULL CHECK (length(native_input_id) > 0),
  workspace_key TEXT NOT NULL CHECK (length(workspace_key) > 0),
  repository_key TEXT,
  at_ms INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('submission','context','replay','unknown')),
  lane TEXT NOT NULL CHECK (lane IN ('main','subagent','unknown')),
  controller TEXT CHECK (controller IS NULL OR (length(controller) BETWEEN 1 AND 128)),
  origin TEXT NOT NULL CHECK (origin IN ('human','automated','unknown')),
  origin_evidence TEXT NOT NULL CHECK (origin_evidence IN ('source','provenance','none','conflict')),
  quality TEXT NOT NULL CHECK (quality IN ('recorded','partial','unavailable')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  scope_decision TEXT NOT NULL DEFAULT 'included' CHECK (scope_decision IN ('included','out-of-scope','unattributed')),
  scope_reason TEXT NOT NULL DEFAULT 'configured-root' CHECK (length(scope_reason) > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (repository_key IS NULL OR length(repository_key) > 0),
  CHECK (at_ms IS NULL OR at_ms >= 0),
  CHECK (
    (origin_evidence IN ('none','conflict') AND origin = 'unknown') OR
    (origin_evidence IN ('source','provenance') AND origin IN ('human','automated'))
  )
) STRICT;

CREATE TABLE IF NOT EXISTS input_native_evidence (
  origin_key TEXT PRIMARY KEY CHECK (length(origin_key) > 0),
  controller TEXT CHECK (controller IS NULL OR (length(controller) BETWEEN 1 AND 128)),
  origin TEXT NOT NULL CHECK (origin IN ('human','automated','unknown')),
  origin_evidence TEXT NOT NULL CHECK (origin_evidence IN ('source','none')),
  CHECK (
    (origin_evidence = 'none' AND origin = 'unknown') OR
    (origin_evidence = 'source' AND origin IN ('human','automated'))
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS input_source_state (
  source_key TEXT PRIMARY KEY CHECK (length(source_key) > 0),
  agent TEXT NOT NULL CHECK (agent IN ('codex','claude','omp','opencode','hermes')),
  parser_version INTEGER NOT NULL CHECK (parser_version = 1),
  quality TEXT NOT NULL CHECK (quality IN ('recorded','partial','unavailable')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  scanned_at_ms INTEGER NOT NULL CHECK (scanned_at_ms >= 0),
  last_successful_scan_ms INTEGER,
  CHECK (last_successful_scan_ms IS NULL OR last_successful_scan_ms >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS input_provenance (
  origin_key TEXT PRIMARY KEY CHECK (length(origin_key) > 0),
  agent TEXT NOT NULL CHECK (agent IN ('codex','claude','omp','opencode','hermes')),
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) > 0),
  native_input_id TEXT NOT NULL CHECK (length(native_input_id) > 0),
  origin TEXT NOT NULL CHECK (origin IN ('human','automated')),
  controller TEXT CHECK (controller IS NULL OR (length(controller) BETWEEN 1 AND 128))
) STRICT;

CREATE INDEX IF NOT EXISTS usage_at_model_idx ON usage(at_ms, provider, model);
CREATE INDEX IF NOT EXISTS usage_agent_at_idx ON usage(agent, at_ms);
CREATE INDEX IF NOT EXISTS usage_session_idx ON usage(agent, session_key);
CREATE INDEX IF NOT EXISTS usage_request_idx ON usage(provider, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_intervals_endpoints_idx ON work_intervals(start_ms, end_ms);
CREATE INDEX IF NOT EXISTS work_intervals_session_idx ON work_intervals(agent, session_key, start_ms);
CREATE INDEX IF NOT EXISTS work_intervals_agent_idx ON work_intervals(agent, start_ms, end_ms);
CREATE INDEX IF NOT EXISTS sessions_source_idx ON sessions(source_key);
CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions(agent, parent_session_key) WHERE parent_session_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS counter_snapshots_session_idx ON counter_snapshots(session_key);
CREATE INDEX IF NOT EXISTS file_cursors_source_idx ON file_cursors(source_key);
CREATE INDEX IF NOT EXISTS collection_runs_cutoff_idx ON collection_runs(cutoff_ms);
CREATE INDEX IF NOT EXISTS commits_committer_idx ON commits(committer_ms);
CREATE INDEX IF NOT EXISTS commits_repository_time_idx ON commits(repository_key, committer_ms);
CREATE INDEX IF NOT EXISTS scope_evidence_at_idx ON scope_evidence(at_ms, agent, decision);
CREATE INDEX IF NOT EXISTS scope_evidence_session_idx ON scope_evidence(agent, session_key);
CREATE INDEX IF NOT EXISTS workspace_attributions_repository_idx ON workspace_attributions(repository_key);
CREATE INDEX IF NOT EXISTS input_events_agent_at_idx ON input_events(agent, at_ms);
CREATE INDEX IF NOT EXISTS input_events_session_idx ON input_events(agent, session_key);
CREATE INDEX IF NOT EXISTS input_events_source_idx ON input_events(source_key);
CREATE INDEX IF NOT EXISTS input_events_native_idx ON input_events(agent, native_session_id, native_input_id);
CREATE INDEX IF NOT EXISTS input_provenance_native_idx ON input_provenance(agent, native_session_id, native_input_id);
`;

const REQUIRED_SCHEMA_TABLES = [
  "collection_runs",
  "commits",
  "counter_snapshots",
  "file_cursors",
  "input_events",
  "input_native_evidence",
  "input_provenance",
  "input_source_state",
  "scope_evidence",
  "sessions",
  "sources",
  "usage",
  "work_intervals",
  "workspace_attributions",
] as const;

const INPUT_NATIVE_EVIDENCE_COLUMNS = [
  "origin_key",
  "controller",
  "origin",
  "origin_evidence",
] as const;

function assertSchemaIntegrity(database: Database): void {
  const tables = new Set((database.query(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as Array<{ name: string }>).map((row) => row.name));
  const missingTables = REQUIRED_SCHEMA_TABLES.filter((table) => !tables.has(table));
  if (missingTables.length > 0) {
    throw new Error(
      `Collector database schema ${SCHEMA_VERSION} is incomplete; rebuild required (missing tables: ${missingTables.join(", ")})`,
    );
  }

  const nativeEvidenceColumns = (database.query(
    "PRAGMA table_info(input_native_evidence)",
  ).all() as Array<{ name: string }>).map((row) => row.name);
  if (
    nativeEvidenceColumns.length !== INPUT_NATIVE_EVIDENCE_COLUMNS.length
    || nativeEvidenceColumns.some((column, index) => column !== INPUT_NATIVE_EVIDENCE_COLUMNS[index])
  ) {
    throw new Error(
      `Collector database schema ${SCHEMA_VERSION} has malformed native input evidence; rebuild required`,
    );
  }
}

const migrateVersionOneSql = `
ALTER TABLE sessions ADD COLUMN scope_decision TEXT NOT NULL DEFAULT 'included'
  CHECK (scope_decision IN ('included','out-of-scope','unattributed'));
ALTER TABLE sessions ADD COLUMN scope_reason TEXT NOT NULL DEFAULT 'legacy-unreconciled';
ALTER TABLE usage ADD COLUMN scope_decision TEXT NOT NULL DEFAULT 'included'
  CHECK (scope_decision IN ('included','out-of-scope','unattributed'));
ALTER TABLE usage ADD COLUMN scope_reason TEXT NOT NULL DEFAULT 'legacy-unreconciled';
ALTER TABLE work_intervals ADD COLUMN scope_decision TEXT NOT NULL DEFAULT 'included'
  CHECK (scope_decision IN ('included','out-of-scope','unattributed'));
ALTER TABLE work_intervals ADD COLUMN scope_reason TEXT NOT NULL DEFAULT 'legacy-unreconciled';
`;

export interface SourceRecord {
  sourceKey: string;
  agent: string;
  kind: string;
  sourcePath?: string | null;
  state: "available" | "partial" | "not-found" | "installed-no-history" | "excluded-wrapper" | "unsupported-schema";
  tokenQuality: Quality;
  workQuality: Quality;
  reasons?: string[];
  diagnosticCounts?: Record<string, number>;
  schemaVersion?: string | null;
  lastSeenMs?: number | null;
  lastSuccessfulScanMs?: number | null;
  cutoffMs?: number | null;
  updatedAtMs?: number;
}

export interface SessionRecord {
  agent: Agent;
  sessionKey: string;
  originKey: string;
  sourceKey: string;
  canonicalSessionKey?: string | null;
  parentSessionKey?: string | null;
  rootSessionKey?: string | null;
  workspaceKey?: string | null;
  repositoryKey?: string | null;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  quality: Quality;
  reasons?: string[];
  updatedAtMs?: number;
}

export type ScopeDecision = "included" | "out-of-scope" | "unattributed";

export interface ScopeMembership {
  scopeDecision?: ScopeDecision;
  scopeReason?: string;
}

export interface WorkspaceAttribution {
  agent: Agent;
  sessionKey: string;
  workspaceKey: string;
  repositoryKey: string;
  provenance: "repository-identity" | "historical-exact" | "historical-descendants";
  verifiedAtMs: number;
}

export interface ScopeEvidence {
  originKey: string;
  sourceKey?: string | null;
  agent: Agent;
  sessionKey: string;
  workspaceKey?: string | null;
  repositoryKey?: string | null;
  atMs?: number | null;
  provider?: string | null;
  knownTotal?: number | null;
  decision: ScopeDecision;
  reason: string;
  lastSeenMs: number;
}

export interface CounterSnapshot {
  sourceKey: string;
  counterKey: string;
  epoch?: number;
  sessionKey?: string | null;
  workspaceKey?: string | null;
  repositoryKey?: string | null;
  provider?: string | null;
  model?: string | null;
  observedAtMs: number;
  firstSeenMs?: number | null;
  lastSeenMs?: number | null;
  uncachedInput?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  output?: number | null;
  reasoning?: number | null;
  total?: number | null;
  costMicrousd?: number | null;
  quality: Quality;
  reasons?: string[];
}

export interface FileCursor {
  sourceKey: string;
  pathKey: string;
  sourcePath: string;
  device: string | number;
  inode: string | number;
  byteOffset: number;
  sizeBytes: number;
  mtimeMs: number;
  prefixFingerprint: string;
  tailFingerprint: string;
  updatedAtMs?: number;
}

export interface CollectionRun {
  runKey: string;
  startedAtMs: number;
  cutoffMs: number;
  completedAtMs?: number | null;
  successfulScanMs?: number | null;
  status: "running" | "completed" | "partial" | "failed";
  rebuild: boolean;
  diagnosticCounts?: Record<string, number>;
}

export interface CommitRecord {
  repositoryKey: string;
  oid: string;
  committerMs: number;
}

export interface CommitReplacementOptions {
  tipOid: string | null;
  collectedAtMs: number;
  shallow: boolean;
}

export interface LedgerBatch {
  sources?: SourceRecord[];
  sessions?: Array<SessionRecord & ScopeMembership>;
  usage?: Array<UsageRecord & ScopeMembership>;
  workIntervals?: Array<WorkInterval & ScopeMembership>;
  inputs?: Array<InputRecord & ScopeMembership>;
  inputSourceStates?: InputSourceState[];
  inputProvenance?: InputProvenanceRecord[];
  counterSnapshots?: CounterSnapshot[];
  fileCursors?: FileCursor[];
  collectionRuns?: CollectionRun[];
  commits?: Array<CommitRecord & CommitReplacementOptions>;
  workspaceAttributions?: WorkspaceAttribution[];
  scopeEvidence?: ScopeEvidence[];
}

function normalizedReasons(reasons: readonly string[] | undefined): string {
  return JSON.stringify([...new Set(reasons ?? [])].sort());
}

function normalizedCounts(counts: Readonly<Record<string, number>> | undefined): string {
  const result: Record<string, number> = {};
  for (const key of Object.keys(counts ?? {}).sort()) {
    const value = counts?.[key];
    if (value === undefined) continue;
    requireNonnegativeInteger(value, `diagnosticCounts.${key}`);
    result[key] = value;
  }
  return JSON.stringify(result);
}

function requireText(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function requireInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

function requireNonnegativeInteger(value: number | null | undefined, name: string): void {
  if (value === null || value === undefined) return;
  requireInteger(value, name);
  if (value < 0) throw new TypeError(`${name} must be nonnegative`);
}

function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null && "then" in value;
}

function ensurePrivateFile(path: string): void {
  if (existsSync(path)) chmodSync(path, 0o600);
}

export class CollectorStore {
  readonly database: Database;
  readonly stateDir: string;
  readonly path: string;

  private transactionDepth = 0;
  private savepointSequence = 0;
  private closed = false;

  private constructor(stateDir: string, path: string, database: Database) {
    this.stateDir = stateDir;
    this.path = path;
    this.database = database;
  }

  static open(stateDir: string): CollectorStore {
    requireText(stateDir, "stateDir");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const canonicalStateDir = realpathSync(stateDir);
    const path = join(canonicalStateDir, DATABASE_FILENAME);
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Collector database is not a regular owned file: ${path}`);
    }

    const database = new Database(path, { create: true, strict: true });
    try {
      ensurePrivateFile(path);
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = NORMAL");
      const versionRow = database.query("PRAGMA user_version").get() as { user_version: number };
      if (versionRow.user_version > SCHEMA_VERSION) {
        throw new Error(`Collector database schema ${versionRow.user_version} is newer than supported schema ${SCHEMA_VERSION}`);
      }
      if (versionRow.user_version === SCHEMA_VERSION) {
        assertSchemaIntegrity(database);
      } else {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(schemaSql);
          if (versionRow.user_version === 1) database.exec(migrateVersionOneSql);
          database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        assertSchemaIntegrity(database);
      }
      ensurePrivateFile(path);
      ensurePrivateFile(`${path}-wal`);
      ensurePrivateFile(`${path}-shm`);
      return new CollectorStore(canonicalStateDir, path, database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.transactionDepth !== 0) throw new Error("Cannot close collector store during a transaction");
    this.database.close();
    ensurePrivateFile(this.path);
    ensurePrivateFile(`${this.path}-wal`);
    ensurePrivateFile(`${this.path}-shm`);
    this.closed = true;
  }

  transaction<T>(operation: (store: CollectorStore) => T): T {
    this.assertOpen();
    const outermost = this.transactionDepth === 0;
    const savepoint = `vito_${++this.savepointSequence}`;
    this.database.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = operation(this);
      if (isThenable(result)) throw new TypeError("CollectorStore transactions must be synchronous");
      this.database.exec(outermost ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        if (outermost) {
          this.database.exec("ROLLBACK");
        } else {
          this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch {
        // Preserve the operation error; SQLite may already have rolled back a failed transaction.
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
      ensurePrivateFile(`${this.path}-wal`);
      ensurePrivateFile(`${this.path}-shm`);
    }
  }

  readTransaction<T>(operation: (store: CollectorStore) => T): T {
    this.assertOpen();
    const outermost = this.transactionDepth === 0;
    const savepoint = `vito_read_${++this.savepointSequence}`;
    this.database.exec(outermost ? "BEGIN" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = operation(this);
      if (isThenable(result)) throw new TypeError("CollectorStore transactions must be synchronous");
      this.database.exec(outermost ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        if (outermost) {
          this.database.exec("ROLLBACK");
        } else {
          this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch {
        // Preserve the operation error.
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  writeBatch(batch: LedgerBatch): void {
    this.transaction((store) => {
      for (const source of batch.sources ?? []) store.upsertSource(source);
      for (const session of batch.sessions ?? []) store.upsertSession(session);
      for (const record of batch.usage ?? []) store.upsertUsage(record);
      for (const interval of batch.workIntervals ?? []) store.upsertWorkInterval(interval);
      for (const record of batch.inputs ?? []) store.upsertInput(record);
      for (const state of batch.inputSourceStates ?? []) store.upsertInputSourceState(state);
      for (const provenance of batch.inputProvenance ?? []) store.upsertInputProvenance(provenance);
      for (const snapshot of batch.counterSnapshots ?? []) store.upsertCounterSnapshot(snapshot);
      for (const cursor of batch.fileCursors ?? []) store.upsertFileCursor(cursor);
      for (const run of batch.collectionRuns ?? []) store.upsertCollectionRun(run);
      for (const commit of batch.commits ?? []) store.upsertCommit(commit, commit);
      for (const attribution of batch.workspaceAttributions ?? []) store.upsertWorkspaceAttribution(attribution);
      for (const evidence of batch.scopeEvidence ?? []) store.upsertScopeEvidence(evidence);
    });
  }

  upsertSource(record: SourceRecord): void {
    requireText(record.sourceKey, "source.sourceKey");
    requireText(record.agent, "source.agent");
    requireText(record.kind, "source.kind");
    for (const [name, value] of [["lastSeenMs", record.lastSeenMs], ["lastSuccessfulScanMs", record.lastSuccessfulScanMs], ["cutoffMs", record.cutoffMs]] as const) {
      requireNonnegativeInteger(value, `source.${name}`);
    }
    const updatedAtMs = record.updatedAtMs ?? Date.now();
    requireNonnegativeInteger(updatedAtMs, "source.updatedAtMs");
    this.database.query(`
      INSERT INTO sources (
        source_key, agent, kind, source_path, state, token_quality, work_quality, reasons_json,
        diagnostic_counts_json, schema_version, last_seen_ms, last_successful_scan_ms, cutoff_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        agent=excluded.agent, kind=excluded.kind, source_path=excluded.source_path, state=excluded.state,
        token_quality=excluded.token_quality, work_quality=excluded.work_quality, reasons_json=excluded.reasons_json,
        diagnostic_counts_json=excluded.diagnostic_counts_json, schema_version=excluded.schema_version,
        last_seen_ms=excluded.last_seen_ms, last_successful_scan_ms=excluded.last_successful_scan_ms,
        cutoff_ms=excluded.cutoff_ms, updated_at_ms=excluded.updated_at_ms
    `).run(
      record.sourceKey, record.agent, record.kind, nullable(record.sourcePath), record.state,
      record.tokenQuality, record.workQuality, normalizedReasons(record.reasons), normalizedCounts(record.diagnosticCounts),
      nullable(record.schemaVersion), nullable(record.lastSeenMs), nullable(record.lastSuccessfulScanMs), nullable(record.cutoffMs), updatedAtMs,
    );
  }

  upsertSession(record: SessionRecord & ScopeMembership): void {
    requireText(record.sessionKey, "session.sessionKey");
    requireText(record.originKey, "session.originKey");
    requireText(record.sourceKey, "session.sourceKey");
    requireNonnegativeInteger(record.startedAtMs, "session.startedAtMs");
    requireNonnegativeInteger(record.endedAtMs, "session.endedAtMs");
    if (record.startedAtMs != null && record.endedAtMs != null && record.endedAtMs < record.startedAtMs) {
      throw new TypeError("session.endedAtMs must not precede startedAtMs");
    }
    const updatedAtMs = record.updatedAtMs ?? Date.now();
    requireNonnegativeInteger(updatedAtMs, "session.updatedAtMs");
    const scopeDecision = record.scopeDecision ?? "included";
    const scopeReason = record.scopeReason ?? "configured-root";
    requireText(scopeReason, "session.scopeReason");
    this.database.query(`
      INSERT INTO sessions (
        agent, session_key, origin_key, source_key, canonical_session_key, parent_session_key, root_session_key,
        workspace_key, repository_key, started_at_ms, ended_at_ms, quality, reasons_json, updated_at_ms,
        scope_decision, scope_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, session_key) DO UPDATE SET
        origin_key=excluded.origin_key, source_key=excluded.source_key, canonical_session_key=excluded.canonical_session_key,
        parent_session_key=excluded.parent_session_key, root_session_key=excluded.root_session_key,
        workspace_key=excluded.workspace_key, repository_key=excluded.repository_key,
        started_at_ms=excluded.started_at_ms, ended_at_ms=excluded.ended_at_ms,
        quality=excluded.quality, reasons_json=excluded.reasons_json, updated_at_ms=excluded.updated_at_ms,
        scope_decision=excluded.scope_decision, scope_reason=excluded.scope_reason
    `).run(
      record.agent, record.sessionKey, record.originKey, record.sourceKey, nullable(record.canonicalSessionKey),
      nullable(record.parentSessionKey), nullable(record.rootSessionKey), nullable(record.workspaceKey), nullable(record.repositoryKey),
      nullable(record.startedAtMs), nullable(record.endedAtMs), record.quality, normalizedReasons(record.reasons), updatedAtMs,
      scopeDecision, scopeReason,
    );
  }

  upsertInput(record: InputRecord & ScopeMembership, updatedAtMs = Date.now()): void {
    inputRecordSchema.parse({
      originKey: record.originKey,
      sourceKey: record.sourceKey,
      agent: record.agent,
      sessionKey: record.sessionKey,
      nativeSessionId: record.nativeSessionId,
      nativeInputId: record.nativeInputId,
      workspaceKey: record.workspaceKey,
      repositoryKey: record.repositoryKey,
      atMs: record.atMs,
      kind: record.kind,
      lane: record.lane,
      controller: record.controller,
      origin: record.origin,
      originEvidence: record.originEvidence,
      quality: record.quality,
      reasons: record.reasons,
    });
    requireNonnegativeInteger(updatedAtMs, "input.updatedAtMs");
    const scopeDecision = record.scopeDecision ?? "included";
    const scopeReason = record.scopeReason ?? "configured-root";
    requireText(scopeReason, "input.scopeReason");
    this.database.query(`
      INSERT INTO input_events (
        origin_key, source_key, agent, session_key, native_session_id, native_input_id,
        workspace_key, repository_key, at_ms, kind, lane, controller, origin,
        origin_evidence, quality, reasons_json, scope_decision, scope_reason, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin_key) DO UPDATE SET
        source_key=excluded.source_key, agent=excluded.agent, session_key=excluded.session_key,
        native_session_id=excluded.native_session_id, native_input_id=excluded.native_input_id,
        workspace_key=excluded.workspace_key, repository_key=excluded.repository_key,
        at_ms=excluded.at_ms, kind=excluded.kind, lane=excluded.lane,
        controller=excluded.controller, origin=excluded.origin, origin_evidence=excluded.origin_evidence,
        quality=excluded.quality, reasons_json=excluded.reasons_json,
        scope_decision=excluded.scope_decision, scope_reason=excluded.scope_reason,
        updated_at_ms=excluded.updated_at_ms
    `).run(
      record.originKey, record.sourceKey, record.agent, record.sessionKey,
      record.nativeSessionId, record.nativeInputId, record.workspaceKey, record.repositoryKey,
      record.atMs, record.kind, record.lane, record.controller, record.origin,
      record.originEvidence, record.quality, normalizedReasons(record.reasons),
      scopeDecision, scopeReason, updatedAtMs,
    );
    if (record.originEvidence === "source" || record.originEvidence === "none") {
      this.database.query(`
        INSERT INTO input_native_evidence (origin_key, controller, origin, origin_evidence)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(origin_key) DO UPDATE SET
          controller=excluded.controller, origin=excluded.origin,
          origin_evidence=excluded.origin_evidence
      `).run(record.originKey, record.controller, record.origin, record.originEvidence);
    }
  }

  upsertInputSourceState(record: InputSourceState): void {
    inputSourceStateSchema.parse(record);
    this.database.query(`
      INSERT INTO input_source_state (
        source_key, agent, parser_version, quality, reasons_json, scanned_at_ms, last_successful_scan_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        agent=excluded.agent, parser_version=excluded.parser_version, quality=excluded.quality,
        reasons_json=excluded.reasons_json, scanned_at_ms=excluded.scanned_at_ms,
        last_successful_scan_ms=excluded.last_successful_scan_ms
    `).run(
      record.sourceKey, record.agent, record.parserVersion, record.quality,
      normalizedReasons(record.reasons), record.scannedAtMs, record.lastSuccessfulScanMs,
    );
  }

  upsertInputProvenance(record: InputProvenanceRecord): void {
    inputProvenanceRecordSchema.parse(record);
    const originKey = createHash("sha256").update(JSON.stringify([
      record.agent,
      record.nativeSessionId,
      record.nativeInputId,
      record.origin,
      record.controller,
    ])).digest("hex");
    this.database.query(`
      INSERT INTO input_provenance (
        origin_key, agent, native_session_id, native_input_id, origin, controller
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin_key) DO UPDATE SET
        agent=excluded.agent, native_session_id=excluded.native_session_id,
        native_input_id=excluded.native_input_id, origin=excluded.origin,
        controller=excluded.controller
    `).run(
      originKey, record.agent, record.nativeSessionId, record.nativeInputId,
      record.origin, record.controller,
    );
  }

  upsertUsage(record: UsageRecord & ScopeMembership, updatedAtMs = Date.now()): void {
    requireText(record.originKey, "usage.originKey");
    requireText(record.sessionKey, "usage.sessionKey");
    requireText(record.workspaceKey, "usage.workspaceKey");
    requireText(record.provider, "usage.provider");
    requireText(record.model, "usage.model");
    requireNonnegativeInteger(record.atMs, "usage.atMs");
    requireNonnegativeInteger(updatedAtMs, "usage.updatedAtMs");
    for (const [name, value] of [
      ["uncachedInput", record.uncachedInput], ["cacheRead", record.cacheRead], ["cacheWrite", record.cacheWrite],
      ["output", record.output], ["reasoning", record.reasoning], ["total", record.total], ["costMicrousd", record.costMicrousd],
    ] as const) requireNonnegativeInteger(value, `usage.${name}`);
    const scopeDecision = record.scopeDecision ?? "included";
    const scopeReason = record.scopeReason ?? "configured-root";
    requireText(scopeReason, "usage.scopeReason");

    this.database.query(`
      INSERT INTO usage (
        origin_key, agent, session_key, workspace_key, repository_key, turn_key, request_key, at_ms,
        provider, model, uncached_input, cache_read, cache_write, output, reasoning, total,
        cost_microusd, cost_kind, quality, reasons_json, updated_at_ms, scope_decision, scope_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin_key) DO UPDATE SET
        agent=excluded.agent, session_key=excluded.session_key, workspace_key=excluded.workspace_key,
        repository_key=excluded.repository_key, turn_key=excluded.turn_key, request_key=excluded.request_key,
        at_ms=excluded.at_ms, provider=excluded.provider, model=excluded.model,
        uncached_input=excluded.uncached_input, cache_read=excluded.cache_read, cache_write=excluded.cache_write,
        output=excluded.output, reasoning=excluded.reasoning, total=excluded.total,
        cost_microusd=excluded.cost_microusd, cost_kind=excluded.cost_kind,
        quality=excluded.quality, reasons_json=excluded.reasons_json, updated_at_ms=excluded.updated_at_ms,
        scope_decision=excluded.scope_decision, scope_reason=excluded.scope_reason
    `).run(
      record.originKey, record.agent, record.sessionKey, record.workspaceKey, record.repositoryKey,
      record.turnKey, record.requestKey, record.atMs, record.provider, record.model,
      record.uncachedInput, record.cacheRead, record.cacheWrite, record.output, record.reasoning, record.total,
      record.costMicrousd, record.costKind, record.quality, normalizedReasons(record.reasons), updatedAtMs,
      scopeDecision, scopeReason,
    );
  }

  upsertWorkInterval(interval: WorkInterval & ScopeMembership, updatedAtMs = Date.now()): void {
    requireText(interval.originKey, "workInterval.originKey");
    requireText(interval.sessionKey, "workInterval.sessionKey");
    requireText(interval.workspaceKey, "workInterval.workspaceKey");
    requireNonnegativeInteger(interval.startMs, "workInterval.startMs");
    requireNonnegativeInteger(interval.endMs, "workInterval.endMs");
    requireNonnegativeInteger(updatedAtMs, "workInterval.updatedAtMs");
    if (interval.endMs <= interval.startMs) throw new TypeError("workInterval.endMs must be greater than startMs");
    const scopeDecision = interval.scopeDecision ?? "included";
    const scopeReason = interval.scopeReason ?? "configured-root";
    requireText(scopeReason, "workInterval.scopeReason");
    this.database.query(`
      INSERT INTO work_intervals (
        origin_key, agent, session_key, workspace_key, repository_key, provider, model,
        start_ms, end_ms, kind, updated_at_ms, scope_decision, scope_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin_key) DO UPDATE SET
        agent=excluded.agent, session_key=excluded.session_key, workspace_key=excluded.workspace_key,
        repository_key=excluded.repository_key, provider=excluded.provider, model=excluded.model,
        start_ms=excluded.start_ms, end_ms=excluded.end_ms, kind=excluded.kind, updated_at_ms=excluded.updated_at_ms,
        scope_decision=excluded.scope_decision, scope_reason=excluded.scope_reason
    `).run(
      interval.originKey, interval.agent, interval.sessionKey, interval.workspaceKey, interval.repositoryKey,
      interval.provider, interval.model, interval.startMs, interval.endMs, interval.kind, updatedAtMs,
      scopeDecision, scopeReason,
    );
  }

  upsertCounterSnapshot(snapshot: CounterSnapshot): void {
    requireText(snapshot.sourceKey, "counterSnapshot.sourceKey");
    requireText(snapshot.counterKey, "counterSnapshot.counterKey");
    requireNonnegativeInteger(snapshot.epoch ?? 0, "counterSnapshot.epoch");
    for (const [name, value] of [
      ["observedAtMs", snapshot.observedAtMs], ["firstSeenMs", snapshot.firstSeenMs], ["lastSeenMs", snapshot.lastSeenMs],
      ["uncachedInput", snapshot.uncachedInput], ["cacheRead", snapshot.cacheRead], ["cacheWrite", snapshot.cacheWrite],
      ["output", snapshot.output], ["reasoning", snapshot.reasoning], ["total", snapshot.total], ["costMicrousd", snapshot.costMicrousd],
    ] as const) requireNonnegativeInteger(value, `counterSnapshot.${name}`);
    this.database.query(`
      INSERT INTO counter_snapshots (
        source_key, counter_key, epoch, session_key, workspace_key, repository_key, provider, model,
        observed_at_ms, first_seen_ms, last_seen_ms, uncached_input, cache_read, cache_write,
        output, reasoning, total, cost_microusd, quality, reasons_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key, counter_key) DO UPDATE SET
        epoch=excluded.epoch, session_key=excluded.session_key, workspace_key=excluded.workspace_key,
        repository_key=excluded.repository_key, provider=excluded.provider, model=excluded.model,
        observed_at_ms=excluded.observed_at_ms, first_seen_ms=excluded.first_seen_ms, last_seen_ms=excluded.last_seen_ms,
        uncached_input=excluded.uncached_input, cache_read=excluded.cache_read, cache_write=excluded.cache_write,
        output=excluded.output, reasoning=excluded.reasoning, total=excluded.total,
        cost_microusd=excluded.cost_microusd, quality=excluded.quality, reasons_json=excluded.reasons_json
    `).run(
      snapshot.sourceKey, snapshot.counterKey, snapshot.epoch ?? 0, nullable(snapshot.sessionKey), nullable(snapshot.workspaceKey),
      nullable(snapshot.repositoryKey), nullable(snapshot.provider), nullable(snapshot.model), snapshot.observedAtMs,
      nullable(snapshot.firstSeenMs), nullable(snapshot.lastSeenMs), nullable(snapshot.uncachedInput), nullable(snapshot.cacheRead),
      nullable(snapshot.cacheWrite), nullable(snapshot.output), nullable(snapshot.reasoning), nullable(snapshot.total),
      nullable(snapshot.costMicrousd), snapshot.quality, normalizedReasons(snapshot.reasons),
    );
  }

  upsertWorkspaceAttribution(attribution: WorkspaceAttribution): void {
    requireText(attribution.sessionKey, "workspaceAttribution.sessionKey");
    requireText(attribution.workspaceKey, "workspaceAttribution.workspaceKey");
    requireText(attribution.repositoryKey, "workspaceAttribution.repositoryKey");
    requireNonnegativeInteger(attribution.verifiedAtMs, "workspaceAttribution.verifiedAtMs");
    this.database.query(`
      INSERT INTO workspace_attributions (
        agent, session_key, workspace_key, repository_key, provenance, verified_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, session_key, workspace_key) DO UPDATE SET
        repository_key=excluded.repository_key, provenance=excluded.provenance,
        verified_at_ms=excluded.verified_at_ms
    `).run(
      attribution.agent, attribution.sessionKey, attribution.workspaceKey,
      attribution.repositoryKey, attribution.provenance, attribution.verifiedAtMs,
    );
  }

  upsertScopeEvidence(evidence: ScopeEvidence): void {
    requireText(evidence.originKey, "scopeEvidence.originKey");
    requireText(evidence.sessionKey, "scopeEvidence.sessionKey");
    requireText(evidence.reason, "scopeEvidence.reason");
    requireNonnegativeInteger(evidence.atMs, "scopeEvidence.atMs");
    requireNonnegativeInteger(evidence.knownTotal, "scopeEvidence.knownTotal");
    requireNonnegativeInteger(evidence.lastSeenMs, "scopeEvidence.lastSeenMs");
    this.database.query(`
      INSERT INTO scope_evidence (
        origin_key, source_key, agent, session_key, workspace_key, repository_key,
        at_ms, provider, known_total, decision, reason, last_seen_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin_key) DO UPDATE SET
        source_key=excluded.source_key, agent=excluded.agent, session_key=excluded.session_key,
        workspace_key=excluded.workspace_key, repository_key=excluded.repository_key,
        at_ms=excluded.at_ms, provider=excluded.provider, known_total=excluded.known_total,
        decision=excluded.decision, reason=excluded.reason, last_seen_ms=excluded.last_seen_ms
    `).run(
      evidence.originKey, nullable(evidence.sourceKey), evidence.agent, evidence.sessionKey,
      nullable(evidence.workspaceKey), nullable(evidence.repositoryKey), nullable(evidence.atMs),
      nullable(evidence.provider), nullable(evidence.knownTotal), evidence.decision,
      evidence.reason, evidence.lastSeenMs,
    );
  }

  upsertFileCursor(cursor: FileCursor): void {
    requireText(cursor.sourceKey, "fileCursor.sourceKey");
    requireText(cursor.pathKey, "fileCursor.pathKey");
    requireText(cursor.sourcePath, "fileCursor.sourcePath");
    requireText(String(cursor.device), "fileCursor.device");
    requireText(String(cursor.inode), "fileCursor.inode");
    requireText(cursor.prefixFingerprint, "fileCursor.prefixFingerprint");
    requireText(cursor.tailFingerprint, "fileCursor.tailFingerprint");
    for (const [name, value] of [["byteOffset", cursor.byteOffset], ["sizeBytes", cursor.sizeBytes], ["mtimeMs", cursor.mtimeMs]] as const) {
      requireNonnegativeInteger(value, `fileCursor.${name}`);
    }
    const updatedAtMs = cursor.updatedAtMs ?? Date.now();
    requireNonnegativeInteger(updatedAtMs, "fileCursor.updatedAtMs");
    this.database.query(`
      INSERT INTO file_cursors (
        source_key, path_key, source_path, device, inode, byte_offset, size_bytes, mtime_ms,
        prefix_fingerprint, tail_fingerprint, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key, path_key) DO UPDATE SET
        source_path=excluded.source_path, device=excluded.device, inode=excluded.inode,
        byte_offset=excluded.byte_offset, size_bytes=excluded.size_bytes, mtime_ms=excluded.mtime_ms,
        prefix_fingerprint=excluded.prefix_fingerprint, tail_fingerprint=excluded.tail_fingerprint,
        updated_at_ms=excluded.updated_at_ms
    `).run(
      cursor.sourceKey, cursor.pathKey, cursor.sourcePath, String(cursor.device), String(cursor.inode),
      cursor.byteOffset, cursor.sizeBytes, cursor.mtimeMs, cursor.prefixFingerprint, cursor.tailFingerprint, updatedAtMs,
    );
  }

  upsertCollectionRun(run: CollectionRun): void {
    requireText(run.runKey, "collectionRun.runKey");
    for (const [name, value] of [
      ["startedAtMs", run.startedAtMs], ["cutoffMs", run.cutoffMs], ["completedAtMs", run.completedAtMs],
      ["successfulScanMs", run.successfulScanMs],
    ] as const) requireNonnegativeInteger(value, `collectionRun.${name}`);
    if (run.completedAtMs != null && run.completedAtMs < run.startedAtMs) {
      throw new TypeError("collectionRun.completedAtMs must not precede startedAtMs");
    }
    this.database.query(`
      INSERT INTO collection_runs (
        run_key, started_at_ms, cutoff_ms, completed_at_ms, successful_scan_ms, status, rebuild, diagnostic_counts_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_key) DO UPDATE SET
        started_at_ms=excluded.started_at_ms, cutoff_ms=excluded.cutoff_ms,
        completed_at_ms=excluded.completed_at_ms, successful_scan_ms=excluded.successful_scan_ms,
        status=excluded.status, rebuild=excluded.rebuild, diagnostic_counts_json=excluded.diagnostic_counts_json
    `).run(
      run.runKey, run.startedAtMs, run.cutoffMs, nullable(run.completedAtMs), nullable(run.successfulScanMs),
      run.status, run.rebuild ? 1 : 0, normalizedCounts(run.diagnosticCounts),
    );
  }

  upsertCommit(commit: CommitRecord, options: CommitReplacementOptions): void {
    requireText(commit.repositoryKey, "commit.repositoryKey");
    requireText(commit.oid, "commit.oid");
    requireNonnegativeInteger(commit.committerMs, "commit.committerMs");
    requireNonnegativeInteger(options.collectedAtMs, "commit.collectedAtMs");
    this.database.query(`
      INSERT INTO commits (repository_key, oid, committer_ms, tip_oid, collected_at_ms, shallow)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_key, oid) DO UPDATE SET
        committer_ms=excluded.committer_ms, tip_oid=excluded.tip_oid,
        collected_at_ms=excluded.collected_at_ms, shallow=excluded.shallow
    `).run(
      commit.repositoryKey, commit.oid, commit.committerMs, options.tipOid, options.collectedAtMs, options.shallow ? 1 : 0,
    );
  }

  replaceRepositoryCommits(
    repositoryKey: string,
    tipOid: string | null,
    commits: readonly CommitRecord[],
    options: Omit<CommitReplacementOptions, "tipOid">,
  ): void {
    requireText(repositoryKey, "repositoryKey");
    for (const commit of commits) {
      if (commit.repositoryKey !== repositoryKey) throw new TypeError("All replacement commits must belong to repositoryKey");
    }
    this.transaction((store) => {
      store.deleteRepositoryCommits(repositoryKey);
      for (const commit of commits) store.upsertCommit(commit, { ...options, tipOid });
    });
  }

  deleteRepositoryCommits(repositoryKey: string): void {
    requireText(repositoryKey, "repositoryKey");
    this.database.query("DELETE FROM commits WHERE repository_key = ?").run(repositoryKey);
  }

  listCommits(repositoryKey?: string): Array<Record<string, unknown>> {
    this.assertOpen();
    if (repositoryKey === undefined) {
      return this.database.query("SELECT * FROM commits ORDER BY repository_key, committer_ms, oid").all() as Array<Record<string, unknown>>;
    }
    return this.database.query("SELECT * FROM commits WHERE repository_key = ? ORDER BY committer_ms, oid").all(repositoryKey) as Array<Record<string, unknown>>;
  }

  getUsage(originKey: string): Record<string, unknown> | null {
    requireText(originKey, "originKey");
    return this.database.query("SELECT * FROM usage WHERE origin_key = ?").get(originKey) as Record<string, unknown> | null;
  }

  getInput(originKey: string): Record<string, unknown> | null {
    requireText(originKey, "originKey");
    return this.database.query("SELECT * FROM input_events WHERE origin_key = ?").get(originKey) as Record<string, unknown> | null;
  }

  getInputSourceState(sourceKey: string): Record<string, unknown> | null {
    requireText(sourceKey, "sourceKey");
    return this.database.query("SELECT * FROM input_source_state WHERE source_key = ?").get(sourceKey) as Record<string, unknown> | null;
  }

  getCounterSnapshot(sourceKey: string, counterKey: string): Record<string, unknown> | null {
    requireText(sourceKey, "sourceKey");
    requireText(counterKey, "counterKey");
    return this.database.query("SELECT * FROM counter_snapshots WHERE source_key = ? AND counter_key = ?").get(sourceKey, counterKey) as Record<string, unknown> | null;
  }

  getFileCursor(sourceKey: string, pathKey: string): Record<string, unknown> | null {
    requireText(sourceKey, "sourceKey");
    requireText(pathKey, "pathKey");
    return this.database.query("SELECT * FROM file_cursors WHERE source_key = ? AND path_key = ?").get(sourceKey, pathKey) as Record<string, unknown> | null;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Collector store is closed");
  }
}

export function openCollectorStore(stateDir: string): CollectorStore {
  return CollectorStore.open(stateDir);
}
