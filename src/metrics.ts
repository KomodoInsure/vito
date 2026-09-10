import { Temporal } from "@js-temporal/polyfill";

import { type Config } from "./config";
import {
  AGENTS,
  PUBLIC_REASON_CODES,
  publicSnapshotSchema,
  sanitizePublicLabel,
  type Agent,
  type InputCadenceCoverage,
  type InputCadenceStats,
  type InputOrigin,
  type Metric,
  type PublicCost,
  type PublicDay,
  type PublicInputGroup,
  type PublicInputRange,
  type PublicReasonCode,
  type PublicSnapshot,
  type PublicScopeCoverage,
  type PublicUsage,
  type PublicWorkGroup,
  type Quality,
  type UsageRecord,
  type WorkInterval,
  type WorkStats,
} from "./contracts";
import { PRICING_METADATA, priceUsage } from "./pricing";
import { type CollectorStore } from "./store";

const HOUR_MS = 3_600_000;
const TOKEN_IRRELEVANT_REASONS: readonly string[] = ["timing-unavailable", "open-interval", "stale-ref"];
const WORK_IRRELEVANT_REASONS: readonly string[] = [
  "unknown-model",
  "unallocated-history",
  "counter-discontinuity",
  "duplicate-ambiguity",
  "upstream-owned",
  "stale-ref",
];
export interface HourlySlot {
  startMs: number;
  endMs: number;
  start: string;
  elapsedMs: number;
  weekday: number;
  localHour: number;
}

export interface AggregationEvidence {
  status: Quality;
  reasons?: readonly string[];
  /** An empty input is a known zero rather than a lack of observations. */
  knownEmpty?: boolean;
}

export interface UsageAggregate {
  usage: PublicUsage;
  cost: PublicCost;
}

interface SourceRow {
  agent: string;
  kind: string;
  state: PublicSnapshot["sources"][number]["state"];
  token_quality: Quality;
  work_quality: Quality;
  reasons_json: string;
  last_successful_scan_ms: number | null;
}

interface UsageRow {
  origin_key: string;
  agent: Agent;
  session_key: string;
  workspace_key: string;
  repository_key: string | null;
  turn_key: string | null;
  request_key: string | null;
  at_ms: number | null;
  provider: string;
  model: string;
  uncached_input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
  cost_microusd: number | null;
  cost_kind: UsageRecord["costKind"];
  quality: Quality;
  reasons_json: string;
}

interface WorkRow {
  origin_key: string;
  agent: Agent;
  session_key: string;
  workspace_key: string;
  repository_key: string | null;
  provider: string | null;
  model: string | null;
  start_ms: number;
  end_ms: number;
  kind: WorkInterval["kind"];
}

interface InputRow {
  origin_key: string;
  source_key: string;
  agent: Agent;
  session_key: string;
  at_ms: number | null;
  kind: "submission" | "context" | "replay" | "unknown";
  lane: "main" | "subagent" | "unknown";
  origin: InputOrigin;
  origin_evidence: "source" | "provenance" | "none" | "conflict";
  quality: Quality;
  reasons_json: string;
  scope_decision: "included" | "out-of-scope" | "unattributed";
}

interface InputSourceStateRow {
  source_key: string;
  agent: Agent;
  parser_version: number;
  quality: Quality;
  reasons_json: string;
  last_successful_scan_ms: number | null;
}

interface ScopeEvidenceRow {
  origin_key: string;
  agent: Agent;
  session_key: string;
  workspace_key: string | null;
  repository_key: string | null;
  at_ms: number | null;
  provider: string | null;
  known_total: number | null;
  decision: "included" | "out-of-scope" | "unattributed";
  reason: string;
  last_seen_ms: number;
}

interface CommitRow {
  repository_key: string;
  oid: string;
  committer_ms: number;
  shallow: number;
}

interface CollectionRunRow {
  status: "completed" | "partial";
  diagnostic_counts_json: string;
}

interface SourceEvidence {
  status: Quality;
  reasons: PublicReasonCode[];
}

function fixedReasons(...collections: ReadonlyArray<readonly string[] | undefined>): PublicReasonCode[] {
  const values = new Set<PublicReasonCode>();
  for (const collection of collections) {
    for (const reason of collection ?? []) {
      if ((PUBLIC_REASON_CODES as readonly string[]).includes(reason)) values.add(reason as PublicReasonCode);
    }
  }
  return [...values].sort();
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return ["parse-gap"];
  }
}

function parseCounts(value: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, count] of Object.entries(parsed)) {
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) result[key] = count;
    }
    return result;
  } catch {
    return {};
  }
}

function combineQualities(qualities: readonly Quality[]): Quality {
  if (qualities.length === 0 || qualities.every((quality) => quality === "unavailable")) return "unavailable";
  if (qualities.every((quality) => quality === "recorded")) return "recorded";
  return "partial";
}

function degradeQuality(left: Quality, right: Quality): Quality {
  if (left === right) return left;
  return "partial";
}

function finiteSafeSum(values: readonly number[]): number | null {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum) || sum < 0) return null;
  }
  return sum;
}

function metric<T>(value: T | null, status: Quality, reasons: readonly string[] = []): Metric<T> {
  return { value, status: value === null && status === "recorded" ? "unavailable" : status, reasons: fixedReasons(reasons) };
}

function evidenceForSources(rows: readonly SourceRow[], dimension: "tokens" | "work"): SourceEvidence {
  if (rows.length === 0) return { status: "unavailable", reasons: ["missing-source"] };
  const qualities = rows.map((row) => dimension === "tokens" ? row.token_quality : row.work_quality);
  const excluded = dimension === "tokens" ? TOKEN_IRRELEVANT_REASONS : WORK_IRRELEVANT_REASONS;
  const reasons = rows.flatMap((row) => parseStringArray(row.reasons_json)).filter((reason) => !excluded.includes(reason));
  return {
    status: combineQualities(qualities),
    reasons: fixedReasons(reasons),
  };
}

function publicUsageRecord(row: UsageRow): UsageRecord {
  return {
    originKey: row.origin_key,
    agent: row.agent,
    sessionKey: row.session_key,
    workspaceKey: row.workspace_key,
    repositoryKey: row.repository_key,
    turnKey: row.turn_key,
    requestKey: row.request_key,
    atMs: row.at_ms,
    provider: row.provider,
    model: row.model,
    uncachedInput: row.uncached_input,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    output: row.output,
    reasoning: row.reasoning,
    total: row.total,
    costMicrousd: row.cost_microusd,
    costKind: row.cost_kind,
    quality: row.quality,
    reasons: parseStringArray(row.reasons_json),
  };
}

function publicWorkInterval(row: WorkRow): WorkInterval {
  return {
    originKey: row.origin_key,
    agent: row.agent,
    sessionKey: row.session_key,
    workspaceKey: row.workspace_key,
    repositoryKey: row.repository_key,
    provider: row.provider,
    model: row.model,
    startMs: row.start_ms,
    endMs: row.end_ms,
    kind: row.kind,
  };
}

function dateAt(epochMs: number, timezone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timezone).toPlainDate().toString();
}

