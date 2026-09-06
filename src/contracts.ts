import { z } from "zod";

export const AGENTS = ["codex", "claude", "omp", "opencode", "hermes"] as const;
export type Agent = (typeof AGENTS)[number];

export const QUALITIES = ["recorded", "partial", "unavailable"] as const;
export type Quality = (typeof QUALITIES)[number];

export const PUBLIC_REASON_CODES = [
  "missing-source",
  "unsupported-schema",
  "parse-gap",
  "unknown-model",
  "unpriced-model",
  "incomplete-token-breakdown",
  "unallocated-history",
  "counter-discontinuity",
  "duplicate-ambiguity",
  "upstream-owned",
  "timing-unavailable",
  "open-interval",
  "unattributed-session",
  "stale-ref",
] as const;
export type PublicReasonCode = (typeof PUBLIC_REASON_CODES)[number];

export interface UsageRecord {
  originKey: string;
  agent: Agent;
  sessionKey: string;
  workspaceKey: string;
  repositoryKey: string | null;
  turnKey: string | null;
  requestKey: string | null;
  atMs: number | null;
  provider: string;
  model: string;
  uncachedInput: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
  costMicrousd: number | null;
  costKind: "source-estimate" | "provider-reported" | "included" | "unknown";
  quality: Quality;
  reasons: string[];
}

export interface WorkInterval {
  originKey: string;
  agent: Agent;
  sessionKey: string;
  workspaceKey: string;
  repositoryKey: string | null;
  provider: string | null;
  model: string | null;
  startMs: number;
  endMs: number;
  kind: "inference" | "tool";
}

export interface Metric<T> {
  value: T | null;
  status: Quality;
  reasons: string[];
}

export interface PublicUsage {
  total: Metric<number>;
  uncachedInput: Metric<number>;
  cacheRead: Metric<number>;
  cacheWrite: Metric<number>;
  output: Metric<number>;
  reasoning: Metric<number>;
  otherRecorded: Metric<number>;
  cacheReadBasis: Metric<{ readTokens: number; promptTokens: number }>;
}

export interface PublicCost {
  apiEquivalentUsd: Metric<number>;
  pricedRecords: number;
  unpricedRecords: number;
  pricedTokens: number;
  unpricedTokens: number;
  sourceEstimatedUsd: Metric<number>;
  providerReportedUsd: Metric<number>;
  unknownRecords: number;
  includedRecords: number;
}

export interface WorkStats {
  activeMs: number;
  inferenceMs: number;
  agentMs: number;
  parallelMs: number;
  histogram: Array<{ agents: number; elapsedMs: number }>;
  unavailableMs: number;
}

export interface PublicWorkGroup {
  work: Metric<WorkStats>;
  byHarness: Array<{ harness: Agent; work: Metric<WorkStats> }>;
}

export interface PublicScopeCount {
  records: number;
  knownTokens: number;
  unknownTotalRecords: number;
}

export interface PublicScopeCoverage {
  byHarness: Array<{
    harness: Agent;
    included: PublicScopeCount;
    outOfScope: PublicScopeCount;
    unattributed: PublicScopeCount;
  }>;
}

export interface PublicDay {
  date: string;
  elapsedMs: number;
  usage: PublicUsage;
  cost: PublicCost;
  usageRows: Array<{
    harness: Agent;
    provider: string;
    model: string;
    usage: PublicUsage;
    cost: PublicCost;
  }>;
  work: PublicWorkGroup;
  hours: Array<{ start: string; elapsedMs: number; work: PublicWorkGroup }>;
  commits: Metric<number>;
  scope: PublicScopeCoverage;
}

export interface PublicSnapshot {
  schemaVersion: 3;
  pricing: {
    asOf: string;
    basis: "standard-api";
    sources: string[];
  };
  organization: "Agent Native";
  timezone: string;
  generatedAt: string;
  cutoff: string;
  periodStart: string;
  periodEnd: string;
  collectionStatus: "ok" | "partial";
  sources: Array<{
    agent: string;
    state:
      | "available"
      | "partial"
      | "not-found"
      | "installed-no-history"
      | "excluded-wrapper"
      | "unsupported-schema";
    tokens: Quality;
    work: Quality;
    reasons: string[];
  }>;
  coverage: {
    unallocatedUsageRecords: number;
    excludedAmbiguousRecords: number;
    scopeStatus: Quality;
    undated: PublicScopeCoverage;
  };
  days: PublicDay[];
}

const nonnegativeSafeIntegerSchema = z.number().finite().int().safe().nonnegative();
const nullableCounterSchema = nonnegativeSafeIntegerSchema.nullable();
const privateKeySchema = z.string().min(1);

