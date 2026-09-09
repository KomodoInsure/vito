import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, normalize } from "node:path";

import { configuredSourcePaths, type Config } from "../config";
import type { InputRecord, Quality, UsageRecord } from "../contracts";
import { mergeInputRecords, retainedInputRecords, storedInputReasons } from "../inputs";
import type { FileCursor, SessionRecord } from "../store";
import { scanJsonl, sourcePathKey } from "./jsonl";
import type { AdapterBatch, AdapterContext, DiscoveryEntry, SourceAdapter } from "./types";

const AGENT = "claude" as const;
const SOURCE_KEY = "claude:projects";
const UNATTRIBUTED_WORKSPACE = "claude:unattributed";

export interface ClaudeRawRecord {
  record: unknown;
  sourcePath: string;
  lineNumber: number;
  sourceCreatedMs?: number;
}

export interface ClaudeNormalization {
  sessions: SessionRecord[];
  usage: UsageRecord[];
  inputs: InputRecord[];
  inputQuality: Quality;
  inputReasons: string[];
  workIntervals: [];
  diagnosticCounts: Record<string, number>;
  unallocatedUsageRecords: number;
  excludedAmbiguousRecords: number;
}

interface ObjectRecord {
  [key: string]: unknown;
}

interface SessionObservation {
  sessionKey: string;
  sourceKey: string;
  rawSessionId: string;
  rawAgentId: string | null;
  parentSessionKey: string | null;
  workspaceKey: string | null;
  atMs: number | null;
  sourcePath: string;
  sourceCreatedMs: number;
  lineNumber: number;
}

interface ParsedCounters {
  uncachedInput: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
  complete: boolean;
  partial: boolean;
}

interface ResponseObservation {
  originKey: string;
  requestKey: string | null;
  messageId: string | null;
  session: SessionObservation;
  atMs: number | null;
  provider: string;
  model: string;
  counters: ParsedCounters;
  partialIdentity: boolean;
  sequence: number;
}

function object(value: unknown): ObjectRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ObjectRecord) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function digest(...parts: Array<string | null>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part ?? "").update("\0");
  return hash.digest("hex");
}

function laneKey(sessionId: string, agentId: string | null): string {
  return `claude:session:${digest(sessionId, agentId ?? "main")}`;
}

function parentLaneKey(sessionId: string): string {
  return laneKey(sessionId, null);
}

function finiteSum(values: readonly number[]): number | null {
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isSafeInteger(result)) return null;
  }
  return result;
}

/** Normalize Claude's disjoint prompt buckets without adding the reasoning subset twice. */
export function normalizeClaudeUsage(value: unknown): ParsedCounters {
  const usage = object(value);
  if (!usage) {
    return {
      uncachedInput: null,
      cacheRead: null,
      cacheWrite: null,
      output: null,
      reasoning: null,
      total: null,
      complete: false,
      partial: true,
    };
  }

  const uncachedInput = counter(usage.input_tokens);
  const cacheRead = counter(usage.cache_read_input_tokens);
  const cacheWrite = counter(usage.cache_creation_input_tokens);
  const output = counter(usage.output_tokens);
  const details = object(usage.output_tokens_details);
  let reasoning = details ? counter(details.thinking_tokens) : null;
  let partial = false;

  if (details && Object.prototype.hasOwnProperty.call(details, "thinking_tokens") && reasoning === null) partial = true;
  if (reasoning !== null && (output === null || reasoning > output)) {
    reasoning = null;
    partial = true;
  }

  const complete = uncachedInput !== null && cacheRead !== null && cacheWrite !== null && output !== null;
  const total = complete ? finiteSum([uncachedInput, cacheRead, cacheWrite, output]) : null;
  if (!complete || total === null) partial = true;

  return { uncachedInput, cacheRead, cacheWrite, output, reasoning, total, complete: complete && total !== null, partial };
}
function compareSessionOwner(first: SessionObservation, second: SessionObservation): number {
  return (
    first.sourceCreatedMs - second.sourceCreatedMs ||
    first.sourcePath.localeCompare(second.sourcePath) ||
    first.lineNumber - second.lineNumber ||
    first.sessionKey.localeCompare(second.sessionKey)
  );
}