function scopeCoverage(rows: readonly ScopeEvidenceRow[]): PublicScopeCoverage {
  const byHarness: PublicScopeCoverage["byHarness"] = [];
  for (const harness of AGENTS) {
    const harnessRows = rows.filter((row) => row.agent === harness);
    if (harnessRows.length === 0) continue;
    const count = (decision: ScopeEvidenceRow["decision"]) => {
      const selected = harnessRows.filter((row) => row.decision === decision);
      return {
        records: selected.length,
        knownTokens: selected.reduce((sum, row) => sum + (row.known_total ?? 0), 0),
        unknownTotalRecords: selected.filter((row) => row.known_total === null).length,
      };
    };
    byHarness.push({
      harness,
      included: count("included"),
      outOfScope: count("out-of-scope"),
      unattributed: count("unattributed"),
    });
  }
  return { byHarness };
}


/** Generate elapsed-hour slots between a local midnight and the next local midnight, clipped at cutoff. */
export function buildHourlySlots(date: string, timezone: string, cutoffMs: number): HourlySlot[] {
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new TypeError("cutoffMs must be a nonnegative safe integer");
  const plainDate = Temporal.PlainDate.from(date);
  const startMs = plainDate.toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from("00:00") }).epochMilliseconds;
  const nextMs = plainDate.add({ days: 1 }).toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from("00:00") }).epochMilliseconds;
  const endMs = Math.min(nextMs, cutoffMs);
  const slots: HourlySlot[] = [];
  for (let slotStart = startMs; slotStart < endMs; slotStart += HOUR_MS) {
    const slotEnd = Math.min(slotStart + HOUR_MS, endMs);
    const zoned = Temporal.Instant.fromEpochMilliseconds(slotStart).toZonedDateTimeISO(timezone);
    slots.push({
      startMs: slotStart,
      endMs: slotEnd,
      start: new Date(slotStart).toISOString(),
      elapsedMs: slotEnd - slotStart,
      weekday: zoned.dayOfWeek,
      localHour: zoned.hour,
    });
  }
  return slots;
}

function recordReasons(records: readonly UsageRecord[]): PublicReasonCode[] {
  return fixedReasons(...records.map((record) => record.reasons));
}

function numericUsageMetric(
  records: readonly UsageRecord[],
  select: (record: UsageRecord) => number | null,
  evidence: AggregationEvidence,
): Metric<number> {
  if (records.length === 0) {
    return evidence.knownEmpty
      ? metric(0, evidence.status, evidence.reasons)
      : metric<number>(null, "unavailable", evidence.reasons);
  }
  const known = records.map(select).filter((value): value is number => value !== null);
  if (known.length === 0) return metric<number>(null, "unavailable", fixedReasons(evidence.reasons, recordReasons(records), ["parse-gap"]));
  const value = finiteSafeSum(known);
  const complete = known.length === records.length && value !== null;
  const recordQuality = combineQualities(records.map((record) => record.quality));
  const status = complete ? degradeQuality(evidence.status, recordQuality) : "partial";
  return metric(value, status, fixedReasons(evidence.reasons, recordReasons(records), complete ? [] : ["parse-gap"]));
}

/** Aggregate canonical observations without adding reasoning or cache subsets twice. */
export function aggregateUsageRecords(
  records: readonly UsageRecord[],
  evidence: AggregationEvidence = { status: records.length > 0 ? "recorded" : "unavailable" },
): UsageAggregate {
  const total = numericUsageMetric(records, (record) => record.total, evidence);
  const uncachedInput = numericUsageMetric(records, (record) => record.uncachedInput, evidence);
  const cacheRead = numericUsageMetric(records, (record) => record.cacheRead, evidence);
  const cacheWrite = numericUsageMetric(records, (record) => record.cacheWrite, evidence);
  const output = numericUsageMetric(records, (record) => record.output, evidence);
  const reasoning = numericUsageMetric(records, (record) => record.reasoning, evidence);

  const completeBreakdowns = records.filter((record) =>
    record.total !== null && record.uncachedInput !== null && record.cacheRead !== null &&
    record.cacheWrite !== null && record.output !== null,
  );
  let invalidResidual = false;
  const residuals: number[] = [];
  for (const record of completeBreakdowns) {
    const componentSum = record.uncachedInput! + record.cacheRead! + record.cacheWrite! + record.output!;
    const residual = record.total! - componentSum;
    if (!Number.isSafeInteger(componentSum) || residual < 0 || !Number.isSafeInteger(residual)) invalidResidual = true;
    else residuals.push(residual);
  }
  const residualSum = finiteSafeSum(residuals);
  const residualComplete = completeBreakdowns.length === records.length && !invalidResidual && residualSum !== null;
  const otherRecorded = records.length === 0
    ? evidence.knownEmpty ? metric(0, evidence.status, evidence.reasons) : metric<number>(null, "unavailable", evidence.reasons)
    : residuals.length === 0
      ? metric<number>(null, "unavailable", fixedReasons(evidence.reasons, recordReasons(records), ["parse-gap"]))
      : metric(residualSum, residualComplete ? degradeQuality(evidence.status, combineQualities(records.map((record) => record.quality))) : "partial",
        fixedReasons(evidence.reasons, recordReasons(records), residualComplete ? [] : ["parse-gap"]));

  const eligiblePrompt = records.filter((record) =>
    record.uncachedInput !== null && record.cacheRead !== null && record.cacheWrite !== null,
  );
  const readTokens = finiteSafeSum(eligiblePrompt.map((record) => record.cacheRead!));
  const promptTokens = finiteSafeSum(eligiblePrompt.map((record) => record.uncachedInput! + record.cacheRead! + record.cacheWrite!));
  const basisComplete = eligiblePrompt.length === records.length && readTokens !== null && promptTokens !== null;
  const cacheBasisReasons = fixedReasons(
    evidence.reasons,
    recordReasons(records),
    eligiblePrompt.length < records.length ? ["parse-gap"] : [],
  );
  const cacheReadBasis = eligiblePrompt.length === 0 || readTokens === null || promptTokens === null || promptTokens === 0
    ? metric<{ readTokens: number; promptTokens: number }>(null, "unavailable", cacheBasisReasons)
    : metric({ readTokens, promptTokens }, basisComplete ? degradeQuality(evidence.status, combineQualities(records.map((record) => record.quality))) : "partial",
      cacheBasisReasons);

  let apiUsd: number | null = 0;
  let pricedRecords = 0;
  let unpricedRecords = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  const pricingReasons: string[] = [];
  for (const record of records) {
    const price = priceUsage(record);
    if (price.reason !== null) pricingReasons.push(price.reason);
    const tokens = record.total !== null && Number.isSafeInteger(record.total) && record.total >= 0 ? record.total : 0;
    if (price.usd === null) {
      unpricedRecords += 1;
      unpricedTokens += tokens;
    } else {
      pricedRecords += 1;
      pricedTokens += tokens;
      if (apiUsd !== null) {
        const sum: number = apiUsd + price.usd;
        if (!Number.isFinite(sum) || sum < 0 || sum > Number.MAX_SAFE_INTEGER) {
          apiUsd = null;
          pricingReasons.push("parse-gap");
        } else {
          apiUsd = sum;
        }
      }
    }
    if (!Number.isSafeInteger(pricedTokens) || !Number.isSafeInteger(unpricedTokens) ||
      !Number.isSafeInteger(pricedTokens + unpricedTokens)) {
      throw new RangeError("Pricing token coverage exceeds the safe integer range");
    }
  }
  const apiReasons = fixedReasons(evidence.reasons, recordReasons(records), pricingReasons);
  const apiEquivalentUsd = records.length === 0
    ? evidence.knownEmpty ? metric(0, evidence.status, apiReasons) : metric<number>(null, "unavailable", apiReasons)
    : pricedRecords === 0
      ? metric<number>(null, "unavailable", apiReasons)
      : metric(apiUsd, unpricedRecords > 0 || apiUsd === null ? "partial"
        : degradeQuality(evidence.status, combineQualities(records.map((record) => record.quality))), apiReasons);

  const sourceAmounts = records.filter((record) => record.costKind === "source-estimate" && record.costMicrousd !== null);
  const providerAmounts = records.filter((record) => record.costKind === "provider-reported" && record.costMicrousd !== null);
  const unknownRecords = records.filter((record) => record.costKind === "unknown" ||
    (record.costKind !== "included" && record.costMicrousd === null)).length;
  const includedRecords = records.filter((record) => record.costKind === "included").length;

  function costMetric(selected: readonly UsageRecord[]): Metric<number> {
    if (selected.length === 0) return metric<number>(null, "unavailable", fixedReasons(evidence.reasons, recordReasons(records)));
    const microusd = finiteSafeSum(selected.map((record) => record.costMicrousd!));
    const incomplete = unknownRecords > 0 || microusd === null;
    return metric(microusd === null ? null : microusd / 1_000_000,
      incomplete ? "partial" : degradeQuality(evidence.status, combineQualities(selected.map((record) => record.quality))),
      fixedReasons(evidence.reasons, recordReasons(records), microusd === null ? ["parse-gap"] : []));
  }

  return {
    usage: { total, uncachedInput, cacheRead, cacheWrite, output, reasoning, otherRecorded, cacheReadBasis },
    cost: {
      apiEquivalentUsd, pricedRecords, unpricedRecords, pricedTokens, unpricedTokens,
      sourceEstimatedUsd: costMetric(sourceAmounts), providerReportedUsd: costMetric(providerAmounts), unknownRecords, includedRecords,
    },
  };
}


