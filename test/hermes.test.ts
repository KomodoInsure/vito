import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { Config } from "../src/config";
import { CollectorStore } from "../src/store";
import { hermesAdapter, normalizeHermesCost } from "../src/sources/hermes";
import type { AdapterBatch } from "../src/sources/types";

const temporaryDirectories: string[] = [];
const DAY_ONE = Date.parse("2026-09-05T12:00:00.000Z") / 1_000;
const DAY_ONE_LATER = Date.parse("2026-09-05T13:00:00.000Z") / 1_000;
const DAY_ONE_LATE = Date.parse("2026-09-05T23:55:00.000Z") / 1_000;
const DAY_TWO_EARLY = Date.parse("2026-09-06T00:05:00.000Z") / 1_000;
const CUTOFF_MS = Date.parse("2026-09-06T18:00:00.000Z");

interface UsageFixture {
  sessionId: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  mode?: string;
  task?: string;
  input: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  firstSeen: number | null;
  lastSeen: number | null;
  estimatedCost?: number;
  actualCost?: number;
  costStatus?: string | null;
}

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "vito-hermes-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createHermesDatabase(path: string, legacy = false): Database {
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  database.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (1);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      parent_session_id TEXT,
      model TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      ${legacy ? "" : "last_activity_at REAL,"}
      cwd TEXT,
      git_repo_root TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      cost_source TEXT
    );
    CREATE TABLE session_model_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      billing_provider TEXT NOT NULL DEFAULT '',
      billing_base_url TEXT NOT NULL DEFAULT '',
      billing_mode TEXT NOT NULL DEFAULT '',
      task TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      actual_cost_usd REAL NOT NULL DEFAULT 0,
      cost_status TEXT,
      cost_source TEXT,
      first_seen REAL,
      last_seen REAL,
      PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
    );
  `);
  return database;
}

function insertSession(
  database: Database,
  id: string,
  input: number,
  options: { parentId?: string; output?: number; started?: number; ended?: number | null; workspace?: string; provider?: string } = {},
): void {
  const started = options.started ?? DAY_ONE;
  const ended = options.ended === undefined ? DAY_ONE_LATER : options.ended;
  const columns = (database.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((row) => row.name);
  const values: Record<string, string | number | null> = {
    id,
    source: "synthetic",
    parent_session_id: options.parentId ?? null,
    model: "synthetic-model",
    started_at: started,
    ended_at: ended,
    last_activity_at: ended,
    cwd: options.workspace ?? "/synthetic/workspace",
    git_repo_root: options.workspace ?? "/synthetic/workspace",
    input_tokens: input,
    output_tokens: options.output ?? 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: options.provider ?? "synthetic-provider",
    billing_base_url: "https://billing.invalid/private-route",
    billing_mode: "synthetic",
    estimated_cost_usd: 0,
    actual_cost_usd: 0,
    cost_status: null,
    cost_source: null,
  };
  const selected = columns.filter((column) => Object.prototype.hasOwnProperty.call(values, column));
  database.query(`INSERT INTO sessions (${selected.join(",")}) VALUES (${selected.map(() => "?").join(",")})`)
    .run(...selected.map((column) => values[column]));
}

function insertUsage(database: Database, fixture: UsageFixture): void {
  database.query(`
    INSERT INTO session_model_usage (
      session_id, model, billing_provider, billing_base_url, billing_mode, task,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      estimated_cost_usd, actual_cost_usd, cost_status, cost_source, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fixture.sessionId,
    fixture.model ?? "synthetic-model",
    fixture.provider ?? "synthetic-provider",
    fixture.baseUrl ?? "https://billing.invalid/private-route",
    fixture.mode ?? "synthetic",
    fixture.task ?? "",
    fixture.input,
    fixture.output ?? 0,
    fixture.cacheRead ?? 0,
    fixture.cacheWrite ?? 0,
    fixture.reasoning ?? 0,
    fixture.estimatedCost ?? 0,
    fixture.actualCost ?? 0,
    fixture.costStatus ?? null,
    fixture.costStatus === undefined ? null : "synthetic-evidence",
    fixture.firstSeen,
    fixture.lastSeen,
  );
}

function updateUsage(database: Database, sessionId: string, input: number, lastSeen: number): void {
  database.query("UPDATE session_model_usage SET input_tokens = ?, last_seen = ? WHERE session_id = ?")
    .run(input, lastSeen, sessionId);
  database.query("UPDATE sessions SET input_tokens = ?, ended_at = ? WHERE id = ?").run(input, lastSeen, sessionId);
}

