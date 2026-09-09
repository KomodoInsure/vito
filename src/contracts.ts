import { z } from "zod";

export const AGENTS = ["codex", "claude", "omp", "opencode", "hermes"] as const;
export type Agent = (typeof AGENTS)[number];

export const QUALITIES = ["recorded", "partial", "unavailable"] as const;
export type Quality = (typeof QUALITIES)[number];

export type InputOrigin = "human" | "automated" | "unknown";

export interface InputRecord {
  originKey: string;
  sourceKey: string;
  agent: Agent;
  sessionKey: string;
  nativeSessionId: string;
  nativeInputId: string;
  workspaceKey: string;
  repositoryKey: string | null;
  atMs: number | null;
  kind: "submission" | "context" | "replay" | "unknown";
  lane: "main" | "subagent" | "unknown";
  controller: string | null;
  origin: InputOrigin;
  originEvidence: "source" | "provenance" | "none" | "conflict";
  quality: Quality;
  reasons: string[];
}

export interface InputSourceState {
  sourceKey: string;
  agent: Agent;
  parserVersion: 1;
  quality: Quality;
  reasons: string[];
  scannedAtMs: number;
  lastSuccessfulScanMs: number | null;
}

export interface InputProvenanceRecord {
  originKey: string;
  agent: Agent;
  nativeSessionId: string;
  nativeInputId: string;
  origin: "human" | "automated";
  controller: string | null;
}

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
  "input-history-incomplete",
  "input-kind-unknown",
  "input-origin-conflict",
  "input-origin-unknown",
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

export interface InputStats {
  human: number;
  automated: number;
  unknown: number;
  activeSessions: number;
}

export interface HumanCadenceStats {
  sessions: number;
  humanInputs: number;
  recordedWorkMs: number;
}

export interface HumanCadenceCoverage {
  consideredSessions: number;
  excluded: {
    inputHistory: number;
    mixedScope: number;
    unknownOrigin: number;
    noHumanInput: number;
    noRecordedWork: number;
  };
}

export interface PublicInputGroup {
  inputs: Metric<InputStats>;
  cadence: Metric<HumanCadenceStats>;
  cadenceCoverage: HumanCadenceCoverage;
  excluded: {
    context: number;
    replayed: number;
    unknownKind: number;
    subagent: number;
    unknownLane: number;
    undated: number;
  };
}

export interface PublicInputRange {
  all: PublicInputGroup;
  byHarness: Array<{ harness: Agent; group: PublicInputGroup }>;
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
  schemaVersion: 5;
  pricing: {
    asOf: string;
    basis: "standard-api";
    sources: string[];
  };
  organization: string;
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
  inputRanges: Record<"7" | "30" | "90" | "365", PublicInputRange>;
  days: PublicDay[];
}

const nonnegativeSafeIntegerSchema = z.number().finite().int().safe().nonnegative();
const nullableCounterSchema = nonnegativeSafeIntegerSchema.nullable();
const privateKeySchema = z.string().min(1);

export const agentSchema = z.enum(AGENTS);
export const qualitySchema = z.enum(QUALITIES);
export const publicReasonCodeSchema = z.enum(PUBLIC_REASON_CODES);
export const inputOriginSchema = z.enum(["human", "automated", "unknown"]);
const controllerSchema = z.string().min(1).max(128).nullable();
const inputReasonsSchema = z.array(publicReasonCodeSchema);

export const inputRecordSchema: z.ZodType<InputRecord> = z
  .object({
    originKey: privateKeySchema,
    sourceKey: privateKeySchema,
    agent: agentSchema,
    sessionKey: privateKeySchema,
    nativeSessionId: privateKeySchema,
    nativeInputId: privateKeySchema,
    workspaceKey: privateKeySchema,
    repositoryKey: privateKeySchema.nullable(),
    atMs: nullableCounterSchema,
    kind: z.enum(["submission", "context", "replay", "unknown"]),
    lane: z.enum(["main", "subagent", "unknown"]),
    controller: controllerSchema,
    origin: inputOriginSchema,
    originEvidence: z.enum(["source", "provenance", "none", "conflict"]),
    quality: qualitySchema,
    reasons: inputReasonsSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const explicitEvidence = record.originEvidence === "source" || record.originEvidence === "provenance";
    if ((explicitEvidence && record.origin === "unknown") || (!explicitEvidence && record.origin !== "unknown")) {
      context.addIssue({
        code: "custom",
        message: "Input origin must agree with its evidence",
        path: ["origin"],
      });
    }
  });

export const inputSourceStateSchema: z.ZodType<InputSourceState> = z
  .object({
    sourceKey: privateKeySchema,
    agent: agentSchema,
    parserVersion: z.literal(1),
    quality: qualitySchema,
    reasons: inputReasonsSchema,
    scannedAtMs: nonnegativeSafeIntegerSchema,
    lastSuccessfulScanMs: nullableCounterSchema,
  })
  .strict();

