import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { Config } from "../config";
import type { InputRecord, Quality, UsageRecord, WorkInterval } from "../contracts";
import { mergeInputRecords, retainedInputRecords, storedInputReasons } from "../inputs";
import type { CounterSnapshot, FileCursor, SessionRecord, SourceRecord } from "../store";
import { scanJsonl, sourcePathKey } from "./jsonl";
import type { AdapterBatch, AdapterContext, DiscoveryEntry, SourceAdapter } from "./types";

const AGENT = "codex" as const;
const UNKNOWN = "unknown";
const SUPPORTED_ITEM_TYPES: Readonly<Record<string, "inference" | "tool">> = {
  reasoning: "inference",
  agentmessage: "inference",
  assistantmessage: "inference",
  commandexecution: "tool",
  command: "tool",
  filechange: "tool",
  websearch: "tool",
  mcptoolcall: "tool",
  dynamictoolcall: "tool",
  toolcall: "tool",
};
const EXCLUDED_ITEM_TYPES: Readonly<Record<string, true>> = {
  usermessage: true,
  subagentactivity: true,
  plan: true,
  collabagentwait: true,
  requestuserinput: true,
  wait: true,
  waitforinput: true,
  waitforagents: true,
  askuser: true,
  approval: true,
};
export interface CodexNormalizationOptions {
  sourceKey?: string;
  completeHistory?: boolean;
  cutoffMs?: number;
  parentBySession?: ReadonlyMap<string, string>;
  sessionByRolloutPath?: ReadonlyMap<string, string>;
}

export interface CodexNormalizationResult {
  sessions: SessionRecord[];
  usage: UsageRecord[];
  workIntervals: WorkInterval[];
  inputs: InputRecord[];
  inputQuality: Quality;
  inputReasons: string[];
  counterSnapshots: CounterSnapshot[];
  diagnosticCounts: Record<string, number>;
  reasons: string[];
  unallocatedUsageRecords: number;
}

export interface CodexJsonlNormalizationResult extends CodexNormalizationResult {
  completeByteOffset: number;
}
type UnknownRecord = Record<string, unknown>;

const COMPONENT_KEYS = [
  "uncachedInput",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
  "total",
] as const satisfies readonly (keyof UsageRecord)[];
type ComponentKey = (typeof COMPONENT_KEYS)[number];
type Components = Pick<UsageRecord, ComponentKey>;


