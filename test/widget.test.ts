import { describe, expect, test } from "bun:test";
import type { Agent, Metric, PublicCost, PublicDay, PublicSnapshot, PublicUsage, PublicWorkGroup, WorkStats } from "../src/contracts";
import {
  aggregateCost,
  aggregateResources,
  aggregateWork,
  buildRhythm,
  buildUsageSeries,
  isPublicSnapshot,
  inferenceStreaks,
  parseWidgetOptions,
  SUPPORTED_VIEWS,
} from "../web/widget";

function metric<T>(value: T | null, status: Metric<T>["status"] = value === null ? "unavailable" : "recorded"): Metric<T> {
  return { value, status, reasons: status === "recorded" ? [] : ["timing-unavailable"] };
}

function usage(total: number | null, values: Partial<Record<keyof PublicUsage, number>> = {}): PublicUsage {
  const counter = (key: "uncachedInput" | "cacheRead" | "cacheWrite" | "output" | "reasoning" | "otherRecorded") => metric(values[key] ?? (total === null ? null : 0));
  return {
    total: metric(total),
    uncachedInput: counter("uncachedInput"),
    cacheRead: counter("cacheRead"),
    cacheWrite: counter("cacheWrite"),
    output: counter("output"),
    reasoning: counter("reasoning"),
    otherRecorded: counter("otherRecorded"),
    cacheReadBasis: metric(total === null ? null : {
      readTokens: values.cacheRead ?? 0,
      promptTokens: (values.uncachedInput ?? 0) + (values.cacheRead ?? 0) + (values.cacheWrite ?? 0),
    }),
  };
}

function cost(source: number | null = null, provider: number | null = null, api: number | null = null, tokens = 0): PublicCost {
  return {
    apiEquivalentUsd: metric(api),
    pricedRecords: api === null ? 0 : 1,
    unpricedRecords: api === null ? 1 : 0,
    pricedTokens: api === null ? 0 : tokens,
    unpricedTokens: api === null ? tokens : 0,
    sourceEstimatedUsd: metric(source),
    providerReportedUsd: metric(provider),
    unknownRecords: source === null && provider === null ? 1 : 0,
    includedRecords: 0,
  };
}

function stats(activeMs: number, agentMs: number, parallelMs: number, histogram: Array<{ agents: number; elapsedMs: number }>, unavailableMs = 0, inferenceMs = activeMs): WorkStats {
  return { activeMs, inferenceMs, agentMs, parallelMs, histogram, unavailableMs };
}

function unavailableWork(): Metric<WorkStats> {
  return metric<WorkStats>(null);
}

function workGroup(company: Metric<WorkStats>, harness: Agent = "codex", harnessWork: Metric<WorkStats> = company): PublicWorkGroup {
  return { work: company, byHarness: [{ harness, work: harnessWork }] };
}

function day(date: string, rows: PublicDay["usageRows"], companyUsage: PublicUsage, work: PublicWorkGroup, commits: Metric<number> = metric(0), elapsedMs = 3_600_000): PublicDay {
  return {
    date,
    elapsedMs,
    usage: companyUsage,
    cost: cost(),
    usageRows: rows,
    work,
    hours: [],
    commits,
    scope: { byHarness: [] },
  };
}

function row(harness: Agent, provider: string, model: string, total: number, parts: Partial<Record<keyof PublicUsage, number>> = {}): PublicDay["usageRows"][number] {
  return { harness, provider, model, usage: usage(total, parts), cost: cost() };
}

describe("widget query contract", () => {
  test("accepts every exact supported view and fixed option value", () => {
    for (const view of SUPPORTED_VIEWS) {
      const parsed = parseWidgetOptions(new URLSearchParams(`view=${view}&range=365&theme=dark&harness=codex`), ["codex"]);
      expect(parsed).toEqual({ view, range: 365, theme: "dark", harness: "codex" });
    }
  });

  test("falls back invalid and disabled values to all/30/auto/all", () => {
    expect(parseWidgetOptions(new URLSearchParams("view=private&range=31&theme=sepia&harness=claude"), ["codex"]))
      .toEqual({ view: "all", range: 30, theme: "auto", harness: "all" });
    expect(parseWidgetOptions(new URLSearchParams("view=ALL&range=07&theme=Auto&harness=Codex"), ["codex"]))
      .toEqual({ view: "all", range: 30, theme: "auto", harness: "all" });
  });
});