export const inputProvenanceRecordSchema: z.ZodType<InputProvenanceRecord> = z
  .object({
    originKey: privateKeySchema,
    agent: agentSchema,
    nativeSessionId: privateKeySchema,
    nativeInputId: privateKeySchema,
    origin: z.enum(["human", "automated"]),
    controller: controllerSchema,
  })
  .strict();

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

const inputStatsSchema = z
  .object({
    human: nonnegativeSafeIntegerSchema,
    automated: nonnegativeSafeIntegerSchema,
    unknown: nonnegativeSafeIntegerSchema,
    activeSessions: nonnegativeSafeIntegerSchema,
  })
  .strict()
  .superRefine((stats, context) => {
    const total = stats.human + stats.automated + stats.unknown;
    if (!Number.isSafeInteger(total)) {
      context.addIssue({ code: "custom", message: "Input total must be a safe integer" });
    } else if (total < stats.activeSessions) {
      context.addIssue({ code: "custom", path: ["activeSessions"], message: "Active sessions cannot exceed counted inputs" });
    }
    if ((total === 0) !== (stats.activeSessions === 0)) {
      context.addIssue({ code: "custom", path: ["activeSessions"], message: "Known-empty inputs and active sessions must be zero together" });
    }
  });

const humanCadenceStatsSchema = z
  .object({
    sessions: nonnegativeSafeIntegerSchema,
    humanInputs: nonnegativeSafeIntegerSchema,
    recordedWorkMs: nonnegativeSafeIntegerSchema,
  })
  .strict()
  .superRefine((stats, context) => {
    if (stats.sessions === 0) {
      context.addIssue({ code: "custom", path: ["sessions"], message: "Measured cadence requires a positive session count" });
    }
    if (stats.humanInputs < stats.sessions) {
      context.addIssue({ code: "custom", path: ["humanInputs"], message: "Each measured session requires a human input" });
    }
    if (stats.recordedWorkMs === 0) {
      context.addIssue({ code: "custom", path: ["recordedWorkMs"], message: "Measured cadence requires positive recorded work" });
    }
  });

const inputMetricSchema = metricSchema(inputStatsSchema).superRefine((entry, context) => {
  if (entry.value === null && entry.status !== "unavailable") {
    context.addIssue({ code: "custom", path: ["status"], message: "Unavailable input data must use unavailable status" });
  } else if (entry.value !== null && entry.status === "unavailable") {
    context.addIssue({ code: "custom", path: ["status"], message: "Available input data cannot use unavailable status" });
  }
});

const humanCadenceMetricSchema = metricSchema(humanCadenceStatsSchema).superRefine((entry, context) => {
  if (entry.value === null && entry.status !== "unavailable") {
    context.addIssue({ code: "custom", path: ["status"], message: "An empty cadence cohort must be unavailable" });
  } else if (entry.value !== null && entry.status === "unavailable") {
    context.addIssue({ code: "custom", path: ["status"], message: "A measured cadence cohort cannot be unavailable" });
  }
});

const cadenceExcludedSchema = z
  .object({
    inputHistory: nonnegativeSafeIntegerSchema,
    mixedScope: nonnegativeSafeIntegerSchema,
    unknownOrigin: nonnegativeSafeIntegerSchema,
    noHumanInput: nonnegativeSafeIntegerSchema,
    noRecordedWork: nonnegativeSafeIntegerSchema,
  })
  .strict();

const cadenceCoverageSchema = z
  .object({
    consideredSessions: nonnegativeSafeIntegerSchema,
    excluded: cadenceExcludedSchema,
  })
  .strict();

const inputExcludedSchema = z
  .object({
    context: nonnegativeSafeIntegerSchema,
    replayed: nonnegativeSafeIntegerSchema,
    unknownKind: nonnegativeSafeIntegerSchema,
    subagent: nonnegativeSafeIntegerSchema,
    unknownLane: nonnegativeSafeIntegerSchema,
    undated: nonnegativeSafeIntegerSchema,
  })
  .strict();

const publicInputGroupSchema = z
  .object({
    inputs: inputMetricSchema,
    cadence: humanCadenceMetricSchema,
    cadenceCoverage: cadenceCoverageSchema,
    excluded: inputExcludedSchema,
  })
  .strict()
  .superRefine((group, context) => {
    const inputs = group.inputs.value;
    const cadence = group.cadence.value;
    if (group.cadenceCoverage.consideredSessions !== (inputs?.activeSessions ?? 0)) {
      context.addIssue({ code: "custom", path: ["cadenceCoverage", "consideredSessions"], message: "Considered sessions must equal input-active sessions" });
    }
    const classified = (cadence?.sessions ?? 0) + Object.values(group.cadenceCoverage.excluded).reduce((sum, count) => sum + count, 0);
    if (!Number.isSafeInteger(classified) || classified !== group.cadenceCoverage.consideredSessions) {
      context.addIssue({ code: "custom", path: ["cadenceCoverage", "excluded"], message: "Every considered session must be classified exactly once" });
    }
    if (cadence !== null && (inputs === null || cadence.humanInputs > inputs.human || cadence.sessions > inputs.activeSessions)) {
      context.addIssue({ code: "custom", path: ["cadence"], message: "Cadence cohort cannot exceed its supporting input population" });
    }
  });