interface ContextState {
  sourceKey: string;
  completeHistory: boolean;
  cutoffMs: number;
  parentBySession: ReadonlyMap<string, string>;
  sessionByRolloutPath: ReadonlyMap<string, string>;
  sessionKey: string | null;
  canonicalSessionKey: string | null;
  parentSessionKey: string | null;
  workspaceKey: string | null;
  provider: string;
  model: string;
  controller: string | null;
  turnKey: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  sawHeader: boolean;
  inheritedHistory: boolean;
  cumulative: Components | null;
  cumulativeAtMs: number | null;
  cumulativeEpoch: number;
  modernSinceCheckpoint: Components;
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): UnknownRecord | null {
  return isUnknownRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function instantMs(value: unknown): number | null {
  if (typeof value === "number") return safeInteger(value);
  if (typeof value !== "string" || value.length === 0) return null;
  const result = Date.parse(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function hash(...values: unknown[]): string {
  const digest = createHash("sha256");
  for (const value of values) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    digest.update(serialized ?? "undefined");
    digest.update("\0");
  }
  return digest.digest("hex");
}

function increment(counts: Record<string, number>, name: string): void {
  counts[name] = (counts[name] ?? 0) + 1;
}

function normalizedItemType(value: unknown): string {
  return typeof value === "string" ? value.replace(/[^A-Za-z0-9]/g, "").toLowerCase() : "";
}

function zeroComponents(): Components {
  return {
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
}

function addComponents(left: Components, right: Components): Components {
  const add = (a: number | null, b: number | null): number | null =>
    a === null || b === null || !Number.isSafeInteger(a + b) ? null : a + b;
  return {
    uncachedInput: add(left.uncachedInput, right.uncachedInput),
    cacheRead: add(left.cacheRead, right.cacheRead),
    cacheWrite: add(left.cacheWrite, right.cacheWrite),
    output: add(left.output, right.output),
    reasoning: add(left.reasoning, right.reasoning),
    total: add(left.total, right.total),
  };
}

function subtractComponents(left: Components, right: Components): { value: Components; inconsistent: boolean } {
  let inconsistent = false;
  const subtract = (a: number | null, b: number | null): number | null => {
    if (a === null || b === null) return null;
    if (b > a) {
      inconsistent = true;
      return null;
    }
    return a - b;
  };
  const value = {
    uncachedInput: subtract(left.uncachedInput, right.uncachedInput),
    cacheRead: subtract(left.cacheRead, right.cacheRead),
    cacheWrite: subtract(left.cacheWrite, right.cacheWrite),
    output: subtract(left.output, right.output),
    reasoning: subtract(left.reasoning, right.reasoning),
    total: subtract(left.total, right.total),
  };
  return { value, inconsistent };
}

function hasDecrease(current: Components, previous: Components): boolean {
  return COMPONENT_KEYS.some((key) => {
    const now = current[key];
    const before = previous[key];
    return now !== null && before !== null && now < before;
  });
}

function hasPositive(components: Components): boolean {
  return COMPONENT_KEYS.some((key) => {
    const value = components[key];
    return value !== null && value > 0;
  });
}

/** Normalize one Codex usage object without retaining any source payload fields. */
export function normalizeCodexUsage(value: unknown): { components: Components; quality: Quality; reasons: string[] } {
  const usage = object(value);
  if (!usage) {
    return {
      components: {
        uncachedInput: null,
        cacheRead: null,
        cacheWrite: null,
        output: null,
        reasoning: null,
        total: null,
      },
      quality: "partial",
      reasons: ["parse-gap"],
    };
  }

  const input = safeInteger(usage.input_tokens);
  const cacheRead = safeInteger(usage.cached_input_tokens);
  const cacheWrite = safeInteger(usage.cache_write_input_tokens);
  const output = safeInteger(usage.output_tokens);
  const reasoning = safeInteger(usage.reasoning_output_tokens);
  const total = safeInteger(usage.total_tokens);
  const reasons: string[] = [];

  let uncachedInput: number | null = null;
  if (input !== null && cacheRead !== null && cacheWrite !== null) {
    const candidate = input - cacheRead - cacheWrite;
    const reconciles =
      candidate >= 0 &&
      (cacheWrite === 0
        ? total === null || total === input + (output ?? 0)
        : total !== null && total === input + (output ?? 0));
    if (reconciles) uncachedInput = candidate;
    else reasons.push("parse-gap");
  } else {
    reasons.push("parse-gap");
  }

  if (reasoning !== null && output !== null && reasoning > output) reasons.push("parse-gap");
  if (total !== null && input !== null && output !== null && total !== input + output) reasons.push("parse-gap");

  const components: Components = {
    uncachedInput,
    cacheRead,
    cacheWrite,
    output,
    reasoning: reasoning !== null && output !== null && reasoning <= output ? reasoning : null,
    total,
  };
  return { components, quality: reasons.length === 0 ? "recorded" : "partial", reasons: [...new Set(reasons)] };
}

class CodexNormalizer {
  readonly sessions: SessionRecord[] = [];
  readonly usage = new Map<string, UsageRecord>();
  readonly workIntervals = new Map<string, WorkInterval>();
  readonly counterSnapshots: CounterSnapshot[] = [];
  readonly inputs: InputRecord[] = [];
  readonly diagnosticCounts: Record<string, number> = {};
  readonly reasons = new Set<string>();
  unallocatedUsageRecords = 0;
  private readonly inputReasons = new Set<string>();
  private readonly verifiedInputIds = new Set<string>();
  private readonly unsupportedInputIds = new Set<string>();
  private sawUnkeyedUnsupportedInputProjection = false;

  private readonly state: ContextState;

  constructor(options: CodexNormalizationOptions = {}) {
    this.state = {
      sourceKey: options.sourceKey ?? "codex:jsonl",
      completeHistory: options.completeHistory ?? true,
      cutoffMs: options.cutoffMs ?? Number.MAX_SAFE_INTEGER,
      parentBySession: options.parentBySession ?? new Map(),
      sessionKey: null,
      canonicalSessionKey: null,
      parentSessionKey: null,
      workspaceKey: null,
      provider: UNKNOWN,
      model: UNKNOWN,
      controller: null,
      turnKey: null,
      sessionByRolloutPath: options.sessionByRolloutPath ?? new Map(),
      startedAtMs: null,
      endedAtMs: null,
      sawHeader: false,
      inheritedHistory: false,
      cumulative: null,
      cumulativeAtMs: null,
      cumulativeEpoch: 0,
      modernSinceCheckpoint: zeroComponents(),
    };
  }

  parseGap(reason = "parse-gap"): void {
    increment(this.diagnosticCounts, reason);
    this.reasons.add(reason);
  }

  accept(recordValue: unknown): void {
    const record = object(recordValue);
    if (!record) {
      this.parseGap();
      return;
    }
    const type = stringValue(record.type);
    const payload = object(record.payload);
    const atMs = instantMs(record.timestamp);
    if (!type || !payload) {
      this.parseGap();
      return;
    }
    if (atMs !== null && atMs > this.state.cutoffMs) return;
    if (atMs !== null) {
      this.state.startedAtMs = this.state.startedAtMs === null ? atMs : Math.min(this.state.startedAtMs, atMs);
      this.state.endedAtMs = this.state.endedAtMs === null ? atMs : Math.max(this.state.endedAtMs, atMs);
    }

    if (type === "session_meta") {
      this.acceptHeader(record, payload, atMs);
      return;
    }
    if (!this.state.sawHeader) {
      this.parseGap("unsupported-schema");
      return;
    }
    if (type === "response_item" && payload.type === "message" && payload.role === "user") {
      this.acceptInput(payload, atMs);
      return;
    }
    if (type === "event_msg" && payload.type === "user_message") {
      this.noteUnsupportedInputProjection(payload);
      return;
    }
    if (type === "turn_context") {
      this.state.model = stringValue(payload.model) ?? UNKNOWN;
      this.state.turnKey = stringValue(payload.turn_id) ?? stringValue(record.turn_id);
      this.state.workspaceKey = stringValue(payload.cwd) ?? this.state.workspaceKey;
      return;
    }
    if (type === "token_usage_record") {
      this.acceptModern(record, payload, atMs);
      return;
    }
    if (type === "event_msg" && payload.type === "token_count") {
      this.acceptCumulative(record, payload, atMs);
      return;
    }
    if (type === "event_msg" && payload.type === "item_completed") {
      const item = object(payload.item);
      if (normalizedItemType(item?.type) === "usermessage") {
        this.noteUnsupportedInputProjection(payload, item);
      }
      this.acceptTimedItem(record, payload);
    }
  }

  finish(): CodexNormalizationResult {
    const state = this.state;
    if (state.sawHeader && state.sessionKey) {
      const reasons = state.workspaceKey ? [] : ["unattributed-session"];
      let rootSessionKey = state.sessionKey;
      const seen = new Set<string>();
      while (!seen.has(rootSessionKey)) {
        seen.add(rootSessionKey);
        const parent = state.parentBySession.get(rootSessionKey);
        if (!parent) break;
        rootSessionKey = parent;
      }
      this.sessions.push({
        agent: AGENT,
        sessionKey: state.sessionKey,
        originKey: `codex:native-session:${hash(state.sessionKey)}`,
        sourceKey: state.sourceKey,
        canonicalSessionKey: state.canonicalSessionKey ?? state.sessionKey,
        parentSessionKey: state.parentSessionKey,
        rootSessionKey,
        workspaceKey: state.workspaceKey,
        repositoryKey: null,
        startedAtMs: state.startedAtMs,
        endedAtMs: state.endedAtMs,
        quality: reasons.length === 0 ? "recorded" : "partial",
        reasons,
      });
    }
    const snapshotAtMs = state.cumulativeAtMs ?? state.startedAtMs;
    if (state.cumulative && state.sessionKey && snapshotAtMs !== null) {
      this.counterSnapshots.push({
        sourceKey: state.sourceKey,
        counterKey: `codex:cumulative:${state.canonicalSessionKey ?? state.sessionKey}`,
        epoch: state.cumulativeEpoch,
        sessionKey: state.sessionKey,
        workspaceKey: state.workspaceKey,
        repositoryKey: null,
        provider: state.provider,
        model: state.model,
        observedAtMs: snapshotAtMs,
        ...state.cumulative,
        costMicrousd: null,
        quality: this.reasons.has("counter-discontinuity") || this.reasons.has("unallocated-history") ? "partial" : "recorded",
        reasons: [...this.reasons].filter((reason) => reason === "counter-discontinuity" || reason === "unallocated-history"),
      });
    }
    if (
      this.sawUnkeyedUnsupportedInputProjection
      || [...this.unsupportedInputIds].some((inputId) => !this.verifiedInputIds.has(inputId))
    ) {
      this.inputReasons.add("input-history-incomplete");
    }
    const mergedInputs = mergeInputRecords(this.inputs);
    return {
      sessions: this.sessions,
      usage: [...this.usage.values()],
      workIntervals: [...this.workIntervals.values()],
      counterSnapshots: this.counterSnapshots,
      inputs: mergedInputs,
      inputQuality: this.inputReasons.size === 0 ? "recorded" : "partial",
      inputReasons: [...this.inputReasons].sort(),
      diagnosticCounts: this.diagnosticCounts,
      reasons: [...this.reasons].sort(),
      unallocatedUsageRecords: this.unallocatedUsageRecords,
    };
  }

  private acceptHeader(record: UnknownRecord, payload: UnknownRecord, atMs: number | null): void {
    const version = payload.version ?? record.version;
    if (version !== undefined && version !== 1 && version !== "1") {
      this.parseGap("unsupported-schema");
      return;
    }
    const sessionKey =
      stringValue(payload.id) ?? stringValue(payload.session_id) ?? stringValue(record.session_id);
    if (!sessionKey) {
      this.parseGap("unsupported-schema");
      return;
    }
    this.state.sawHeader = true;
    this.state.sessionKey = sessionKey;
    this.state.workspaceKey = stringValue(payload.cwd);
    this.state.provider = stringValue(payload.model_provider) ?? UNKNOWN;
    const originator = stringValue(payload.originator);
    this.state.controller = originator !== null && originator.length <= 128 ? originator : null;
    this.state.parentSessionKey = this.state.parentBySession.get(sessionKey) ?? null;
    const previous: unknown[] = Array.isArray(payload.previousSessionFiles)
      ? payload.previousSessionFiles
      : [];
    this.state.inheritedHistory = previous.length > 0;
    const previousOriginal = previous
      .map((value: unknown) => stringValue(value))
      .filter((value: string | null): value is string => value !== null)
      .map((value: string) => this.state.sessionByRolloutPath.get(resolve(value)))
      .find((value: string | undefined) => value !== undefined);
    this.state.canonicalSessionKey =
      stringValue(payload.origin_session_id) ??
      stringValue(payload.root_session_id) ??
      previousOriginal ??
      sessionKey;
    this.state.startedAtMs = atMs ?? instantMs(payload.timestamp) ?? this.state.startedAtMs;
  }

  private acceptInput(payload: UnknownRecord, atMs: number | null): void {
    if (!this.state.sessionKey) return;
    const nativeInputId = stringValue(payload.id);
    if (nativeInputId === null) {
      this.sawUnkeyedUnsupportedInputProjection = true;
      this.inputReasons.add("input-history-incomplete");
      return;
    }
    this.verifiedInputIds.add(nativeInputId);
    const metadata = object(payload.internal_chat_message_metadata_passthrough);
    const rawKinds = metadata?.content_item_kinds;
    const kinds = Array.isArray(rawKinds)
      ? rawKinds.filter((kind): kind is string => typeof kind === "string")
      : [];
    const contextKinds: Record<string, true> = {
      "plugins.recommendations": true,
      "agents_md.instructions": true,
      "environments.environment_context": true,
      "skills.selected_skill_instructions": true,
    };
    let kind: InputRecord["kind"] = "unknown";
    if (kinds.includes("user.text")) kind = "submission";
    else if (kinds.length > 0 && kinds.length === (rawKinds as unknown[]).length && kinds.every((value) => contextKinds[value])) {
      kind = "context";
    }
    const reasons = kind === "unknown" ? ["input-kind-unknown"] : [];
    if (kind === "unknown") this.inputReasons.add("input-kind-unknown");
    this.inputs.push({
      originKey: `codex:input:${hash(nativeInputId)}`,
      sourceKey: this.state.sourceKey,
      agent: AGENT,
      sessionKey: this.state.sessionKey,
      nativeSessionId: this.state.sessionKey,
      nativeInputId,
      workspaceKey: this.state.workspaceKey ?? `codex:unattributed:${hash(this.state.sessionKey)}`,
      repositoryKey: null,
      atMs,
      kind,
      lane: this.state.parentSessionKey === null ? "main" : "subagent",
      controller: this.state.controller,
      origin: "unknown",
      originEvidence: "none",
      quality: kind === "unknown" ? "partial" : "recorded",
      reasons,
    });
  }

  private noteUnsupportedInputProjection(
    payload: UnknownRecord,
    item: UnknownRecord | null = null,
  ): void {
    const nativeInputId = stringValue(item?.id) ?? stringValue(payload.id);
    if (nativeInputId === null) this.sawUnkeyedUnsupportedInputProjection = true;
    else this.unsupportedInputIds.add(nativeInputId);
  }

  private acceptModern(record: UnknownRecord, payload: UnknownRecord, atMs: number | null): void {
    if (!this.state.sessionKey) return;
    const normalized = normalizeCodexUsage(payload.usage);
    if (normalized.quality === "partial") this.parseGap();
    const provider = stringValue(payload.model_provider) ?? this.state.provider;
    const model = stringValue(payload.model) ?? this.state.model;
    const responseId = stringValue(payload.response_id);
    const threadId = stringValue(payload.thread_id) ?? this.state.canonicalSessionKey ?? this.state.sessionKey;
    const turnKey = stringValue(payload.turn_id) ?? this.state.turnKey;
    const requestKey = responseId;
    const ordinal = safeInteger(record.ordinal);
    const fallbackIdentity = [threadId, turnKey, ordinal, atMs, normalized.components];
    const originKey = responseId
      ? `codex:response:${hash(provider, responseId)}`
      : `codex:event:${hash(...fallbackIdentity)}`;
    const missingAccountingTime = atMs === null;
    const usage: UsageRecord = {
      originKey,
      agent: AGENT,
      sessionKey: this.state.sessionKey,
      workspaceKey: this.state.workspaceKey ?? "unattributed",
      repositoryKey: null,
      turnKey,
      requestKey,
      atMs,
      provider,
      model,
      ...normalized.components,
      costMicrousd: null,
      costKind: "unknown",
      quality: normalized.quality === "partial" || missingAccountingTime ? "partial" : "recorded",
      reasons: [...new Set([...normalized.reasons, ...(missingAccountingTime ? ["unallocated-history"] : [])])],
    };
    const existing = this.usage.get(originKey);
    if (!existing) {
      this.usage.set(originKey, usage);
      this.state.modernSinceCheckpoint = addComponents(this.state.modernSinceCheckpoint, normalized.components);
    } else {
      const same = COMPONENT_KEYS.every((key) => existing[key] === usage[key]);
      if (!same) {
        this.parseGap();
        const existingCompleteness = COMPONENT_KEYS.filter((key) => existing[key] !== null).length;
        const nextCompleteness = COMPONENT_KEYS.filter((key) => usage[key] !== null).length;
        const selected = nextCompleteness >= existingCompleteness ? usage : existing;
        if (selected === usage) {
          const previousComponents: Components = {
            uncachedInput: existing.uncachedInput,
            cacheRead: existing.cacheRead,
            cacheWrite: existing.cacheWrite,
            output: existing.output,
            reasoning: existing.reasoning,
            total: existing.total,
          };
          const revision = subtractComponents(normalized.components, previousComponents);
          if (revision.inconsistent) this.parseGap();
          else this.state.modernSinceCheckpoint = addComponents(this.state.modernSinceCheckpoint, revision.value);
        }
        this.usage.set(originKey, {
          ...selected,
          sessionKey: existing.sessionKey,
          workspaceKey: existing.workspaceKey,
          repositoryKey: existing.repositoryKey,
          turnKey: existing.turnKey,
          atMs: existing.atMs,
          quality: "partial",
          reasons: [...new Set([...existing.reasons, ...usage.reasons, "parse-gap"])],
        });
      }
    }
    if (!existing && missingAccountingTime) {
      this.unallocatedUsageRecords += 1;
      this.parseGap("unallocated-history");
    }
  }

  private acceptCumulative(record: UnknownRecord, payload: UnknownRecord, atMs: number | null): void {
    if (!this.state.sessionKey) return;
    const info = object(payload.info);
    const cumulativeUsage = object(info?.total_token_usage);
    if (cumulativeUsage === null) return;
    const normalized = normalizeCodexUsage(cumulativeUsage);
    if (COMPONENT_KEYS.every((key) => normalized.components[key] === null)) return;
    if (normalized.quality === "partial") this.parseGap();
    const current = normalized.components;
    const previous = this.state.cumulative;

    if (previous === null) {
      if (!this.state.completeHistory || this.state.inheritedHistory) {
        this.state.cumulative = current;
        this.state.cumulativeAtMs = atMs;
        this.state.modernSinceCheckpoint = zeroComponents();
        this.unallocatedUsageRecords += 1;
        this.parseGap("unallocated-history");
        return;
      }
      this.emitLegacyRemainder(record, current, this.state.modernSinceCheckpoint, atMs);
    } else if (hasDecrease(current, previous)) {
      this.state.cumulativeEpoch += 1;
      this.state.modernSinceCheckpoint = zeroComponents();
      this.parseGap("counter-discontinuity");
      this.state.cumulative = current;
      this.state.cumulativeAtMs = atMs;
      return;
    } else {
      const delta = subtractComponents(current, previous);
      if (delta.inconsistent) {
        this.parseGap();
      } else {
        this.emitLegacyRemainder(record, delta.value, this.state.modernSinceCheckpoint, atMs);
      }
    }
    this.state.cumulative = current;
    this.state.cumulativeAtMs = atMs;
    this.state.modernSinceCheckpoint = zeroComponents();
  }

  private emitLegacyRemainder(
    record: UnknownRecord,
    delta: Components,
    modern: Components,
    atMs: number | null,
  ): void {
    const remainder = subtractComponents(delta, modern);
    if (remainder.inconsistent) {
      this.parseGap();
      return;
    }
    if (!hasPositive(remainder.value) || !this.state.sessionKey) return;
    const ordinal = safeInteger(record.ordinal);
    const originKey = `codex:legacy:${hash(
      this.state.canonicalSessionKey ?? this.state.sessionKey,
      this.state.cumulativeEpoch,
      ordinal,
      atMs,
      delta,
    )}`;
    const incompleteComponents = COMPONENT_KEYS.some((key) => remainder.value[key] === null);
    const reasons = [
      ...(incompleteComponents ? ["parse-gap"] : []),
      ...(atMs === null ? ["unallocated-history"] : []),
    ];
    this.usage.set(originKey, {
      originKey,
      agent: AGENT,
      sessionKey: this.state.sessionKey,
      workspaceKey: this.state.workspaceKey ?? "unattributed",
      repositoryKey: null,
      turnKey: this.state.turnKey,
      requestKey: null,
      atMs,
      provider: this.state.provider,
      model: this.state.model,
      ...remainder.value,
      costMicrousd: null,
      costKind: "unknown",
      quality: reasons.length > 0 ? "partial" : "recorded",
      reasons,
    });
    if (incompleteComponents) this.parseGap();
    if (atMs === null) {
      this.unallocatedUsageRecords += 1;
      this.parseGap("unallocated-history");
    }
  }

  private acceptTimedItem(record: UnknownRecord, payload: UnknownRecord): void {
    if (!this.state.sessionKey) return;
    const item = object(payload.item) ?? payload;
    const itemType = normalizedItemType(item.type ?? payload.item_type);
    const name = normalizedItemType(item.name ?? item.tool_name);
    const classification = SUPPORTED_ITEM_TYPES[itemType];
    if (EXCLUDED_ITEM_TYPES[itemType] || EXCLUDED_ITEM_TYPES[name] || !classification) return;

    const startMs = safeInteger(item.started_at_ms) ?? safeInteger(payload.started_at_ms);
    const endMs = safeInteger(item.completed_at_ms) ?? safeInteger(payload.completed_at_ms);
    if (startMs === null || endMs === null) {
      this.parseGap("open-interval");
      return;
    }
    if (endMs <= startMs) {
      this.parseGap("timing-unavailable");
      return;
    }
    if (startMs > this.state.cutoffMs) return;
    const clippedEnd = Math.min(endMs, this.state.cutoffMs);
    if (clippedEnd <= startMs) return;
    const itemId = stringValue(item.id) ?? stringValue(payload.item_id) ?? stringValue(record.id);
    const originKey = `codex:item:${hash(
      this.state.canonicalSessionKey ?? this.state.sessionKey,
      itemId ?? safeInteger(record.ordinal),
      itemType,
      startMs,
      endMs,
    )}`;
    this.workIntervals.set(originKey, {
      originKey,
      agent: AGENT,
      sessionKey: this.state.sessionKey,
      workspaceKey: this.state.workspaceKey ?? "unattributed",
      repositoryKey: null,
      provider: classification === "inference" ? this.state.provider : null,
      model: classification === "inference" ? this.state.model : null,
      startMs,
      endMs: clippedEnd,
      kind: classification,
    });
  }
}

/** Normalize complete JSONL records. The final unterminated line is deliberately retained by the caller. */
export function normalizeCodexJsonl(
  text: string,
  options: CodexNormalizationOptions = {},
): CodexJsonlNormalizationResult {
  const normalizer = new CodexNormalizer(options);
  let completeByteOffset = 0;
  let cursor = 0;
  for (;;) {
    const newline = text.indexOf("\n", cursor);
    if (newline < 0) break;
    const line = text.slice(cursor, newline).replace(/\r$/, "");
    completeByteOffset += Buffer.byteLength(text.slice(cursor, newline + 1));
    cursor = newline + 1;
    if (!line.trim()) continue;
    try {
      normalizer.accept(JSON.parse(line));
    } catch {
      normalizer.parseGap();
    }
  }
  return { ...normalizer.finish(), completeByteOffset };
}

function configuredRoots(config?: Config): string[] {
  if (config && Object.prototype.hasOwnProperty.call(config.sources, AGENT)) {
    return config.sources.codex ?? [];
  }
  return [
    join(homedir(), ".codex", "sessions"),
    join(homedir(), ".codex", "archived_sessions"),
    join(homedir(), ".codex", "state_5.sqlite"),
  ];
}

function walkCodexSources(root: string, jsonl: string[], stateDatabases: string[]): void {
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (extname(root).toLowerCase() === ".jsonl") jsonl.push(resolve(root));
    else if (basename(root) === "state_5.sqlite") stateDatabases.push(resolve(root));
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    walkCodexSources(join(root, entry.name), jsonl, stateDatabases);
  }
}

function sourceInventory(config?: Config): { jsonl: string[]; stateDatabases: string[]; existingRoots: string[] } {
  const jsonl: string[] = [];
  const stateDatabases: string[] = [];
  const existingRoots: string[] = [];
  for (const selected of configuredRoots(config)) {
    const root = normalize(selected);
    if (!existsSync(root)) continue;
    existingRoots.push(resolve(root));
    let stat;
    try {
      stat = lstatSync(root);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (
      stat.isFile() &&
      (basename(root) === "state_5.sqlite" ||
        extname(root).toLowerCase() === ".sqlite" ||
        extname(root).toLowerCase() === ".db")
    ) {
      stateDatabases.push(resolve(root));
    } else {
      walkCodexSources(root, jsonl, stateDatabases);
    }
  }
  return {
    jsonl: [...new Set(jsonl)].sort(),
    stateDatabases: [...new Set(stateDatabases)].sort(),
    existingRoots: [...new Set(existingRoots)].sort(),
  };
}

function probeHeader(path: string): "recognized" | "unsupported" | "parse-gap" {
  let text: string;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const size = Math.min(Number(fstatSync(descriptor).size), 128 * 1024);
    const bytes = Buffer.alloc(size);
    if (size > 0) readSync(descriptor, bytes, 0, size, 0);
    text = bytes.toString("utf8");
  } catch {
    return "parse-gap";
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = object(JSON.parse(line));
      if (!record) return "unsupported";
      if (record.type !== "session_meta") continue;
      const payload = object(record.payload);
      if (
        !payload ||
        (!stringValue(payload.id) && !stringValue(payload.session_id) && !stringValue(record.session_id))
      ) return "unsupported";
      const version = payload.version ?? record.version;
      return version === undefined || version === 1 || version === "1" ? "recognized" : "unsupported";
    } catch {
      return "parse-gap";
    }
  }
  return "unsupported";
}

interface CodexStateMetadata {
  parentBySession: Map<string, string>;
  sessionByRolloutPath: Map<string, string>;
}
interface SqlNameRow {
  name: unknown;
}

interface CodexThreadRow {
  id: unknown;
  rollout_path: unknown;
}

interface CodexSpawnEdgeRow {
  parent_thread_id: unknown;
  child_thread_id: unknown;
}


function readStateMetadata(paths: readonly string[], diagnostics: Record<string, number>): CodexStateMetadata {
  const parentBySession = new Map<string, string>();
  const sessionByRolloutPath = new Map<string, string>();
  for (const path of paths) {
    let database: Database | null = null;
    try {
      database = new Database(path, { readonly: true });
      const tables = new Set(
        database
          .query<SqlNameRow, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row: SqlNameRow) => stringValue(row.name))
          .filter((name: string | null): name is string => name !== null),
      );
      if (tables.has("threads")) {
        const columns = new Set(
          database
            .query<SqlNameRow, []>("PRAGMA table_info(threads)")
            .all()
            .map((row: SqlNameRow) => stringValue(row.name))
            .filter((name: string | null): name is string => name !== null),
        );
        if (!columns.has("id") || !columns.has("rollout_path")) {
          increment(diagnostics, "unsupported-schema");
        } else {
          const threads = database
            .query<CodexThreadRow, []>(
              "SELECT id, rollout_path FROM threads WHERE rollout_path IS NOT NULL",
            )
            .all();
          for (const thread of threads) {
            const id = stringValue(thread.id);
            const rolloutPath = stringValue(thread.rollout_path);
            if (id && rolloutPath && isAbsolute(rolloutPath)) {
              sessionByRolloutPath.set(normalize(rolloutPath), id);
            }
          }
        }
      } else {
        increment(diagnostics, "unsupported-schema");
      }

      if (tables.has("thread_spawn_edges")) {
        const columns = new Set(
          database
            .query<SqlNameRow, []>("PRAGMA table_info(thread_spawn_edges)")
            .all()
            .map((row: SqlNameRow) => stringValue(row.name))
            .filter((name: string | null): name is string => name !== null),
        );
        if (!columns.has("parent_thread_id") || !columns.has("child_thread_id")) {
          increment(diagnostics, "unsupported-schema");
        } else {
          const edges = database
            .query<CodexSpawnEdgeRow, []>(
              "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges",
            )
            .all();
          for (const edge of edges) {
            const parent = stringValue(edge.parent_thread_id);
            const child = stringValue(edge.child_thread_id);
            if (parent && child) parentBySession.set(child, parent);
          }
        }
      }
    } catch {
      increment(diagnostics, "parse-gap");
    } finally {
      database?.close();
    }
  }
  return { parentBySession, sessionByRolloutPath };
}