describe("widget aggregates", () => {
  test("filters API estimates and coverage without substituting source charges", () => {
    const priced = row("codex", "openai", "known", 100);
    priced.cost = cost(90, 80, 0.25, 100);
    const unpriced = row("claude", "anthropic", "unknown", 300);
    unpriced.cost = cost(40, 30, null, 300);
    unpriced.cost.apiEquivalentUsd.reasons = ["unpriced-model"];
    const first = day("2026-09-05", [priced, unpriced], usage(400), workGroup(unavailableWork()));
    first.cost = aggregateCost([priced.cost, unpriced.cost]);
    const second = day("2026-09-06", [priced], usage(100), workGroup(unavailableWork()));
    second.cost = priced.cost;
    const days = [first, second];
    expect(aggregateResources(days, "all").cost).toMatchObject({
      apiEquivalentUsd: { value: 0.5, status: "partial", reasons: ["unpriced-model"] },
      pricedRecords: 2, unpricedRecords: 1, pricedTokens: 200, unpricedTokens: 300,
      sourceEstimatedUsd: { value: 220 }, providerReportedUsd: { value: 190 },
    });
    expect(aggregateResources([first], "all").cost.apiEquivalentUsd.value).toBe(0.25);
    expect(aggregateResources(days, "codex").cost).toMatchObject({
      apiEquivalentUsd: { value: 0.5, status: "recorded" }, pricedRecords: 2, unpricedRecords: 0,
    });
    expect(aggregateResources(days, "all", { provider: "anthropic", model: "unknown" }).cost).toMatchObject({
      apiEquivalentUsd: { value: null }, pricedRecords: 0, unpricedRecords: 1, unpricedTokens: 300,
    });
    expect(aggregateCost([cost(null, null, 0)]).apiEquivalentUsd.value).toBe(0);
    expect(aggregateCost([]).apiEquivalentUsd.value).toBeNull();
  });

  test("does not publish unsafe aggregate cost amounts or coverage", () => {
    expect(aggregateCost([cost(null, null, Number.MAX_SAFE_INTEGER), cost(null, null, 1)]).apiEquivalentUsd)
      .toEqual({ value: null, status: "partial", reasons: ["parse-gap"] });
    const unsafe = cost(null, null, 1);
    unsafe.pricedTokens = Number.MAX_SAFE_INTEGER;
    expect(() => aggregateCost([unsafe, cost(null, null, 1, 1)])).toThrow(RangeError);
  });

  test("uses paired prompt populations rather than averaging shares", () => {
    const noWork = workGroup(unavailableWork());
    const first = row("codex", "openai", "a", 100, { uncachedInput: 20, cacheRead: 80 });
    const second = row("codex", "openai", "a", 900, { uncachedInput: 810, cacheRead: 90 });
    const days = [day("2026-09-05", [first], first.usage, noWork), day("2026-09-06", [second], second.usage, noWork)];
    const result = aggregateResources(days, "all");
    expect(result.usage.cacheReadBasis.value).toEqual({ readTokens: 170, promptTokens: 1_000 });
    expect(result.usage.total.value).toBe(1_000);
  });

  test("keeps company overlap independent from harness work and preserves unavailable time", () => {
    const first = aggregateWork([
      { elapsedMs: 3_600_000, work: metric(stats(900_000, 1_200_000, 300_000, [
        { agents: 0, elapsedMs: 2_700_000 },
        { agents: 1, elapsedMs: 600_000 },
        { agents: 2, elapsedMs: 300_000 },
      ])) },
      { elapsedMs: 3_600_000, work: unavailableWork() },
    ]);
    expect(first.value).toEqual(stats(900_000, 1_200_000, 300_000, [
      { agents: 0, elapsedMs: 2_700_000 },
      { agents: 1, elapsedMs: 600_000 },
      { agents: 2, elapsedMs: 300_000 },
    ], 3_600_000));
    expect(first.status).toBe("partial");
  });
  test("finds consecutive inference hours and local active days", () => {
    const inferenceHour = (inferenceMs: number | null, start: string): PublicDay["hours"][number] => ({
      start,
      elapsedMs: 3_600_000,
      work: inferenceMs === null
        ? workGroup(unavailableWork())
        : workGroup(metric(stats(1, 1, 0, [{ agents: 0, elapsedMs: 3_599_999 }, { agents: 1, elapsedMs: 1 }], 0, inferenceMs))),
    });
    const noUsage = usage(0);
    const first = day("2026-09-04", [], noUsage, workGroup(unavailableWork()));
    first.hours = [
      inferenceHour(1, "2026-09-04T00:00:00.000Z"),
      inferenceHour(1, "2026-09-04T01:00:00.000Z"),
      inferenceHour(0, "2026-09-04T02:00:00.000Z"),
    ];
    const second = day("2026-09-05", [], noUsage, workGroup(unavailableWork()));
    second.hours = [
      inferenceHour(1, "2026-09-05T00:00:00.000Z"),
      inferenceHour(1, "2026-09-05T01:00:00.000Z"),
      inferenceHour(null, "2026-09-05T02:00:00.000Z"),
    ];
    const third = day("2026-09-06", [], noUsage, workGroup(unavailableWork()));
    third.hours = [inferenceHour(0, "2026-09-06T00:00:00.000Z")];

    expect(inferenceStreaks([first, second, third], "all")).toEqual({ hourly: 2, daily: 2 });
  });


  test("selects six leading models, keeps unknown separate, and rolls the remainder into Other", () => {
    const rows = [
      row("codex", "p", "m1", 80), row("codex", "p", "m2", 70), row("codex", "p", "m3", 60),
      row("codex", "p", "m4", 50), row("codex", "p", "m5", 40), row("codex", "p", "m6", 30),
      row("codex", "p", "m7", 20), row("codex", "p", "unknown", 10),
    ];
    const series = buildUsageSeries([day("2026-09-06", rows, usage(360), workGroup(unavailableWork()))], "all", "model");
    expect(series.keys).toEqual(["p · m1", "p · m2", "p · m3", "p · m4", "p · m5", "p · m6", "Other", "p · unknown"]);
    expect(series.values[0]?.values.Other).toBe(20);
    expect(series.values[0]?.fullTotal).toBe(360);
  });

  test("keeps explicit missing token observations as chart gaps rather than zero", () => {
    const missing = row("codex", "p", "unknown", 0);
    missing.usage = usage(null);
    const known = row("codex", "p", "known", 12);
    const days = [
      day("2026-09-05", [known, missing], usage(12), workGroup(unavailableWork())),
      day("2026-09-06", [], usage(null), workGroup(unavailableWork())),
    ];
    const series = buildUsageSeries(days, "all", "model");
    expect(series.keys).toContain("p · unknown");
    expect(series.values[0]?.values).toEqual({ "p · known": 12, "p · unknown": null });
    expect(series.values[1]?.values).toEqual({ "p · known": null, "p · unknown": null });
    expect(series.values[1]?.fullTotal).toBeNull();
  });

  test("combines both repeated fall-back local hours into one rhythm cell", () => {
    const measured = workGroup(metric(stats(3_600_000, 3_600_000, 0, [{ agents: 1, elapsedMs: 3_600_000 }])));
    const fixture = day("2026-11-01", [], usage(0), measured, metric(0), 90_000_000);
    fixture.hours = [
      { start: "2026-11-01T05:00:00.000Z", elapsedMs: 3_600_000, work: measured },
      { start: "2026-11-01T06:00:00.000Z", elapsedMs: 3_600_000, work: measured },
    ];
    const cell = buildRhythm([fixture], "all", "America/New_York").find((candidate) => candidate.weekday === 0 && candidate.hour === 1);
    expect(cell).toMatchObject({ elapsedMs: 7_200_000, activeMs: 7_200_000, agentMs: 7_200_000, available: true });
  });
});