type WorkLanes = Map<string, Array<[number, number]>>;

function addLaneRange(lanes: WorkLanes, key: string, startMs: number, endMs: number): void {
  const lane = lanes.get(key) ?? [];
  lane.push([startMs, endMs]);
  lanes.set(key, lane);
}

function laneEvents(lanes: WorkLanes): Map<number, number> {
  const events = new Map<number, number>();
  for (const ranges of lanes.values()) {
    ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    let mergedStart = ranges[0]?.[0];
    let mergedEnd = ranges[0]?.[1];
    if (mergedStart === undefined || mergedEnd === undefined) continue;
    for (let index = 1; index < ranges.length; index += 1) {
      const [nextStart, nextEnd] = ranges[index]!;
      if (nextStart <= mergedEnd) mergedEnd = Math.max(mergedEnd, nextEnd);
      else {
        events.set(mergedStart, (events.get(mergedStart) ?? 0) + 1);
        events.set(mergedEnd, (events.get(mergedEnd) ?? 0) - 1);
        mergedStart = nextStart;
        mergedEnd = nextEnd;
      }
    }
    events.set(mergedStart, (events.get(mergedStart) ?? 0) + 1);
    events.set(mergedEnd, (events.get(mergedEnd) ?? 0) - 1);
  }
  return events;
}

function activeDuration(events: ReadonlyMap<number, number>, startMs: number, endMs: number): number {
  let activeMs = 0;
  let concurrency = 0;
  let cursor = startMs;
  for (const at of [...events.keys()].sort((left, right) => left - right)) {
    if (concurrency > 0) activeMs += at - cursor;
    concurrency += events.get(at)!;
    cursor = at;
  }
  if (concurrency > 0) activeMs += endMs - cursor;
  return activeMs;
}

/** Union intervals within each agent/session lane, then sweep the independent lanes. */
export function aggregateWorkIntervals(
  intervals: readonly WorkInterval[],
  startMs: number,
  endMs: number,
  evidence: AggregationEvidence = { status: intervals.length > 0 ? "recorded" : "unavailable" },
): Metric<WorkStats> {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) {
    throw new TypeError("Work aggregation requires an ordered safe-integer window");
  }
  const lanes: WorkLanes = new Map();
  const inferenceLanes: WorkLanes = new Map();
  for (const interval of intervals) {
    const start = Math.max(startMs, interval.startMs);
    const end = Math.min(endMs, interval.endMs);
    if (end <= start) continue;
    const key = `${interval.agent}\u0000${interval.sessionKey}`;
    addLaneRange(lanes, key, start, end);
    if (interval.kind === "inference") addLaneRange(inferenceLanes, key, start, end);
  }

  if (lanes.size === 0 && !evidence.knownEmpty) {
    return metric<WorkStats>(null, "unavailable", fixedReasons(evidence.reasons, ["timing-unavailable"]));
  }

  const events = laneEvents(lanes);
  const inferenceMs = activeDuration(laneEvents(inferenceLanes), startMs, endMs);

  const histogram = new Map<number, number>();
  let activeMs = 0;
  let agentMs = 0;
  let parallelMs = 0;
  let concurrency = 0;
  let cursor = startMs;
  for (const at of [...events.keys()].sort((left, right) => left - right)) {
    const elapsed = at - cursor;
    if (elapsed > 0) {
      histogram.set(concurrency, (histogram.get(concurrency) ?? 0) + elapsed);
      if (concurrency > 0) activeMs += elapsed;
      agentMs += concurrency * elapsed;
      if (concurrency >= 2) parallelMs += elapsed;
    }
    concurrency += events.get(at)!;
    cursor = at;
  }
  if (cursor < endMs) histogram.set(concurrency, (histogram.get(concurrency) ?? 0) + endMs - cursor);

  const stats: WorkStats = {
    activeMs,
    inferenceMs,
    agentMs,
    parallelMs,
    histogram: [...histogram.entries()]
      .filter(([, elapsedMs]) => elapsedMs > 0)
      .sort(([left], [right]) => left - right)
      .map(([agents, elapsedMs]) => ({ agents, elapsedMs })),
    unavailableMs: 0,
  };
  const status = evidence.status === "unavailable" ? "partial" : evidence.status;
  return metric(stats, status, fixedReasons(evidence.reasons));
}

