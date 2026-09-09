import { describe, expect, test } from "bun:test";

import { main, type CliOperations } from "../src/cli";
import type { PublishResult } from "../src/publish";
import type { Config } from "../src/config";
import type { CollectorStore } from "../src/store";
import type { PublicSnapshot } from "../src/contracts";
import type { ExportResult } from "../src/export";
import type { GitCollectionResult } from "../src/git";
import { PRICING_METADATA } from "../src/pricing";

const NOW = Date.parse("2026-09-06T18:00:00.000Z");

const config: Config = {
  version: 1,
  workspaceRoots: ["/company/work"],
  timezone: "UTC",
  stateDir: "/private/vito-state",
  sources: {},
  repositories: [],
  publication: { repository: "owner/activity", branch: "main" },
};

function collectionSummary() {
  return {
    runKey: "run-1",
    startedAtMs: NOW - 10,
    completedAtMs: NOW,
    cutoffMs: NOW,
    status: "completed" as const,
    adaptersCollected: 5,
    unallocatedUsageRecords: 2,
    excludedAmbiguousRecords: 3,
    excludedUnattributedRecords: 4,
  };
}

function gitCollectionResult(): GitCollectionResult {
  return {
    repositories: [{
      repositoryKey: "repo",
      path: "/company/work/repo",
      commonDir: "/company/work/repo/.git",
      ref: null,
      tipOid: null,
      commits: [],
      collectedAtMs: NOW,
      fetchEvidenceMs: null,
      remoteFreshness: "unknown",
      shallow: false,
      quality: "recorded",
      reasons: [],
      diagnostics: [],
    }],
    diagnostics: [],
  };
}

function publicSnapshot(at: string): PublicSnapshot {
  const group = () => ({
    inputs: { value: null, status: "unavailable" as const, reasons: ["input-history-incomplete" as const] },
    cadence: { value: null, status: "unavailable" as const, reasons: [] },
    cadenceCoverage: {
      consideredSessions: 0,
      excluded: { inputHistory: 0, mixedScope: 0, unknownOrigin: 0, noHumanInput: 0, noRecordedWork: 0 },
    },
    excluded: { context: 0, replayed: 0, unknownKind: 0, subagent: 0, unknownLane: 0, undated: 0 },
  });
  const range = () => ({ all: group(), byHarness: [] });
  return {
    schemaVersion: 5,
    pricing: { ...PRICING_METADATA, sources: [...PRICING_METADATA.sources] },
    organization: "Komodo Risk Inc",
    timezone: "UTC",
    generatedAt: at,
    cutoff: at,
    periodStart: "2025-09-07",
    periodEnd: "2026-09-06",
    collectionStatus: "partial",
    sources: [],
    coverage: {
      unallocatedUsageRecords: 2,
      excludedAmbiguousRecords: 3,
      scopeStatus: "recorded",
      undated: { byHarness: [] },
    },
    inputRanges: { "7": range(), "30": range(), "90": range(), "365": range() },
    days: [],
  };
}

function exportResult(outDir: string, at: string): ExportResult {
  return {
    outDir,
    files: ["activity.json"],
    snapshot: publicSnapshot(at),
  };
}

function publicationResult(): PublishResult {
  return {
    exportDirectory: "/private/vito-state/export",
    exportedFiles: ["activity.json", "widget.js"],
    snapshotCoverage: {
      periodStart: "2025-09-07",
      periodEnd: "2026-09-06",
      collectionStatus: "partial",
      unallocatedUsageRecords: 2,
      excludedAmbiguousRecords: 3,
    },
    changed: true,
    pushed: false,
    siteUrl: "https://owner.example/activity/",
  };
}

function fakeStore(events: string[]): CollectorStore {
  const store = {
    readTransaction<T>(operation: (value: CollectorStore) => T): T {
      events.push("read-transaction");
      return operation(store as unknown as CollectorStore);
    },
    close(): void {
      events.push("close-store");
    },
  };
  return store as unknown as CollectorStore;
}

