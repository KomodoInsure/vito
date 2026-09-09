import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InputRecord, UsageRecord, WorkInterval } from "../src/contracts";
import { WRITER_LOCK_DIRECTORY, WriterLock, WriterLockBusyError, withWriterLock } from "../src/lock";
import { CollectorStore } from "../src/store";

const temporaryDirectories: string[] = [];

function temporaryState(): string {
  const directory = mkdtempSync(join(tmpdir(), "vito-store-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function usage(total: number): UsageRecord {
  return {
    originKey: "response:one",
    agent: "codex",
    sessionKey: "session:one",
    workspaceKey: "workspace:synthetic",
    repositoryKey: null,
    turnKey: "turn:one",
    requestKey: "request:one",
    atMs: 1_700_000_000_000,
    provider: "synthetic",
    model: "model-one",
    uncachedInput: total,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total,
    costMicrousd: null,
    costKind: "unknown",
    quality: "recorded",
    reasons: [],
  };
}

function interval(endMs: number): WorkInterval {
  return {
    originKey: "interval:one",
    agent: "codex",
    sessionKey: "session:one",
    workspaceKey: "workspace:synthetic",
    repositoryKey: null,
    provider: "synthetic",
    model: "model-one",
    startMs: 1_000,
    endMs,
    kind: "inference",
  };
}

function input(originKey = "input:one"): InputRecord {
  return {
    originKey,
    sourceKey: "source:one",
    agent: "codex",
    sessionKey: "session:one",
    nativeSessionId: "native-session",
    nativeInputId: "native-input",
    workspaceKey: "workspace:synthetic",
    repositoryKey: null,
    atMs: 1_700_000_000_000,
    kind: "submission",
    lane: "main",
    controller: null,
    origin: "unknown",
    originEvidence: "none",
    quality: "recorded",
    reasons: [],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CollectorStore", () => {
  test("creates the complete private WAL ledger and indexes", () => {
    const store = CollectorStore.open(temporaryState());
    try {
      const tables = (store.database.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all() as Array<{ name: string }>).map(({ name }) => name);
      expect(tables).toEqual([
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
      ]);

      const indexes = new Set((store.database.query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'",
      ).all() as Array<{ name: string }>).map(({ name }) => name));
      for (const required of [
        "usage_at_model_idx",
        "usage_agent_at_idx",
        "work_intervals_endpoints_idx",
        "work_intervals_session_idx",
        "commits_committer_idx",
        "commits_repository_time_idx",
        "input_events_agent_at_idx",
        "input_events_session_idx",
        "input_events_source_idx",
        "input_events_native_idx",
        "input_provenance_native_idx",
      ]) expect(indexes.has(required)).toBe(true);

      expect((store.database.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
      expect((store.database.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      expect(statSync(store.path).mode & 0o777).toBe(0o600);
      expect(statSync(store.stateDir).mode & 0o777).toBe(0o700);
    } finally {
      store.close();
    }
  });

  test("upserts semantic usage and work origins idempotently", () => {
    const store = CollectorStore.open(temporaryState());
    try {
      store.upsertUsage(usage(10), 1);
      store.upsertUsage(usage(25), 2);
      store.upsertWorkInterval(interval(2_000), 1);
      store.upsertWorkInterval(interval(3_000), 2);

      expect((store.database.query("SELECT count(*) AS count FROM usage").get() as { count: number }).count).toBe(1);
      expect(store.getUsage("response:one")?.total).toBe(25);
      expect((store.database.query("SELECT count(*) AS count FROM work_intervals").get() as { count: number }).count).toBe(1);
      expect((store.database.query("SELECT end_ms FROM work_intervals WHERE origin_key = ?").get("interval:one") as { end_ms: number }).end_ms).toBe(3_000);
    } finally {
      store.close();
    }
  });

  test("strictly persists input facts, source state, and distinct provenance claims", () => {
    const store = CollectorStore.open(temporaryState());
    try {
      store.writeBatch({
        inputs: [{ ...input(), scopeDecision: "out-of-scope", scopeReason: "configured-root" }],
        inputSourceStates: [{
          sourceKey: "source:one",
          agent: "codex",
          parserVersion: 1,
          quality: "recorded",
          reasons: [],
          scannedAtMs: 20,
          lastSuccessfulScanMs: 20,
        }],
        inputProvenance: [
          {
            originKey: "ignored-by-store",
            agent: "codex",
            nativeSessionId: "native-session",
            nativeInputId: "native-input",
            origin: "human",
            controller: "runner",
          },
          {
            originKey: "also-ignored",
            agent: "codex",
            nativeSessionId: "native-session",
            nativeInputId: "native-input",
            origin: "human",
            controller: "runner",
          },
          {
            originKey: "contrary",
            agent: "codex",
            nativeSessionId: "native-session",
            nativeInputId: "native-input",
            origin: "automated",
            controller: "runner",
          },
        ],
      });

      expect(store.database.query("SELECT * FROM input_events WHERE origin_key = 'input:one'").get()).toMatchObject({
        native_session_id: "native-session",
        native_input_id: "native-input",
        scope_decision: "out-of-scope",
      });
      expect(store.getInputSourceState("source:one")).toMatchObject({
        parser_version: 1,
        quality: "recorded",
        last_successful_scan_ms: 20,
      });
      expect((store.database.query("SELECT count(*) AS count FROM input_provenance").get() as { count: number }).count).toBe(2);
      expect(() => store.upsertInput({ ...input("invalid"), controller: "" })).toThrow();
      expect(() => store.upsertInputSourceState({
        sourceKey: "invalid",
        agent: "codex",
        parserVersion: 1,
        quality: "recorded",
        reasons: [],
        scannedAtMs: -1,
        lastSuccessfulScanMs: null,
      })).toThrow();
    } finally {
      store.close();
    }
  });

  test("migrates a version-two ledger without disturbing retained accounting", () => {
    const state = temporaryState();
    const first = CollectorStore.open(state);
    first.upsertUsage(usage(10), 1);
    first.database.exec("DROP TABLE input_events; DROP TABLE input_source_state; DROP TABLE input_provenance; PRAGMA user_version = 2;");
    first.close();

    const migrated = CollectorStore.open(state);
    try {
      expect((migrated.database.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
      expect(migrated.getUsage("response:one")?.total).toBe(10);
      expect((migrated.database.query("SELECT count(*) AS count FROM input_events").get() as { count: number }).count).toBe(0);
    } finally {
      migrated.close();
    }
  });

  test("rolls facts and cursor/counter checkpoints back as one batch", () => {
    const store = CollectorStore.open(temporaryState());
    try {
      store.upsertCounterSnapshot({
        sourceKey: "source:one",
        counterKey: "counter:one",
        observedAtMs: 100,
        total: 10,
        quality: "recorded",
      });
      store.upsertFileCursor({
        sourceKey: "source:one",
        pathKey: "path:one",
        sourcePath: "/synthetic/source.jsonl",
        device: "1",
        inode: "2",
        byteOffset: 10,
        sizeBytes: 20,
        mtimeMs: 100,
        prefixFingerprint: "prefix-one",
        tailFingerprint: "tail-one",
      });

      expect(() => store.transaction((transaction) => {
        transaction.upsertUsage(usage(40), 3);
        transaction.upsertCounterSnapshot({
          sourceKey: "source:one",
          counterKey: "counter:one",
          observedAtMs: 200,
          total: 40,
          quality: "recorded",
        });
        transaction.upsertFileCursor({
          sourceKey: "source:one",
          pathKey: "path:one",
          sourcePath: "/synthetic/source.jsonl",
          device: "1",
          inode: "2",
          byteOffset: 40,
          sizeBytes: 40,
          mtimeMs: 200,
          prefixFingerprint: "prefix-two",
          tailFingerprint: "tail-two",
        });
        throw new Error("synthetic interruption");
      })).toThrow("synthetic interruption");

      expect(store.getUsage("response:one")).toBeNull();
      expect(store.getCounterSnapshot("source:one", "counter:one")?.total).toBe(10);
      expect(store.getFileCursor("source:one", "path:one")?.byte_offset).toBe(10);
    } finally {
      store.close();
    }
  });

  test("atomically replaces default-branch membership", () => {
    const store = CollectorStore.open(temporaryState());
    try {
      store.replaceRepositoryCommits("repo:one", "tip-a", [
        { repositoryKey: "repo:one", oid: "a", committerMs: 100 },
        { repositoryKey: "repo:one", oid: "b", committerMs: 200 },
      ], { collectedAtMs: 300, shallow: false });
      store.replaceRepositoryCommits("repo:one", "tip-b", [
        { repositoryKey: "repo:one", oid: "b", committerMs: 200 },
        { repositoryKey: "repo:one", oid: "c", committerMs: 400 },
      ], { collectedAtMs: 500, shallow: true });

      expect(store.listCommits("repo:one").map((row) => row.oid)).toEqual(["b", "c"]);
      expect(store.listCommits("repo:one").every((row) => row.tip_oid === "tip-b" && row.shallow === 1)).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("WriterLock", () => {
  test("rejects a live competing writer", () => {
    const stateDir = temporaryState();
    const first = WriterLock.acquire(stateDir);
    try {
      expect(() => WriterLock.acquire(stateDir)).toThrow(WriterLockBusyError);
    } finally {
      first.release();
    }
    const next = WriterLock.acquire(stateDir);
    next.release();
  });

  test("acquires under a scheduler PATH without system binaries", () => {
    const stateDir = temporaryState();
    const lockModule = new URL("../src/lock.ts", import.meta.url).href;
    // The altered PATH must be isolated in a child process, so this test cannot use the parent's static import.
    const script = `const { WriterLock } = await import(${JSON.stringify(lockModule)}); const lock = WriterLock.acquire(${JSON.stringify(stateDir)}); lock.release();`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, PATH: "/nonexistent" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
  });

  test("reclaims ownership proven stale by process-start identity", () => {
    const stateDir = temporaryState();
    chmodSync(stateDir, 0o700);
    const lockPath = join(stateDir, WRITER_LOCK_DIRECTORY);
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStart: "a different process that reused this pid",
      nonce: "stale-owner",
    })}\n`, { mode: 0o600 });

    const lock = WriterLock.acquire(stateDir);
    try {
      const newOwner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { nonce: string };
      expect(newOwner.nonce).not.toBe("stale-owner");
    } finally {
      lock.release();
    }
  });

  test("does not reclaim a lock whose owner cannot be established", () => {
    const stateDir = temporaryState();
    const lockPath = join(stateDir, WRITER_LOCK_DIRECTORY);
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), "not valid lock metadata\n", { mode: 0o600 });
    expect(() => WriterLock.acquire(stateDir)).toThrow(WriterLockBusyError);
  });

  test("reuses one lock context for nested mutating operations", async () => {
    const stateDir = temporaryState();
    let outerNonce = "";
    await withWriterLock(stateDir, async (outer) => {
      outerNonce = outer.owner.nonce;
      await withWriterLock(stateDir, (inner) => {
        expect(inner).toBe(outer);
      });
      expect(outer.isHeld).toBe(true);
    });
    expect(outerNonce.length).toBeGreaterThan(0);
    const next = WriterLock.acquire(stateDir);
    next.release();
  });
});