function compareOwner(first: ResponseObservation, second: ResponseObservation): number {
  return (
    first.session.sourceCreatedMs - second.session.sourceCreatedMs ||
    first.session.sourcePath.localeCompare(second.session.sourcePath) ||
    first.session.lineNumber - second.session.lineNumber ||
    first.session.sessionKey.localeCompare(second.session.sessionKey)
  );
}

function compareRevision(first: ResponseObservation, second: ResponseObservation): number {
  return (
    (first.atMs ?? -1) - (second.atMs ?? -1) ||
    first.sequence - second.sequence ||
    first.session.sourcePath.localeCompare(second.session.sourcePath) ||
    first.session.lineNumber - second.session.lineNumber
  );
}

function countersDiffer(first: ParsedCounters, second: ParsedCounters): boolean {
  return (
    first.uncachedInput !== second.uncachedInput ||
    first.cacheRead !== second.cacheRead ||
    first.cacheWrite !== second.cacheWrite ||
    first.output !== second.output ||
    first.reasoning !== second.reasoning ||
    first.total !== second.total
  );
}

function eventWorkspace(record: ObjectRecord): string | null {
  const cwd = text(record.cwd);
  return cwd === null ? null : normalize(cwd);
}

function responseFrom(raw: ClaudeRawRecord, sequence: number, cutoffMs: number): ResponseObservation | null {
  const record = object(raw.record);
  if (!record || record.type !== "assistant") return null;
  const message = object(record.message);
  const usage = message && object(message.usage);
  if (!message || !usage) return null;

  const sessionId = text(record.sessionId);
  if (!sessionId) return null;
  const agentId = text(record.agentId);
  const atMs = timestamp(record.timestamp);
  if (atMs !== null && atMs > cutoffMs) return null;

  const requestId = text(record.requestId);
  const messageId = text(message.id);
  const fallbackId = text(record.uuid);
  if (requestId === null && messageId === null && fallbackId === null) return null;
  const partialIdentity = requestId === null || messageId === null;
  const identity = partialIdentity
    ? digest(requestId, messageId, fallbackId, raw.sourcePath, String(raw.lineNumber))
    : digest(requestId, messageId);
  const sessionKey = laneKey(sessionId, agentId);

  return {
    originKey: `claude:response:${identity}`,
    requestKey: requestId === null ? null : `claude:request:${digest(requestId)}`,
    messageId,
    session: {
      sessionKey,
      sourceKey: SOURCE_KEY,
      rawSessionId: sessionId,
      rawAgentId: agentId,
      parentSessionKey: agentId === null ? null : parentLaneKey(sessionId),
      workspaceKey: eventWorkspace(record),
      atMs,
      sourcePath: raw.sourcePath,
      sourceCreatedMs: raw.sourceCreatedMs ?? 0,
      lineNumber: raw.lineNumber,
    },
    atMs,
    provider: "unknown",
    model: text(message.model) ?? "unknown",
    counters: normalizeClaudeUsage(usage),
    partialIdentity,
    sequence,
  };
}

function sessionFromRecord(raw: ClaudeRawRecord): SessionObservation | null {
  const record = object(raw.record);
  if (!record) return null;
  const sessionId = text(record.sessionId);
  if (!sessionId) return null;
  const agentId = text(record.agentId);
  return {
    sessionKey: laneKey(sessionId, agentId),
    sourceKey: SOURCE_KEY,
    rawSessionId: sessionId,
    rawAgentId: agentId,
    parentSessionKey: agentId === null ? null : parentLaneKey(sessionId),
    workspaceKey: eventWorkspace(record),
    atMs: timestamp(record.timestamp),
    sourcePath: raw.sourcePath,
    sourceCreatedMs: raw.sourceCreatedMs ?? 0,
    lineNumber: raw.lineNumber,
  };
}

