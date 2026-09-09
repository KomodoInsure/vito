import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { Database } from "bun:sqlite";
import type { Config } from "../config";
import type { InputRecord, Quality, UsageRecord, WorkInterval } from "../contracts";
import { mergeInputRecords, retainedInputRecords, storedInputReasons, storedInputRecord } from "../inputs";
import type { CounterSnapshot, SessionRecord, SourceRecord } from "../store";
import type { AdapterBatch, AdapterContext, DiscoveryEntry, SourceAdapter } from "./types";

const AGENT = "opencode" as const;
const SOURCE_KEY = "opencode";
const PAGE_SIZE = 256;
const PREFIX_LIMIT = 32;
const EXCLUDED_PARENT_TOOLS = new Set(["task", "question"]);
const IDENTITY_KEYS = new Set([
  "id",
  "sessionID",
  "sessionId",
  "session_id",
  "messageID",
  "messageId",
  "message_id",
  "parentID",
  "parentId",
  "parent_id",
]);

interface SchemaProbe {
  state: "available" | "unsupported-schema";
  reason: string | null;
}

interface SourceSessionRow {
  id: string;
  directory: string | null;
  parent_id: string | null;
  time_created: number | null;
  time_updated: number | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  role: string | null;
  provider: string | null;
  model: string | null;
  started: number | null;
  completed: number | null;
  tokens_json: string | null;
  cost: number | null;
  data_json: string;
  finish: string | null;
}

interface PartRow {
  id: string;
  message_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}
interface StoredMessageState {
  fingerprint: string;
  observedAtMs: number;
}


export interface OpenCodePartInput {
  id?: string;
  timeCreated?: number;
  timeUpdated?: number;
  data: unknown;
}

export interface OpenCodeMessageInput {
  id: string;
  sessionId: string;
  workspaceKey: string;
  originKey?: string;
  provider?: unknown;
  model?: unknown;
  createdMs?: unknown;
  updatedMs?: unknown;
  startedMs?: unknown;
  completedMs?: unknown;
  tokens?: unknown;
  cost?: unknown;
  finish?: unknown;
  parts?: OpenCodePartInput[];
}

export interface NormalizedOpenCodeMessage {
  usage: UsageRecord;
  workIntervals: WorkInterval[];
  fingerprint: string;
  incomplete: boolean;
  openWait: boolean;
}

interface CandidateMessage {
  row: MessageRow;
  session: SourceSessionRow;
  sourceHash: string;
  parts: PartRow[];
  input: InputRecord | null;
  normalized: NormalizedOpenCodeMessage | null;
  fingerprint: string;
}

interface SessionScan {
  session: SourceSessionRow;
  sourceHash: string;
  messages: CandidateMessage[];
  fullHistory: boolean;
}

interface Range {
  startMs: number;
  endMs: number;
}
interface NormalizedTokenBuckets {
  uncachedInput: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
  partial: boolean;
}