function operations(events: string[], overrides: Partial<CliOperations> = {}): CliOperations {
  const store = fakeStore(events);
  return {
    loadConfig(configPath) {
      events.push(`load:${configPath ?? "default"}`);
      return config;
    },
    resolveConfigPath(configPath) {
      return configPath ?? "/default/config.json";
    },
    async discoverSources(receivedConfig) {
      events.push(`discover:${receivedConfig === undefined ? "unconfigured" : "configured"}`);
      return [];
    },
    formatDiscoveryOutput() {
      return "[]\n";
    },
    async withWriterLock<T>(stateDir: string, operation: () => T | Promise<T>): Promise<T> {
      events.push(`lock:${stateDir}`);
      return await operation();
    },
    openCollectorStore(stateDir) {
      events.push(`open-store:${stateDir}`);
      return store;
    },
    async collectIntoStore(_config, _store, options) {
      events.push(`collect:${String(options?.rebuild ?? false)}`);
      return collectionSummary();
    },
    collectGitCommits(_config, _store, options) {
      events.push(`git:${options?.collectedAtMs}`);
      return gitCollectionResult();
    },
    exportStaticSite(_config, _store, options) {
      events.push(`export:${options.outDir}:${options.at ?? "now"}`);
      return exportResult(options.outDir, options.at ?? new Date(NOW).toISOString());
    },
    buildScopeReport(_config, _store, days, cutoffMs) {
      events.push(`scope:${days}:${cutoffMs}`);
      const cutoff = new Date(cutoffMs).toISOString();
      return {
        timezone: "UTC",
        cutoff,
        windowStart: cutoff,
        windowEnd: cutoff,
        freshness: { latestSuccessfulScan: cutoff, status: "recorded" },
        totals: {
          included: { records: 0, knownTokens: 0, unknownTotalRecords: 0 },
          outOfScope: { records: 0, knownTokens: 0, unknownTotalRecords: 0 },
          unattributed: { records: 0, knownTokens: 0, unknownTotalRecords: 0 },
        },
        breakdowns: [],
      };
    },
    startPreview(directory, port) {
      events.push(`preview:${directory}:${port}`);
      return { port, stop() {} };
    },
    async waitForPreviewStop() {
      events.push("preview-stopped");
    },
    async publishActivity(_config, options) {
      events.push(`publish:${String(options?.dryRun ?? false)}:${String(options?.lockHeld ?? false)}:${options?.at ?? "now"}`);
      return publicationResult();
    },
    async setupPages(_config, options) {
      events.push(`pages:${String(options?.lockHeld ?? false)}`);
      return publicationResult();
    },
    readPublicationState() {
      return null;
    },
    async installSchedule(_config, configPath) {
      events.push(`schedule-install:${configPath}`);
      return { installed: true };
    },
    async scheduleStatus(_config, configPath) {
      events.push(`schedule-status:${configPath}`);
      return { loaded: true };
    },
    async uninstallSchedule(_config, configPath) {
      events.push(`schedule-uninstall:${configPath}`);
      return { removed: true };
    },
    now() {
      return NOW;
    },
    ...overrides,
  };
}

async function execute(argv: string[], ops: CliOperations): Promise<{ code: number; output: string[]; errors: string[] }> {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await main(argv, undefined, {
    operations: ops,
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
  });
  return { code, output, errors };
}