function inputFromRecord(raw: ClaudeRawRecord, cutoffMs: number): { input: InputRecord | null; reason: string | null } {
  const record = object(raw.record);
  const message = object(record?.message);
  if (!record || record.type !== "user" || message?.role !== "user") return { input: null, reason: null };
  const sessionId = text(record.sessionId);
  if (sessionId === null) return { input: null, reason: "input-history-incomplete" };
  const nativeInputId = text(record.uuid);
  if (nativeInputId === null) return { input: null, reason: "input-history-incomplete" };
  const atMs = timestamp(record.timestamp);
  if (atMs !== null && atMs > cutoffMs) return { input: null, reason: null };
  const agentId = text(record.agentId);
  const originKind = text(object(record.origin)?.kind);
  const content = message.content;
  let kind: InputRecord["kind"] = "unknown";
  let origin: InputRecord["origin"] = "unknown";
  let originEvidence: InputRecord["originEvidence"] = "none";

  const contentBlocks = Array.isArray(content) ? content.map(object) : null;
  const blockTypes = contentBlocks?.map((block) => text(block?.type));
  const toolOnly = blockTypes !== undefined
    && blockTypes.length > 0
    && blockTypes.every((type) => type === "tool_result" || type === "tool_use");
  if (record.toolUseResult !== undefined || toolOnly || originKind === "task-notification") {
    kind = "context";
  } else if (text(record.interruptedMessageId) !== null) {
    kind = "context";
  } else if (text(record.scheduledTaskId) !== null && text(record.scheduledFireId) !== null) {
    kind = "submission";
    origin = "automated";
    originEvidence = "source";
  } else if (originKind === "human") {
    kind = "submission";
    origin = "human";
    originEvidence = "source";
  } else if (originKind === "peer" || originKind === "coordinator" || originKind === "auto-continuation") {
    kind = "submission";
    origin = "automated";
    originEvidence = "source";
  } else if (record.isMeta === true || record.isSynthetic === true) {
    kind = "context";
  } else if (typeof content === "string") {
    kind = content.length > 0 ? "submission" : "context";
  } else if (contentBlocks !== null) {
    if (contentBlocks.length === 0 || toolOnly) {
      kind = "context";
    } else if (
      contentBlocks.every((block) => block !== null)
      && blockTypes?.every((type) => type === "text" || type === "image")
    ) {
      kind = "submission";
    }
  }

  const reason = kind === "unknown" ? "input-kind-unknown" : null;
  return {
    input: {
      originKey: `claude:input:${digest(nativeInputId)}`,
      sourceKey: SOURCE_KEY,
      agent: AGENT,
      sessionKey: laneKey(sessionId, agentId),
      nativeSessionId: sessionId,
      nativeInputId,
      workspaceKey: eventWorkspace(record) ?? `claude:unattributed:${digest(sessionId)}`,
      repositoryKey: null,
      atMs,
      kind,
      lane: record.isSidechain === true || agentId !== null ? "subagent" : "main",
      controller: null,
      origin,
      originEvidence,
      quality: kind === "unknown" ? "partial" : "recorded",
      reasons: reason === null ? [] : [reason],
    },
    reason,
  };
}

/**
 * Pure normalization over projected JSONL records. Raw transcript blocks are used
 * only during this call and never copied into a returned record.
 */