describe("public DOM safety boundary", () => {
  test("strictly rejects unknown nested keys", () => {
    const unavailable = workGroup(unavailableWork());
    const fixture: PublicSnapshot = {
      schemaVersion: 3,
      pricing: { asOf: "2026-09-06", basis: "standard-api", sources: ["https://openai.com/api/pricing/"] },
      organization: "Komodo Risk Inc",
      timezone: "UTC",
      generatedAt: "2026-09-06T12:00:00.000Z",
      cutoff: "2026-09-06T12:00:00.000Z",
      periodStart: "2026-09-06",
      periodEnd: "2026-09-06",
      collectionStatus: "ok",
      sources: [],
      coverage: {
        unallocatedUsageRecords: 0,
        excludedAmbiguousRecords: 0,
        scopeStatus: "recorded",
        undated: { byHarness: [] },
      },
      days: [day("2026-09-06", [], usage(0), unavailable)],
    };
    expect(isPublicSnapshot(fixture)).toBe(true);
    expect(isPublicSnapshot({ ...fixture, organization: "Komodo" })).toBe(true);
    expect(isPublicSnapshot({ ...fixture, organization: " " })).toBe(false);
    expect(isPublicSnapshot({ ...fixture, schemaVersion: 1 })).toBe(false);
    expect(isPublicSnapshot({ ...fixture, pricing: undefined })).toBe(false);
    expect(isPublicSnapshot({ ...fixture, pricing: { ...fixture.pricing, asOf: "2026-02-30" } })).toBe(false);
    for (const source of ["javascript:alert(1)", "http://example.com", "https://user:password@example.com"]) {
      expect(isPublicSnapshot({ ...fixture, pricing: { ...fixture.pricing, sources: [source] } })).toBe(false);
    }
    const missingCost = structuredClone(fixture);
    delete (missingCost.days[0]!.cost as Partial<PublicCost>).pricedTokens;
    expect(isPublicSnapshot(missingCost)).toBe(false);
    const unsafe = structuredClone(fixture) as PublicSnapshot & { days: Array<PublicDay & { repository: string }> };
    unsafe.days[0]!.repository = "/private/repository";
    expect(isPublicSnapshot(unsafe)).toBe(false);
  });

});