const publicInputHarnessSchema = z
  .object({
    harness: agentSchema,
    group: publicInputGroupSchema,
  })
  .strict();

const INPUT_COUNTER_KEYS = ["human", "automated", "unknown", "activeSessions"] as const;
const CADENCE_COUNTER_KEYS = ["sessions", "humanInputs", "recordedWorkMs"] as const;
const CADENCE_EXCLUDED_KEYS = ["inputHistory", "mixedScope", "unknownOrigin", "noHumanInput", "noRecordedWork"] as const;
const INPUT_EXCLUDED_KEYS = ["context", "replayed", "unknownKind", "subagent", "unknownLane", "undated"] as const;

function safeCounterSum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

const publicInputRangeSchema = z
  .object({
    all: publicInputGroupSchema,
    byHarness: z.array(publicInputHarnessSchema),
  })
  .strict()
  .superRefine((range, context) => {
    let previous = -1;
    for (const [index, entry] of range.byHarness.entries()) {
      const position = AGENTS.indexOf(entry.harness);
      if (position <= previous) {
        context.addIssue({ code: "custom", path: ["byHarness", index, "harness"], message: "Harness entries must be unique and follow AGENTS order" });
      }
      previous = position;
    }

    const availableInputs = range.byHarness.flatMap((entry) => entry.group.inputs.value === null ? [] : [entry.group.inputs.value]);
    if ((range.all.inputs.value === null) !== (availableInputs.length === 0)) {
      context.addIssue({ code: "custom", path: ["all", "inputs"], message: "All-harness inputs must sum available harness inputs" });
    } else if (range.all.inputs.value !== null) {
      for (const key of INPUT_COUNTER_KEYS) {
        const total = safeCounterSum(availableInputs.map((value) => value[key]));
        if (total === null || range.all.inputs.value[key] !== total) {
          context.addIssue({ code: "custom", path: ["all", "inputs", "value", key], message: "All-harness inputs must sum available harness inputs" });
        }
      }
    }

    const availableCadence = range.byHarness.flatMap((entry) => entry.group.cadence.value === null ? [] : [entry.group.cadence.value]);
    if ((range.all.cadence.value === null) !== (availableCadence.length === 0)) {
      context.addIssue({ code: "custom", path: ["all", "cadence"], message: "All-harness cadence must sum measured harness cohorts" });
    } else if (range.all.cadence.value !== null) {
      for (const key of CADENCE_COUNTER_KEYS) {
        const total = safeCounterSum(availableCadence.map((value) => value[key]));
        if (total === null || range.all.cadence.value[key] !== total) {
          context.addIssue({ code: "custom", path: ["all", "cadence", "value", key], message: "All-harness cadence must sum measured harness cohorts" });
        }
      }
    }

    const considered = safeCounterSum(range.byHarness.map((entry) => entry.group.cadenceCoverage.consideredSessions));
    if (considered === null || range.all.cadenceCoverage.consideredSessions !== considered) {
      context.addIssue({ code: "custom", path: ["all", "cadenceCoverage", "consideredSessions"], message: "All-harness coverage must sum harness coverage" });
    }
    for (const key of CADENCE_EXCLUDED_KEYS) {
      const total = safeCounterSum(range.byHarness.map((entry) => entry.group.cadenceCoverage.excluded[key]));
      if (total === null || range.all.cadenceCoverage.excluded[key] !== total) {
        context.addIssue({ code: "custom", path: ["all", "cadenceCoverage", "excluded", key], message: "All-harness exclusions must sum harness exclusions" });
      }
    }
    for (const key of INPUT_EXCLUDED_KEYS) {
      const total = safeCounterSum(range.byHarness.map((entry) => entry.group.excluded[key]));
      if (total === null || range.all.excluded[key] !== total) {
        context.addIssue({ code: "custom", path: ["all", "excluded", key], message: "All-harness record exclusions must sum harness exclusions" });
      }
    }
  });

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
    schemaVersion: z.literal(5),
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
    organization: z.string().trim().min(1).max(80),
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
    inputRanges: z
      .object({
        "7": publicInputRangeSchema,
        "30": publicInputRangeSchema,
        "90": publicInputRangeSchema,
        "365": publicInputRangeSchema,
      })
      .strict(),
    days: z.array(publicDaySchema),
  })
  .strict();
