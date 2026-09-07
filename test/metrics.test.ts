import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config";
import { publicSnapshotSchema, type Agent, type UsageRecord, type WorkInterval } from "../src/contracts";
import { aggregateUsageRecords, aggregateWorkIntervals, buildHourlySlots, buildPublicSnapshot } from "../src/metrics";
import { CollectorStore } from "../src/store";

const temporaryDirectories: string[] = [];

function temporaryStore(): CollectorStore {
  const stateDir = mkdtempSync(join(tmpdir(), "vito-metrics-test-"));
  temporaryDirectories.push(stateDir);
  return CollectorStore.open(stateDir);
}

function config(stateDir: string, timezone = "UTC", companyName = "Komodo Risk Inc"): Config {
  return {
    version: 1,
    companyName,
    workspaceRoots: ["/synthetic/workspace"],
    timezone,
    stateDir,
    sources: { codex: ["/synthetic/codex"], claude: [], omp: [], opencode: [], hermes: [] },
    repositories: [],
    publication: { repository: "komodorisk/activity", branch: "main" },
  };
}

function interval(
  originKey: string,
  agent: Agent,
  sessionKey: string,
  startMs: number,
  endMs: number,
  kind: WorkInterval["kind"] = "inference",
): WorkInterval {
  return {
    originKey,
    agent,
    sessionKey,
    workspaceKey: "/private/workspace-sentinel",
    repositoryKey: "/private/repository-sentinel",
    provider: "synthetic",
    model: "model",
    startMs,
    endMs,
    kind,
  };
}

function usage(originKey: string, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    originKey,
    agent: "codex",
    sessionKey: "private-session-sentinel",
    workspaceKey: "/private/workspace-sentinel",
    repositoryKey: "/private/repository-sentinel",
    turnKey: "private-turn-sentinel",
    requestKey: "private-request-sentinel",
    atMs: Date.parse("2026-09-06T00:30:00.000Z"),
    provider: "synthetic",
    model: "model",
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    costMicrousd: null,
    costKind: "unknown",
    quality: "recorded",
    reasons: [],
    ...overrides,
  };
}