export const agentSchema = z.enum(AGENTS);
export const qualitySchema = z.enum(QUALITIES);
export const publicReasonCodeSchema = z.enum(PUBLIC_REASON_CODES);

export const usageRecordSchema: z.ZodType<UsageRecord> = z
  .object({
    originKey: privateKeySchema,
    agent: agentSchema,
    sessionKey: privateKeySchema,
    workspaceKey: privateKeySchema,
    repositoryKey: privateKeySchema.nullable(),
    turnKey: privateKeySchema.nullable(),
    requestKey: privateKeySchema.nullable(),
    atMs: nullableCounterSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    uncachedInput: nullableCounterSchema,
    cacheRead: nullableCounterSchema,
    cacheWrite: nullableCounterSchema,
    output: nullableCounterSchema,
    reasoning: nullableCounterSchema,
    total: nullableCounterSchema,
    costMicrousd: nullableCounterSchema,
    costKind: z.enum(["source-estimate", "provider-reported", "included", "unknown"]),
    quality: qualitySchema,
    reasons: z.array(z.string()),
  })
  .strict();

export const workIntervalSchema: z.ZodType<WorkInterval> = z
  .object({
    originKey: privateKeySchema,
    agent: agentSchema,
    sessionKey: privateKeySchema,
    workspaceKey: privateKeySchema,
    repositoryKey: privateKeySchema.nullable(),
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    startMs: nonnegativeSafeIntegerSchema,
    endMs: nonnegativeSafeIntegerSchema,
    kind: z.enum(["inference", "tool"]),
  })
  .strict()
  .refine((interval) => interval.endMs > interval.startMs, {
    message: "endMs must be greater than startMs",
    path: ["endMs"],
  });

const PUBLIC_LABEL_PATTERN = /^[A-Za-z0-9._\-/:+()\[\]]{1,128}$/;
const SECRET_LABEL_PREFIX = /^(?:sk-|ghp_|gho_|ghs_|github_pat_)/i;

export function sanitizePublicLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    !PUBLIC_LABEL_PATTERN.test(value) ||
    value.includes("://") ||
    SECRET_LABEL_PREFIX.test(value)
  ) {
    return "unknown";
  }
  return value;
}

export const publicLabelSchema = z.string().transform(sanitizePublicLabel);

const publicDateSchema = z.string().refine(
  (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  },
  { message: "Expected a valid YYYY-MM-DD date" },
);

const instantSchema = z.string().refine(
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)),
  { message: "Expected an ISO instant" },
);

const publicReasonsSchema = z
  .array(publicReasonCodeSchema)
  .superRefine((reasons, context) => {
    for (let index = 1; index < reasons.length; index += 1) {
      if (reasons[index - 1]! >= reasons[index]!) {
        context.addIssue({
          code: "custom",
          message: "Reason codes must be unique and lexically sorted",
        });
        return;
      }
    }
  });

function metricSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .object({
      value: valueSchema.nullable(),
      status: qualitySchema,
      reasons: publicReasonsSchema,
    })
    .strict();
}

const tokenMetricSchema = metricSchema(nonnegativeSafeIntegerSchema);
const usdMetricSchema = metricSchema(z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER));