function config(sourcePaths: string[], stateDir: string): Config {
  return {
    version: 1,
    workspaceRoots: ["/synthetic/workspace"],
    timezone: "UTC",
    stateDir,
    sources: { hermes: sourcePaths },
    repositories: [],
    publication: { repository: "synthetic/activity", branch: "main" },
  };
}

async function collect(store: CollectorStore, sourcePaths: string[]): Promise<AdapterBatch> {
  return hermesAdapter.collect({
    config: config(sourcePaths, store.stateDir),
    store,
    rebuild: false,
    cutoffMs: CUTOFF_MS,
    reconcileAll: true,
  });
}

function commit(store: CollectorStore, batch: AdapterBatch): void {
  store.writeBatch({
    sources: [batch.source],
    sessions: batch.sessions,
    usage: batch.usage,
    workIntervals: batch.workIntervals,
    counterSnapshots: batch.counterSnapshots,
    fileCursors: batch.fileCursors,
  });
}

function tokenTotal(batch: AdapterBatch): number {
  return batch.usage.reduce((sum, record) => sum + (record.total ?? 0), 0);
}

function fixtureStore(root: string): CollectorStore {
  return CollectorStore.open(join(root, "collector"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Hermes cumulative accounting", () => {
  test("honors disabled and explicit source configuration", async () => {
    const root = temporaryRoot();
    const disabled = await hermesAdapter.discover(config([], join(root, "collector")));
    expect(disabled).toEqual([{
      agent: "hermes",
      state: "not-found",
      capabilities: { tokens: "unavailable", work: "unavailable" },
      paths: [],
      diagnosticCounts: { disabled: 1 },
      reasons: ["missing-source", "timing-unavailable"],
    }]);

    const path = join(root, "state.db");
    const source = createHermesDatabase(path);
    source.close();
    const explicit = await hermesAdapter.discover(config([root], join(root, "collector")));
    expect(explicit[0]?.state).toBe("available");
    expect(explicit[0]?.paths).toEqual([realpathSync(path)]);
  });

  test("allocates a bounded initial snapshot once, then only its same-day positive delta", async () => {
    const root = temporaryRoot();
    const path = join(root, "state.db");
    const source = createHermesDatabase(path);
    insertSession(source, "bounded", 100);
    insertUsage(source, { sessionId: "bounded", input: 100, firstSeen: DAY_ONE, lastSeen: DAY_ONE_LATER });
    source.close();
    const store = fixtureStore(root);
    try {
      const initial = await collect(store, [path]);
      expect(tokenTotal(initial)).toBe(100);
      expect(initial.usage).toHaveLength(1);
      expect(initial.usage[0]?.atMs).toBe(DAY_ONE_LATER * 1_000);
      commit(store, initial);

      const unchanged = await collect(store, [path]);
      expect(unchanged.usage).toHaveLength(0);
      commit(store, unchanged);

      const writer = new Database(path);
      updateUsage(writer, "bounded", 140, DAY_ONE_LATER + 60);
      writer.close();
      const delta = await collect(store, [path]);
      expect(tokenTotal(delta)).toBe(40);
      expect(delta.usage[0]?.uncachedInput).toBe(40);
    } finally {
      store.close();
    }
  });

  test("retains multi-day initial and cross-midnight deltas as unallocated accounting", async () => {
    const root = temporaryRoot();
    const initialPath = join(root, "multi-day.db");
    const initialSource = createHermesDatabase(initialPath);
    insertSession(initialSource, "multi-day", 100, { started: DAY_ONE_LATE, ended: DAY_TWO_EARLY });
    insertUsage(initialSource, { sessionId: "multi-day", input: 100, firstSeen: DAY_ONE_LATE, lastSeen: DAY_TWO_EARLY });
    initialSource.close();
    const initialStore = CollectorStore.open(join(root, "initial-collector"));
    try {
      const multiDay = await collect(initialStore, [initialPath]);
      expect(multiDay.unallocatedUsageRecords).toBe(1);
      expect(multiDay.usage).toHaveLength(1);
      expect(multiDay.usage[0]?.atMs).toBeNull();
      expect(multiDay.usage[0]?.total).toBe(100);
      expect(multiDay.usage[0]?.reasons).toContain("unallocated-history");
    } finally {
      initialStore.close();
    }

    const deltaPath = join(root, "cross-midnight.db");
    const deltaSource = createHermesDatabase(deltaPath);
    insertSession(deltaSource, "cross-midnight", 100, { started: DAY_ONE_LATE, ended: DAY_ONE_LATE });
    insertUsage(deltaSource, { sessionId: "cross-midnight", input: 100, firstSeen: DAY_ONE_LATE, lastSeen: DAY_ONE_LATE });
    deltaSource.close();
    const deltaStore = CollectorStore.open(join(root, "delta-collector"));
    try {
      const baseline = await collect(deltaStore, [deltaPath]);
      commit(deltaStore, baseline);
      const writer = new Database(deltaPath);
      updateUsage(writer, "cross-midnight", 140, DAY_TWO_EARLY);
      writer.close();
      const crossMidnight = await collect(deltaStore, [deltaPath]);
      expect(crossMidnight.unallocatedUsageRecords).toBe(1);
      expect(crossMidnight.usage[0]?.atMs).toBeNull();
      expect(crossMidnight.usage[0]?.total).toBe(40);
    } finally {
      deltaStore.close();
    }
  });

  test("counts persisted parent and child sessions independently", async () => {
    const root = temporaryRoot();
    const path = join(root, "state.db");
    const source = createHermesDatabase(path);
    insertSession(source, "parent", 100);
    insertUsage(source, { sessionId: "parent", input: 100, firstSeen: DAY_ONE, lastSeen: DAY_ONE_LATER });
    insertSession(source, "child", 40, { parentId: "parent" });
    insertUsage(source, { sessionId: "child", input: 40, firstSeen: DAY_ONE, lastSeen: DAY_ONE_LATER });
    source.close();
    const store = fixtureStore(root);
    try {
      const batch = await collect(store, [path]);
      expect(tokenTotal(batch)).toBe(140);
      expect(batch.sessions.find((session) => session.sessionKey === "hermes:child")?.parentSessionKey).toBe("hermes:parent");
    } finally {
      store.close();
    }
  });

  test("marks a counter decrease partial and never bills the reset value", async () => {
    const root = temporaryRoot();
    const path = join(root, "state.db");
    const source = createHermesDatabase(path);
    insertSession(source, "reset", 100);
    insertUsage(source, { sessionId: "reset", input: 100, firstSeen: DAY_ONE, lastSeen: DAY_ONE_LATER });
    source.close();
    const store = fixtureStore(root);
    try {
      const baseline = await collect(store, [path]);
      commit(store, baseline);
      const writer = new Database(path);
      updateUsage(writer, "reset", 60, DAY_ONE_LATER + 60);
      writer.close();

      const correction = await collect(store, [path]);
      expect(correction.usage).toHaveLength(0);
      expect(correction.source.reasons).toContain("counter-discontinuity");
      expect(correction.counterSnapshots[0]?.quality).toBe("partial");
      expect(correction.counterSnapshots[0]?.epoch).toBe(1);
    } finally {
      store.close();
    }
  });

  test("includes independently accounted auxiliary tasks and keeps unresolved routes unallocated", async () => {
    const root = temporaryRoot();
    const path = join(root, "state.db");
    const source = createHermesDatabase(path);
    insertSession(source, "auxiliary", 100);
    insertUsage(source, { sessionId: "auxiliary", input: 100, firstSeen: DAY_ONE, lastSeen: DAY_ONE_LATER });
    insertUsage(source, {
      sessionId: "auxiliary",
      model: "synthetic-review-model",
      provider: "synthetic-provider",
      task: "background-review",
      input: 40,
      firstSeen: DAY_ONE,
      lastSeen: DAY_ONE_LATER,
    });
    insertSession(source, "unresolved", 0);
    insertUsage(source, {
      sessionId: "unresolved",
      model: "synthetic-aux-model",
      provider: "auto",
      task: "auxiliary",
      input: 25,
      firstSeen: DAY_ONE,
      lastSeen: DAY_ONE_LATER,
    });
    source.close();
    const store = fixtureStore(root);
    try {
      const batch = await collect(store, [path]);
      expect(batch.usage.filter((record) => record.sessionKey === "hermes:auxiliary").reduce(
        (sum, record) => sum + (record.total ?? 0),
        0,
      )).toBe(140);
      const unresolved = batch.usage.find((record) => record.sessionKey === "hermes:unresolved");
      expect(unresolved?.atMs).toBeNull();
      expect(unresolved?.reasons).toContain("unallocated-history");
      expect(batch.unallocatedUsageRecords).toBe(1);
      expect(JSON.stringify(batch)).not.toContain("https://billing.invalid/private-route");
    } finally {
      store.close();
    }
  });

  test("excludes Codex-owned mirrors while retaining an upstream coverage reason", async () => {
    const root = temporaryRoot();
    const path = join(root, "state.db");
    const source = createHermesDatabase(path);
    insertSession(source, "mirror", 100, { provider: "openai-codex" });
    insertUsage(source, {
      sessionId: "mirror",
      provider: "openai-codex",
      input: 100,
      firstSeen: DAY_ONE,
      lastSeen: DAY_ONE_LATER,
      costStatus: "included",
    });
    source.close();
    const store = fixtureStore(root);
    try {
      const batch = await collect(store, [path]);
      expect(batch.usage).toHaveLength(0);
      expect(batch.source.reasons).toContain("upstream-owned");
      expect(batch.source.diagnosticCounts?.upstreamOwned).toBe(1);
    } finally {
      store.close();
    }
  });

  test("deduplicates migrated copies and marks conflicting snapshots partial without adding both", async () => {
    const root = temporaryRoot();
    const profiles = join(root, "profiles");
    mkdirSync(join(profiles, "first"), { recursive: true });
    mkdirSync(join(profiles, "second"), { recursive: true });
    const firstPath = join(profiles, "first", "state.db");
    const secondPath = join(profiles, "second", "state.db");
    const first = createHermesDatabase(firstPath);
    insertSession(first, "migrated", 100, { output: 20 });
    insertUsage(first, { sessionId: "migrated", input: 100, output: 20, firstSeen: DAY_ONE, lastSeen: DAY_ONE_LATER });
    first.close();
    const second = createHermesDatabase(secondPath);
    insertSession(second, "migrated", 90, { output: 30 });
    insertUsage(second, { sessionId: "migrated", input: 90, output: 30, firstSeen: DAY_ONE, lastSeen: DAY_ONE_LATER + 60 });
    second.close();
    const store = fixtureStore(root);
    try {
      const batch = await collect(store, [profiles]);
      expect(batch.usage).toHaveLength(1);
      expect(tokenTotal(batch)).toBe(120);
      expect(batch.usage[0]?.quality).toBe("partial");
      expect(batch.usage[0]?.reasons).toContain("duplicate-ambiguity");
      expect(batch.excludedAmbiguousRecords).toBe(1);
    } finally {
      store.close();
    }
  });

  test("emits unmatched main-session residuals as unknown model and gates default-zero cost", async () => {
    const root = temporaryRoot();
    const path = join(root, "state.db");
    const source = createHermesDatabase(path);
    insertSession(source, "residual", 150);
    insertUsage(source, {
      sessionId: "residual",
      input: 100,
      firstSeen: DAY_ONE,
      lastSeen: DAY_ONE_LATER,
      estimatedCost: 0,
      costStatus: null,
    });
    source.close();
    const store = fixtureStore(root);
    try {
      const batch = await collect(store, [path]);
      expect(tokenTotal(batch)).toBe(150);
      const direct = batch.usage.find((record) => record.model === "synthetic-model");
      const residual = batch.usage.find((record) => record.model === "unknown");
      expect(direct?.costMicrousd).toBeNull();
      expect(direct?.costKind).toBe("unknown");
      expect(residual?.total).toBe(50);
    } finally {
      store.close();
    }
    expect(normalizeHermesCost({ estimated_cost_usd: 0, actual_cost_usd: 0 })).toEqual({
      costMicrousd: null,
      costKind: "unknown",
      partial: false,
    });
    expect(normalizeHermesCost({ cost_status: "estimated", estimated_cost_usd: 1.25 })).toEqual({
      costMicrousd: 1_250_000,
      costKind: "source-estimate",
      partial: false,
    });
    expect(normalizeHermesCost({ cost_status: "actual", actual_cost_usd: 2.5 })).toEqual({
      costMicrousd: 2_500_000,
      costKind: "provider-reported",
      partial: false,
    });
    expect(normalizeHermesCost({ cost_status: "included", estimated_cost_usd: 99 })).toEqual({
      costMicrousd: null,
      costKind: "included",
      partial: false,
    });
  });

  test("probes legacy columns and sees committed rows still resident in a live WAL", async () => {
    const root = temporaryRoot();
    const path = join(root, "state.db");
    const writer = createHermesDatabase(path, true);
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    insertSession(writer, "wal-visible", 75);
    insertUsage(writer, { sessionId: "wal-visible", input: 75, firstSeen: DAY_ONE, lastSeen: DAY_ONE_LATER });
    expect(existsSync(`${path}-wal`)).toBe(true);
    const store = fixtureStore(root);
    try {
      const batch = await collect(store, [path]);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(tokenTotal(batch)).toBe(75);
      expect(batch.workIntervals).toEqual([]);
      expect(batch.source.state).toBe("available");
    } finally {
      store.close();
      writer.close();
    }
  });
});