function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => !IDENTITY_KEYS.has(key))
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function privatePathHash(path: string): string {
  return stableHash(normalize(path)).slice(0, 24);
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeTimestamp(value: unknown): number | null {
  return safeInteger(value);
}

function label(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function addSafe(...values: number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function normalizeCost(value: unknown): { costMicrousd: number | null; costKind: UsageRecord["costKind"]; invalid: boolean } {
  if (value === null || value === undefined || value === 0) {
    return { costMicrousd: null, costKind: "unknown", invalid: false };
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { costMicrousd: null, costKind: "unknown", invalid: true };
  }
  const costMicrousd = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(costMicrousd) || costMicrousd <= 0) {
    return { costMicrousd: null, costKind: "unknown", invalid: true };
  }
  return { costMicrousd, costKind: "source-estimate", invalid: false };
}

function normalizeTokenBuckets(tokensValue: unknown): NormalizedTokenBuckets {
  const tokens = parseObject(tokensValue);
  if (tokens === null) {
    return {
      uncachedInput: null,
      cacheRead: null,
      cacheWrite: null,
      output: null,
      reasoning: null,
      total: null,
      partial: true,
    };
  }

  const cache = parseObject(tokens.cache);
  const rawValues = {
    uncachedInput: tokens.input,
    cacheRead: cache?.read,
    cacheWrite: cache?.write,
    output: tokens.output,
    reasoning: tokens.reasoning,
    total: tokens.total,
  };
  let partial = false;
  const parsed = Object.fromEntries(
    Object.entries(rawValues).map(([key, value]) => {
      const result = safeInteger(value);
      if (value !== null && value !== undefined && result === null) partial = true;
      return [key, result];
    }),
  ) as Record<keyof typeof rawValues, number | null>;

  const { uncachedInput, cacheRead, cacheWrite, reasoning } = parsed;
  const rawOutput = parsed.output;
  let output: number | null = rawOutput;
  let total = parsed.total;
  const componentsKnown = uncachedInput !== null && cacheRead !== null && cacheWrite !== null && rawOutput !== null;

  if (componentsKnown) {
    const reasoningValue = reasoning ?? 0;
    const disjointTotal = addSafe(uncachedInput, cacheRead, cacheWrite, rawOutput, reasoningValue);
    const inclusiveOutputTotal = addSafe(uncachedInput, cacheRead, cacheWrite, rawOutput);
    if (total === null) {
      output = reasoning === null ? rawOutput : addSafe(rawOutput, reasoning);
      total = output === null ? null : addSafe(uncachedInput, cacheRead, cacheWrite, output);
      if (output === null || total === null) partial = true;
    } else if (reasoning !== null && disjointTotal === total) {
      output = addSafe(rawOutput, reasoning);
      if (output === null) partial = true;
    } else if (inclusiveOutputTotal === total) {
      output = rawOutput;
    } else {
      output = reasoning === null ? rawOutput : addSafe(rawOutput, reasoning);
      partial = true;
    }
  } else if (total !== null) {
    partial = true;
  }

  if (reasoning !== null && output !== null && reasoning > output) partial = true;
  return { uncachedInput, cacheRead, cacheWrite, output, reasoning, total, partial };
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function subtractOpenCodeWaits(
  inference: Range,
  waits: Array<{ startMs: number; endMs: number | null }>,
): { ranges: Range[]; openWait: boolean } {
  if (!Number.isSafeInteger(inference.startMs) || !Number.isSafeInteger(inference.endMs) || inference.endMs <= inference.startMs) {
    return { ranges: [], openWait: false };
  }
  let openWait = false;
  const exclusions: Range[] = [];
  for (const wait of waits) {
    if (!Number.isSafeInteger(wait.startMs)) continue;
    const startMs = Math.max(inference.startMs, wait.startMs);
    let endMs: number;
    if (wait.endMs === null) {
      endMs = inference.endMs;
      openWait = startMs < inference.endMs || openWait;
    } else if (Number.isSafeInteger(wait.endMs)) {
      endMs = Math.min(inference.endMs, wait.endMs);
    } else {
      continue;
    }
    if (endMs > startMs) exclusions.push({ startMs, endMs });
  }

  const ranges: Range[] = [];
  let cursor = inference.startMs;
  for (const exclusion of mergeRanges(exclusions)) {
    if (exclusion.startMs > cursor) ranges.push({ startMs: cursor, endMs: exclusion.startMs });
    cursor = Math.max(cursor, exclusion.endMs);
  }
  if (cursor < inference.endMs) ranges.push({ startMs: cursor, endMs: inference.endMs });
  return { ranges, openWait };
}

function parsePartData(part: OpenCodePartInput): Record<string, unknown> | null {
  return parseObject(part.data);
}

function partSortKey(part: OpenCodePartInput): [number, string, string] {
  const data = parsePartData(part);
  const state = parseObject(data?.state);
  const time = parseObject(state?.time);
  return [safeTimestamp(part.timeCreated) ?? safeTimestamp(time?.start) ?? 0, label(data?.type), stableHash(data)];
}
function canonicalPartDigest(parts: OpenCodePartInput[]): string {
  const ordered = [...parts].sort((left, right) => {
    const a = partSortKey(left);
    const b = partSortKey(right);
    return a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]);
  });
  return stableHash(ordered.map((part) => parsePartData(part)));
}

function makeFingerprint(input: OpenCodeMessageInput, tokens: NormalizedTokenBuckets): string {
  return stableHash({
    role: "assistant",
    provider: label(input.provider),
    model: label(input.model),
    createdMs: safeTimestamp(input.createdMs),
    startedMs: safeTimestamp(input.startedMs),
    completedMs: safeTimestamp(input.completedMs),
    tokens: {
      uncachedInput: tokens.uncachedInput,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      output: tokens.output,
      reasoning: tokens.reasoning,
      total: tokens.total,
    },
    parts: canonicalPartDigest(input.parts ?? []),
  });
}

export function normalizeOpenCodeMessage(input: OpenCodeMessageInput): NormalizedOpenCodeMessage {
  const tokens = normalizeTokenBuckets(input.tokens);
  const cost = normalizeCost(input.cost);
  const createdMs = safeTimestamp(input.createdMs);
  const startedMs = safeTimestamp(input.startedMs);
  const completedMs = safeTimestamp(input.completedMs);
  const provider = label(input.provider);
  const model = label(input.model);
  const reasons = new Set<string>();
  if (tokens.partial || cost.invalid) reasons.add("parse-gap");
  const incomplete = completedMs === null || tokens.total === null;
  if (incomplete) reasons.add("parse-gap");
  const fingerprint = makeFingerprint(input, tokens);
  const semanticKey = input.originKey ?? `opencode:call:${provider}:${fingerprint}`;

  const usage: UsageRecord = {
    originKey: semanticKey,
    agent: AGENT,
    sessionKey: input.sessionId,
    workspaceKey: input.workspaceKey,
    repositoryKey: null,
    turnKey: null,
    requestKey: input.id,
    atMs: completedMs,
    provider,
    model,
    uncachedInput: tokens.uncachedInput,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    output: tokens.output,
    reasoning: tokens.reasoning,
    total: tokens.total,
    costMicrousd: cost.costMicrousd,
    costKind: cost.costKind,
    quality: reasons.size === 0 ? "recorded" : "partial",
    reasons: [...reasons].sort(),
  };

  const parsedParts = (input.parts ?? []).flatMap((part) => {
    const data = parsePartData(part);
    if (data?.type !== "tool") return [];
    const state = parseObject(data.state);
    const time = parseObject(state?.time);
    return [{
      id: part.id ?? stableHash(data).slice(0, 16),
      tool: label(data.tool),
      status: label(state?.status),
      startMs: safeTimestamp(time?.start),
      endMs: safeTimestamp(time?.end),
      digest: stableHash(data),
    }];
  });
  const waits = parsedParts
    .filter((part) => EXCLUDED_PARENT_TOOLS.has(part.tool) && part.startMs !== null)
    .map((part) => ({ startMs: part.startMs as number, endMs: part.endMs }));

  let openWait = false;
  const workIntervals: WorkInterval[] = [];
  if (startedMs !== null && completedMs !== null && completedMs > startedMs) {
    const subtracted = subtractOpenCodeWaits({ startMs: startedMs, endMs: completedMs }, waits);
    openWait = subtracted.openWait;
    for (const range of subtracted.ranges) {
      workIntervals.push({
        originKey: `${semanticKey}:inference:${range.startMs}:${range.endMs}`,
        agent: AGENT,
        sessionKey: input.sessionId,
        workspaceKey: input.workspaceKey,
        repositoryKey: null,
        provider,
        model,
        startMs: range.startMs,
        endMs: range.endMs,
        kind: "inference",
      });
    }
  }

  for (const part of parsedParts) {
    if (EXCLUDED_PARENT_TOOLS.has(part.tool)) continue;
    if (part.status !== "completed" && part.status !== "error") continue;
    if (part.startMs === null || part.endMs === null || part.endMs <= part.startMs) continue;
    workIntervals.push({
      originKey: `${semanticKey}:tool:${part.digest}:${part.startMs}:${part.endMs}`,
      agent: AGENT,
      sessionKey: input.sessionId,
      workspaceKey: input.workspaceKey,
      repositoryKey: null,
      provider: null,
      model: null,
      startMs: part.startMs,
      endMs: part.endMs,
      kind: "tool",
    });
  }

  return { usage, workIntervals, fingerprint, incomplete, openWait };
}

function tableColumns(database: Database, table: string): Set<string> {
  const rows = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function hasColumns(database: Database, table: string, required: string[]): boolean {
  const columns = tableColumns(database, table);
  return required.every((column) => columns.has(column));
}

function tableExists(database: Database, table: string): boolean {
  return database.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !== null;
}

function tablePopulated(database: Database, table: string): boolean {
  return database.query(`SELECT 1 AS present FROM ${table} LIMIT 1`).get() !== null;
}

function hasExpectedIndex(database: Database, table: string, columns: string[]): boolean {
  const indexes = database.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
  return indexes.some((index) => {
    const actual = (database.query(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ seqno: number; name: string }>)
      .sort((a, b) => a.seqno - b.seqno)
      .map((row) => row.name);
    return actual.length >= columns.length && columns.every((column, position) => actual[position] === column);
  });
}

export function probeOpenCodeDatabase(path: string): SchemaProbe {
  let database: Database | null = null;
  try {
    database = new Database(path, { readonly: true });
    database.exec("BEGIN");
    const hasLegacyTables = ["session", "message", "part"].every((table) => tableExists(database as Database, table));
    const newPopulated = tableExists(database, "session_message") && tablePopulated(database, "session_message");
    if (!hasLegacyTables) return { state: "unsupported-schema", reason: "unsupported-schema" };
    const legacyPopulated = tablePopulated(database, "message");
    if (newPopulated && !legacyPopulated) return { state: "unsupported-schema", reason: "unsupported-schema" };
    if (
      !hasColumns(database, "session", ["id", "directory", "parent_id", "time_created", "time_updated"]) ||
      !hasColumns(database, "message", ["id", "session_id", "time_created", "time_updated", "data"]) ||
      !hasColumns(database, "part", ["id", "message_id", "session_id", "time_created", "time_updated", "data"])
    ) return { state: "unsupported-schema", reason: "unsupported-schema" };
    if (
      legacyPopulated &&
      (!hasExpectedIndex(database, "message", ["session_id", "time_created", "id"]) ||
        !hasExpectedIndex(database, "part", ["message_id", "id"]) ||
        !hasExpectedIndex(database, "part", ["session_id"]))
    ) return { state: "unsupported-schema", reason: "unsupported-schema" };
    return { state: "available", reason: null };
  } catch {
    return { state: "unsupported-schema", reason: "unsupported-schema" };
  } finally {
    if (database !== null) {
      try { database.exec("ROLLBACK"); } catch { /* no active read transaction */ }
      database.close();
    }
  }
}

function configuredPaths(config?: Config): string[] {
  if (config !== undefined && Object.prototype.hasOwnProperty.call(config.sources, AGENT)) {
    return config.sources.opencode ?? [];
  }
  return [join(homedir(), ".local", "share", "opencode", "opencode.db")];
}

function expandSourcePaths(paths: string[]): string[] {
  const expanded: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let canonical: string;
    try {
      canonical = realpathSync.native(path);
      const stat = statSync(canonical);
      if (stat.isFile()) expanded.push(canonical);
      else if (stat.isDirectory()) {
        const candidate = join(canonical, "opencode.db");
        if (existsSync(candidate) && lstatSync(candidate).isFile()) expanded.push(realpathSync.native(candidate));
      }
    } catch {
      // Discovery reports the inaccessible configured root as unavailable without exposing an error string.
    }
  }
  return [...new Set(expanded)].sort();
}

async function discover(config?: Config): Promise<DiscoveryEntry[]> {
  const selected = configuredPaths(config);
  if (selected.length === 0) {
    return [{
      agent: AGENT,
      state: "not-found",
      capabilities: { tokens: "unavailable", work: "unavailable" },
      paths: [],
      diagnosticCounts: { disabled: 1 },
      reasons: ["missing-source"],
    }];
  }
  const paths = expandSourcePaths(selected);
  if (paths.length === 0) {
    return [{
      agent: AGENT,
      state: "not-found",
      capabilities: { tokens: "unavailable", work: "unavailable" },
      paths: selected,
      diagnosticCounts: { missing: selected.length },
      reasons: ["missing-source"],
    }];
  }
  let unsupported = 0;
  let available = 0;
  for (const path of paths) {
    const probe = probeOpenCodeDatabase(path);
    if (probe.state === "available") available += 1;
    else unsupported += 1;
  }
  const state = available === 0 ? "unsupported-schema" : unsupported > 0 ? "partial" : "available";
  const quality: Quality = state === "available" ? "recorded" : state === "partial" ? "partial" : "unavailable";
  return [{
    agent: AGENT,
    state,
    capabilities: { tokens: quality, work: quality },
    paths,
    diagnosticCounts: unsupported > 0 ? { unsupportedSchema: unsupported } : {},
    reasons: unsupported > 0 ? ["unsupported-schema"] : [],
  }];
}

const MESSAGE_PROJECTION = `
  SELECT id, session_id, time_created, time_updated, data AS data_json,
    json_extract(data, '$.role') AS role,
    json_extract(data, '$.providerID') AS provider,
    json_extract(data, '$.modelID') AS model,
    json_extract(data, '$.time.created') AS started,
    json_extract(data, '$.time.completed') AS completed,
    json_extract(data, '$.tokens') AS tokens_json,
    json_extract(data, '$.cost') AS cost,
    json_extract(data, '$.finish') AS finish
  FROM message`;

function readMessagesKeyset(database: Database, sessionId: string, lowerBound: number | null): MessageRow[] {
  const rows: MessageRow[] = [];
  let cursorTime = lowerBound === null ? -1 : Math.max(-1, lowerBound - 1);
  let cursorId = "";
  while (true) {
    const page = database.query(`${MESSAGE_PROJECTION}
      WHERE session_id = ? AND (time_created > ? OR (time_created = ? AND id > ?))
      ORDER BY time_created, id LIMIT ?`).all(sessionId, cursorTime, cursorTime, cursorId, PAGE_SIZE) as MessageRow[];
    if (page.length === 0) break;
    rows.push(...page);
    const last = page[page.length - 1] as MessageRow;
    cursorTime = last.time_created;
    cursorId = last.id;
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}


function readParts(database: Database, messageId: string): PartRow[] {
  const rows: PartRow[] = [];
  let cursor = "";
  while (true) {
    const page = database.query(`
      SELECT id, message_id, time_created, time_updated, data
      FROM part WHERE message_id = ? AND id > ? ORDER BY id LIMIT ?
    `).all(messageId, cursor, PAGE_SIZE) as PartRow[];
    if (page.length === 0) break;
    rows.push(...page);
    cursor = (page[page.length - 1] as PartRow).id;
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function readIncompleteMessageIds(context: AdapterContext, sessionKey: string): string[] {
  const rows = context.store.database.query(`
    SELECT request_key FROM usage
    WHERE agent = 'opencode' AND session_key = ? AND quality = 'partial' AND request_key IS NOT NULL
  `).all(sessionKey) as Array<{ request_key: string }>;
  return [...new Set(rows.map((row) => row.request_key))].sort();
}

function snapshotWatermark(context: AdapterContext, sourceHash: string, sessionId: string): Record<string, unknown> | null {
  return context.store.getCounterSnapshot(SOURCE_KEY, `message-watermark:${sourceHash}:${sessionId}`);
}


function rawMessageFingerprint(row: MessageRow, parts: PartRow[]): string {
  return stableHash({
    role: row.role,
    provider: row.provider,
    model: row.model,
    createdMs: safeTimestamp(row.time_created),
    startedMs: safeTimestamp(row.started),
    completedMs: safeTimestamp(row.completed),
    tokens: parseObject(row.tokens_json),
    parts: canonicalPartDigest(parts.map((part) => ({
      id: part.id,
      timeCreated: part.time_created,
      timeUpdated: part.time_updated,
      data: part.data,
    }))),
  });
}

function normalizeOpenCodeInput(
  row: MessageRow,
  session: SourceSessionRow,
  sourceHash: string,
  parts: PartRow[],
): InputRecord | null {
  if (row.role !== "user") return null;
  const messageData = parseObject(row.data_json);
  const messageKeys = messageData === null ? [] : Object.keys(messageData).sort();
  const expectedMessageKeys = ["agent", "model", "role", "summary", "time"];
  const ordinaryMessage = messageKeys.length === expectedMessageKeys.length
    && messageKeys.every((key, index) => key === expectedMessageKeys[index])
    && messageData?.role === "user";
  const ordinaryParts = parts.length > 0 && parts.every((part) => {
    const data = parsePartData({
      id: part.id,
      timeCreated: part.time_created,
      timeUpdated: part.time_updated,
      data: part.data,
    });
    if (data === null) return false;
    const keys = Object.keys(data).sort();
    return keys.length === 2
      && keys[0] === "text"
      && keys[1] === "type"
      && data.type === "text"
      && typeof data.text === "string"
      && data.text.length > 0;
  });
  const kind: InputRecord["kind"] = ordinaryMessage && ordinaryParts ? "submission" : "unknown";
  const sessionKey = `${sourceHash}:${session.id}`;
  return {
    originKey: `opencode:input:${stableHash([sourceHash, row.id])}`,
    sourceKey: SOURCE_KEY,
    agent: AGENT,
    sessionKey,
    nativeSessionId: session.id,
    nativeInputId: row.id,
    workspaceKey: session.directory === null || session.directory.length === 0
      ? `opencode:unattributed:${stableHash([sourceHash, session.id])}`
      : normalize(session.directory),
    repositoryKey: null,
    atMs: safeTimestamp(row.time_created),
    kind,
    lane: session.parent_id === null ? "main" : "unknown",
    controller: null,
    origin: "unknown",
    originEvidence: "none",
    quality: kind === "unknown" ? "partial" : "recorded",
    reasons: kind === "unknown" ? ["input-kind-unknown"] : [],
  };
}

function makeCandidate(
  row: MessageRow,
  session: SourceSessionRow,
  sourceHash: string,
  parts: PartRow[],
  includeAccounting: boolean,
  fingerprintOverride?: string,
): CandidateMessage {
  const workspaceKey = session.directory === null || session.directory.length === 0 ? "unattributed" : normalize(session.directory);
  const normalized = row.role === "assistant" && includeAccounting
    ? normalizeOpenCodeMessage({
        id: row.id,
        sessionId: `${sourceHash}:${session.id}`,
        workspaceKey,
        provider: row.provider,
        model: row.model,
        originKey: `opencode:${sourceHash}:message:${row.id}`,
        createdMs: row.time_created,
        updatedMs: row.time_updated,
        startedMs: row.started,
        completedMs: row.completed,
        tokens: row.tokens_json,
        cost: row.cost,
        finish: row.finish,
        parts: parts.map((part) => ({ id: part.id, timeCreated: part.time_created, timeUpdated: part.time_updated, data: part.data })),
      })
    : null;
  const input = normalizeOpenCodeInput(row, session, sourceHash, parts);
  return {
    row,
    session,
    sourceHash,
    parts,
    normalized,
    input,
    fingerprint: fingerprintOverride ?? rawMessageFingerprint(row, parts),
  };
}

function storedMessageState(context: AdapterContext, sourceHash: string, messageId: string): StoredMessageState | null {
  const prefix = `message-state:${sourceHash}:${stableHash(messageId).slice(0, 24)}:`;
  const row = context.store.database.query(`
    SELECT counter_key, observed_at_ms
    FROM counter_snapshots
    WHERE source_key = ? AND counter_key LIKE ?
    ORDER BY observed_at_ms DESC, counter_key DESC LIMIT 1
  `).get(SOURCE_KEY, `${prefix}%`) as { counter_key: string; observed_at_ms: number } | null;
  if (row === null || !row.counter_key.startsWith(prefix)) return null;
  const fingerprint = row.counter_key.slice(prefix.length);
  return fingerprint.length === 64 && safeTimestamp(row.observed_at_ms) !== null
    ? { fingerprint, observedAtMs: row.observed_at_ms }
    : null;
}

function sessionOrder(left: SourceSessionRow, right: SourceSessionRow): number {
  return (safeTimestamp(left.time_created) ?? Number.MAX_SAFE_INTEGER) - (safeTimestamp(right.time_created) ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id);
}

function storedPrefixInput(
  context: AdapterContext,
  position: number,
  sessionKey: string,
): InputRecord | null {
  const prefix = `input-prefix-owner:${stableHash(sessionKey)}:${position}:`;
  const rows = context.store.database.query(`
    SELECT counter_key FROM counter_snapshots
    WHERE source_key = ? AND session_key = ? AND counter_key LIKE ?
  `).all(SOURCE_KEY, sessionKey, `${prefix}%`) as Array<{ counter_key: string }>;
  const records = rows
    .map((row) => context.store.getInput(row.counter_key.slice(prefix.length)))
    .filter((row): row is Record<string, unknown> => row !== null)
    .map(storedInputRecord)
    .filter((record): record is InputRecord => record !== null);
  return records.length === 1 ? records[0]! : null;
}


function determineCloneOwners(scans: SessionScan[], context: AdapterContext): {
  ownerBySession: Map<string, string>;
  duplicateMessageKeys: Set<string>;
  ambiguousMessageKeys: Set<string>;
  retainedReplayInputs: InputRecord[];
  promotedPrefixFingerprints: Set<string>;
} {
  const ownerBySession = new Map<string, string>();
  const duplicateMessageKeys = new Set<string>();
  const ambiguousMessageKeys = new Set<string>();
  const retainedReplayInputs: InputRecord[] = [];
  const promotedPrefixFingerprints = new Set<string>();
  const orderedScans = [...scans].sort((a, b) => sessionOrder(a.session, b.session));

  for (let i = 0; i < orderedScans.length; i += 1) {
    const owner = orderedScans[i] as SessionScan;
    for (let j = i + 1; j < orderedScans.length; j += 1) {
      const copy = orderedScans[j] as SessionScan;
      if (!owner.fullHistory || !copy.fullHistory) continue;
      let common = 0;
      let hasAssistant = false;
      const length = Math.min(owner.messages.length, copy.messages.length);
      while (common < length && owner.messages[common]?.fingerprint === copy.messages[common]?.fingerprint) {
        if (owner.messages[common]?.row.role === "assistant") hasAssistant = true;
        common += 1;
      }
      if (common >= 2 && hasAssistant) {
        const ownerKey = `${owner.sourceHash}:${owner.session.id}`;
        const copyKey = `${copy.sourceHash}:${copy.session.id}`;
        ownerBySession.set(copyKey, ownerBySession.get(ownerKey) ?? ownerKey);
        for (let index = 0; index < common; index += 1) {
          const message = copy.messages[index];
          if (message && (message.normalized !== null || message.input !== null)) {
            duplicateMessageKeys.add(`${copyKey}:${message.row.id}`);
          }
        }
      }
    }
  }

  for (const scan of orderedScans) {
    if (!scan.fullHistory) continue;
    const sessionKey = `${scan.sourceHash}:${scan.session.id}`;
    let common = 0;
    let hasAssistant = false;
    let storedOwner: string | null = null;
    for (const message of scan.messages.slice(0, PREFIX_LIMIT)) {
      const snapshot = context.store.getCounterSnapshot(SOURCE_KEY, `clone-prefix:${message.fingerprint}`);
      if (snapshot === null || typeof snapshot.session_key !== "string" || snapshot.session_key === sessionKey) break;
      if (storedOwner !== null && storedOwner !== snapshot.session_key) break;
      storedOwner = snapshot.session_key;
      if (message.row.role === "assistant") hasAssistant = true;
      common += 1;
    }
    if (common >= 2 && hasAssistant && storedOwner !== null) {
      const storedSession = context.store.database.query(`
        SELECT started_at_ms FROM sessions WHERE agent = 'opencode' AND session_key = ?
      `).get(storedOwner) as { started_at_ms: number | null } | null;
      const currentStarted = safeTimestamp(scan.session.time_created);
      const storedStarted = safeTimestamp(storedSession?.started_at_ms);
      const currentIsOlder = storedSession !== null
        && currentStarted !== null
        && (storedStarted === null
          || currentStarted < storedStarted
          || (currentStarted === storedStarted && sessionKey.localeCompare(storedOwner) < 0));
      if (currentIsOlder) {
        ownerBySession.set(storedOwner, sessionKey);
        for (const [position, message] of scan.messages.slice(0, common).entries()) {
          promotedPrefixFingerprints.add(message.fingerprint);
          if (message.input === null) continue;
          const retainedInput = storedPrefixInput(context, position, storedOwner);
          if (retainedInput === null || retainedInput.kind === "context" || retainedInput.kind === "unknown") continue;
          retainedReplayInputs.push({
            ...retainedInput,
            kind: "replay",
            quality: "recorded",
            reasons: [],
          });
        }
      } else {
        ownerBySession.set(sessionKey, storedOwner);
        for (const message of scan.messages.slice(0, common)) {
          if (message.normalized !== null || message.input !== null) duplicateMessageKeys.add(`${sessionKey}:${message.row.id}`);
        }
      }
    }
  }

  const byFingerprint = new Map<string, CandidateMessage[]>();
  for (const scan of orderedScans) {
    for (const message of scan.messages) {
      if (message.normalized === null) continue;
      const list = byFingerprint.get(message.fingerprint) ?? [];
      list.push(message);
      byFingerprint.set(message.fingerprint, list);
    }
  }
  for (const messages of byFingerprint.values()) {
    if (messages.length < 2) continue;
    messages.sort((a, b) => sessionOrder(a.session, b.session) || a.row.id.localeCompare(b.row.id));
    for (const duplicate of messages.slice(1)) {
      const key = `${duplicate.sourceHash}:${duplicate.session.id}:${duplicate.row.id}`;
      if (!duplicateMessageKeys.has(key)) ambiguousMessageKeys.add(key);
    }
  }
  for (const scan of orderedScans) {
    const sessionKey = `${scan.sourceHash}:${scan.session.id}`;
    for (const message of scan.messages) {
      if (message.normalized === null) continue;
      const messageKey = `${sessionKey}:${message.row.id}`;
      if (duplicateMessageKeys.has(messageKey)) continue;
      const snapshot = context.store.getCounterSnapshot(SOURCE_KEY, `clone-prefix:${message.fingerprint}`);
      if (snapshot !== null && typeof snapshot.session_key === "string" && snapshot.session_key !== sessionKey) {
        ambiguousMessageKeys.add(messageKey);
      }
    }
  }
  return {
    ownerBySession,
    duplicateMessageKeys,
    ambiguousMessageKeys,
    retainedReplayInputs,
    promotedPrefixFingerprints,
  };
}

function collectDatabase(path: string, context: AdapterContext, forceInputHistory: boolean): {
  scans: SessionScan[];
  sessions: SessionRecord[];
  snapshots: CounterSnapshot[];
} {
  const sourceHash = privatePathHash(path);
  const database = new Database(path, { readonly: true });
  const scans: SessionScan[] = [];
  const sessions: SessionRecord[] = [];
  const snapshots: CounterSnapshot[] = [];
  let transactionOpen = false;
  try {
    database.exec("BEGIN");
    transactionOpen = true;
    const sessionRows = database.query(`
      SELECT id, directory, parent_id, time_created, time_updated
      FROM session ORDER BY time_created, id
    `).all() as SourceSessionRow[];

    for (const session of sessionRows) {
      const sessionKey = `${sourceHash}:${session.id}`;
      const workspaceKey = session.directory === null || session.directory.length === 0 ? null : normalize(session.directory);
      const baseline = snapshotWatermark(context, sourceHash, session.id);
      const priorMessageTime = context.rebuild ? null : safeTimestamp(baseline?.observed_at_ms);
      const priorSessionUpdate = context.rebuild ? null : safeTimestamp(baseline?.last_seen_ms);
      const sessionChanged = priorSessionUpdate === null || safeTimestamp(session.time_updated) !== priorSessionUpdate;
      const shouldScan = context.rebuild || context.reconcileAll || forceInputHistory || baseline === null || sessionChanged;
      const incompleteIds = !context.rebuild && !context.reconcileAll && baseline !== null
        ? new Set(readIncompleteMessageIds(context, sessionKey))
        : new Set<string>();
      const rows = shouldScan ? readMessagesKeyset(database, session.id, null) : [];
      const fullHistory = shouldScan;
      const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()]
        .filter((row) => safeTimestamp(row.time_created) !== null && row.time_created <= context.cutoffMs)
        .sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id));
      const messages = uniqueRows.map((row) => {
        const priorState = context.rebuild ? null : storedMessageState(context, sourceHash, row.id);
        const existingUsage = row.role === "assistant"
          ? context.store.getUsage(`opencode:${sourceHash}:message:${row.id}`)
          : null;
        const needsParts = row.role === "user"
          || priorState === null
          || safeTimestamp(row.time_updated) !== priorState.observedAtMs
          || existingUsage?.quality === "partial";
        const includeAccounting = context.rebuild
          || context.reconcileAll
          || priorMessageTime === null
          || row.time_created >= priorMessageTime
          || priorState === null
          || safeTimestamp(row.time_updated) !== priorState.observedAtMs
          || existingUsage?.quality === "partial"
          || incompleteIds.has(row.id);
        const candidate = makeCandidate(
          row,
          session,
          sourceHash,
          needsParts ? readParts(database, row.id) : [],
          includeAccounting,
          needsParts ? undefined : priorState.fingerprint,
        );
        snapshots.push({
          sourceKey: SOURCE_KEY,
          counterKey: `message-state:${sourceHash}:${stableHash(row.id).slice(0, 24)}:${candidate.fingerprint}`,
          sessionKey,
          observedAtMs: safeTimestamp(row.time_updated) ?? row.time_created,
          quality: "recorded",
          reasons: [],
        });
        return candidate;
      });
      const watermark = Math.max(priorMessageTime ?? 0, ...uniqueRows.map((row) => row.time_created));
      scans.push({ session, sourceHash, messages, fullHistory });
      const quality: Quality = workspaceKey === null ? "partial" : "recorded";
      sessions.push({
        agent: AGENT,
        sessionKey,
        originKey: `opencode:${sourceHash}:session:${session.id}`,
        sourceKey: SOURCE_KEY,
        canonicalSessionKey: sessionKey,
        parentSessionKey: session.parent_id === null ? null : `${sourceHash}:${session.parent_id}`,
        rootSessionKey: null,
        workspaceKey,
        repositoryKey: null,
        startedAtMs: safeTimestamp(session.time_created),
        endedAtMs: null,
        quality,
        reasons: quality === "partial" ? ["unattributed-session"] : [],
      });
      snapshots.push({
        sourceKey: SOURCE_KEY,
        counterKey: `message-watermark:${sourceHash}:${session.id}`,
        sessionKey,
        observedAtMs: watermark,
        firstSeenMs: safeTimestamp(session.time_created),
        lastSeenMs: safeTimestamp(session.time_updated),
        quality: "recorded",
        reasons: [],
      });
    }
    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the projection failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
  return { scans, sessions, snapshots };
}

async function collect(context: AdapterContext): Promise<AdapterBatch> {
  const selected = configuredPaths(context.config);
  const paths = expandSourcePaths(selected);
  const priorInputState = context.store.getInputSourceState(SOURCE_KEY);
  const forceInputHistory = context.rebuild
    || context.reconcileAll
    || priorInputState === null
    || priorInputState.parser_version !== 1
    || priorInputState.last_successful_scan_ms === null;
  const previousSuccessfulScan = typeof priorInputState?.last_successful_scan_ms === "number"
    ? priorInputState.last_successful_scan_ms
    : null;
  const source: SourceRecord = {
    sourceKey: SOURCE_KEY,
    agent: AGENT,
    kind: "sqlite",
    sourcePath: paths.length === 1 ? paths[0] : null,
    state: paths.length === 0 ? "not-found" : "available",
    tokenQuality: paths.length === 0 ? "unavailable" : "recorded",
    workQuality: paths.length === 0 ? "unavailable" : "recorded",
    reasons: paths.length === 0 ? ["missing-source"] : [],
    diagnosticCounts: {},
    lastSeenMs: context.cutoffMs,
    lastSuccessfulScanMs: paths.length === 0 ? null : context.cutoffMs,
    cutoffMs: context.cutoffMs,
  };
  if (paths.length === 0) {
    return {
      source,
      sessions: [],
      usage: [],
      workIntervals: [],
      inputs: [],
      inputSourceState: {
        sourceKey: SOURCE_KEY,
        agent: AGENT,
        parserVersion: 1,
        quality: "unavailable",
        reasons: ["missing-source"],
        scannedAtMs: context.cutoffMs,
        lastSuccessfulScanMs: previousSuccessfulScan,
      },
      counterSnapshots: [],
      fileCursors: [],
      unallocatedUsageRecords: 0,
      excludedAmbiguousRecords: 0,
    };
  }

  const scans: SessionScan[] = [];
  const sessions: SessionRecord[] = [];
  const counterSnapshots: CounterSnapshot[] = [];
  let unsupported = 0;
  let parseGaps = 0;
  let inputScanFailures = 0;
  let projectedDatabases = 0;
  for (const path of paths) {
    const probe = probeOpenCodeDatabase(path);
    if (probe.state !== "available") {
      unsupported += 1;
      continue;
    }
    try {
      const result = collectDatabase(path, context, forceInputHistory);
      scans.push(...result.scans);
      sessions.push(...result.sessions);
      counterSnapshots.push(...result.snapshots);
      projectedDatabases += 1;
    } catch {
      parseGaps += 1;
      inputScanFailures += 1;
    }
  }

  const {
    ownerBySession,
    duplicateMessageKeys,
    ambiguousMessageKeys,
    retainedReplayInputs,
    promotedPrefixFingerprints,
  } = determineCloneOwners(scans, context);
  const usage: UsageRecord[] = [];
  const workIntervals: WorkInterval[] = [];
  const emittedOrigins = new Set<string>();
  let openIntervals = 0;
  for (const scan of scans) {
    const sessionKey = `${scan.sourceHash}:${scan.session.id}`;
    for (const message of scan.messages) {
      if (message.normalized === null) continue;
      const messageKey = `${sessionKey}:${message.row.id}`;
      if (duplicateMessageKeys.has(messageKey) || ambiguousMessageKeys.has(messageKey)) continue;
      const normalized = message.normalized;
      const existing = context.store.getUsage(normalized.usage.originKey);
      if (existing !== null && existing.session_key !== normalized.usage.sessionKey) {
        ambiguousMessageKeys.add(messageKey);
        continue;
      }
      if (emittedOrigins.has(normalized.usage.originKey)) {
        ambiguousMessageKeys.add(messageKey);
        continue;
      }
      emittedOrigins.add(normalized.usage.originKey);
      usage.push(normalized.usage);
      workIntervals.push(...normalized.workIntervals);
      if (normalized.usage.quality === "partial") parseGaps += 1;
      if (normalized.openWait) openIntervals += 1;
    }
    const canonicalSessionKey = ownerBySession.get(sessionKey);
    if (canonicalSessionKey !== undefined) {
      const record = sessions.find((candidate) => candidate.sessionKey === sessionKey);
      if (record !== undefined) record.canonicalSessionKey = canonicalSessionKey;
    }
  }
  const currentInputs: InputRecord[] = [];
  const inputReasons = new Set<string>();
  for (const scan of scans) {
    const sessionKey = `${scan.sourceHash}:${scan.session.id}`;
    for (const message of scan.messages) {
      if (message.input === null) continue;
      const messageKey = `${sessionKey}:${message.row.id}`;
      const input = { ...message.input, reasons: [...message.input.reasons] };
      if (duplicateMessageKeys.has(messageKey)) {
        input.kind = "replay";
        input.quality = "recorded";
        input.reasons = [];
      } else {
        const retained = context.store.getInput(input.originKey);
        const retainedInput = retained === null ? null : storedInputRecord(retained);
        if (retainedInput?.kind === "replay" && input.kind === "submission") {
          input.kind = "replay";
        }
      }
      if (input.kind === "unknown") inputReasons.add("input-kind-unknown");
      currentInputs.push(input);
    }
  }
  currentInputs.push(...retainedReplayInputs);
  if (unsupported > 0 || inputScanFailures > 0) inputReasons.add("input-history-incomplete");
  if (!forceInputHistory && priorInputState?.quality === "partial") {
    for (const reason of storedInputReasons(priorInputState)) inputReasons.add(reason);
  }
  const inputs = mergeInputRecords(
    currentInputs,
    retainedInputRecords(context.store, currentInputs.map((record) => record.originKey)),
  );
  const inputQuality: Quality = projectedDatabases === 0
    ? "unavailable"
    : inputReasons.size > 0 ? "partial" : "recorded";
  const coherentInputScan = paths.length > 0
    && projectedDatabases === paths.length
    && unsupported === 0
    && inputScanFailures === 0
    && inputReasons.size === 0;
  const inputSourceState = {
    sourceKey: SOURCE_KEY,
    agent: AGENT,
    parserVersion: 1 as const,
    quality: inputQuality,
    reasons: [...inputReasons].sort(),
    scannedAtMs: context.cutoffMs,
    lastSuccessfulScanMs: coherentInputScan ? context.cutoffMs : previousSuccessfulScan,
  };

  const reasons = new Set<string>();
  if (unsupported > 0) reasons.add("unsupported-schema");
  if (parseGaps > 0) reasons.add("parse-gap");
  if (ambiguousMessageKeys.size > 0) reasons.add("duplicate-ambiguity");
  if (openIntervals > 0) reasons.add("open-interval");
  const successful = paths.length - unsupported - (parseGaps > 0 && scans.length === 0 ? 1 : 0);
  source.state = successful <= 0 ? (unsupported > 0 ? "unsupported-schema" : "partial") : reasons.size > 0 ? "partial" : "available";
  source.tokenQuality = successful <= 0 ? "unavailable" : reasons.has("parse-gap") || reasons.has("duplicate-ambiguity") ? "partial" : "recorded";
  source.workQuality = successful <= 0 ? "unavailable" : reasons.has("open-interval") || reasons.has("parse-gap") ? "partial" : "recorded";
  source.reasons = [...reasons].sort();
  source.diagnosticCounts = {
    ...(unsupported > 0 ? { unsupportedSchema: unsupported } : {}),
    ...(parseGaps > 0 ? { parseGaps } : {}),
    ...(ambiguousMessageKeys.size > 0 ? { duplicateAmbiguities: ambiguousMessageKeys.size } : {}),
    ...(openIntervals > 0 ? { openIntervals } : {}),
  };
  source.lastSuccessfulScanMs = successful > 0 ? context.cutoffMs : null;

  const prefixSnapshots = new Map<string, CounterSnapshot>();
  for (const scan of scans) {
    const sessionKey = `${scan.sourceHash}:${scan.session.id}`;
    const canonicalSessionKey = ownerBySession.get(sessionKey) ?? sessionKey;
    for (const [position, message] of scan.messages.slice(0, PREFIX_LIMIT).entries()) {
      const key = `clone-prefix:${message.fingerprint}`;
      if (promotedPrefixFingerprints.has(message.fingerprint)
        || (context.store.getCounterSnapshot(SOURCE_KEY, key) === null && !prefixSnapshots.has(key))) {
        prefixSnapshots.set(key, {
          sourceKey: SOURCE_KEY,
          counterKey: key,
          sessionKey: canonicalSessionKey,
          observedAtMs: message.row.time_created,
          quality: "recorded",
          reasons: [],
        });
      }
      if (message.input !== null && !duplicateMessageKeys.has(`${sessionKey}:${message.row.id}`)) {
        counterSnapshots.push({
          sourceKey: SOURCE_KEY,
          counterKey: `input-prefix-owner:${stableHash(sessionKey)}:${position}:${message.input.originKey}`,
          sessionKey,
          observedAtMs: message.row.time_created,
          quality: "recorded",
          reasons: [],
        });
      }
    }
  }
  counterSnapshots.push(...prefixSnapshots.values());

  return {
    source,
    sessions,
    usage,
    workIntervals,
    inputs,
    inputSourceState,
    counterSnapshots,
    fileCursors: [],
    unallocatedUsageRecords: 0,
    excludedAmbiguousRecords: ambiguousMessageKeys.size,
  };
}

export const opencodeAdapter: SourceAdapter = {
  agent: AGENT,
  discover,
  collect,
};