function installCodexSource(store: CollectorStore, workQuality: "recorded" | "partial" | "unavailable" = "recorded"): void {
  store.writeBatch({
    sources: [{
      sourceKey: "codex:synthetic-private-source",
      agent: "codex",
      kind: "jsonl",
      sourcePath: "/private/source-path-sentinel",
      state: workQuality === "recorded" ? "available" : "partial",
      tokenQuality: "recorded",
      workQuality,
      reasons: workQuality === "recorded" ? [] : ["timing-unavailable"],
    }],
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("work interval aggregation", () => {
  test("computes the exact time-weighted one-hour concurrency fixture", () => {
    const result = aggregateWorkIntervals([
      interval("first", "codex", "lane-a", 0, 600_000),
      interval("second", "codex", "lane-b", 300_000, 900_000),
    ], 0, 3_600_000);

    expect(result).toEqual({
      value: {
        activeMs: 900_000,
        inferenceMs: 900_000,
        agentMs: 1_200_000,
        parallelMs: 300_000,
        histogram: [
          { agents: 0, elapsedMs: 2_700_000 },
          { agents: 1, elapsedMs: 600_000 },
          { agents: 2, elapsedMs: 300_000 },
        ],
        unavailableMs: 0,
      },
      status: "recorded",
      reasons: [],
    });
  });
  test("separates union inference time from tool-only activity", () => {
    const result = aggregateWorkIntervals([
      interval("first-inference", "codex", "lane-a", 0, 600_000),
      interval("second-inference", "codex", "lane-b", 300_000, 900_000),
      interval("tool", "codex", "lane-a", 900_000, 1_200_000, "tool"),
    ], 0, 3_600_000);

    expect(result.value).toMatchObject({
      activeMs: 1_200_000,
      inferenceMs: 900_000,
      agentMs: 1_500_000,
    });
  });


  test("unions overlapping and touching work in one lane before sweeping", () => {
    const result = aggregateWorkIntervals([
      interval("one", "codex", "same-lane", 0, 600_000),
      interval("two", "codex", "same-lane", 300_000, 900_000),
      interval("three", "codex", "same-lane", 900_000, 1_200_000),
    ], 0, 3_600_000);

    expect(result.value).toMatchObject({ activeMs: 1_200_000, agentMs: 1_200_000, parallelMs: 0 });
    expect(result.value?.histogram).toEqual([
      { agents: 0, elapsedMs: 2_400_000 },
      { agents: 1, elapsedMs: 1_200_000 },
    ]);
  });

  test("recomputes the company union instead of summing harness active time", () => {
    const intervals = [
      interval("codex", "codex", "codex-lane", 0, 600_000),
      interval("omp", "omp", "omp-lane", 300_000, 900_000),
    ];
    const company = aggregateWorkIntervals(intervals, 0, 3_600_000);
    const codex = aggregateWorkIntervals(intervals.filter((entry) => entry.agent === "codex"), 0, 3_600_000);
    const omp = aggregateWorkIntervals(intervals.filter((entry) => entry.agent === "omp"), 0, 3_600_000);

    expect(codex.value?.activeMs).toBe(600_000);
    expect(omp.value?.activeMs).toBe(600_000);
    expect(company.value?.activeMs).toBe(900_000);
    expect(company.value?.activeMs).not.toBe((codex.value?.activeMs ?? 0) + (omp.value?.activeMs ?? 0));
  });

  test("keeps an hour without measured evidence unavailable in daily totals", () => {
    const store = temporaryStore();
    try {
      installCodexSource(store);
      store.writeBatch({ workIntervals: [
        interval("measured", "codex", "lane", Date.parse("2026-09-06T00:00:00Z"), Date.parse("2026-09-06T00:15:00Z")),
      ] });
      const snapshot = buildPublicSnapshot(config(store.stateDir), store, Date.parse("2026-09-06T02:00:00Z"));
      const today = snapshot.days.at(-1)!;

      expect(today.hours).toHaveLength(2);
      expect(today.hours[0]?.work.work.value?.histogram).toEqual([
        { agents: 0, elapsedMs: 2_700_000 },
        { agents: 1, elapsedMs: 900_000 },
      ]);
      expect(today.hours[1]?.work.work).toMatchObject({ value: null, status: "unavailable" });
      expect(today.work.work).toMatchObject({
        status: "partial",
        value: { activeMs: 900_000, agentMs: 900_000, unavailableMs: 3_600_000 },
      });
      const accounted = today.work.work.value!.histogram.reduce((sum, bin) => sum + bin.elapsedMs, 0) + today.work.work.value!.unavailableMs;
      expect(accounted).toBe(today.elapsedMs);
    } finally {
      store.close();
    }
  });
});

describe("usage aggregation", () => {
  test("uses a paired cache population and does not average request percentages", () => {
    const aggregate = aggregateUsageRecords([
      usage("first", { uncachedInput: 20, cacheRead: 80, cacheWrite: 0, total: 100 }),
      usage("second", { uncachedInput: 810, cacheRead: 90, cacheWrite: 0, total: 900 }),
      usage("excluded", { uncachedInput: null, cacheRead: 500, cacheWrite: 0, total: null, quality: "partial", reasons: ["parse-gap"] }),
    ]);

    expect(aggregate.usage.cacheReadBasis).toEqual({
      value: { readTokens: 170, promptTokens: 1_000 },
      status: "partial",
      reasons: ["parse-gap"],
    });
    expect(aggregate.usage.cacheRead.value).toBe(670);
  });

  test("keeps reasoning as an output subset and exposes only verified residuals", () => {
    const aggregate = aggregateUsageRecords([
      usage("complete", { uncachedInput: 20, cacheRead: 80, cacheWrite: 0, output: 30, reasoning: 10, total: 135 }),
    ]);

    expect(aggregate.usage.output.value).toBe(30);
    expect(aggregate.usage.reasoning.value).toBe(10);
    expect(aggregate.usage.otherRecorded.value).toBe(5);
    expect(aggregate.usage.total.value).toBe(135);
  });

  test("does not manufacture a cache share for a zero prompt denominator", () => {
    const aggregate = aggregateUsageRecords([usage("zero")]);
    expect(aggregate.usage.cacheReadBasis).toMatchObject({ value: null, status: "unavailable" });
  });

  test("keeps source charges separate from the API-equivalent zero for complete empty usage", () => {
    const aggregate = aggregateUsageRecords([
      usage("estimate", { costKind: "source-estimate", costMicrousd: 1_500_000 }),
      usage("provider", { costKind: "provider-reported", costMicrousd: 2_500_000 }),
      usage("unknown-cost"),
      usage("included", { costKind: "included", costMicrousd: null }),
    ]);

    expect(aggregate.cost).toEqual({
      apiEquivalentUsd: { value: 0, status: "recorded", reasons: [] },
      pricedRecords: 4,
      unpricedRecords: 0,
      pricedTokens: 0,
      unpricedTokens: 0,
      sourceEstimatedUsd: { value: 1.5, status: "partial", reasons: [] },
      providerReportedUsd: { value: 2.5, status: "partial", reasons: [] },
      unknownRecords: 1,
      includedRecords: 1,
    });
    expect(aggregateUsageRecords([usage("only-unknown")]).cost.sourceEstimatedUsd.value).toBeNull();
    expect(aggregateUsageRecords([]).cost.apiEquivalentUsd).toMatchObject({ value: null, status: "unavailable" });
    expect(aggregateUsageRecords([], { status: "recorded", knownEmpty: true }).cost.apiEquivalentUsd)
      .toEqual({ value: 0, status: "recorded", reasons: [] });
  });
});

describe("zoned reporting boundaries", () => {
  test("generates 23 and 25 elapsed hours across New York DST dates", () => {
    const spring = buildHourlySlots("2026-03-08", "America/New_York", Date.parse("2026-03-09T04:00:00Z"));
    const fall = buildHourlySlots("2026-11-01", "America/New_York", Date.parse("2026-11-02T05:00:00Z"));

    expect(spring).toHaveLength(23);
    expect(spring.reduce((sum, slot) => sum + slot.elapsedMs, 0)).toBe(23 * 3_600_000);
    expect(spring.some((slot) => slot.localHour === 2)).toBe(false);
    expect(fall).toHaveLength(25);
    expect(fall.reduce((sum, slot) => sum + slot.elapsedMs, 0)).toBe(25 * 3_600_000);
    expect(fall.filter((slot) => slot.localHour === 1)).toHaveLength(2);
    expect(new Set(fall.filter((slot) => slot.localHour === 1).map((slot) => slot.start)).size).toBe(2);
  });

  test("splits midnight work, clips today at one cutoff, and supports weighted range ratios", () => {
    const store = temporaryStore();
    try {
      installCodexSource(store);
      const firstStart = Date.parse("2026-09-05T23:30:00Z");
      const secondEnd = Date.parse("2026-09-06T00:30:00Z");
      store.writeBatch({ workIntervals: [interval("cross-midnight", "codex", "lane", firstStart, secondEnd)] });
      const snapshot = buildPublicSnapshot(config(store.stateDir), store, Date.parse("2026-09-06T01:00:00Z"));
      const previous = snapshot.days.at(-2)!;
      const today = snapshot.days.at(-1)!;

      expect(previous.work.work.value?.activeMs).toBe(1_800_000);
      expect(today.work.work.value?.activeMs).toBe(1_800_000);
      expect(today.elapsedMs).toBe(3_600_000);
      expect(today.hours.at(-1)?.start).toBe("2026-09-06T00:00:00.000Z");
      const weighted = ((previous.work.work.value?.activeMs ?? 0) + (today.work.work.value?.activeMs ?? 0)) /
        (previous.elapsedMs + today.elapsedMs);
      const meanOfDailyRatios = (((previous.work.work.value?.activeMs ?? 0) / previous.elapsedMs) +
        ((today.work.work.value?.activeMs ?? 0) / today.elapsedMs)) / 2;
      expect(weighted).not.toBe(meanOfDailyRatios);
    } finally {
      store.close();
    }
  });
});

describe("public snapshot", () => {
  test("counts commit-active dates while retaining partial repository coverage", () => {
    const store = temporaryStore();
    try {
      installCodexSource(store);
      const collectedAtMs = Date.parse("2026-09-06T12:00:00Z");
      store.writeBatch({
        sources: [{
          sourceKey: "git:private-repository",
          agent: "git",
          kind: "git-repository",
          sourcePath: "/private/repository-sentinel",
          state: "partial",
          tokenQuality: "unavailable",
          workQuality: "unavailable",
          reasons: ["stale-ref"],
          lastSuccessfulScanMs: collectedAtMs,
        }],
        commits: [
          { repositoryKey: "private-repository-key", oid: "private-oid-one", committerMs: Date.parse("2026-09-05T10:00:00Z"), tipOid: "tip", collectedAtMs, shallow: false },
          { repositoryKey: "private-repository-key", oid: "private-oid-two", committerMs: Date.parse("2026-09-05T11:00:00Z"), tipOid: "tip", collectedAtMs, shallow: false },
        ],
      });
      const snapshot = buildPublicSnapshot(config(store.stateDir, "UTC", "Komodo"), store, collectedAtMs);
      const activeDays = snapshot.days.filter((day) => day.commits.value !== null && day.commits.value > 0);

      expect(snapshot.organization).toBe("Komodo");
      expect(activeDays).toHaveLength(1);
      expect(activeDays[0]?.commits).toEqual({ value: 2, status: "partial", reasons: ["stale-ref"] });
      expect(snapshot.days.at(-1)?.commits).toEqual({ value: 0, status: "partial", reasons: ["stale-ref"] });
    } finally {
      store.close();
    }
  });

  test("preserves record-level priced subsets through daily and model grouping independently of source charges", () => {
    const store = temporaryStore();
    try {
      installCodexSource(store);
      const records = [
        usage("priced-estimate", {
          provider: "anthropic", model: "claude-sonnet-5", uncachedInput: 1_000, output: 100, total: 1_100,
          costKind: "source-estimate", costMicrousd: 100_000_000,
        }),
        usage("priced-included", {
          provider: "anthropic", model: "claude-sonnet-5", uncachedInput: 500, cacheRead: 500, output: 100, total: 1_100,
          costKind: "included",
        }),
        usage("unpriced-model", { uncachedInput: 100, total: 100, costKind: "provider-reported", costMicrousd: 200_000_000 }),
        usage("incomplete", { provider: "anthropic", model: "claude-sonnet-5", uncachedInput: null, total: 50 }),
        usage("unknown-total", { uncachedInput: null, total: null }),
      ];
      store.writeBatch({ usage: records });
      const snapshot = buildPublicSnapshot(config(store.stateDir), store, Date.parse("2026-09-06T01:00:00Z"));
      const today = snapshot.days.at(-1)!;
      expect(today.cost).toMatchObject({
        apiEquivalentUsd: {
          status: "partial",
          reasons: ["incomplete-token-breakdown", "unpriced-model"],
        },
        pricedRecords: 2, unpricedRecords: 3, pricedTokens: 2_200, unpricedTokens: 150,
        sourceEstimatedUsd: { value: 100 },
        providerReportedUsd: { value: 200 },
      });
      expect(today.cost.apiEquivalentUsd.value).toBeCloseTo(0.0051, 12);
      expect(today.usageRows.reduce((sum, row) => sum + (row.cost.apiEquivalentUsd.value ?? 0), 0))
        .toBe(today.cost.apiEquivalentUsd.value!);
      for (const field of ["pricedRecords", "unpricedRecords", "pricedTokens", "unpricedTokens"] as const) {
        expect(today.usageRows.reduce((sum, row) => sum + row.cost[field], 0)).toBe(today.cost[field]);
      }
      const withoutCharges = aggregateUsageRecords(records.map((record) => ({
        ...record, costKind: "unknown" as const, costMicrousd: null,
      }))).cost;
      expect(withoutCharges.apiEquivalentUsd).toEqual(today.cost.apiEquivalentUsd);
      expect(withoutCharges.pricedTokens).toBe(today.cost.pricedTokens);
      expect(withoutCharges.unpricedTokens).toBe(today.cost.unpricedTokens);
    } finally {
      store.close();
    }
  });

  test("regroups sanitized label collisions and emits no private dimensions", () => {
    const store = temporaryStore();
    try {
      installCodexSource(store);
      store.writeBatch({
        sources: [{
          sourceKey: "codex:partial-private-source",
          agent: "codex",
          kind: "jsonl",
          sourcePath: "/private/second-source-sentinel",
          state: "partial",
          tokenQuality: "partial",
          workQuality: "partial",
          reasons: ["timing-unavailable", "parse-gap", "timing-unavailable", "raw-private-reason"],
        }],
        usage: [
          usage("unsafe-url", { provider: "https://private.example/provider", model: "<script>private</script>", total: 10 }),
          usage("unsafe-secret", { provider: "sk-private-provider", model: "github_pat_private", total: 20 }),
        ],
        collectionRuns: [{
          runKey: "run",
          startedAtMs: Date.parse("2026-09-06T00:00:00Z"),
          cutoffMs: Date.parse("2026-09-06T01:00:00Z"),
          completedAtMs: Date.parse("2026-09-06T01:00:00Z"),
          status: "completed",
          rebuild: false,
          diagnosticCounts: { "unallocated-history": 3, "duplicate-ambiguity": 2 },
        }],
      });
      const snapshot = buildPublicSnapshot(config(store.stateDir), store, Date.parse("2026-09-06T01:00:00Z"));
      expect(snapshot.days).toHaveLength(365);
      expect(snapshot.periodEnd).toBe("2026-09-06");
      const today = snapshot.days.at(-1)!;

      expect(today.usageRows).toHaveLength(1);
      expect(today.usageRows[0]).toMatchObject({ provider: "unknown", model: "unknown", usage: { total: { value: 30 } } });
      expect(snapshot.coverage).toEqual({
        unallocatedUsageRecords: 3,
        excludedAmbiguousRecords: 2,
        scopeStatus: "partial",
        undated: { byHarness: [] },
      });
      expect(publicSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(publicSnapshotSchema.safeParse({ ...snapshot, workspacePath: "/private/workspace-sentinel" }).success).toBe(false);
      expect(snapshot.sources.find((source) => source.agent === "codex")?.reasons).toEqual(["parse-gap", "timing-unavailable"]);
      const serialized = JSON.stringify(snapshot);
      for (const forbidden of [
        "/private/workspace-sentinel",
        "/private/repository-sentinel",
        "/private/source-path-sentinel",
        "/private/second-source-sentinel",
        "raw-private-reason",
        "private-session-sentinel",
        "private-request-sentinel",
        "private-oid-one",
        "https://private.example/provider",
        "sk-private-provider",
      ]) expect(serialized).not.toContain(forbidden);
      expect(serialized).not.toContain("workspaceKey");
      expect(serialized).not.toContain("repositoryKey");
      expect(serialized).not.toContain("sessionKey");
    } finally {
      store.close();
    }
  });

  test("conserves known tokens across scope decisions and separates unknown totals", () => {
    const store = temporaryStore();
    try {
      installCodexSource(store);
      const atMs = Date.parse("2026-09-06T00:30:00Z");
      store.writeBatch({
        usage: [usage("included", { atMs, total: 10 })],
        scopeEvidence: [
          {
            originKey: "included",
            sourceKey: "codex:synthetic-private-source",
            agent: "codex",
            sessionKey: "included-session",
            atMs,
            knownTotal: 10,
            decision: "included",
            reason: "configured-root",
            lastSeenMs: atMs,
          },
          {
            originKey: "excluded",
            sourceKey: "codex:synthetic-private-source",
            agent: "codex",
            sessionKey: "excluded-session",
            atMs,
            knownTotal: 20,
            decision: "out-of-scope",
            reason: "outside-configured-scope",
            lastSeenMs: atMs,
          },
          {
            originKey: "unattributed",
            sourceKey: "codex:synthetic-private-source",
            agent: "codex",
            sessionKey: "unknown-session",
            atMs,
            knownTotal: null,
            decision: "unattributed",
            reason: "attribution-unavailable",
            lastSeenMs: atMs,
          },
        ],
      });

      const snapshot = buildPublicSnapshot(config(store.stateDir), store, Date.parse("2026-09-06T01:00:00Z"));
      const scope = snapshot.days.at(-1)?.scope.byHarness[0];
      expect(scope).toEqual({
        harness: "codex",
        included: { records: 1, knownTokens: 10, unknownTotalRecords: 0 },
        outOfScope: { records: 1, knownTokens: 20, unknownTotalRecords: 0 },
        unattributed: { records: 1, knownTokens: 0, unknownTotalRecords: 1 },
      });
      expect(snapshot.days.at(-1)?.usage.total.value).toBe(10);
      expect(snapshot.coverage.scopeStatus).toBe("recorded");
    } finally {
      store.close();
    }
  });
});