function combineWorkMetrics(entries: ReadonlyArray<{ elapsedMs: number; metric: Metric<WorkStats> }>): Metric<WorkStats> {
  const known = entries.filter((entry) => entry.metric.value !== null);
  if (known.length === 0) {
    return metric<WorkStats>(null, "unavailable", fixedReasons(...entries.map((entry) => entry.metric.reasons)));
  }
  const histogram = new Map<number, number>();
  let activeMs = 0;
  let inferenceMs = 0;
  let agentMs = 0;
  let parallelMs = 0;
  let unavailableMs = 0;
  for (const entry of entries) {
    const value = entry.metric.value;
    if (value === null) {
      unavailableMs += entry.elapsedMs;
      continue;
    }
    activeMs += value.activeMs;
    inferenceMs += value.inferenceMs;
    agentMs += value.agentMs;
    parallelMs += value.parallelMs;
    unavailableMs += value.unavailableMs;
    for (const bin of value.histogram) histogram.set(bin.agents, (histogram.get(bin.agents) ?? 0) + bin.elapsedMs);
  }
  const partial = unavailableMs > 0 || known.some((entry) => entry.metric.status !== "recorded");
  return metric({
    activeMs,
    inferenceMs,
    agentMs,
    parallelMs,
    histogram: [...histogram.entries()].filter(([, elapsedMs]) => elapsedMs > 0)
      .sort(([left], [right]) => left - right).map(([agents, elapsedMs]) => ({ agents, elapsedMs })),
    unavailableMs,
  }, partial ? "partial" : "recorded", fixedReasons(...entries.map((entry) => entry.metric.reasons)));
}

function sourcePublicRows(rows: readonly SourceRow[]): PublicSnapshot["sources"] {
  const groups = new Map<string, SourceRow[]>();
  for (const row of rows) {
    const safeAgent = /^[A-Za-z0-9._-]{1,64}$/.test(row.agent) ? row.agent : "unknown";
    const group = groups.get(safeAgent) ?? [];
    group.push(row);
    groups.set(safeAgent, group);
  }
  return [...groups.entries()].map(([agent, group]) => {
    const states = group.map((row) => row.state);
    let state: PublicSnapshot["sources"][number]["state"];
    if (states.every((value) => value === states[0])) state = states[0]!;
    else if (states.includes("available") || states.includes("partial")) state = "partial";
    else if (states.includes("unsupported-schema")) state = "unsupported-schema";
    else state = states[0]!;
    return {
      agent,
      state,
      tokens: combineQualities(group.map((row) => row.token_quality)),
      work: combineQualities(group.map((row) => row.work_quality)),
      reasons: fixedReasons(...group.map((row) => parseStringArray(row.reasons_json))),
    };
  }).sort((left, right) => left.agent.localeCompare(right.agent));
}

function enabledAgents(config: Config): Agent[] {
  return AGENTS.filter((agent) => config.sources[agent] === undefined || config.sources[agent]!.length > 0);
}

function aggregateSourceEvidence(
  sourceRows: readonly SourceRow[],
  agents: readonly Agent[],
  dimension: "tokens" | "work",
): SourceEvidence {
  const perAgent = agents.map((agent) => evidenceForSources(sourceRows.filter((row) => row.agent === agent), dimension));
  return {
    status: combineQualities(perAgent.map((entry) => entry.status)),
    reasons: fixedReasons(...perAgent.map((entry) => entry.reasons)),
  };
}

function workGroupForSlot(
  intervals: readonly WorkInterval[],
  startMs: number,
  endMs: number,
  agents: readonly Agent[],
  companyEvidence: SourceEvidence,
  harnessEvidence: ReadonlyMap<Agent, SourceEvidence>,
): PublicWorkGroup {
  const companyIntervals = intervals.filter((interval) => interval.endMs > startMs && interval.startMs < endMs);
  const work = aggregateWorkIntervals(companyIntervals, startMs, endMs, {
    status: companyEvidence.status,
    reasons: companyEvidence.reasons,
  });
  const byHarness = agents.map((harness) => {
    const selected = companyIntervals.filter((interval) => interval.agent === harness);
    const evidence = harnessEvidence.get(harness)!;
    return {
      harness,
      work: aggregateWorkIntervals(selected, startMs, endMs, { status: evidence.status, reasons: evidence.reasons }),
    };
  });
  return { work, byHarness };
}

function combineWorkGroups(hours: ReadonlyArray<PublicDay["hours"][number]>, agents: readonly Agent[]): PublicWorkGroup {
  return {
    work: combineWorkMetrics(hours.map((hour) => ({ elapsedMs: hour.elapsedMs, metric: hour.work.work }))),
    byHarness: agents.map((harness) => ({
      harness,
      work: combineWorkMetrics(hours.map((hour) => ({
        elapsedMs: hour.elapsedMs,
        metric: hour.work.byHarness.find((entry) => entry.harness === harness)!.work,
      }))),
    })),
  };
}

function usageRowsForDay(records: readonly UsageRecord[], evidenceByAgent: ReadonlyMap<Agent, SourceEvidence>): PublicDay["usageRows"] {
  const grouped = new Map<string, { harness: Agent; provider: string; model: string; records: UsageRecord[] }>();
  for (const record of records) {
    const provider = sanitizePublicLabel(record.provider);
    const model = sanitizePublicLabel(record.model);
    const key = `${record.agent}\u0000${provider}\u0000${model}`;
    const group = grouped.get(key) ?? { harness: record.agent, provider, model, records: [] };
    const unsafeLabel = provider === "unknown" && record.provider !== "unknown" || model === "unknown" && record.model !== "unknown";
    group.records.push(unsafeLabel ? { ...record, quality: "partial", reasons: fixedReasons(record.reasons, ["unknown-model"]) } : record);
    grouped.set(key, group);
  }
  return [...grouped.values()].sort((left, right) =>
    left.harness.localeCompare(right.harness) || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
  ).map((group) => {
    const sourceEvidence = evidenceByAgent.get(group.harness) ?? { status: "partial" as const, reasons: ["missing-source" as const] };
    const aggregate = aggregateUsageRecords(group.records, sourceEvidence);
    return { harness: group.harness, provider: group.provider, model: group.model, usage: aggregate.usage, cost: aggregate.cost };
  });
}


const CADENCE_EXCLUSION_KEYS = ["inputHistory", "mixedScope", "noRecordedWork"] as const;
const INPUT_EXCLUSION_KEYS = ["context", "replayed", "unknownKind", "subagent", "unknownLane", "undated"] as const;