export function normalizeClaudeRecords(records: readonly ClaudeRawRecord[], cutoffMs = Number.MAX_SAFE_INTEGER): ClaudeNormalization {
  const sessionsByKey = new Map<string, SessionObservation[]>();
  const responsesByOrigin = new Map<string, ResponseObservation[]>();
  const inputCandidates: InputRecord[] = [];
  const inputReasons = new Set<string>();
  let ignoredParentSummaries = 0;
  let malformedUsage = 0;

  records.forEach((raw, sequence) => {
    const record = object(raw.record);
    if (!record) return;
    const normalizedInput = inputFromRecord(raw, cutoffMs);
    if (normalizedInput.input !== null) inputCandidates.push(normalizedInput.input);
    if (normalizedInput.reason !== null) inputReasons.add(normalizedInput.reason);
    const session = sessionFromRecord(raw);
    if (session && (session.atMs === null || session.atMs <= cutoffMs)) {
      const observations = sessionsByKey.get(session.sessionKey) ?? [];
      observations.push(session);
      sessionsByKey.set(session.sessionKey, observations);
    }

    if (record.type !== "assistant") {
      if (object(record.message)?.usage || object(object(record.toolUseResult)?.usage) || record.type === "cost-state") {
        ignoredParentSummaries += 1;
      }
      return;
    }

    const response = responseFrom(raw, sequence, cutoffMs);
    if (!response) {
      if (object(record.message)?.usage) malformedUsage += 1;
      return;
    }
    const observations = responsesByOrigin.get(response.originKey) ?? [];
    observations.push(response);
    responsesByOrigin.set(response.originKey, observations);
  });

  const selectedSessions = new Map<string, SessionObservation>();
  for (const [sessionKey, observations] of sessionsByKey) {
    const explicitWorkspace = observations
      .filter((entry) => entry.workspaceKey !== null)
      .sort(
        (first, second) =>
          (first.atMs ?? Number.MAX_SAFE_INTEGER) - (second.atMs ?? Number.MAX_SAFE_INTEGER) ||
          compareSessionOwner(first, second),
      )[0];
    const earliest = [...observations].sort(compareSessionOwner)[0]!;
    selectedSessions.set(sessionKey, explicitWorkspace ?? earliest);
  }

  for (const session of selectedSessions.values()) {
    if (session.workspaceKey !== null || session.parentSessionKey === null) continue;
    const parent = selectedSessions.get(session.parentSessionKey);
    if (parent?.workspaceKey) session.workspaceKey = parent.workspaceKey;
  }

  const sessions: SessionRecord[] = [...selectedSessions.values()]
    .map((session) => {
      const observations = sessionsByKey.get(session.sessionKey) ?? [session];
      let startedAtMs: number | null = null;
      let endedAtMs: number | null = null;
      for (const observation of observations) {
        if (observation.atMs === null) continue;
        startedAtMs = startedAtMs === null ? observation.atMs : Math.min(startedAtMs, observation.atMs);
        endedAtMs = endedAtMs === null ? observation.atMs : Math.max(endedAtMs, observation.atMs);
      }
      const workspaceKey = session.workspaceKey;
      return {
        agent: AGENT,
        sessionKey: session.sessionKey,
        originKey: `claude:lane:${digest(session.rawSessionId, session.rawAgentId ?? "main")}`,
        sourceKey: SOURCE_KEY,
        canonicalSessionKey: session.sessionKey,
        parentSessionKey: session.parentSessionKey,
        rootSessionKey: parentLaneKey(session.rawSessionId),
        workspaceKey,
        repositoryKey: null,
        startedAtMs,
        endedAtMs,
        quality: workspaceKey === null ? "partial" : "recorded",
        reasons: workspaceKey === null ? ["unattributed-session", "timing-unavailable"] : ["timing-unavailable"],
      } satisfies SessionRecord;
    })
    .sort((first, second) => first.sessionKey.localeCompare(second.sessionKey));

  const usage: UsageRecord[] = [];
  let duplicateObservations = 0;
  let forkCopies = 0;
  let inconsistentRevisions = 0;
  let unattributedSessions = 0;

  for (const observations of responsesByOrigin.values()) {
    duplicateObservations += Math.max(0, observations.length - 1);
    const distinctLanes = new Set(observations.map((entry) => entry.session.sessionKey));
    forkCopies += Math.max(0, distinctLanes.size - 1);

    const owner = [...observations].sort(compareOwner)[0]!;
    const complete = observations.filter((entry) => entry.counters.complete).sort(compareRevision);
    const selected = complete.at(-1) ?? [...observations].sort(compareRevision).at(-1)!;
    const firstTimes = observations.map((entry) => entry.atMs).filter((value): value is number => value !== null);
    const firstAtMs = firstTimes.length === 0 ? null : Math.min(...firstTimes);
    const conflictingComplete = complete.some((entry) => countersDiffer(entry.counters, selected.counters));
    if (conflictingComplete) inconsistentRevisions += 1;

    const ownerSession = selectedSessions.get(owner.session.sessionKey) ?? owner.session;
    const workspaceKey = owner.session.workspaceKey ?? ownerSession.workspaceKey ?? UNATTRIBUTED_WORKSPACE;
    if (workspaceKey === UNATTRIBUTED_WORKSPACE) unattributedSessions += 1;
    const reasons = new Set<string>();
    if (selected.counters.partial || selected.partialIdentity || conflictingComplete) reasons.add("parse-gap");
    if (workspaceKey === UNATTRIBUTED_WORKSPACE) reasons.add("unattributed-session");

    usage.push({
      originKey: selected.originKey,
      agent: AGENT,
      sessionKey: owner.session.sessionKey,
      workspaceKey,
      repositoryKey: null,
      turnKey: null,
      requestKey: selected.requestKey,
      atMs: firstAtMs,
      provider: selected.provider,
      model: selected.model,
      uncachedInput: selected.counters.uncachedInput,
      cacheRead: selected.counters.cacheRead,
      cacheWrite: selected.counters.cacheWrite,
      output: selected.counters.output,
      reasoning: selected.counters.reasoning,
      total: selected.counters.total,
      costMicrousd: null,
      costKind: "unknown",
      quality: reasons.size === 0 ? "recorded" : "partial",
      reasons: [...reasons].sort(),
    });
  }

  usage.sort((first, second) => first.originKey.localeCompare(second.originKey));
  const inputs = mergeInputRecords(inputCandidates).map((input) => {
    const owner = selectedSessions.get(input.sessionKey);
    if (owner?.workspaceKey) input.workspaceKey = owner.workspaceKey;
    return input;
  });
  if (inputs.some((input) => input.kind === "unknown")) inputReasons.add("input-kind-unknown");
  const unallocatedUsageRecords = usage.filter((entry) => entry.atMs === null).length;
  return {
    sessions,
    usage,
    inputs,
    inputQuality: inputReasons.size === 0 ? "recorded" : "partial",
    inputReasons: [...inputReasons].sort(),
    workIntervals: [],
    diagnosticCounts: {
      assistantResponses: usage.length,
      duplicateObservations,
      forkCopies,
      ignoredParentSummaries,
      inconsistentRevisions,
      malformedUsage,
      unattributedSessions,
    },
    unallocatedUsageRecords,
    excludedAmbiguousRecords: 0,
  };
}

