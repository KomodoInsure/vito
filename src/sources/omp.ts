import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

import type { Config } from "../config";
import type { Quality, UsageRecord, WorkInterval } from "../contracts";
import type { FileCursor, SessionRecord, SourceRecord } from "../store";
import type { AdapterBatch, AdapterContext, DiscoveryEntry, SourceAdapter } from "./types";
import { scanJsonl, sourcePathKey } from "./jsonl";

const OMP_SOURCE_KEY = "omp";
const OMP_HEADER_VERSION = 3;
const MAIN_SESSION_NAME = /^\d{4}-\d{2}-\d{2}T[^/]+_[^/]+\.jsonl$/;
const EXCLUDED_DIRECTORIES: Record<string, true> = { local: true, "tool-results": true, tools: true };
const EXCLUDED_FILES = /(?:\.read\.log|\.bash\.log|agent\.db)$/;

interface JsonObject {
  [key: string]: unknown;
}

interface ParsedHeader {
  id: string;
  cwd: string | null;
  timestampMs: number | null;
  parentSession: string | null;
  previousSessionFiles: string[];
}

interface ParsedSession {
  path: string;
  sourceKey: string;
  header: ParsedHeader;
  records: JsonObject[];
  malformedRecords: number;
  incompleteTail: boolean;
  missingPrevious: boolean;
  artifactOwnerPath: string | null;
}

interface UsageCandidate {
  record: UsageRecord;
  sessionIndex: number;
  recordIndex: number;
  kind: "message" | "model_usage";
  interval: WorkInterval | null;
  completeComponents: number;
  identityFingerprint: string | null;
}

export type OmpDiagnosticCode =
  | "duplicate-ambiguity"
  | "open-interval"
  | "parse-gap"
  | "timing-unavailable"
  | "unknown-model";

export interface OmpSessionInput {
  path: string;
  records: readonly unknown[];
  sourceKey?: string;
  malformedRecords?: number;
  incompleteTail?: boolean;
}

export interface OmpNormalizationResult {
  sessions: SessionRecord[];
  usage: UsageRecord[];
  workIntervals: WorkInterval[];
  diagnosticCounts: Record<string, number>;
  excludedAmbiguousRecords: number;
}