function addSafe(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} exceeds safe integer range`);
  return value;
}

function emptyCadenceCoverage(): InputCadenceCoverage {
  return {
    consideredSessions: 0,
    excluded: { inputHistory: 0, mixedScope: 0, noRecordedWork: 0 },
  };
}

function emptyInputExclusions(): PublicInputGroup["excluded"] {
  return { context: 0, replayed: 0, unknownKind: 0, subagent: 0, unknownLane: 0, undated: 0 };
}

function usableInputState(state: InputSourceStateRow | undefined): state is InputSourceStateRow {
  return state !== undefined &&
    state.parser_version === 1 &&
    state.last_successful_scan_ms !== null &&
    state.quality === "recorded";
}

// Aggregate source quality still controls the public metric status. Session
// eligibility uses compatible scan state plus that session's row-level gaps,
// so an unrelated damaged partition cannot exclude every clean session.
function hasUsableSessionInputState(state: InputSourceStateRow | undefined): state is InputSourceStateRow {
  return state !== undefined &&
    state.parser_version === 1 &&
    state.quality !== "unavailable";
}

function inputVolumeReasons(rows: readonly InputRow[], states: readonly InputSourceStateRow[], gap: boolean): PublicReasonCode[] {
  const stateReasons = states.flatMap((state) => parseStringArray(state.reasons_json));
  const rowReasons = rows.flatMap((row) => parseStringArray(row.reasons_json))
    .filter((reason) => reason !== "input-origin-unknown" && reason !== "input-origin-conflict");
  return fixedReasons(stateReasons, rowReasons, gap ? ["input-history-incomplete"] : []);
}

function countInputPopulation(rows: readonly InputRow[], startMs: number, cutoffMs: number): {
  stats: { inputs: number; activeSessions: number };
  sessions: Map<string, InputRow[]>;
  excluded: PublicInputGroup["excluded"];
} {
  const excluded = emptyInputExclusions();
  const sessions = new Map<string, InputRow[]>();
  let inputs = 0;
  for (const row of rows) {
    if (row.scope_decision !== "included") continue;
    if (row.at_ms === null) {
      excluded.undated = addSafe(excluded.undated, 1, "Undated input count");
      continue;
    }
    if (row.at_ms < startMs || row.at_ms > cutoffMs) continue;
    if (row.kind === "context") {
      excluded.context = addSafe(excluded.context, 1, "Context input count");
      continue;
    }
    if (row.kind === "replay") {
      excluded.replayed = addSafe(excluded.replayed, 1, "Replayed input count");
      continue;
    }
    if (row.kind === "unknown") {
      excluded.unknownKind = addSafe(excluded.unknownKind, 1, "Unknown-kind input count");
      continue;
    }
    if (row.lane === "subagent") {
      excluded.subagent = addSafe(excluded.subagent, 1, "Subagent input count");
      continue;
    }
    if (row.lane === "unknown") {
      excluded.unknownLane = addSafe(excluded.unknownLane, 1, "Unknown-lane input count");
      continue;
    }
    inputs = addSafe(inputs, 1, "Input count");
    const entries = sessions.get(row.session_key) ?? [];
    entries.push(row);
    sessions.set(row.session_key, entries);
  }
  return { stats: { inputs, activeSessions: sessions.size }, sessions, excluded };
}

function inputGroupForAgent(
  agent: Agent,
  rows: readonly InputRow[],
  states: readonly InputSourceStateRow[],
  intervals: readonly WorkInterval[],
  sourceRows: readonly SourceRow[],
  startMs: number,
  cutoffMs: number,
): PublicInputGroup {
  const includedRows = rows.filter((row) => row.scope_decision === "included");
  const stateBySource = new Map(states.map((state) => [state.source_key, state]));
  const hasSuccessfulScan = states.some((state) => state.parser_version === 1 && state.last_successful_scan_ms !== null);
  const sourceGap = states.length === 0 || states.some((state) => !usableInputState(state));
  const observationGap = includedRows.some((row) =>
    row.quality !== "recorded" ||
    row.kind === "unknown" ||
    row.lane === "unknown" ||
    row.at_ms === null && row.kind !== "context" && row.kind !== "replay"
  );
  const volumeGap = sourceGap || observationGap;
  const population = countInputPopulation(rows, startMs, cutoffMs);
  const hasRetainedObservations = includedRows.length > 0;
  const inputs = !hasSuccessfulScan && !hasRetainedObservations
    ? metric<typeof population.stats>(null, "unavailable", inputVolumeReasons(includedRows, states, true))
    : metric(population.stats, volumeGap ? "partial" : "recorded", inputVolumeReasons(includedRows, states, volumeGap));

  const cadenceCoverage = emptyCadenceCoverage();
  cadenceCoverage.consideredSessions = population.sessions.size;
  const workBySession = new Map<string, WorkInterval[]>();
  for (const interval of intervals) {
    if (interval.agent !== agent) continue;
    const entries = workBySession.get(interval.sessionKey) ?? [];
    entries.push(interval);
    workBySession.set(interval.sessionKey, entries);
  }
  const rowsBySession = new Map<string, InputRow[]>();
  for (const row of rows) {
    const entries = rowsBySession.get(row.session_key) ?? [];
    entries.push(row);
    rowsBySession.set(row.session_key, entries);
  }

  let sessions = 0;
  let measuredInputs = 0;
  const measuredIntervals: WorkInterval[] = [];
  for (const [sessionKey, counted] of population.sessions) {
    const candidates = rowsBySession.get(sessionKey) ?? counted;
    const inputHistory = candidates.some((row) => !hasUsableSessionInputState(stateBySource.get(row.source_key))) ||
      candidates.some((row) => row.at_ms === null && row.kind !== "context" && row.kind !== "replay") ||
      candidates.some((row) =>
        row.at_ms !== null &&
        row.at_ms >= startMs &&
        row.at_ms <= cutoffMs &&
        row.kind !== "context" &&
        row.kind !== "replay" &&
        (row.kind === "unknown" || row.lane === "unknown" || row.quality !== "recorded")
      );
    if (inputHistory) {
      cadenceCoverage.excluded.inputHistory = addSafe(cadenceCoverage.excluded.inputHistory, 1, "Input-history exclusion count");
      continue;
    }
    const mixedScope = candidates.some((row) =>
      row.at_ms !== null &&
      row.at_ms >= startMs &&
      row.at_ms <= cutoffMs &&
      row.kind !== "context" &&
      row.kind !== "replay" &&
      row.scope_decision !== "included"
    );
    if (mixedScope) {
      cadenceCoverage.excluded.mixedScope = addSafe(cadenceCoverage.excluded.mixedScope, 1, "Mixed-scope exclusion count");
      continue;
    }
    const firstInputMs = Math.min(...counted.map((row) => row.at_ms!));
    const clipped = (workBySession.get(sessionKey) ?? []).flatMap((interval) => {
      const clippedStart = Math.max(firstInputMs, interval.startMs);
      const clippedEnd = Math.min(cutoffMs, interval.endMs);
      return clippedEnd > clippedStart ? [{ ...interval, startMs: clippedStart, endMs: clippedEnd }] : [];
    });
    if (clipped.length === 0) {
      cadenceCoverage.excluded.noRecordedWork = addSafe(cadenceCoverage.excluded.noRecordedWork, 1, "No-recorded-work exclusion count");
      continue;
    }
    sessions = addSafe(sessions, 1, "Measured session count");
    measuredInputs = addSafe(measuredInputs, counted.length, "Measured input count");
    measuredIntervals.push(...clipped);
  }

  const exclusionCount = Object.values(cadenceCoverage.excluded).reduce(
    (sum, count) => addSafe(sum, count, "Cadence exclusion total"),
    0,
  );
  const exclusionReasons = fixedReasons(
    cadenceCoverage.excluded.inputHistory > 0 || cadenceCoverage.excluded.mixedScope > 0 ? ["input-history-incomplete"] : [],
    cadenceCoverage.excluded.noRecordedWork > 0 ? ["timing-unavailable"] : [],
  );
  let cadence: Metric<InputCadenceStats>;
  if (sessions === 0) {
    cadence = metric<InputCadenceStats>(null, "unavailable", exclusionReasons);
  } else {
    const workEvidence = evidenceForSources(sourceRows.filter((row) => row.agent === agent), "work");
    const measured = aggregateWorkIntervals(measuredIntervals, startMs, cutoffMs, {
      status: workEvidence.status,
      reasons: workEvidence.reasons,
    });
    const recordedWorkMs = measured.value?.agentMs ?? 0;
    if (recordedWorkMs <= 0) throw new RangeError("Measured cadence must contain positive recorded work");
    const partial = inputs.status !== "recorded" || measured.status !== "recorded" || exclusionCount > 0;
    cadence = metric(
      { sessions, inputs: measuredInputs, recordedWorkMs },
      partial ? "partial" : "recorded",
      fixedReasons(measured.reasons, exclusionReasons, inputs.status === "recorded" ? [] : inputs.reasons),
    );
  }
  return { inputs, cadence, cadenceCoverage, excluded: population.excluded };
}

function combineInputGroups(
  entries: PublicInputRange["byHarness"],
  enabled: ReadonlySet<Agent>,
): PublicInputGroup {
  const availableInputs = entries.flatMap((entry) => entry.group.inputs.value === null ? [] : [entry.group.inputs.value]);
  const inputsValue = availableInputs.length === 0 ? null : availableInputs.reduce((total, value) => ({
    inputs: addSafe(total.inputs, value.inputs, "All-harness input count"),
    activeSessions: addSafe(total.activeSessions, value.activeSessions, "All-harness active session count"),
  }), { inputs: 0, activeSessions: 0 });
  const enabledInputGap = entries.some((entry) => enabled.has(entry.harness) && entry.group.inputs.status !== "recorded");
  const inputPartial = entries.some((entry) => entry.group.inputs.value !== null && entry.group.inputs.status !== "recorded") || enabledInputGap;
  const inputReasons = fixedReasons(...entries.map((entry) => entry.group.inputs.reasons));
  const inputs = metric(inputsValue, inputsValue === null ? "unavailable" : inputPartial ? "partial" : "recorded", inputReasons);

  const cadenceCoverage = emptyCadenceCoverage();
  const excluded = emptyInputExclusions();
  for (const entry of entries) {
    cadenceCoverage.consideredSessions = addSafe(
      cadenceCoverage.consideredSessions,
      entry.group.cadenceCoverage.consideredSessions,
      "All-harness considered session count",
    );
    for (const key of CADENCE_EXCLUSION_KEYS) {
      cadenceCoverage.excluded[key] = addSafe(
        cadenceCoverage.excluded[key],
        entry.group.cadenceCoverage.excluded[key],
        `All-harness ${key} exclusion count`,
      );
    }
    for (const key of INPUT_EXCLUSION_KEYS) {
      excluded[key] = addSafe(excluded[key], entry.group.excluded[key], `All-harness ${key} record count`);
    }
  }

  const measured = entries.flatMap((entry) => entry.group.cadence.value === null ? [] : [entry.group.cadence.value]);
  const cadenceValue = measured.length === 0 ? null : measured.reduce((total, value) => ({
    sessions: addSafe(total.sessions, value.sessions, "All-harness measured session count"),
    inputs: addSafe(total.inputs, value.inputs, "All-harness measured input count"),
    recordedWorkMs: addSafe(total.recordedWorkMs, value.recordedWorkMs, "All-harness recorded work"),
  }), { sessions: 0, inputs: 0, recordedWorkMs: 0 });
  const anyExclusion = Object.values(cadenceCoverage.excluded).some((count) => count > 0);
  const cadencePartial = entries.some((entry) => entry.group.cadence.value !== null && entry.group.cadence.status !== "recorded") ||
    enabledInputGap ||
    anyExclusion;
  const cadenceReasons = fixedReasons(
    ...entries.map((entry) => entry.group.cadence.reasons),
    ...entries.filter((entry) => enabled.has(entry.harness) && entry.group.inputs.status !== "recorded")
      .map((entry) => entry.group.inputs.reasons),
  );
  const cadence = metric(
    cadenceValue,
    cadenceValue === null ? "unavailable" : cadencePartial ? "partial" : "recorded",
    cadenceReasons,
  );
  return { inputs, cadence, cadenceCoverage, excluded };
}

function buildInputRanges(
  inputRows: readonly InputRow[],
  inputStates: readonly InputSourceStateRow[],
  intervals: readonly WorkInterval[],
  sourceRows: readonly SourceRow[],
  cutoffDate: Temporal.PlainDate,
  timezone: string,
  cutoffMs: number,
  enabledAgentsList: readonly Agent[],
): PublicSnapshot["inputRanges"] {
  const enabled = new Set(enabledAgentsList);
  const ranges = {} as PublicSnapshot["inputRanges"];
  for (const days of [7, 30, 90, 365] as const) {
    const startDate = cutoffDate.subtract({ days: days - 1 });
    const startMs = startDate.toZonedDateTime({
      timeZone: timezone,
      plainTime: Temporal.PlainTime.from("00:00"),
    }).epochMilliseconds;
    const rangeRows = inputRows.filter((row) => row.at_ms === null || row.at_ms >= startMs && row.at_ms <= cutoffMs);
    const visible = new Set(enabledAgentsList);
    for (const row of rangeRows) {
      if (row.scope_decision === "included") visible.add(row.agent);
    }
    const byHarness = AGENTS.filter((agent) => visible.has(agent)).map((harness) => ({
      harness,
      group: inputGroupForAgent(
        harness,
        rangeRows.filter((row) => row.agent === harness),
        inputStates.filter((state) => state.agent === harness),
        intervals,
        sourceRows,
        startMs,
        cutoffMs,
      ),
    }));
    ranges[String(days) as keyof PublicSnapshot["inputRanges"]] = {
      all: combineInputGroups(byHarness, enabled),
      byHarness,
    };
  }
  return ranges;
}
/** Read one consistent ledger snapshot and construct only the strict public allowlist. */
export function buildPublicSnapshot(config: Config, store: CollectorStore, cutoffMs: number): PublicSnapshot {
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new TypeError("cutoffMs must be a nonnegative safe integer");
  return store.readTransaction((ledger) => {
    const cutoffDate = Temporal.Instant.fromEpochMilliseconds(cutoffMs).toZonedDateTimeISO(config.timezone).toPlainDate();
    const periodStartDate = cutoffDate.subtract({ days: 364 });
    const periodStart = periodStartDate.toString();
    const periodEnd = cutoffDate.toString();
    const periodStartMs = periodStartDate.toZonedDateTime({ timeZone: config.timezone, plainTime: Temporal.PlainTime.from("00:00") }).epochMilliseconds;

    const sourceRows = ledger.database.query(`
      SELECT agent, kind, state, token_quality, work_quality, reasons_json, last_successful_scan_ms
      FROM sources ORDER BY agent, source_key
    `).all() as SourceRow[];
    const usageRows = ledger.database.query(`
      SELECT origin_key, agent, session_key, workspace_key, repository_key, turn_key, request_key,
             at_ms, provider, model, uncached_input, cache_read, cache_write, output, reasoning,
             total, cost_microusd, cost_kind, quality, reasons_json
      FROM usage
      WHERE scope_decision = 'included' AND at_ms IS NOT NULL AND at_ms >= ? AND at_ms <= ?
      ORDER BY at_ms, origin_key
    `).all(periodStartMs, cutoffMs) as UsageRow[];
    const workRows = ledger.database.query(`
      SELECT origin_key, agent, session_key, workspace_key, repository_key, provider, model, start_ms, end_ms, kind
      FROM work_intervals
      WHERE scope_decision = 'included' AND end_ms > ? AND start_ms < ?
      ORDER BY start_ms, end_ms, origin_key
    `).all(periodStartMs, cutoffMs) as WorkRow[];
    const inputRows = ledger.database.query(`
      SELECT origin_key, source_key, agent, session_key, at_ms, kind, lane, origin, origin_evidence,
             quality, reasons_json, scope_decision
      FROM input_events
      WHERE at_ms IS NULL OR (at_ms >= ? AND at_ms <= ?)
      ORDER BY agent, session_key, at_ms, origin_key
    `).all(periodStartMs, cutoffMs) as InputRow[];
    const inputStates = ledger.database.query(`
      SELECT source_key, agent, parser_version, quality, reasons_json, last_successful_scan_ms
      FROM input_source_state
      ORDER BY agent, source_key
    `).all() as InputSourceStateRow[];
    const commitRows = ledger.database.query(`
      SELECT repository_key, oid, committer_ms, shallow FROM commits
      WHERE committer_ms >= ? AND committer_ms <= ? ORDER BY committer_ms, repository_key, oid
    `).all(periodStartMs, cutoffMs) as CommitRow[];
    const latestRun = ledger.database.query(`
      SELECT status, diagnostic_counts_json FROM collection_runs
      WHERE status IN ('completed','partial') AND cutoff_ms <= ?
      ORDER BY completed_at_ms DESC, started_at_ms DESC LIMIT 1
    `).get(cutoffMs) as CollectionRunRow | null;
    const scopeRows = ledger.database.query(`
      SELECT origin_key, agent, session_key, workspace_key, repository_key, at_ms, provider,
             known_total, decision, reason, last_seen_ms
      FROM scope_evidence
      UNION ALL
      SELECT usage.origin_key, usage.agent, usage.session_key, usage.workspace_key, usage.repository_key,
             usage.at_ms, usage.provider, usage.total, usage.scope_decision, usage.scope_reason, usage.updated_at_ms
      FROM usage
      WHERE NOT EXISTS (
        SELECT 1 FROM scope_evidence WHERE scope_evidence.origin_key = usage.origin_key
      )
      ORDER BY at_ms, origin_key
    `).all() as ScopeEvidenceRow[];

    const usage = usageRows.map(publicUsageRecord);
    const intervals = workRows.map(publicWorkInterval);
    const agents = enabledAgents(config);
    const accountingSources = sourceRows.filter((row) => agents.includes(row.agent as Agent));
    const tokenEvidence = aggregateSourceEvidence(accountingSources, agents, "tokens");
    const workEvidence = aggregateSourceEvidence(accountingSources, agents, "work");
    const tokenEvidenceByAgent = new Map<Agent, SourceEvidence>();
    const workEvidenceByAgent = new Map<Agent, SourceEvidence>();
    for (const agent of agents) {
      tokenEvidenceByAgent.set(agent, evidenceForSources(accountingSources.filter((row) => row.agent === agent), "tokens"));
      workEvidenceByAgent.set(agent, evidenceForSources(accountingSources.filter((row) => row.agent === agent), "work"));
    }

    const earliestUsageDate = usage[0]?.atMs === undefined ? null : dateAt(usage[0].atMs!, config.timezone);
    const usageByDate = new Map<string, UsageRecord[]>();
    for (const record of usage) {
      const date = dateAt(record.atMs!, config.timezone);
      const records = usageByDate.get(date) ?? [];
      records.push(record);
      usageByDate.set(date, records);
    }
    const gitSources = sourceRows.filter((row) => row.kind === "git-repository" || row.agent === "git");
    const gitReasons = fixedReasons(...gitSources.map((row) => parseStringArray(row.reasons_json)));
    const commitEvidence: SourceEvidence = gitSources.length === 0
      ? { status: "unavailable", reasons: ["missing-source"] }
      : {
          status: combineQualities(gitSources.map((row) =>
            row.state === "available" ? "recorded" : row.last_successful_scan_ms === null ? "unavailable" : "partial",
          )),
          reasons: gitReasons,
        };
    const commitsByDate = new Map<string, number>();
    for (const commit of commitRows) {
      const date = dateAt(commit.committer_ms, config.timezone);
      commitsByDate.set(date, (commitsByDate.get(date) ?? 0) + 1);
    }
    const scopeRowsByDate = new Map<string, ScopeEvidenceRow[]>();
    const undatedScopeRows: ScopeEvidenceRow[] = [];
    for (const row of scopeRows) {
      if (row.at_ms === null) {
        undatedScopeRows.push(row);
        continue;
      }
      if (row.at_ms < periodStartMs || row.at_ms > cutoffMs) continue;
      const date = dateAt(row.at_ms, config.timezone);
      const rows = scopeRowsByDate.get(date) ?? [];
      rows.push(row);
      scopeRowsByDate.set(date, rows);
    }
    if (commitRows.some((row) => row.shallow !== 0) && commitEvidence.status === "recorded") commitEvidence.status = "partial";

    const days: PublicDay[] = [];
    let nextIntervalIndex = 0;
    let activeIntervals: WorkInterval[] = [];
    for (let offset = 0; offset < 365; offset += 1) {
      const plainDate = periodStartDate.add({ days: offset });
      const date = plainDate.toString();
      const slots = buildHourlySlots(date, config.timezone, cutoffMs);
      const elapsedMs = slots.reduce((sum, slot) => sum + slot.elapsedMs, 0);
      const dayRecords = usageByDate.get(date) ?? [];
      const usageKnown = earliestUsageDate !== null && date >= earliestUsageDate;
      const aggregate = aggregateUsageRecords(dayRecords, {
        status: tokenEvidence.status,
        reasons: tokenEvidence.reasons,
        knownEmpty: usageKnown,
      });
      const hours = slots.map((slot) => {
        while (nextIntervalIndex < intervals.length && intervals[nextIntervalIndex]!.startMs < slot.endMs) {
          activeIntervals.push(intervals[nextIntervalIndex]!);
          nextIntervalIndex += 1;
        }
        activeIntervals = activeIntervals.filter((interval) => interval.endMs > slot.startMs);
        return {
          start: slot.start,
          elapsedMs: slot.elapsedMs,
          work: workGroupForSlot(activeIntervals, slot.startMs, slot.endMs, agents, workEvidence, workEvidenceByAgent),
        };
      });
      const commitCount = commitsByDate.get(date) ?? 0;
      const commits = commitEvidence.status === "unavailable"
        ? metric<number>(null, "unavailable", commitEvidence.reasons)
        : metric(commitCount, commitEvidence.status, commitEvidence.reasons);
      days.push({
        date,
        elapsedMs,
        usage: aggregate.usage,
        cost: aggregate.cost,
        usageRows: usageRowsForDay(dayRecords, tokenEvidenceByAgent),
        work: combineWorkGroups(hours, agents),
        hours,
        commits,
        scope: scopeCoverage(scopeRowsByDate.get(date) ?? []),
      });
    }

    const counts = latestRun ? parseCounts(latestRun.diagnostic_counts_json) : {};
    const sources = sourcePublicRows(sourceRows);
    const enabledSourceProblem = agents.some((agent) => {
      const rows = accountingSources.filter((row) => row.agent === agent);
      return rows.length === 0 || rows.some((row) => row.state !== "available" || row.token_quality !== "recorded" || row.work_quality !== "recorded");
    }) || gitSources.length === 0 || gitSources.some((row) => row.state !== "available");
    const scopeStatus: Quality =
      scopeRows.length === 0 || scopeRows.some((row) => row.reason === "legacy-unreconciled")
        ? "partial"
        : sourceRows.some((row) => row.state !== "available")
          ? "partial"
          : "recorded";
    const inputRanges = buildInputRanges(
      inputRows,
      inputStates,
      intervals,
      sourceRows,
      cutoffDate,
      config.timezone,
      cutoffMs,
      agents,
    );
    const snapshot: PublicSnapshot = {
      schemaVersion: 6,
      pricing: { ...PRICING_METADATA, sources: [...PRICING_METADATA.sources] },
      organization: config.companyName ?? "Komodo Risk Inc",
      timezone: config.timezone,
      generatedAt: new Date(cutoffMs).toISOString(),
      cutoff: new Date(cutoffMs).toISOString(),
      periodStart,
      periodEnd,
      collectionStatus: latestRun?.status === "partial" || enabledSourceProblem ? "partial" : "ok",
      sources,
      coverage: {
        unallocatedUsageRecords: counts["unallocated-history"] ?? 0,
        excludedAmbiguousRecords: counts["duplicate-ambiguity"] ?? 0,
        scopeStatus,
        undated: scopeCoverage(undatedScopeRows),
      },
      inputRanges,
      days,
    };
    return publicSnapshotSchema.parse(snapshot);
  });
}

export interface ScopeReport {
  timezone: string;
  cutoff: string;
  windowStart: string;
  windowEnd: string;
  freshness: {
    latestSuccessfulScan: string | null;
    status: Quality;
  };
  totals: {
    included: { records: number; knownTokens: number; unknownTotalRecords: number };
    outOfScope: { records: number; knownTokens: number; unknownTotalRecords: number };
    unattributed: { records: number; knownTokens: number; unknownTotalRecords: number };
  };
  breakdowns: Array<{
    harness: Agent;
    provider: string;
    decision: ScopeEvidenceRow["decision"];
    reason: string;
    workspace: string | null;
    records: number;
    knownTokens: number;
    unknownTotalRecords: number;
  }>;
}

export function buildScopeReport(
  config: Config,
  store: CollectorStore,
  days: number,
  cutoffMs: number,
): ScopeReport {
  if (!Number.isSafeInteger(days) || days < 1) throw new TypeError("days must be a positive safe integer");
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new TypeError("cutoffMs must be a nonnegative safe integer");
  return store.readTransaction((ledger) => {
    const cutoff = Temporal.Instant.fromEpochMilliseconds(cutoffMs);
    const cutoffDate = cutoff.toZonedDateTimeISO(config.timezone).toPlainDate();
    const startMs = cutoffDate
      .subtract({ days: days - 1 })
      .toZonedDateTime({ timeZone: config.timezone, plainTime: Temporal.PlainTime.from("00:00") })
      .epochMilliseconds;
    const rows = ledger.database.query(`
      SELECT origin_key, agent, session_key, workspace_key, repository_key, at_ms, provider,
             known_total, decision, reason, last_seen_ms
      FROM scope_evidence
      WHERE at_ms IS NOT NULL AND at_ms >= ? AND at_ms <= ?
      UNION ALL
      SELECT usage.origin_key, usage.agent, usage.session_key, usage.workspace_key, usage.repository_key,
             usage.at_ms, usage.provider, usage.total, usage.scope_decision, usage.scope_reason, usage.updated_at_ms
      FROM usage
      WHERE usage.at_ms IS NOT NULL AND usage.at_ms >= ? AND usage.at_ms <= ?
        AND NOT EXISTS (
          SELECT 1 FROM scope_evidence WHERE scope_evidence.origin_key = usage.origin_key
        )
      ORDER BY agent, provider, decision, reason, workspace_key, origin_key
    `).all(startMs, cutoffMs, startMs, cutoffMs) as ScopeEvidenceRow[];
    const count = (decision: ScopeEvidenceRow["decision"]) => {
      const selected = rows.filter((row) => row.decision === decision);
      return {
        records: selected.length,
        knownTokens: selected.reduce((sum, row) => sum + (row.known_total ?? 0), 0),
        unknownTotalRecords: selected.filter((row) => row.known_total === null).length,
      };
    };
    const grouped = new Map<string, ScopeReport["breakdowns"][number]>();
    for (const row of rows) {
      const key = JSON.stringify([row.agent, row.provider ?? "unknown", row.decision, row.reason, row.workspace_key]);
      const entry = grouped.get(key) ?? {
        harness: row.agent,
        provider: row.provider ?? "unknown",
        decision: row.decision,
        reason: row.reason,
        workspace: row.workspace_key,
        records: 0,
        knownTokens: 0,
        unknownTotalRecords: 0,
      };
      entry.records += 1;
      entry.knownTokens += row.known_total ?? 0;
      if (row.known_total === null) entry.unknownTotalRecords += 1;
      grouped.set(key, entry);
    }
    const freshness = ledger.database.query(`
      SELECT MAX(last_successful_scan_ms) AS latest,
             SUM(CASE WHEN state = 'available' THEN 0 ELSE 1 END) AS stale
      FROM sources
    `).get() as { latest: number | null; stale: number | null };
    return {
      timezone: config.timezone,
      cutoff: cutoff.toString(),
      windowStart: Temporal.Instant.fromEpochMilliseconds(startMs).toString(),
      windowEnd: cutoff.toString(),
      freshness: {
        latestSuccessfulScan: freshness.latest === null ? null : new Date(freshness.latest).toISOString(),
        status: (freshness.stale ?? 0) > 0 ? "partial" : freshness.latest === null ? "unavailable" : "recorded",
      },
      totals: {
        included: count("included"),
        outOfScope: count("out-of-scope"),
        unattributed: count("unattributed"),
      },
      breakdowns: [...grouped.values()],
    };
  });
}