function isRecognizedClaudeFile(path: string): boolean {
  if (extname(path) !== ".jsonl" || basename(path) === "history.jsonl") return false;
  const normalizedPath = normalize(path);
  const pieces = normalizedPath.split(/[\\/]/);
  if (pieces.some((piece) => piece === "tool-results" || piece === "local")) return false;
  const subagentsIndex = pieces.lastIndexOf("subagents");
  if (subagentsIndex >= 0) {
    return subagentsIndex === pieces.length - 2 && /^agent-[^/\\]+\.jsonl$/.test(basename(path));
  }
  return true;
}

async function collectRecognizedFiles(input: string): Promise<string[]> {
  let canonical: string;
  try {
    canonical = normalize(await realpath(input));
  } catch {
    return [];
  }
  const initial = await lstat(canonical);
  if (initial.isSymbolicLink()) return [];
  if (initial.isFile()) return isRecognizedClaudeFile(canonical) ? [canonical] : [];
  if (!initial.isDirectory()) return [];

  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const stream = await opendir(directory);
    for await (const entry of stream) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "tool-results" || entry.name === "local") continue;
        await visit(path);
      } else if (entry.isFile() && isRecognizedClaudeFile(path)) {
        files.push(normalize(await realpath(path)));
      }
    }
  }
  await visit(canonical);
  return files.sort();
}

