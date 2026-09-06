import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnSync } from "node:child_process";
import type { Config } from "../src/config";
import type { UsageRecord } from "../src/contracts";
import {
  collectConfiguredActivity,
  collectIntoStore,
  createScopeResolver,
  filterAdapterBatch,
} from "../src/ingest";
import { resolveSourcePath, scanJsonl } from "../src/sources/jsonl";
import type { AdapterBatch, SourceAdapter } from "../src/sources/types";
import { CollectorStore, type FileCursor, type SessionRecord } from "../src/store";

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `vito-ingest-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureConfig(root: string, stateDir: string): Config {
  return {
    version: 1,
    workspaceRoots: [root],
    timezone: "UTC",
    stateDir,
    sources: { codex: [], claude: [], omp: [], opencode: [], hermes: [] },
    repositories: [],
    publication: { repository: "fixture/activity", branch: "main" },
  };
}

function fixtureSession(workspaceKey: string | null, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    agent: "codex",
    sessionKey: "session-one",
    originKey: "session-origin-one",
    sourceKey: "codex:fixture",
    workspaceKey,
    repositoryKey: null,
    quality: "recorded",
    reasons: [],
    ...overrides,
  };
}

function fixtureUsage(originKey: string, sessionKey: string, workspaceKey: string, total = 10): UsageRecord {
  return {
    originKey,
    agent: "codex",
    sessionKey,
    workspaceKey,
    repositoryKey: null,
    turnKey: null,
    requestKey: originKey,
    atMs: 1_700_000_000_000,
    provider: "fixture",
    model: "fixture-model",
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

function fixtureBatch(root: string): AdapterBatch {
  return {
    source: {
      sourceKey: "codex:fixture",
      agent: "codex",
      kind: "jsonl",
      state: "available",
      tokenQuality: "recorded",
      workQuality: "unavailable",
      reasons: ["timing-unavailable"],
      diagnosticCounts: {},
    },
    sessions: [fixtureSession(root)],
    usage: [fixtureUsage("usage-one", "session-one", root)],
    workIntervals: [],
    counterSnapshots: [],
    fileCursors: [],
    unallocatedUsageRecords: 0,
    excludedAmbiguousRecords: 0,
  };
}

function adapterFor(batch: AdapterBatch): SourceAdapter {
  return {
    agent: "codex",
    async discover() {
      return [];
    },
    async collect() {
      return batch;
    },
  };
}

function git(directory: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("complete-line JSONL cursoring", () => {
  test("retains an unterminated tail and delivers it once after completion", async () => {
    const directory = temporaryDirectory("tail");
    const path = join(directory, "source.jsonl");
    writeFileSync(path, '{"id":"one"}\n{"id":"two"');
    const seen: string[] = [];

    const first = await scanJsonl({
      sourceKey: "fixture",
      path,
      onRecord(record) {
        seen.push((record as { id: string }).id);
      },
    });
    expect(seen).toEqual(["one"]);
    expect(first.diagnostics.unterminatedTailBytes).toBe(Buffer.byteLength('{"id":"two"'));
    expect(first.cursor.byteOffset).toBe(Buffer.byteLength('{"id":"one"}\n'));

    writeFileSync(path, '{"id":"one"}\n{"id":"two"}\n');
    const second = await scanJsonl({
      sourceKey: "fixture",
      path,
      previousCursor: first.cursor,
      onRecord(record) {
        seen.push((record as { id: string }).id);
      },
    });
    expect(second.diagnostics.replayed).toBe(false);
    expect(second.diagnostics.unterminatedTailBytes).toBe(0);
    expect(seen).toEqual(["one", "two"]);
  });

  test("replays replacements and truncations while semantic origins stay unique", async () => {
    const directory = temporaryDirectory("replacement");
    const path = join(directory, "source.jsonl");
    const semanticRecords = new Map<string, unknown>();
    const consume = (record: unknown) => {
      semanticRecords.set((record as { origin: string }).origin, record);
    };

    writeFileSync(path, '{"origin":"same","value":1}\n{"origin":"old","value":1}\n');
    const initial = await scanJsonl({ sourceKey: "fixture", path, onRecord: consume });
    writeFileSync(path, '{"origin":"same","value":2}\n');
    const truncated = await scanJsonl({ sourceKey: "fixture", path, previousCursor: initial.cursor, onRecord: consume });
    expect(truncated.diagnostics.replayed).toBe(true);
    const truncationReason = truncated.diagnostics.replayReason;
    if (truncationReason === null) throw new Error("Expected replay reason for truncated source");
    expect(["truncated", "prefix-changed", "tail-changed"]).toContain(truncationReason);
    expect(semanticRecords.size).toBe(2);
    expect((semanticRecords.get("same") as { value: number }).value).toBe(2);

    const priorCursor = truncated.cursor;
    rmSync(path);
    writeFileSync(path, '{"origin":"same","value":3}\n{"origin":"new","value":1}\n');
    const replaced = await scanJsonl({ sourceKey: "fixture", path, previousCursor: priorCursor, onRecord: consume });
    expect(replaced.diagnostics.replayed).toBe(true);
    const replacementReason = replaced.diagnostics.replayReason;
    if (replacementReason === null) throw new Error("Expected replay reason for replaced source");
    expect(["identity-changed", "prefix-changed", "tail-changed"]).toContain(replacementReason);
    expect(semanticRecords.size).toBe(3);
    expect((semanticRecords.get("same") as { value: number }).value).toBe(3);
  });

  test("counts malformed complete records and unsupported schemas without exposing data", async () => {
    const directory = temporaryDirectory("diagnostics");
    const path = join(directory, "source.jsonl");
    writeFileSync(path, '{"version":99,"secret":"SENTINEL"}\nnot-json\n{"version":1}\n');
    const accepted: unknown[] = [];
    const result = await scanJsonl({
      sourceKey: "fixture",
      path,
      classify(record) {
        return (record as { version: number }).version === 99 ? "unsupported-schema" : "accept";
      },
      onRecord(record) {
        accepted.push(record);
      },
    });
    expect(result.diagnostics).toMatchObject({ parseGaps: 1, unsupportedSchema: 1, acceptedRecords: 1 });
    expect(JSON.stringify(result.diagnostics)).not.toContain("SENTINEL");
  });

  test("rejects a recognized-root symlink escape", async () => {
    const directory = temporaryDirectory("source-path");
    const root = join(directory, "recognized");
    const outside = join(directory, "outside.jsonl");
    const link = join(root, "linked.jsonl");
    mkdirSync(root);
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, link);
    await expect(resolveSourcePath(link, root)).rejects.toThrow("escapes its recognized root");
  });
});

describe("scope and orchestration", () => {
  test("uses component boundaries, event-local scope, and explicit parent inheritance", () => {
    const parent = temporaryDirectory("scope");
    const root = join(parent, "work");
    const inside = join(root, "project");
    const lookalike = join(parent, "work-other");
    const missingHistorical = `${inside}/discarded/../removed/project`;
    mkdirSync(inside, { recursive: true });
    mkdirSync(lookalike, { recursive: true });
    const state = join(parent, "state");
    mkdirSync(state);
    const config = fixtureConfig(root, state);
    config.repositories = [{ path: inside, remote: "origin" }];
    const batch = fixtureBatch(root);
    batch.sessions = [
      fixtureSession(root, { sessionKey: "parent", originKey: "parent-origin" }),
      fixtureSession(null, {
        sessionKey: "child",
        originKey: "child-origin",
        parentSessionKey: "parent",
      }),
      fixtureSession(lookalike, { sessionKey: "outside", originKey: "outside-origin" }),
      fixtureSession(null, { sessionKey: "orphan", originKey: "orphan-origin" }),
      fixtureSession(missingHistorical, { sessionKey: "historical", originKey: "historical-origin" }),
    ];
    batch.usage = [
      fixtureUsage("inside", "parent", inside),
      fixtureUsage("child", "child", "unattributed-child"),
      fixtureUsage("event-moved-outside", "parent", lookalike),
      fixtureUsage("outside", "outside", lookalike),
      fixtureUsage("orphan", "orphan", "unattributed-orphan"),
      fixtureUsage("historical", "historical", missingHistorical),
      fixtureUsage("inside", "parent", inside, 20),
    ];

    const scoped = filterAdapterBatch(batch, config);
    expect(scoped.sessions.filter((session) => session.scopeDecision === "included")
      .map((session) => session.sessionKey).sort()).toEqual(["child", "historical", "parent"]);
    expect(scoped.usage.filter((record) => record.scopeDecision === "included")
      .map((record) => record.originKey).sort()).toEqual(["child", "historical", "inside"]);
    const insideUsage = scoped.usage.find((record) => record.originKey === "inside");
    const childUsage = scoped.usage.find((record) => record.originKey === "child");
    const historicalUsage = scoped.usage.find((record) => record.originKey === "historical");
    if (insideUsage === undefined || childUsage === undefined || historicalUsage === undefined || insideUsage.total === null) {
      throw new Error("Expected all scoped fixture usage with a known inside total");
    }
    expect(insideUsage.total).toBe(20);
    expect(childUsage.workspaceKey).toBe(realpathSync.native(root));
    expect(historicalUsage.workspaceKey).toBe(join(realpathSync.native(inside), "removed", "project"));
    expect(historicalUsage.repositoryKey).toBeNull();
    expect(historicalUsage.scopeReason).toBe("configured-root");
    expect(scoped.excludedUnattributedRecords).toBe(2);
  });

  test("includes linked worktrees by common repository identity and explicit deleted mappings", () => {
    const parent = temporaryDirectory("repository-identity");
    const company = join(parent, "company");
    const repository = join(company, "main");
    const linked = join(parent, "external", "linked");
    mkdirSync(repository, { recursive: true });
    mkdirSync(join(parent, "external"), { recursive: true });
    git(repository, "init");
    git(repository, "config", "user.email", "fixture@example.com");
    git(repository, "config", "user.name", "Fixture");
    writeFileSync(join(repository, "tracked.txt"), "tracked\n");
    git(repository, "add", "tracked.txt");
    git(repository, "commit", "-m", "fixture");
    git(repository, "worktree", "add", linked, "-b", "linked");

    const config = fixtureConfig(repository, join(parent, "state"));
    const linkedBatch = fixtureBatch(linked);
    const linkedScoped = filterAdapterBatch(linkedBatch, config);
    expect(linkedScoped.usage[0]).toMatchObject({
      scopeDecision: "included",
      scopeReason: "repository-identity",
      repositoryKey: realpathSync(repository),
    });

    const deleted = join(parent, "deleted-workspaces", "ticket-one");
    config.historicalWorkspaces = [{
      path: deleted,
      repositoryPath: repository,
      match: "exact",
    }];
    const historicalScoped = filterAdapterBatch(fixtureBatch(deleted), config);
    expect(historicalScoped.usage[0]?.scopeDecision).toBe("included");
    expect(historicalScoped.usage[0]?.scopeReason).toBe("historical-exact");
    expect(historicalScoped.usage[0]?.workspaceKey).toBe(
      join(realpathSync(parent), "deleted-workspaces", "ticket-one"),
    );
    expect(historicalScoped.usage[0]?.repositoryKey).toBe(realpathSync(repository));
  });

  test("cached attribution is session-bound and invalidated with its repository", () => {
    const parent = temporaryDirectory("cached-attribution");
    const repository = join(parent, "repository");
    const root = join(parent, "root");
    const deleted = join(parent, "deleted", "workspace");
    const canonicalDeleted = join(realpathSync(parent), "deleted", "workspace");
    const state = join(parent, "state");
    mkdirSync(repository);
    mkdirSync(root);
    git(repository, "init");
    const config = fixtureConfig(root, state);
    config.repositories = [{ path: repository, remote: "origin" }];
    const store = CollectorStore.open(state);
    try {
      store.writeBatch({
        workspaceAttributions: [{
          agent: "codex",
          sessionKey: "session-one",
          workspaceKey: canonicalDeleted,
          repositoryKey: realpathSync(repository),
          provenance: "repository-identity",
          verifiedAtMs: 1,
        }],
      });
      const sameSession = filterAdapterBatch(fixtureBatch(deleted), config, undefined, 2);
      expect(sameSession.usage[0]?.scopeDecision).toBe("out-of-scope");

      const resolver = createScopeResolver(config, store);
      expect(resolver.resolve("codex", "session-one", deleted).scopeReason).toBe("cached-attribution");
      expect(resolver.resolve("codex", "different-session", deleted).scopeDecision).toBe("out-of-scope");

      config.repositories = [];
      const narrowed = createScopeResolver(config, store);
      expect(narrowed.resolve("codex", "session-one", deleted).scopeDecision).toBe("out-of-scope");
    } finally {
      store.close();
    }
  });

  test("commits facts and checkpoints atomically for one adapter", async () => {
    const parent = temporaryDirectory("atomic");
    const root = join(parent, "work");
    const state = join(parent, "state");
    mkdirSync(root);
    const config = fixtureConfig(root, state);
    const store = CollectorStore.open(state);
    try {
      const batch = fixtureBatch(root);
      batch.counterSnapshots = [{
        sourceKey: "codex:fixture",
        counterKey: "fixture-counter",
        observedAtMs: 1,
        total: 10,
        quality: "recorded",
      }];
      batch.fileCursors = [{
        sourceKey: "codex:fixture",
        pathKey: "fixture-path",
        sourcePath: join(parent, "fixture.jsonl"),
        device: "1",
        inode: "1",
        byteOffset: -1,
        sizeBytes: 1,
        mtimeMs: 1,
        prefixFingerprint: "prefix",
        tailFingerprint: "tail",
      } as FileCursor];
      await expect(collectIntoStore(config, store, {
        adapters: [adapterFor(batch)],
        cutoffMs: Date.now(),
      })).rejects.toThrow("fileCursor.byteOffset must be nonnegative");
      expect(store.getUsage("usage-one")).toBeNull();
      expect(store.getCounterSnapshot("codex:fixture", "fixture-counter")).toBeNull();
      expect(store.database.query("SELECT * FROM sources WHERE source_key = ?").get("codex:fixture")).toBeNull();
      expect((store.database.query("SELECT status FROM collection_runs").all() as Array<{ status: string }>).at(-1)?.status).toBe("failed");
    } finally {
      store.close();
    }
  });

  test("retains prior history when a source later becomes unavailable", async () => {
    const parent = temporaryDirectory("missing");
    const root = join(parent, "work");
    const state = join(parent, "state");
    mkdirSync(root);
    const config = fixtureConfig(root, state);
    const store = CollectorStore.open(state);
    try {
      await collectIntoStore(config, store, {
        adapters: [adapterFor(fixtureBatch(root))],
        cutoffMs: Date.now(),
      });
      const missing = fixtureBatch(root);
      missing.source = {
        ...missing.source,
        state: "not-found",
        tokenQuality: "unavailable",
        reasons: ["missing-source"],
      };
      missing.sessions = [];
      missing.usage = [];
      await collectIntoStore(config, store, {
        adapters: [adapterFor(missing)],
        cutoffMs: Date.now(),
        rebuild: true,
      });
      const retainedUsage = store.getUsage("usage-one");
      if (retainedUsage === null || retainedUsage.total === null) {
        throw new Error("Expected retained usage with a known total");
      }
      expect(retainedUsage.total).toBe(10);
      expect((store.database.query("SELECT state FROM sources WHERE source_key = ?").get("codex:fixture") as { state: string }).state).toBe("not-found");
    } finally {
      store.close();
    }
  });

  test("reconciles contraction, expansion, repeated runs, and missing sources without duplication", async () => {
    const parent = temporaryDirectory("scope-transition");
    const root = join(parent, "selected-root");
    const repository = join(parent, "external-repository");
    const state = join(parent, "state");
    mkdirSync(root);
    mkdirSync(repository);
    git(repository, "init");
    const expanded = fixtureConfig(root, state);
    expanded.repositories = [{ path: repository, remote: "origin" }];
    const store = CollectorStore.open(state);
    try {
      await collectIntoStore(expanded, store, {
        adapters: [adapterFor(fixtureBatch(repository))],
        cutoffMs: 100,
      });
      const included = store.database.query(
        "SELECT scope_decision AS decision FROM usage WHERE origin_key = ?",
      ).get("usage-one");
      expect(included).toEqual({ decision: "included" });

      const unavailable = fixtureBatch(repository);
      unavailable.source = {
        ...unavailable.source,
        state: "not-found",
        tokenQuality: "unavailable",
        reasons: ["missing-source"],
      };
      unavailable.sessions = [];
      unavailable.usage = [];
      const contracted = { ...expanded, repositories: [] };
      await collectIntoStore(contracted, store, {
        adapters: [adapterFor(unavailable)],
        cutoffMs: 200,
        rebuild: true,
      });
      await collectIntoStore(contracted, store, {
        adapters: [adapterFor(unavailable)],
        cutoffMs: 200,
      });
      expect(store.database.query(
        "SELECT scope_decision AS decision FROM usage WHERE origin_key = ?",
      ).get("usage-one")).toEqual({ decision: "out-of-scope" });
      expect(store.database.query(
        "SELECT decision, known_total AS total FROM scope_evidence WHERE origin_key = ?",
      ).get("usage-one")).toEqual({ decision: "out-of-scope", total: 10 });
      expect(store.database.query("SELECT COUNT(*) AS count FROM usage").get()).toEqual({ count: 1 });
      expect(store.database.query("SELECT COUNT(*) AS count FROM scope_evidence").get()).toEqual({ count: 1 });

      await collectIntoStore(expanded, store, {
        adapters: [adapterFor(unavailable)],
        cutoffMs: 300,
      });
      expect(store.database.query(
        "SELECT scope_decision AS decision FROM usage WHERE origin_key = ?",
      ).get("usage-one")).toEqual({ decision: "included" });
      expect(store.database.query(
        "SELECT state, last_successful_scan_ms AS successful FROM sources WHERE source_key = ?",
      ).get("codex:fixture")).toEqual({ state: "not-found", successful: null });
    } finally {
      store.close();
    }
  });

  test("fails before collecting when configuration is absent", async () => {
    const directory = temporaryDirectory("no-config");
    await expect(collectConfiguredActivity(join(directory, "missing-config.json"), { adapters: [] })).rejects.toThrow(
      "Cannot read configuration",
    );
  });
});