describe("integrated CLI runner", () => {
  test("discover needs no configuration and prints only its formatter's bounded report", async () => {
    const events: string[] = [];
    const privateSentinel = "/company/secret/repository";
    const result = await execute(["discover"], operations(events, {
      async discoverSources(receivedConfig) {
        expect(receivedConfig).toBeUndefined();
        events.push("discover:unconfigured");
        return [{
          agent: "codex",
          state: "available",
          capabilities: { tokens: "recorded", work: "recorded" },
          paths: [privateSentinel],
          diagnosticCounts: {},
          reasons: [],
        }];
      },
      formatDiscoveryOutput() {
        return "[{\"agent\":\"codex\",\"state\":\"available\"}]\n";
      },
    }));

    expect(result.code).toBe(0);
    expect(events).toEqual(["discover:unconfigured"]);
    expect(result.output).toEqual(['[{"agent":"codex","state":"available"}]']);
    expect(result.output.join("\n")).not.toContain(privateSentinel);
    expect(result.errors).toEqual([]);
  });

  test("an explicitly configured discover loads that configuration", async () => {
    const events: string[] = [];
    const result = await execute(["--config", "/chosen/config.json", "discover"], operations(events));
    expect(result.code).toBe(0);
    expect(events).toEqual(["load:/chosen/config.json", "discover:configured"]);
  });

  test("configured commands stop at an actionable missing-config error", async () => {
    for (const argv of [["collect"], ["export", "--out", "/tmp/out"], ["publish"], ["pages", "setup"], ["tick"], ["schedule", "status"]]) {
      const events: string[] = [];
      const result = await execute(argv, operations(events, {
        loadConfig() {
          events.push("load");
          throw new Error("No Vito configuration found; run 'vito init' first.");
        },
      }));
      expect(result.code).toBe(1);
      expect(events).toEqual(["load"]);
      expect(result.errors).toEqual(["vito: No Vito configuration found; run 'vito init' first."]);
    }
  });

  test("collect acquires one outer lock, ingests activity and Git, and closes its store", async () => {
    const events: string[] = [];
    let lockDepth = 0;
    let maximumLockDepth = 0;
    const ops = operations(events, {
      async withWriterLock<T>(_stateDir: string, operation: () => T | Promise<T>): Promise<T> {
        lockDepth += 1;
        maximumLockDepth = Math.max(maximumLockDepth, lockDepth);
        events.push("lock-enter");
        try {
          return await operation();
        } finally {
          events.push("lock-exit");
          lockDepth -= 1;
        }
      },
    });
    const result = await execute(["collect", "--rebuild"], ops);

    expect(result.code).toBe(0);
    expect(maximumLockDepth).toBe(1);
    expect(events).toEqual([
      "load:default",
      "lock-enter",
      "open-store:/private/vito-state",
      "collect:true",
      `git:${NOW}`,
      "close-store",
      "lock-exit",
    ]);
    expect(result.output[0]).toContain('"repositories":1');
  });

  test("export holds a consistent read transaction and forwards the fixed cutoff", async () => {
    const events: string[] = [];
    const at = "2026-09-06T17:45:00.000Z";
    const result = await execute(["export", "--out", "/tmp/site", "--at", at], operations(events));

    expect(result.code).toBe(0);
    expect(events).toEqual([
      "load:default",
      "open-store:/private/vito-state",
      "read-transaction",
      `export:/tmp/site:${at}`,
      "close-store",
    ]);
    expect(result.output[0]).toContain('"unallocatedUsageRecords":2');
  });

  test("scope reads the private ledger without collecting or locking", async () => {
    const events: string[] = [];
    const at = "2026-09-06T17:45:00.000Z";
    const result = await execute(["scope", "--days", "7", "--at", at], operations(events));

    expect(result.code).toBe(0);
    expect(events).toEqual([
      "load:default",
      "open-store:/private/vito-state",
      `scope:7:${Date.parse(at)}`,
      "close-store",
    ]);
    expect(result.output[0]).toContain("Scope report");
    expect(result.output[0]).toContain(`"cutoff":"${at}"`);
  });

  test("preview forwards directory and port then waits for server shutdown", async () => {
    const events: string[] = [];
    const result = await execute(["preview", "--dir", "/tmp/site with spaces", "--port", "4317"], operations(events));
    expect(result.code).toBe(0);
    expect(events).toEqual(["preview:/tmp/site with spaces:4317", "preview-stopped"]);
    expect(result.output).toEqual(["Previewing /tmp/site with spaces at http://127.0.0.1:4317/"]);
  });

  test("publish modes and Pages setup each use one outer lock and internal lock context", async () => {
    const dryEvents: string[] = [];
    const dry = await execute(["publish", "--dry-run"], operations(dryEvents));
    expect(dry.code).toBe(0);
    expect(dryEvents).toEqual([
      "load:default",
      "lock:/private/vito-state",
      "publish:true:true:now",
    ]);
    expect(dry.output[0]).toContain("Prepared publication dry run");
    expect(dry.output[0]).toContain('"exportedFiles":["activity.json","widget.js"]');
    expect(dry.output[0]).toContain('"snapshotCoverage"');

    const publishEvents: string[] = [];
    const published = await execute(["publish"], operations(publishEvents));
    expect(published.code).toBe(0);
    expect(publishEvents).toEqual([
      "load:default",
      "lock:/private/vito-state",
      "publish:false:true:now",
    ]);
    expect(published.output[0]).toContain("Published activity");

    const pagesEvents: string[] = [];
    const pages = await execute(["pages", "setup"], operations(pagesEvents));
    expect(pages.code).toBe(0);
    expect(pagesEvents).toEqual([
      "load:default",
      "lock:/private/vito-state",
      "pages:true",
    ]);
  });

  test("tick below the interval collects activity and Git without publishing", async () => {
    const events: string[] = [];
    const result = await execute(["tick"], operations(events, {
      readPublicationState() {
        events.push("read-publication-state");
        return { lastSuccessfulPublicationAt: new Date(NOW - 14 * 60_000).toISOString() };
      },
    }));

    expect(result.code).toBe(0);
    expect(events).toEqual([
      "load:default",
      "lock:/private/vito-state",
      "read-publication-state",
      "open-store:/private/vito-state",
      "collect:false",
      `git:${NOW}`,
      "close-store",
    ]);
    expect(result.output[0]).toContain('"publicationDue":false');
  });

  test("tick at the interval delegates one locked collect/export/publication pipeline", async () => {
    const events: string[] = [];
    const result = await execute(["tick"], operations(events, {
      readPublicationState() {
        events.push("read-publication-state");
        return { lastSuccessfulPublicationAt: new Date(NOW - 15 * 60_000).toISOString() };
      },
    }));

    expect(result.code).toBe(0);
    expect(events).toEqual([
      "load:default",
      "lock:/private/vito-state",
      "read-publication-state",
      `publish:false:true:${new Date(NOW).toISOString()}`,
    ]);
    expect(result.output[0]).toContain("Tick published activity");
  });

  test("a tick publication failure remains nonzero after its collection side effect", async () => {
    const events: string[] = [];
    let collectionPersisted = false;
    const result = await execute(["tick"], operations(events, {
      async publishActivity() {
        events.push("publisher-collected");
        collectionPersisted = true;
        throw new Error("GitHub is offline; local collection and export were preserved.");
      },
    }));

    expect(result.code).toBe(1);
    expect(collectionPersisted).toBe(true);
    expect(events).toEqual([
      "load:default",
      "lock:/private/vito-state",
      "publisher-collected",
    ]);
    expect(result.errors).toEqual(["vito: GitHub is offline; local collection and export were preserved."]);
  });

  test("all schedule actions route with the resolved configuration path", async () => {
    const cases = [
      ["install", "schedule-install"],
      ["status", "schedule-status"],
      ["uninstall", "schedule-uninstall"],
    ] as const;
    for (const [action, event] of cases) {
      const events: string[] = [];
      const result = await execute(["--config", "/chosen/config.json", "schedule", action], operations(events));
      expect(result.code).toBe(0);
      expect(events).toEqual(action === "status"
        ? ["load:/chosen/config.json", `${event}:/chosen/config.json`]
        : ["load:/chosen/config.json", "lock:/private/vito-state", `${event}:/chosen/config.json`]);
      expect(result.output[0]).toStartWith(`Schedule ${action} `);
    }
  });
});