async function sourceFiles(config?: Config): Promise<{ files: string[]; anyRoot: boolean; disabled: boolean }> {
  const conventional = [join(homedir(), ".claude", "projects")];
  const selected = config ? configuredSourcePaths(config, AGENT, conventional) : conventional;
  if (selected.length === 0) return { files: [], anyRoot: false, disabled: true };
  const groups = await Promise.all(
    selected.map(async (path) => {
      try {
        await lstat(path);
        return { exists: true, files: await collectRecognizedFiles(path) };
      } catch {
        return { exists: false, files: [] as string[] };
      }
    }),
  );
  return {
    files: [...new Set(groups.flatMap((group) => group.files))].sort(),
    anyRoot: groups.some((group) => group.exists),
    disabled: false,
  };
}

export async function discoverClaude(config?: Config): Promise<DiscoveryEntry[]> {
  const found = await sourceFiles(config);
  const state = found.files.length > 0 ? "available" : found.anyRoot && !found.disabled ? "installed-no-history" : "not-found";
  return [
    {
      agent: AGENT,
      state,
      capabilities: { tokens: found.files.length > 0 ? "recorded" : "unavailable", work: "unavailable" },
      paths: found.files,
      diagnosticCounts: { recognizedFiles: found.files.length },
      reasons: found.files.length > 0 ? ["timing-unavailable"] : ["missing-source", "timing-unavailable"],
    },
  ];
}

function parseReasons(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function storedSession(context: AdapterContext, sessionKey: string): SessionRecord | null {
  const row = context.store.database
    .query("SELECT * FROM sessions WHERE agent = ? AND session_key = ?")
    .get(AGENT, sessionKey) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    agent: AGENT,
    sessionKey: String(row.session_key),
    originKey: String(row.origin_key),
    sourceKey: String(row.source_key),
    canonicalSessionKey: row.canonical_session_key == null ? null : String(row.canonical_session_key),
    parentSessionKey: row.parent_session_key == null ? null : String(row.parent_session_key),
    rootSessionKey: row.root_session_key == null ? null : String(row.root_session_key),
    workspaceKey: row.workspace_key == null ? null : String(row.workspace_key),
    repositoryKey: row.repository_key == null ? null : String(row.repository_key),
    startedAtMs: row.started_at_ms == null ? null : Number(row.started_at_ms),
    endedAtMs: row.ended_at_ms == null ? null : Number(row.ended_at_ms),
    quality: row.quality as SessionRecord["quality"],
    reasons: parseReasons(row.reasons_json),
  };
}

function storedNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mergeStoredUsage(context: AdapterContext, current: UsageRecord): UsageRecord | null {
  const previous = context.store.getUsage(current.originKey);
  if (!previous) return current;
  const previousComplete = storedNumber(previous, "total") !== null;
  if (previousComplete && current.total === null) return null;

  const firstAt = storedNumber(previous, "at_ms");
  const priorComponents = ["uncached_input", "cache_read", "cache_write", "output", "reasoning", "total"].map((key) => storedNumber(previous, key));
  const nextComponents = [current.uncachedInput, current.cacheRead, current.cacheWrite, current.output, current.reasoning, current.total];
  const conflict = previousComplete && current.total !== null && priorComponents.some((value, index) => value !== nextComponents[index]);
  const reasons = new Set([...(previousComplete ? parseReasons(previous.reasons_json) : []), ...current.reasons]);
  if (conflict) reasons.add("parse-gap");

  return {
    ...current,
    sessionKey: String(previous.session_key),
    workspaceKey: String(previous.workspace_key),
    repositoryKey: previous.repository_key == null ? null : String(previous.repository_key),
    atMs: firstAt === null ? current.atMs : current.atMs === null ? firstAt : Math.min(firstAt, current.atMs),
    quality: conflict || (previousComplete && previous.quality === "partial") || current.quality === "partial" ? "partial" : "recorded",
    reasons: [...reasons].sort(),
  };
}

