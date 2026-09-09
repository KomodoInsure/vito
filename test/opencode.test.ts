import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Config } from "../src/config";
import { normalizeOpenCodeMessage, opencodeAdapter, subtractOpenCodeWaits } from "../src/sources/opencode";
import type { AdapterBatch, AdapterContext } from "../src/sources/types";
import { CollectorStore } from "../src/store";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vito-opencode-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createSourceDatabase(path: string): Database {
  const database = new Database(path, { create: true, strict: true });
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT,
      parent_id TEXT,
      time_created INTEGER,
      time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session_message (id TEXT PRIMARY KEY, data TEXT);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
    CREATE INDEX part_message_id_id_idx ON part(message_id, id);
    CREATE INDEX part_session_idx ON part(session_id);
  `);
  return database;
}

function configuration(sourcePath: string, stateDir: string): Config {
  return {
    version: 1,
    workspaceRoots: [join(stateDir, "synthetic-workspace")],
    timezone: "UTC",
    stateDir,
    sources: {
      codex: [],
      claude: [],
      omp: [],
      opencode: [sourcePath],
      hermes: [],
    },
    repositories: [],
    publication: { repository: "fixture/vito-pages", branch: "main" },
  };
}

function context(config: Config, store: CollectorStore, options: Partial<AdapterContext> = {}): AdapterContext {
  return {
    config,
    store,
    rebuild: options.rebuild ?? true,
    cutoffMs: options.cutoffMs ?? 100_000,
    reconcileAll: options.reconcileAll ?? false,
  };
}

function commitBatch(store: CollectorStore, batch: AdapterBatch): void {
  store.writeBatch({
    sources: [batch.source],
    sessions: batch.sessions,
    usage: batch.usage,
    workIntervals: batch.workIntervals,
    inputs: batch.inputs,
    inputSourceStates: [batch.inputSourceState],
    counterSnapshots: batch.counterSnapshots,
    fileCursors: batch.fileCursors,
  });
}

function insertSession(database: Database, id: string, created: number, updated = created): void {
  database.query("INSERT INTO session (id,directory,parent_id,time_created,time_updated) VALUES (?,?,?,?,?)")
    .run(id, "/synthetic/company/project", null, created, updated);
}

function insertMessage(
  database: Database,
  id: string,
  sessionId: string,
  timeCreated: number,
  data: Record<string, unknown>,
  timeUpdated = timeCreated,
): void {
  database.query("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)")
    .run(id, sessionId, timeCreated, timeUpdated, JSON.stringify(data));
}

function insertPart(
  database: Database,
  id: string,
  messageId: string,
  sessionId: string,
  timeCreated: number,
  data: Record<string, unknown>,
): void {
  database.query("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)")
    .run(id, messageId, sessionId, timeCreated, timeCreated, JSON.stringify(data));
}

function assistant(start: number, completed: number | undefined, total = 16, cost = 0): Record<string, unknown> {
  return {
    role: "assistant",
    providerID: "fixture-provider",
    modelID: "fixture-model",
    time: completed === undefined ? { created: start } : { created: start, completed },
    tokens: completed === undefined
      ? {}
      : { input: 2, cache: { read: 3, write: 4 }, output: 5, reasoning: 2, total },
    cost,
    finish: completed === undefined ? undefined : "stop",
  };
}

function user(created: number): Record<string, unknown> {
  return {
    agent: "build",
    model: { providerID: "fixture-provider", modelID: "fixture-model" },
    role: "user",
    summary: { title: "fixture" },
    time: { created },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OpenCode normalization", () => {
  test("reconciles disjoint reasoning and treats unqualified zero cost as unknown", () => {
    const normalized = normalizeOpenCodeMessage({
      id: "message-synthetic",
      sessionId: "session-synthetic",
      workspaceKey: "/synthetic/company/project",
      provider: "fixture-provider",
      model: "fixture-model",
      createdMs: 1_000,
      startedMs: 1_000,
      completedMs: 2_000,
      tokens: { input: 2, cache: { read: 3, write: 4 }, output: 5, reasoning: 2, total: 16 },
      cost: 0,
    });

    expect(normalized.usage).toMatchObject({
      uncachedInput: 2,
      cacheRead: 3,
      cacheWrite: 4,
      output: 7,
      reasoning: 2,
      total: 16,
      costMicrousd: null,
      costKind: "unknown",
      quality: "recorded",
    });
  });

  test("uses a demonstrated reasoning-inclusive output convention", () => {
    const normalized = normalizeOpenCodeMessage({
      id: "message-inclusive",
      sessionId: "session-synthetic",
      workspaceKey: "/synthetic/company/project",
      startedMs: 1_000,
      completedMs: 2_000,
      tokens: { input: 2, cache: { read: 3, write: 4 }, output: 5, reasoning: 2, total: 14 },
    });
    expect(normalized.usage.output).toBe(5);
    expect(normalized.usage.total).toBe(14);
    expect(normalized.usage.quality).toBe("recorded");
  });

  test("subtracts closed waits and clips at an open wait", () => {
    expect(subtractOpenCodeWaits(
      { startMs: 0, endMs: 100 },
      [{ startMs: 20, endMs: 40 }, { startMs: 60, endMs: null }],
    )).toEqual({
      ranges: [{ startMs: 0, endMs: 20 }, { startMs: 40, endMs: 60 }],
      openWait: true,
    });

    const normalized = normalizeOpenCodeMessage({
      id: "message-waits",
      sessionId: "session-waits",
      workspaceKey: "/synthetic/company/project",
      provider: "fixture-provider",
      model: "fixture-model",
      startedMs: 0,
      completedMs: 100,
      tokens: { input: 1, cache: { read: 0, write: 0 }, output: 1, reasoning: 0, total: 2 },
      parts: [
        { data: { type: "tool", tool: "task", state: { status: "completed", time: { start: 20, end: 40 } } } },
        { data: { type: "tool", tool: "question", state: { status: "running", time: { start: 60 } } } },
        { data: { type: "tool", tool: "bash", state: { status: "completed", time: { start: 45, end: 50 } } } },
      ],
    });
    expect(normalized.openWait).toBe(true);
    expect(normalized.workIntervals.map(({ kind, startMs, endMs }) => ({ kind, startMs, endMs }))).toEqual([
      { kind: "inference", startMs: 0, endMs: 20 },
      { kind: "inference", startMs: 40, endMs: 60 },
      { kind: "tool", startMs: 45, endMs: 50 },
    ]);
  });
});

describe("OpenCode SQLite adapter", () => {
  test("sees committed WAL rows and replaces an incomplete inclusive-watermark observation", async () => {
    const root = temporaryDirectory();
    const sourcePath = join(root, "opencode.db");
    const writer = createSourceDatabase(sourcePath);
    const store = CollectorStore.open(join(root, "state"));
    try {
      insertSession(writer, "session-one", 1_000);
      insertMessage(writer, "message-one", "session-one", 1_100, assistant(1_100, undefined));
      insertPart(writer, "part-step", "message-one", "session-one", 1_101, {
        type: "step-finish",
        tokens: { input: 9_999, output: 9_999 },
      });
      expect(existsSync(`${sourcePath}-wal`)).toBe(true);

      const config = configuration(sourcePath, join(root, "state"));
      const first = await opencodeAdapter.collect(context(config, store));
      expect(first.usage).toHaveLength(1);
      expect(first.usage[0]?.total).toBeNull();
      expect(first.inputSourceState).toMatchObject({
        quality: "recorded",
        lastSuccessfulScanMs: 100_000,
      });
      commitBatch(store, first);

      writer.query("UPDATE message SET time_updated=?, data=? WHERE id=?")
        .run(1_300, JSON.stringify(assistant(1_100, 1_300)), "message-one");
      writer.query("UPDATE session SET time_updated=? WHERE id=?").run(1_300, "session-one");

      const second = await opencodeAdapter.collect(context(config, store, { rebuild: false }));
      expect(second.usage).toHaveLength(1);
      expect(second.usage[0]?.total).toBe(16);
      commitBatch(store, second);

      expect((store.database.query("SELECT count(*) AS count FROM usage").get() as { count: number }).count).toBe(1);
      expect((store.database.query("SELECT total FROM usage").get() as { total: number }).total).toBe(16);
      expect(second.workIntervals.filter((interval) => interval.kind === "inference")).toHaveLength(1);
    } finally {
      writer.close();
      store.close();
    }
  });

  test("deduplicates a copied leading prefix while retaining a new branch call", async () => {
    const root = temporaryDirectory();
    const sourcePath = join(root, "opencode.db");
    const writer = createSourceDatabase(sourcePath);
    const store = CollectorStore.open(join(root, "state"));
    try {
      insertSession(writer, "session-original", 1_000);
      insertSession(writer, "session-copy", 2_000);
      insertMessage(writer, "user-original", "session-original", 1_100, user(1_100));
      insertMessage(writer, "assistant-original", "session-original", 1_200, assistant(1_200, 1_300));
      insertMessage(writer, "user-copy", "session-copy", 1_100, user(1_100));
      insertMessage(writer, "assistant-copy", "session-copy", 1_200, assistant(1_200, 1_300), 2_100);
      insertMessage(writer, "assistant-branch", "session-copy", 2_200, assistant(2_200, 2_300));
      insertPart(writer, "text-original", "user-original", "session-original", 1_100, { type: "text", text: "synthetic request alpha" });
      insertPart(writer, "text-copy", "user-copy", "session-copy", 1_100, { type: "text", text: "synthetic request alpha" });
      insertPart(writer, "step-original", "assistant-original", "session-original", 1_300, { type: "step-finish", reason: "stop" });
      insertPart(writer, "step-copy", "assistant-copy", "session-copy", 1_300, { type: "step-finish", reason: "stop" });

      const batch = await opencodeAdapter.collect(context(configuration(sourcePath, join(root, "state")), store));
      expect(batch.usage.map((record) => record.requestKey).sort()).toEqual(["assistant-branch", "assistant-original"]);
      expect(batch.usage.reduce((sum, record) => sum + (record.total ?? 0), 0)).toBe(32);
      expect(batch.excludedAmbiguousRecords).toBe(0);
      expect(batch.sessions.find((session) => session.sessionKey.endsWith(":session-copy"))?.canonicalSessionKey)
        .toBe(batch.sessions.find((session) => session.sessionKey.endsWith(":session-original"))?.sessionKey);
      expect(batch.inputs.filter((input) => input.kind === "submission")).toHaveLength(1);
      expect(batch.inputs.filter((input) => input.kind === "replay")).toHaveLength(1);
      expect(batch.inputs.find((input) => input.nativeInputId === "user-copy")).toMatchObject({
        kind: "replay",
        lane: "main",
        origin: "unknown",
      });
    } finally {
      writer.close();
      store.close();
    }
  });

  test("reclassifies a retained copied prefix when an older original appears later", async () => {
    const root = temporaryDirectory();
    const sourcePath = join(root, "opencode.db");
    const stateDir = join(root, "state");
    const writer = createSourceDatabase(sourcePath);
    const store = CollectorStore.open(stateDir);
    try {
      insertSession(writer, "session-copy", 2_000);
      insertMessage(writer, "user-copy", "session-copy", 1_100, user(1_100));
      insertMessage(writer, "assistant-copy", "session-copy", 1_200, assistant(1_200, 1_300));
      insertPart(writer, "text-copy", "user-copy", "session-copy", 1_100, { type: "text", text: "synthetic request" });
      insertPart(writer, "step-copy", "assistant-copy", "session-copy", 1_300, { type: "step-finish", reason: "stop" });

      const config = configuration(sourcePath, stateDir);
      const first = await opencodeAdapter.collect(context(config, store));
      commitBatch(store, first);
      const inputOwnershipKeys = (store.database.query(`
        SELECT counter_key FROM counter_snapshots WHERE counter_key LIKE 'input-%'
      `).all() as Array<{ counter_key: string }>).map((row) => row.counter_key);
      expect(inputOwnershipKeys).toHaveLength(1);
      expect(inputOwnershipKeys[0]).toMatch(
        /^input-prefix-owner:[0-9a-f]{64}:0:opencode:input:[0-9a-f]{64}$/,
      );
      expect(inputOwnershipKeys.some((key) => key.startsWith("input-clone-prefix:"))).toBe(false);
      expect(first.inputs.find((input) => input.nativeInputId === "user-copy")?.kind).toBe("submission");

      insertSession(writer, "session-original", 1_000);
      insertMessage(writer, "user-original", "session-original", 1_100, user(1_100));
      insertMessage(writer, "assistant-original", "session-original", 1_200, assistant(1_200, 1_300));
      insertPart(writer, "text-original", "user-original", "session-original", 1_100, { type: "text", text: "synthetic request" });
      insertPart(writer, "step-original", "assistant-original", "session-original", 1_300, { type: "step-finish", reason: "stop" });

      const second = await opencodeAdapter.collect(context(config, store, { rebuild: false }));
      commitBatch(store, second);
      const storedKinds = store.database.query(`
        SELECT native_input_id AS id, kind FROM input_events ORDER BY native_input_id
      `).all();
      expect(storedKinds).toEqual([
        { id: "user-copy", kind: "replay" },
        { id: "user-original", kind: "submission" },
      ]);
      const originalSessionKey = second.sessions
        .find((session) => session.sessionKey.endsWith(":session-original"))?.sessionKey;
      expect(second.sessions.find((session) => session.sessionKey.endsWith(":session-copy"))?.canonicalSessionKey)
        .toBe(originalSessionKey);
    } finally {
      writer.close();
      store.close();
    }
  });

  test("counts one plain-text user message and marks unfamiliar parts unknown", async () => {
    const root = temporaryDirectory();
    const sourcePath = join(root, "opencode.db");
    const writer = createSourceDatabase(sourcePath);
    const store = CollectorStore.open(join(root, "state"));
    try {
      insertSession(writer, "parent", 1_000);
      writer.query("UPDATE session SET parent_id = ? WHERE id = ?").run("branch-parent", "parent");
      insertMessage(writer, "plain", "parent", 1_100, user(1_100));
      insertPart(writer, "plain-text", "plain", "parent", 1_100, { type: "text", text: "private request" });
      insertMessage(writer, "attachment", "parent", 1_200, user(1_200));
      insertPart(writer, "attachment-part", "attachment", "parent", 1_200, { type: "file", path: "/private" });

      const batch = await opencodeAdapter.collect(context(configuration(sourcePath, join(root, "state")), store));
      expect(batch.inputs.map((input) => ({
        id: input.nativeInputId,
        kind: input.kind,
        lane: input.lane,
      })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
        { id: "attachment", kind: "unknown", lane: "unknown" },
        { id: "plain", kind: "submission", lane: "unknown" },
      ]);
      expect(batch.inputSourceState).toMatchObject({
        parserVersion: 1,
        quality: "partial",
        reasons: ["input-kind-unknown"],
      });
    } finally {
      writer.close();
      store.close();
    }
  });

  test("excludes a solitary exact duplicate candidate as ambiguous", async () => {
    const root = temporaryDirectory();
    const sourcePath = join(root, "opencode.db");
    const writer = createSourceDatabase(sourcePath);
    const store = CollectorStore.open(join(root, "state"));
    try {
      insertSession(writer, "session-first", 1_000);
      insertSession(writer, "session-second", 2_000);
      insertMessage(writer, "assistant-first", "session-first", 1_100, assistant(1_100, 1_200));
      insertMessage(writer, "assistant-second", "session-second", 1_100, assistant(1_100, 1_200));

      const batch = await opencodeAdapter.collect(context(configuration(sourcePath, join(root, "state")), store));
      expect(batch.usage).toHaveLength(1);
      expect(batch.usage[0]?.requestKey).toBe("assistant-first");
      expect(batch.excludedAmbiguousRecords).toBe(1);
      expect(batch.source.reasons).toContain("duplicate-ambiguity");
    } finally {
      writer.close();
      store.close();
    }
  });
});