function mergeCounts(target: Record<string, number>, source: Readonly<Record<string, number>>): void {
  for (const [name, count] of Object.entries(source)) target[name] = (target[name] ?? 0) + count;
}

export const codexAdapter: SourceAdapter = {
  agent: AGENT,

  async discover(config?: Config): Promise<DiscoveryEntry[]> {
    const roots = configuredRoots(config);
    if (roots.length === 0) {
      return [{
        agent: AGENT,
        state: "not-found",
        capabilities: { tokens: "unavailable", work: "unavailable" },
        paths: [],
        diagnosticCounts: { "missing-source": 1 },
        reasons: ["missing-source"],
      }];
    }
    const inventory = sourceInventory(config);
    const counts: Record<string, number> = {};
    let recognized = 0;
    for (const path of inventory.jsonl) {
      const result = probeHeader(path);
      if (result === "recognized") recognized += 1;
      else increment(counts, result);
    }
    readStateMetadata(inventory.stateDatabases, counts);
    if (inventory.existingRoots.length === 0) {
      return [{
        agent: AGENT,
        state: "not-found",
        capabilities: { tokens: "unavailable", work: "unavailable" },
        paths: [],
        diagnosticCounts: { "missing-source": 1 },
        reasons: ["missing-source"],
      }];
    }
    if (recognized === 0) {
      const unsupported = (counts["unsupported"] ?? 0) > 0 || (counts["unsupported-schema"] ?? 0) > 0;
      return [{
        agent: AGENT,
        state: unsupported ? "unsupported-schema" : "partial",
        capabilities: { tokens: "unavailable", work: "unavailable" },
        paths: [...inventory.jsonl, ...inventory.stateDatabases].sort(),
        diagnosticCounts: counts,
        reasons: [unsupported ? "unsupported-schema" : "parse-gap"],
      }];
    }
    const partial = Object.keys(counts).length > 0;
    const reasons = [
      ...(counts["parse-gap"] || counts.unsupported ? ["parse-gap"] : []),
      ...(counts["unsupported-schema"] ? ["unsupported-schema"] : []),
    ];
    return [{
      agent: AGENT,
      state: partial ? "partial" : "available",
      capabilities: { tokens: partial ? "partial" : "recorded", work: "partial" },
      paths: [...inventory.jsonl, ...inventory.stateDatabases].sort(),
      diagnosticCounts: counts,
      reasons,
    }];
  },

  async collect(context: AdapterContext): Promise<AdapterBatch> {
    const inventory = sourceInventory(context.config);
    const discovery = (await this.discover(context.config))[0]!;
    const diagnostics: Record<string, number> = { ...discovery.diagnosticCounts };
    const stateMetadata = readStateMetadata(inventory.stateDatabases, {});
    const usage = new Map<string, UsageRecord>();
    const intervals = new Map<string, WorkInterval>();
    const sessions = new Map<string, SessionRecord>();
    const snapshots: CounterSnapshot[] = [];
    const cursors: FileCursor[] = [];
    const reasons = new Set(discovery.reasons);
    const currentInputs: InputRecord[] = [];
    const inputReasons = new Set<string>();
    const priorInputState = context.store.getInputSourceState("codex");
    const forceInputBackfill = context.rebuild
      || context.reconcileAll
      || priorInputState === null
      || priorInputState.parser_version !== 1
      || priorInputState.last_successful_scan_ms === null;
    let successfulInputScans = 0;
    let unallocatedUsageRecords = 0;

    for (const path of inventory.jsonl) {
      if (probeHeader(path) !== "recognized") {
        inputReasons.add("input-history-incomplete");
        continue;
      }
      const sourceKey = `codex:file:${hash(resolve(path))}`;
      const makeNormalizer = () => new CodexNormalizer({
        sourceKey,
        completeHistory: true,
        cutoffMs: context.cutoffMs,
        parentBySession: stateMetadata.parentBySession,
        sessionByRolloutPath: stateMetadata.sessionByRolloutPath,
      });
      try {
        const pathKey = sourcePathKey(sourceKey, resolve(path));
        const previousCursor = context.rebuild || context.reconcileAll || forceInputBackfill
          ? null
          : context.store.getFileCursor(sourceKey, pathKey);
        let normalizer = makeNormalizer();
        let scan = await scanJsonl({
          sourceKey,
          pathKey,
          path,
          previousCursor,
          onRecord: (record) => normalizer.accept(record),
        });
        let result = normalizer.finish();
        if (previousCursor && !scan.diagnostics.replayed && scan.diagnostics.acceptedRecords > 0) {
          normalizer = makeNormalizer();
          scan = await scanJsonl({
            sourceKey,
            pathKey,
            path,
            onRecord: (record) => normalizer.accept(record),
          });
          result = normalizer.finish();
        }
        cursors.push(scan.cursor);
        mergeCounts(diagnostics, result.diagnosticCounts);
        for (const reason of result.reasons) reasons.add(reason);
        for (const reason of result.inputReasons) inputReasons.add(reason);
        currentInputs.push(...result.inputs);
        successfulInputScans += 1;
        if (result.usage.length > 0 && result.workIntervals.length === 0) {
          increment(diagnostics, "timing-unavailable");
          reasons.add("timing-unavailable");
        }
        if (scan.diagnostics.parseGaps > 0) {
          diagnostics["parse-gap"] = (diagnostics["parse-gap"] ?? 0) + scan.diagnostics.parseGaps;
          reasons.add("parse-gap");
          inputReasons.add("input-history-incomplete");
        }
        if (scan.diagnostics.unsupportedSchema > 0) {
          diagnostics["unsupported-schema"] =
            (diagnostics["unsupported-schema"] ?? 0) + scan.diagnostics.unsupportedSchema;
          reasons.add("unsupported-schema");
          inputReasons.add("input-history-incomplete");
        }
        unallocatedUsageRecords += result.unallocatedUsageRecords;
        for (const session of result.sessions) sessions.set(session.sessionKey, session);
        for (const record of result.usage) {
          const stored = context.store.getUsage(record.originKey);
          const canonicalRecord: UsageRecord = stored
            ? {
                ...record,
                sessionKey: typeof stored.session_key === "string" ? stored.session_key : record.sessionKey,
                workspaceKey: typeof stored.workspace_key === "string" ? stored.workspace_key : record.workspaceKey,
                repositoryKey:
                  typeof stored.repository_key === "string" ? stored.repository_key : record.repositoryKey,
                turnKey: typeof stored.turn_key === "string" ? stored.turn_key : record.turnKey,
                requestKey: typeof stored.request_key === "string" ? stored.request_key : record.requestKey,
                atMs: typeof stored.at_ms === "number" ? stored.at_ms : record.atMs,
              }
            : record;
          const existing = usage.get(record.originKey);
          if (!existing) usage.set(record.originKey, canonicalRecord);
          else if (JSON.stringify(existing) !== JSON.stringify(canonicalRecord)) {
            usage.set(record.originKey, {
              ...existing,
              quality: "partial",
              reasons: [...new Set([...existing.reasons, ...canonicalRecord.reasons, "parse-gap"])],
            });
            increment(diagnostics, "parse-gap");
            reasons.add("parse-gap");
          }
        }
        for (const interval of result.workIntervals) intervals.set(interval.originKey, interval);
        snapshots.push(...result.counterSnapshots);
      } catch {
        increment(diagnostics, "parse-gap");
        reasons.add("parse-gap");
        inputReasons.add("input-history-incomplete");
      }
    }
    if (successfulInputScans === 0) {
      inputReasons.add(inventory.jsonl.length === 0 ? "missing-source" : "input-history-incomplete");
    }
    if (!forceInputBackfill && priorInputState?.quality === "partial") {
      for (const reason of storedInputReasons(priorInputState)) inputReasons.add(reason);
    }
    const inputs = mergeInputRecords(
      currentInputs,
      retainedInputRecords(context.store, currentInputs.map((record) => record.originKey)),
    ).map((record) => ({ ...record, sourceKey: "codex" }));
    if (inputs.some((input) => input.kind === "unknown")) inputReasons.add("input-kind-unknown");
    const previousSuccessfulScan = typeof priorInputState?.last_successful_scan_ms === "number"
      ? priorInputState.last_successful_scan_ms
      : null;
    const inputQuality: Quality = successfulInputScans === 0
      ? "unavailable"
      : inputReasons.size > 0 ? "partial" : "recorded";
    const coherentInputScan = inventory.jsonl.length > 0
      && successfulInputScans === inventory.jsonl.length
      && inputReasons.size === 0;
    const inputSourceState = {
      sourceKey: "codex",
      agent: AGENT,
      parserVersion: 1 as const,
      quality: inputQuality,
      reasons: [...inputReasons].sort(),
      scannedAtMs: context.cutoffMs,
      lastSuccessfulScanMs: coherentInputScan ? context.cutoffMs : previousSuccessfulScan,
    };

    const state = discovery.state === "available" && reasons.size > 0 ? "partial" : discovery.state;
    const tokenQuality: Quality = usage.size === 0
      ? discovery.capabilities.tokens
      : reasons.has("parse-gap") || reasons.has("counter-discontinuity") || reasons.has("unallocated-history")
        ? "partial"
        : "recorded";
    const workQuality: Quality = intervals.size === 0
      ? inventory.jsonl.length > 0 ? "partial" : discovery.capabilities.work
      : reasons.has("open-interval") || reasons.has("timing-unavailable") || reasons.has("parse-gap")
        ? "partial"
        : "recorded";
    const now = Date.now();
    const source: SourceRecord = {
      sourceKey: "codex",
      agent: AGENT,
      kind: "jsonl",
      sourcePath: null,
      state,
      tokenQuality,
      workQuality,
      reasons: [...reasons].sort(),
      diagnosticCounts: diagnostics,
      schemaVersion: "session_meta/1",
      lastSeenMs: inventory.jsonl.length > 0 ? now : null,
      lastSuccessfulScanMs: inventory.jsonl.length > 0 ? now : null,
      cutoffMs: context.cutoffMs,
    };

    return {
      source,
      sessions: [...sessions.values()],
      usage: [...usage.values()],
      workIntervals: [...intervals.values()],
      inputs,
      inputSourceState,
      counterSnapshots: snapshots,
      fileCursors: cursors,
      unallocatedUsageRecords,
      excludedAmbiguousRecords: 0,
    };
  },
};