export const claudeAdapter: SourceAdapter = {
  agent: AGENT,

  discover: discoverClaude,

  async collect(context: AdapterContext): Promise<AdapterBatch> {
    const found = await sourceFiles(context.config);
    const projected: ClaudeRawRecord[] = [];
    const fileCursors: FileCursor[] = [];
    let parseGaps = 0;
    let unterminatedTailBytes = 0;
    let readFailures = 0;
    const priorInputState = context.store.getInputSourceState(SOURCE_KEY);
    const forceInputBackfill = context.rebuild
      || context.reconcileAll
      || priorInputState === null
      || priorInputState.parser_version !== 1
      || priorInputState.last_successful_scan_ms === null;
    let successfulInputScans = 0;

    for (const path of found.files) {
      try {
        const stat = await lstat(path);
        const pathKey = sourcePathKey(SOURCE_KEY, path);
        const previousCursor = forceInputBackfill ? null : context.store.getFileCursor(SOURCE_KEY, pathKey);
        const result = await scanJsonl({
          sourceKey: SOURCE_KEY,
          pathKey,
          path,
          previousCursor,
          classify(record) {
            const value = object(record);
            return value && typeof value.type === "string" ? "accept" : "skip";
          },
          onRecord(record, location) {
            projected.push({
              record,
              sourcePath: path,
              lineNumber: location.lineNumber,
              sourceCreatedMs: Math.max(0, Math.floor(stat.birthtimeMs || stat.ctimeMs)),
            });
          },
        });
        fileCursors.push(result.cursor);
        parseGaps += result.diagnostics.parseGaps;
        unterminatedTailBytes += result.diagnostics.unterminatedTailBytes;
        successfulInputScans += 1;
      } catch {
        readFailures += 1;
      }
    }

    const normalized = normalizeClaudeRecords(projected, context.cutoffMs);
    const mergedUsage = normalized.usage
      .map((record) => mergeStoredUsage(context, record))
      .filter((record): record is UsageRecord => record !== null);
    const sessions = new Map(normalized.sessions.map((session) => [session.sessionKey, session]));

    const attachStoredLineage = (sessionKey: string): void => {
      if (sessions.has(sessionKey)) return;
      const session = storedSession(context, sessionKey);
      if (!session) return;
      sessions.set(sessionKey, session);
      if (session.parentSessionKey) attachStoredLineage(session.parentSessionKey);
    };
    for (const record of mergedUsage) attachStoredLineage(record.sessionKey);
    for (const session of [...sessions.values()]) {
      if (session.parentSessionKey) attachStoredLineage(session.parentSessionKey);
    }
    const resolvingWorkspace = new Set<string>();
    const resolveWorkspace = (session: SessionRecord): string | null => {
      if (session.workspaceKey !== null && session.workspaceKey !== undefined) return session.workspaceKey;
      if (session.parentSessionKey === null || session.parentSessionKey === undefined || resolvingWorkspace.has(session.sessionKey)) {
        return null;
      }
      const parent = sessions.get(session.parentSessionKey);
      if (!parent) return null;
      resolvingWorkspace.add(session.sessionKey);
      const inherited = resolveWorkspace(parent);
      resolvingWorkspace.delete(session.sessionKey);
      if (inherited !== null) {
        session.workspaceKey = inherited;
        session.quality = "recorded";
        session.reasons = (session.reasons ?? []).filter((reason) => reason !== "unattributed-session");
      }
      return inherited;
    };
    for (const session of sessions.values()) resolveWorkspace(session);
    for (const record of mergedUsage) {
      if (record.workspaceKey !== UNATTRIBUTED_WORKSPACE) continue;
      const session = sessions.get(record.sessionKey);
      const inherited = session ? resolveWorkspace(session) : null;
      if (inherited === null) continue;
      record.workspaceKey = inherited;
      record.reasons = record.reasons.filter((reason) => reason !== "unattributed-session");
      record.quality = record.reasons.length === 0 ? "recorded" : "partial";
    }
    const currentInputs = normalized.inputs.map((input) => {
      const session = sessions.get(input.sessionKey);
      const workspace = session ? resolveWorkspace(session) : null;
      if (workspace !== null) input.workspaceKey = workspace;
      return input;
    });
    const inputs = mergeInputRecords(
      currentInputs,
      retainedInputRecords(context.store, currentInputs.map((record) => record.originKey)),
    );
    const inputReasons = new Set(normalized.inputReasons);
    if (successfulInputScans === 0 && found.files.length === 0) inputReasons.add("missing-source");
    if (parseGaps > 0 || readFailures > 0 || unterminatedTailBytes > 0) {
      inputReasons.add("input-history-incomplete");
    }
    if (!forceInputBackfill && priorInputState?.quality === "partial") {
      for (const reason of storedInputReasons(priorInputState)) inputReasons.add(reason);
    }
    const inputQuality: Quality = successfulInputScans === 0
      ? "unavailable"
      : inputReasons.size > 0 ? "partial" : "recorded";
    const previousSuccessfulScan = typeof priorInputState?.last_successful_scan_ms === "number"
      ? priorInputState.last_successful_scan_ms
      : null;
    const inputSourceState = {
      sourceKey: SOURCE_KEY,
      agent: AGENT,
      parserVersion: 1 as const,
      quality: inputQuality,
      reasons: [...inputReasons].sort(),
      scannedAtMs: context.cutoffMs,
      lastSuccessfulScanMs: successfulInputScans > 0 ? context.cutoffMs : previousSuccessfulScan,
    };


    const diagnosticCounts = {
      ...normalized.diagnosticCounts,
      parseGaps,
      readFailures,
      recognizedFiles: found.files.length,
      unterminatedTailBytes,
    };
    const partial =
      parseGaps > 0 ||
      readFailures > 0 ||
      normalized.diagnosticCounts.malformedUsage > 0 ||
      normalized.diagnosticCounts.inconsistentRevisions > 0 ||
      mergedUsage.some((record) => record.quality === "partial");
    const available = found.files.length > 0;
    const reasons = new Set<string>(["timing-unavailable"]);
    if (!available) reasons.add("missing-source");
    if (partial) reasons.add("parse-gap");

    return {
      source: {
        sourceKey: SOURCE_KEY,
        agent: AGENT,
        kind: "claude-jsonl",
        sourcePath: null,
        state: available ? (partial ? "partial" : "available") : found.anyRoot && !found.disabled ? "installed-no-history" : "not-found",
        tokenQuality: available ? (partial ? "partial" : "recorded") : "unavailable",
        workQuality: "unavailable",
        reasons: [...reasons].sort(),
        diagnosticCounts,
        lastSeenMs: context.cutoffMs,
        lastSuccessfulScanMs: readFailures === 0 ? context.cutoffMs : null,
        cutoffMs: context.cutoffMs,
      },
      sessions: [...sessions.values()].sort((first, second) => first.sessionKey.localeCompare(second.sessionKey)),
      usage: mergedUsage,
      workIntervals: [],
      inputs,
      inputSourceState,
      counterSnapshots: [],
      fileCursors,
      unallocatedUsageRecords: mergedUsage.filter((record) => record.atMs === null).length,
      excludedAmbiguousRecords: normalized.excludedAmbiguousRecords,
    };
  },
};