class UnionFind {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parents[index]!;
    if (parent !== index) this.parents[index] = this.find(parent);
    return this.parents[index]!;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parents[rightRoot] = leftRoot;
  }
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hashParts(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update(":");
    hash.update(part);
    hash.update(";");
  }
  return hash.digest("hex");
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function token(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeLabel(value: unknown): string {
  return text(value) ?? "unknown";
}

function resolveReference(fromPath: string, reference: string): string {
  const expanded = reference.startsWith("~/") ? join(homedir(), reference.slice(2)) : reference;
  return normalize(isAbsolute(expanded) ? expanded : resolve(dirname(fromPath), expanded));
}

function headerFromRecords(records: readonly unknown[]): { header: ParsedHeader | null; unsupported: boolean } {
  let headerValue: JsonObject | null = null;
  for (let index = 0; index < Math.min(records.length, 2); index += 1) {
    const candidate = object(records[index]);
    if (!candidate) return { header: null, unsupported: false };
    if (index === 0 && candidate.type === "title") continue;
    headerValue = candidate;
    break;
  }
  if (!headerValue || headerValue.type !== "session") return { header: null, unsupported: false };
  if (headerValue.version !== OMP_HEADER_VERSION) return { header: null, unsupported: true };
  const id = text(headerValue.id);
  if (!id) return { header: null, unsupported: false };

  const previousValue = headerValue.previousSessionFiles;
  const previousSessionFiles = Array.isArray(previousValue)
    ? previousValue.flatMap((value) => text(value) ? [text(value)!] : [])
    : text(previousValue) ? [text(previousValue)!] : [];
  const parentValue = object(headerValue.parentSession);
  const parentSession = text(headerValue.parentSession) ?? text(parentValue?.id) ?? text(parentValue?.path);
  return {
    unsupported: false,
    header: {
      id,
      cwd: text(headerValue.cwd),
      timestampMs: timestampMs(headerValue.timestamp),
      parentSession,
      previousSessionFiles,
    },
  };
}

function canonicalPath(path: string): string {
  try {
    return normalize(realpathSync.native(path));
  } catch {
    return normalize(resolve(path));
  }
}

function artifactOwner(path: string, knownFiles: ReadonlySet<string>): string | null {
  let current = dirname(path);
  while (true) {
    const sibling = `${current}.jsonl`;
    if (knownFiles.has(sibling)) return sibling;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function makeParsedSessions(inputs: readonly OmpSessionInput[]): ParsedSession[] {
  const canonicalFiles = new Set(inputs.map((input) => canonicalPath(input.path)));
  const sessions: ParsedSession[] = [];
  for (const input of inputs) {
    const records = input.records.flatMap((record) => object(record) ? [object(record)!] : []);
    const parsed = headerFromRecords(records);
    if (!parsed.header) continue;
    const path = canonicalPath(input.path);
    const previous = parsed.header.previousSessionFiles.map((entry) => resolveReference(path, entry));
    sessions.push({
      path,
      sourceKey: input.sourceKey ?? OMP_SOURCE_KEY,
      header: { ...parsed.header, previousSessionFiles: previous },
      records,
      malformedRecords: input.malformedRecords ?? input.records.length - records.length,
      incompleteTail: input.incompleteTail ?? false,
      missingPrevious: previous.some((entry) => !canonicalFiles.has(entry)),
      artifactOwnerPath: artifactOwner(path, canonicalFiles),
    });
  }
  return sessions;
}

function sessionOrder(left: ParsedSession, right: ParsedSession): number {
  return (left.header.timestampMs ?? Number.MAX_SAFE_INTEGER) -
    (right.header.timestampMs ?? Number.MAX_SAFE_INTEGER) || left.path.localeCompare(right.path);
}

function familyRoots(sessions: readonly ParsedSession[]): { roots: number[]; canonicalByRoot: Map<number, number> } {
  const union = new UnionFind(sessions.length);
  const byPath = new Map<string, number>();
  const byId = new Map<string, number>();
  const byMissingPreviousPath = new Map<string, number>();
  sessions.forEach((session, index) => {
    byPath.set(session.path, index);
    const sameId = byId.get(session.header.id);
    if (sameId !== undefined) union.union(index, sameId);
    else byId.set(session.header.id, index);
  });
  sessions.forEach((session, index) => {
    for (const previous of session.header.previousSessionFiles) {
      const previousIndex = byPath.get(previous);
      if (previousIndex !== undefined) {
        union.union(index, previousIndex);
        continue;
      }
      const priorCopy = byMissingPreviousPath.get(previous);
      if (priorCopy === undefined) byMissingPreviousPath.set(previous, index);
      else union.union(index, priorCopy);
    }
  });

  // Forked artifact directories can copy child logs under a new parent path. A
  // matching relative child path is lineage evidence only when the owning
  // parent session files are already in the same fork family.
  const childGroups = new Map<string, number>();
  sessions.forEach((session, index) => {
    if (!session.artifactOwnerPath) return;
    const ownerIndex = byPath.get(session.artifactOwnerPath);
    if (ownerIndex === undefined) return;
    const relativeChild = relative(session.artifactOwnerPath.slice(0, -".jsonl".length), session.path);
    const key = `${union.find(ownerIndex)}:${relativeChild}`;
    const previousChild = childGroups.get(key);
    if (previousChild === undefined) childGroups.set(key, index);
    else union.union(index, previousChild);
  });

  const roots = sessions.map((_, index) => union.find(index));
  const canonicalByRoot = new Map<number, number>();
  sessions.forEach((session, index) => {
    const root = union.find(index);
    const current = canonicalByRoot.get(root);
    if (current === undefined || sessionOrder(session, sessions[current]!) < 0) canonicalByRoot.set(root, index);
  });
  return { roots, canonicalByRoot };
}

function usageObject(record: JsonObject, message: JsonObject | null): JsonObject | null {
  return object(message?.usage) ?? object(record.usage);
}

function responseId(record: JsonObject, message: JsonObject | null): string | null {
  return text(message?.responseId) ?? text(record.responseId) ?? text(message?.response_id) ?? text(record.response_id);
}

function providerFor(record: JsonObject, message: JsonObject | null): string {
  return normalizeLabel(message?.provider ?? message?.providerID ?? record.provider ?? record.providerID);
}

function modelFor(record: JsonObject, message: JsonObject | null): string {
  return normalizeLabel(message?.model ?? message?.modelID ?? record.model ?? record.modelID);
}

function sourceEstimatedCost(usage: JsonObject): { microusd: number | null; invalid: boolean } {
  if (usage.cost === undefined || usage.cost === null) return { microusd: null, invalid: false };
  const cost = object(usage.cost);
  if (!cost) return { microusd: null, invalid: true };
  const amount = cost.total;
  if (amount === undefined || amount === null || amount === 0) return { microusd: null, invalid: false };
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    return { microusd: null, invalid: true };
  }
  const micros = Math.round(amount * 1_000_000);
  return Number.isSafeInteger(micros) && micros > 0
    ? { microusd: micros, invalid: false }
    : { microusd: null, invalid: true };
}

function accounting(usage: JsonObject): {
  uncachedInput: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
  quality: Quality;
  reasons: string[];
  completeComponents: number;
} {
  const uncachedInput = token(usage.input);
  const cacheRead = token(usage.cacheRead);
  const cacheWrite = token(usage.cacheWrite);
  const output = token(usage.output);
  const reasoningValue = usage.reasoningTokens ?? usage.reasoning;
  const reasoning = reasoningValue === undefined ? null : token(reasoningValue);
  const reportedTotalValue = usage.totalTokens ?? usage.total;
  let total = reportedTotalValue === undefined ? null : token(reportedTotalValue);
  const components = [uncachedInput, cacheRead, cacheWrite, output];
  const completeComponents = components.filter((value) => value !== null).length;
  const reasons: string[] = [];
  if (completeComponents !== components.length || (reasoningValue !== undefined && reasoning === null)) reasons.push("parse-gap");
  if (components.every((value) => value !== null)) {
    const visibleTotal = components.reduce<number>((sum, value) => sum + value!, 0);
    if (!Number.isSafeInteger(visibleTotal)) {
      total = null;
      reasons.push("parse-gap");
    } else if (reportedTotalValue === undefined) {
      total = visibleTotal;
    } else if (total === null || total < visibleTotal) {
      reasons.push("parse-gap");
    }
  } else if (reportedTotalValue !== undefined && total === null) {
    reasons.push("parse-gap");
  }
  if (reasoning !== null && output !== null && reasoning > output) reasons.push("parse-gap");
  return {
    uncachedInput,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    total,
    quality: reasons.length > 0 ? "partial" : "recorded",
    reasons: [...new Set(reasons)],
    completeComponents,
  };
}

function nestedMessage(record: JsonObject): JsonObject | null {
  return object(record.message);
}

function usageKind(record: JsonObject): "message" | "model_usage" | null {
  if (record.type === "model_usage") return "model_usage";
  if (record.type !== "message") return null;
  const message = nestedMessage(record);
  return message?.role === "assistant" ? "message" : null;
}

function isToolResult(record: JsonObject): boolean {
  if (record.type === "toolResult" || record.type === "tool_result") return true;
  const message = nestedMessage(record);
  return record.type === "message" && (message?.role === "toolResult" || message?.role === "tool_result" || message?.role === "tool");
}

function eventTime(record: JsonObject, message: JsonObject | null): number | null {
  return timestampMs(message?.completedAt) ?? timestampMs(record.completedAt) ?? timestampMs(record.timestamp);
}

function requestInterval(
  record: JsonObject,
  message: JsonObject | null,
  originKey: string,
  sessionKey: string,
  workspaceKey: string,
  provider: string,
  model: string,
): WorkInterval | null {
  const startMs = timestampMs(message?.timestamp);
  const endMs = timestampMs(message?.completedAt);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return {
    originKey: `omp:work:${originKey.slice("omp:".length)}`,
    agent: "omp",
    sessionKey,
    workspaceKey,
    repositoryKey: null,
    provider,
    model,
    startMs,
    endMs,
    kind: "inference",
  };
}

function diagnosticIncrement(diagnostics: Record<string, number>, code: OmpDiagnosticCode, amount = 1): void {
  diagnostics[code] = (diagnostics[code] ?? 0) + amount;
}

/**
 * Pure OMP normalization used by fixture tests and the streaming adapter. Raw
 * transcript values are projected immediately into the private allowlist.
 */
export function normalizeOmpSessions(inputs: readonly OmpSessionInput[], cutoffMs = Number.MAX_SAFE_INTEGER): OmpNormalizationResult {
  const parsedSessions = makeParsedSessions(inputs);
  const diagnostics: Record<string, number> = {};
  const { roots, canonicalByRoot } = familyRoots(parsedSessions);
  const indexByPath = new Map(parsedSessions.map((session, index) => [session.path, index]));
  const indexById = new Map(parsedSessions.map((session, index) => [session.header.id, index]));
  const sessionKeys = parsedSessions.map((session) => `omp:session:${hashParts(session.header.id)}`);
  const familyKeys = roots.map((root) => {
    const canonical = parsedSessions[canonicalByRoot.get(root)!]!;
    return `omp:family:${hashParts(canonical.header.id)}`;
  });

  const parentIndexes = parsedSessions.map((session) => {
    if (session.header.parentSession) {
      const reference = session.header.parentSession;
      const byId = indexById.get(reference);
      if (byId !== undefined) return byId;
      const byPath = indexByPath.get(resolveReference(session.path, reference));
      if (byPath !== undefined) return byPath;
    }
    if (session.artifactOwnerPath) return indexByPath.get(session.artifactOwnerPath) ?? null;
    return null;
  });
  const rootIndex = (index: number): number => {
    const visited = new Set<number>();
    let current = index;
    while (parentIndexes[current] !== null && !visited.has(current)) {
      visited.add(current);
      current = parentIndexes[current]!;
    }
    return current;
  };

  const sessionsByKey = new Map<string, SessionRecord>();
  const sessionIndexByKey = new Map<string, number>();
  parsedSessions.forEach((session, index) => {
    const workspaceKey = session.header.cwd && isAbsolute(session.header.cwd) ? normalize(session.header.cwd) : null;
    const reasons: string[] = [];
    if (!workspaceKey) reasons.push("unattributed-session");
    if (session.malformedRecords > 0 || session.incompleteTail) reasons.push("parse-gap");
    if (session.missingPrevious) reasons.push("duplicate-ambiguity");
    if (session.malformedRecords > 0) diagnosticIncrement(diagnostics, "parse-gap", session.malformedRecords);
    if (session.incompleteTail) diagnosticIncrement(diagnostics, "parse-gap");
    if (session.missingPrevious) diagnosticIncrement(diagnostics, "duplicate-ambiguity");
    const record: SessionRecord = {
      agent: "omp",
      sessionKey: sessionKeys[index]!,
      originKey: familyKeys[index]!,
      sourceKey: session.sourceKey,
      canonicalSessionKey: sessionKeys[canonicalByRoot.get(roots[index]!)!]!,
      parentSessionKey: parentIndexes[index] === null ? null : sessionKeys[parentIndexes[index]!]!,
      rootSessionKey: sessionKeys[rootIndex(index)]!,
      workspaceKey,
      repositoryKey: null,
      startedAtMs: session.header.timestampMs,
      endedAtMs: null,
      quality: reasons.length > 0 ? "partial" : "recorded",
      reasons,
    };
    const existingIndex = sessionIndexByKey.get(record.sessionKey);
    if (existingIndex === undefined || sessionOrder(session, parsedSessions[existingIndex]!) < 0) {
      sessionsByKey.set(record.sessionKey, record);
      sessionIndexByKey.set(record.sessionKey, index);
    }
  });

  const candidates = new Map<string, UsageCandidate[]>();
  parsedSessions.forEach((session, sessionIndex) => {
    const sessionKey = sessionKeys[sessionIndex]!;
    const workspaceKey = session.header.cwd && isAbsolute(session.header.cwd)
      ? normalize(session.header.cwd)
      : `omp:unattributed:${hashParts(session.header.id)}`;
    session.records.forEach((record, recordIndex) => {
      if (isToolResult(record)) {
        diagnosticIncrement(diagnostics, "timing-unavailable");
        return;
      }
      const kind = usageKind(record);
      if (!kind) return;
      const message = nestedMessage(record);
      const rawUsage = usageObject(record, message);
      if (!rawUsage) return;
      const atMs = eventTime(record, message);
      if (atMs !== null && atMs > cutoffMs) return;
      const provider = providerFor(record, message);
      const model = modelFor(record, message);
      const response = responseId(record, message);
      const entryId = text(record.id) ?? text(message?.id);
      const normalized = accounting(rawUsage);
      const identityFingerprint = hashParts(
        kind,
        String(atMs ?? "unknown"),
        provider,
        model,
        JSON.stringify([
          normalized.uncachedInput,
          normalized.cacheRead,
          normalized.cacheWrite,
          normalized.output,
          normalized.reasoning,
          normalized.total,
        ]),
      );
      const stableIdentity = response
        ? `response:${provider}:${response}`
        : entryId
          ? `entry:${familyKeys[sessionIndex]}:${entryId}`
          : `fingerprint:${familyKeys[sessionIndex]}:${identityFingerprint}`;
      const originKey = `omp:${hashParts(stableIdentity)}`;
      const reasons = [...normalized.reasons];
      if (session.missingPrevious) reasons.push("duplicate-ambiguity");
      if (model === "unknown") {
        reasons.push("unknown-model");
        diagnosticIncrement(diagnostics, "unknown-model");
      }
      const cost = sourceEstimatedCost(rawUsage);
      if (cost.invalid) {
        reasons.push("parse-gap");
        diagnosticIncrement(diagnostics, "parse-gap");
      }
      const usageRecord: UsageRecord = {
        originKey,
        agent: "omp",
        sessionKey,
        workspaceKey,
        repositoryKey: null,
        turnKey: text(record.parentId) ? `omp:turn:${hashParts(text(record.parentId)!)}` : null,
        requestKey: response ? `omp:request:${hashParts(provider, response)}` : null,
        atMs,
        provider,
        model,
        uncachedInput: normalized.uncachedInput,
        cacheRead: normalized.cacheRead,
        cacheWrite: normalized.cacheWrite,
        output: normalized.output,
        reasoning: normalized.reasoning,
        total: normalized.total,
        costMicrousd: cost.microusd,
        costKind: cost.microusd === null ? "unknown" : "source-estimate",
        quality: reasons.length > 0 ? "partial" : normalized.quality,
        reasons: [...new Set(reasons)],
      };
      const interval = kind === "message"
        ? requestInterval(record, message, originKey, sessionKey, workspaceKey, provider, model)
        : null;
      if (!interval) {
        const isOpenMessage = kind === "message" &&
          timestampMs(message?.timestamp) !== null &&
          timestampMs(message?.completedAt) === null;
        diagnosticIncrement(diagnostics, isOpenMessage ? "open-interval" : "timing-unavailable");
      }
      const bucket = candidates.get(originKey) ?? [];
      bucket.push({
        record: usageRecord,
        sessionIndex,
        recordIndex,
        kind,
        interval,
        completeComponents: normalized.completeComponents,
        identityFingerprint: response ? null : identityFingerprint,
      });
      candidates.set(originKey, bucket);
    });
  });

  const usage: UsageRecord[] = [];
  const workIntervals: WorkInterval[] = [];
  let excludedAmbiguousRecords = 0;
  for (const bucket of candidates.values()) {
    bucket.sort((left, right) => {
      const leftCanonical = canonicalByRoot.get(roots[left.sessionIndex]!) === left.sessionIndex ? 0 : 1;
      const rightCanonical = canonicalByRoot.get(roots[right.sessionIndex]!) === right.sessionIndex ? 0 : 1;
      return leftCanonical - rightCanonical ||
        (left.kind === "message" ? 0 : 1) - (right.kind === "message" ? 0 : 1) ||
        right.completeComponents - left.completeComponents || left.recordIndex - right.recordIndex;
    });
    const selected = bucket[0]!;
    const selectedAccounting = JSON.stringify([
      selected.record.uncachedInput,
      selected.record.cacheRead,
      selected.record.cacheWrite,
      selected.record.output,
      selected.record.reasoning,
      selected.record.total,
    ]);
    const conflicting = bucket.slice(1).some((candidate) => {
      const accountingDiffers = JSON.stringify([
        candidate.record.uncachedInput,
        candidate.record.cacheRead,
        candidate.record.cacheWrite,
        candidate.record.output,
        candidate.record.reasoning,
        candidate.record.total,
      ]) !== selectedAccounting;
      const fallbackIdentityDiffers = selected.identityFingerprint !== null &&
        candidate.identityFingerprint !== null &&
        selected.identityFingerprint !== candidate.identityFingerprint;
      return accountingDiffers || fallbackIdentityDiffers;
    });
    if (conflicting) {
      selected.record.quality = "partial";
      selected.record.reasons = [...new Set([...selected.record.reasons, "duplicate-ambiguity"])];
      excludedAmbiguousRecords += bucket.length - 1;
      diagnosticIncrement(diagnostics, "duplicate-ambiguity", bucket.length - 1);
    }
    usage.push(selected.record);
    if (selected.interval) workIntervals.push(selected.interval);
  }

  usage.sort((left, right) => left.originKey.localeCompare(right.originKey));
  workIntervals.sort((left, right) => left.originKey.localeCompare(right.originKey));
  return {
    sessions: [...sessionsByKey.values()].sort((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
    usage,
    workIntervals,
    diagnosticCounts: diagnostics,
    excludedAmbiguousRecords,
  };
}

function rootsFor(config?: Config): string[] {
  if (config && Object.prototype.hasOwnProperty.call(config.sources, "omp")) return config.sources.omp ?? [];
  return [join(homedir(), ".omp", "agent", "sessions")];
}


function hasMainArtifactAncestor(path: string): boolean {
  let current = dirname(path);
  while (true) {
    if (existsSync(`${current}.jsonl`) && MAIN_SESSION_NAME.test(basename(`${current}.jsonl`))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function discoverFilesUnder(root: string): string[] {
  let rootStat: Stats;
  try {
    rootStat = lstatSync(root);
  } catch {
    return [];
  }
  if (rootStat.isSymbolicLink()) return [];
  if (rootStat.isFile()) return root.endsWith(".jsonl") && !EXCLUDED_FILES.test(basename(root)) ? [canonicalPath(root)] : [];
  if (!rootStat.isDirectory()) return [];

  const candidates: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES[entry.name]) visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && !EXCLUDED_FILES.test(entry.name)) {
        candidates.push(canonicalPath(path));
      }
    }
  };
  visit(canonicalPath(root));
  return candidates.filter((path) => MAIN_SESSION_NAME.test(basename(path)) || hasMainArtifactAncestor(path));
}

export function discoverOmpSessionFiles(config?: Config): string[] {
  return [...new Set(rootsFor(config).flatMap(discoverFilesUnder))].sort();
}


async function readHeader(path: string): Promise<{ supported: boolean; unsupported: boolean; records: JsonObject[] }> {
  let pending = Buffer.alloc(0);
  const records: JsonObject[] = [];
  try {
    for await (const rawChunk of createReadStream(path)) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      pending = Buffer.concat([pending, chunk]);
      while (records.length < 2) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        const bytes = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (bytes.length === 0) continue;
        try {
          const parsed = object(JSON.parse(bytes.toString("utf8")));
          if (!parsed) return { supported: false, unsupported: false, records };
          records.push(parsed);
        } catch {
          return { supported: false, unsupported: false, records };
        }
        const parsedHeader = headerFromRecords(records);
        if (parsedHeader.header) return { supported: true, unsupported: false, records };
        if (parsedHeader.unsupported) return { supported: false, unsupported: true, records };
        if (records[0]?.type !== "title" || records.length === 2) {
          return { supported: false, unsupported: false, records };
        }
      }
      if (records.length >= 2) break;
    }
  } catch {
    return { supported: false, unsupported: false, records };
  }
  const parsed = headerFromRecords(records);
  return { supported: parsed.header !== null, unsupported: parsed.unsupported, records };
}

async function discover(config?: Config): Promise<DiscoveryEntry[]> {
  const configuredRoots = rootsFor(config);
  if (configuredRoots.length === 0) {
    return [{
      agent: "omp",
      state: "not-found",
      capabilities: { tokens: "unavailable", work: "unavailable" },
      paths: [],
      diagnosticCounts: { disabled: 1 },
      reasons: ["missing-source"],
    }];
  }
  const files = discoverOmpSessionFiles(config);
  if (files.length === 0) {
    return [{
      agent: "omp",
      state: "not-found",
      capabilities: { tokens: "unavailable", work: "unavailable" },
      paths: configuredRoots.filter(existsSync).map(canonicalPath),
      diagnosticCounts: {},
      reasons: ["missing-source"],
    }];
  }
  let supported = 0;
  let unsupported = 0;
  let malformed = 0;
  for (const path of files) {
    const header = await readHeader(path);
    if (header.supported) supported += 1;
    else if (header.unsupported) unsupported += 1;
    else malformed += 1;
  }
  const state = supported === 0 && unsupported > 0
    ? "unsupported-schema"
    : unsupported > 0 || malformed > 0 ? "partial" : "available";
  const reasons = [
    ...(unsupported > 0 ? ["unsupported-schema"] : []),
    ...(malformed > 0 ? ["parse-gap"] : []),
    ...(supported > 0 ? ["timing-unavailable"] : []),
  ];
  return [{
    agent: "omp",
    state,
    capabilities: {
      tokens: supported > 0 ? (unsupported > 0 || malformed > 0 ? "partial" : "recorded") : "unavailable",
      work: supported > 0 ? "partial" : "unavailable",
    },
    paths: files,
    diagnosticCounts: {
      ...(unsupported > 0 ? { "unsupported-schema": unsupported } : {}),
      ...(malformed > 0 ? { "parse-gap": malformed } : {}),
    },
    reasons: [...new Set(reasons)].sort(),
  }];
}

async function collect(context: AdapterContext): Promise<AdapterBatch> {
  const discovered = await discover(context.config);
  const discovery = discovered[0]!;
  const sourceBase: SourceRecord = {
    sourceKey: OMP_SOURCE_KEY,
    agent: "omp",
    kind: "jsonl",
    sourcePath: null,
    state: discovery.state,
    tokenQuality: discovery.capabilities.tokens,
    workQuality: discovery.capabilities.work,
    reasons: discovery.reasons,
    diagnosticCounts: discovery.diagnosticCounts,
    schemaVersion: discovery.state === "unsupported-schema" ? null : String(OMP_HEADER_VERSION),
    lastSeenMs: context.cutoffMs,
    lastSuccessfulScanMs: discovery.state === "not-found" || discovery.state === "unsupported-schema" ? null : context.cutoffMs,
    cutoffMs: context.cutoffMs,
  };
  if (discovery.state === "not-found" || discovery.state === "unsupported-schema") {
    return {
      source: sourceBase,
      sessions: [],
      usage: [],
      workIntervals: [],
      counterSnapshots: [],
      fileCursors: [],
      unallocatedUsageRecords: 0,
      excludedAmbiguousRecords: 0,
    };
  }

  const inputs: OmpSessionInput[] = [];
  const fileCursors: FileCursor[] = [];
  let unsupported = 0;
  let scanFailures = 0;
  for (const path of discovery.paths) {
    const header = await readHeader(path);
    if (!header.supported) {
      if (header.unsupported) unsupported += 1;
      else scanFailures += 1;
      continue;
    }
    const records: JsonObject[] = [...header.records];
    const pathKey = sourcePathKey(OMP_SOURCE_KEY, path);
    try {
      const scanned = await scanJsonl({
        sourceKey: OMP_SOURCE_KEY,
        pathKey,
        path,
        previousCursor: context.rebuild ? null : context.store.getFileCursor(OMP_SOURCE_KEY, pathKey),
        onRecord(record) {
          const parsed = object(record);
          if (parsed) records.push(parsed);
        },
      });
      inputs.push({
        path,
        sourceKey: OMP_SOURCE_KEY,
        records,
        malformedRecords: scanned.diagnostics.parseGaps,
        incompleteTail: scanned.diagnostics.unterminatedTailBytes > 0,
      });
      fileCursors.push(scanned.cursor);
    } catch {
      scanFailures += 1;
    }
  }
  const normalized = normalizeOmpSessions(inputs, context.cutoffMs);
  const diagnosticCounts: Record<string, number> = { ...discovery.diagnosticCounts };
  if (unsupported > 0) {
    diagnosticCounts["unsupported-schema"] = Math.max(diagnosticCounts["unsupported-schema"] ?? 0, unsupported);
  }
  if (scanFailures > 0) {
    diagnosticCounts["parse-gap"] = Math.max(diagnosticCounts["parse-gap"] ?? 0, scanFailures);
  }
  for (const [code, count] of Object.entries(normalized.diagnosticCounts)) {
    diagnosticCounts[code] = (diagnosticCounts[code] ?? 0) + count;
  }
  if (Object.keys(normalized.diagnosticCounts).length > 0 || unsupported > 0 || scanFailures > 0) {
    sourceBase.state = "partial";
    sourceBase.tokenQuality = normalized.diagnosticCounts["parse-gap"] ||
      normalized.diagnosticCounts["duplicate-ambiguity"] ||
      scanFailures > 0
      ? "partial"
      : sourceBase.tokenQuality;
    sourceBase.workQuality = "partial";
    sourceBase.reasons = [...new Set([
      ...(sourceBase.reasons ?? []),
      ...Object.keys(normalized.diagnosticCounts),
      ...(unsupported > 0 ? ["unsupported-schema"] : []),
      ...(scanFailures > 0 ? ["parse-gap"] : []),
    ])].sort();
  }
  sourceBase.diagnosticCounts = diagnosticCounts;
  return {
    source: sourceBase,
    sessions: normalized.sessions,
    usage: normalized.usage,
    workIntervals: normalized.workIntervals,
    counterSnapshots: [],
    fileCursors,
    unallocatedUsageRecords: 0,
    excludedAmbiguousRecords: normalized.excludedAmbiguousRecords,
  };
}

export const ompAdapter: SourceAdapter = {
  agent: "omp",
  discover,
  collect,
};