export const publicUsageSchema = z
  .object({
    total: tokenMetricSchema,
    uncachedInput: tokenMetricSchema,
    cacheRead: tokenMetricSchema,
    cacheWrite: tokenMetricSchema,
    output: tokenMetricSchema,
    reasoning: tokenMetricSchema,
    otherRecorded: tokenMetricSchema,
    cacheReadBasis: metricSchema(
      z
        .object({
          readTokens: nonnegativeSafeIntegerSchema,
          promptTokens: nonnegativeSafeIntegerSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const publicCostSchema = z
  .object({
    apiEquivalentUsd: usdMetricSchema,
    pricedRecords: nonnegativeSafeIntegerSchema,
    unpricedRecords: nonnegativeSafeIntegerSchema,
    pricedTokens: nonnegativeSafeIntegerSchema,
    unpricedTokens: nonnegativeSafeIntegerSchema,
    sourceEstimatedUsd: usdMetricSchema,
    providerReportedUsd: usdMetricSchema,
    unknownRecords: nonnegativeSafeIntegerSchema,
    includedRecords: nonnegativeSafeIntegerSchema,
  })
  .strict();

const histogramEntrySchema = z
  .object({
    agents: nonnegativeSafeIntegerSchema,
    elapsedMs: nonnegativeSafeIntegerSchema,
  })
  .strict();

export const workStatsSchema = z
  .object({
    activeMs: nonnegativeSafeIntegerSchema,
    inferenceMs: nonnegativeSafeIntegerSchema,
    agentMs: nonnegativeSafeIntegerSchema,
    parallelMs: nonnegativeSafeIntegerSchema,
    histogram: z.array(histogramEntrySchema),
    unavailableMs: nonnegativeSafeIntegerSchema,
  })
  .strict()
  .superRefine((stats, context) => {
    if (stats.inferenceMs > stats.activeMs) {
      context.addIssue({ code: "custom", path: ["inferenceMs"], message: "Inference time cannot exceed active time" });
    }
    let previous = -1;
    for (const [index, entry] of stats.histogram.entries()) {
      if (entry.elapsedMs === 0) {
        context.addIssue({ code: "custom", path: ["histogram", index, "elapsedMs"], message: "Zero-duration bins must be omitted" });
      }
      if (entry.agents <= previous) {
        context.addIssue({ code: "custom", path: ["histogram", index, "agents"], message: "Histogram agent counts must be unique and sorted" });
      }
      previous = entry.agents;
    }
  });

const workMetricSchema = metricSchema(workStatsSchema);
const byHarnessSchema = z
  .object({
    harness: agentSchema,
    work: workMetricSchema,
  })
  .strict();

export const publicWorkGroupSchema = z
  .object({
    work: workMetricSchema,
    byHarness: z.array(byHarnessSchema),
  })
  .strict();

const publicUsageRowSchema = z
  .object({
    harness: agentSchema,
    provider: publicLabelSchema,
    model: publicLabelSchema,
    usage: publicUsageSchema,
    cost: publicCostSchema,
  })
  .strict();

const publicHourSchema = z
  .object({
    start: instantSchema,
    elapsedMs: nonnegativeSafeIntegerSchema,
    work: publicWorkGroupSchema,
  })
  .strict();


const publicScopeCountSchema = z
  .object({
    records: nonnegativeSafeIntegerSchema,
    knownTokens: nonnegativeSafeIntegerSchema,
    unknownTotalRecords: nonnegativeSafeIntegerSchema,
  })
  .strict()
  .refine((value) => value.unknownTotalRecords <= value.records, {
    message: "Unknown-total records cannot exceed scope record count",
  });

const publicScopeCoverageSchema = z
  .object({
    byHarness: z.array(z
      .object({
        harness: agentSchema,
        included: publicScopeCountSchema,
        outOfScope: publicScopeCountSchema,
        unattributed: publicScopeCountSchema,
      })
      .strict()),
  })
  .strict();
export const publicDaySchema = z
  .object({
    date: publicDateSchema,
    elapsedMs: nonnegativeSafeIntegerSchema,
    usage: publicUsageSchema,
    cost: publicCostSchema,
    usageRows: z.array(publicUsageRowSchema),
    work: publicWorkGroupSchema,
    hours: z.array(publicHourSchema),
    commits: metricSchema(nonnegativeSafeIntegerSchema),
    scope: publicScopeCoverageSchema,
  })
  .strict();

const publicSourceSchema = z
  .object({
    agent: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
    state: z.enum([
      "available",
      "partial",
      "not-found",
      "installed-no-history",
      "excluded-wrapper",
      "unsupported-schema",
    ]),
    tokens: qualitySchema,
    work: qualitySchema,
    reasons: publicReasonsSchema,
  })
  .strict();

export const publicSnapshotSchema: z.ZodType<PublicSnapshot> = z
  .object({
    schemaVersion: z.literal(3),
    pricing: z
      .object({
        asOf: publicDateSchema,
        basis: z.literal("standard-api"),
        sources: z.array(z.string().url().refine((value) => {
          try {
            const url = new URL(value);
            return url.protocol === "https:" && url.username === "" && url.password === "";
          } catch {
            return false;
          }
        }, { message: "Expected an HTTPS pricing source URL without credentials" })),
      })
      .strict(),
    organization: z.literal("Agent Native"),
    timezone: z.string().min(1).max(128),
    generatedAt: instantSchema,
    cutoff: instantSchema,
    periodStart: publicDateSchema,
    periodEnd: publicDateSchema,
    collectionStatus: z.enum(["ok", "partial"]),
    sources: z.array(publicSourceSchema),
    coverage: z
      .object({
        unallocatedUsageRecords: nonnegativeSafeIntegerSchema,
        excludedAmbiguousRecords: nonnegativeSafeIntegerSchema,
        scopeStatus: qualitySchema,
        undated: publicScopeCoverageSchema,
      })
      .strict(),
    days: z.array(publicDaySchema),
  })
  .strict();
