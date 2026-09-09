import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalizePotentialPath, loadConfig, isPathWithin, type Config } from "./config";
import type { InputRecord, UsageRecord, WorkInterval } from "./contracts";
import { mergeInputRecords, storedInputReasons } from "./inputs";
import { discoverGitRepositories } from "./git";
import { withWriterLock } from "./lock";
import {
  openCollectorStore,
  type CollectorStore,
  type ScopeDecision,
  type ScopeEvidence,
  type ScopeMembership,
  type SessionRecord,
  type WorkspaceAttribution,
} from "./store";
import { claudeAdapter } from "./sources/claude";
import { codexAdapter } from "./sources/codex";
import { hermesAdapter } from "./sources/hermes";
import { ompAdapter } from "./sources/omp";
import { opencodeAdapter } from "./sources/opencode";
import { collectInputProvenance } from "./sources/provenance";
import type { AdapterBatch, AdapterContext, SourceAdapter } from "./sources/types";

export const SOURCE_ADAPTERS: readonly SourceAdapter[] = [
  codexAdapter,
  claudeAdapter,
  ompAdapter,
  opencodeAdapter,
  hermesAdapter,
];

export interface CollectOptions {
  rebuild?: boolean;
  cutoffMs?: number;
  reconcileAll?: boolean;
  adapters?: readonly SourceAdapter[];
  store?: CollectorStore;
}

export interface CollectionSummary {
  runKey: string;
  startedAtMs: number;
  completedAtMs: number;
  cutoffMs: number;
  status: "completed" | "partial";
  adaptersCollected: number;
  unallocatedUsageRecords: number;
  excludedAmbiguousRecords: number;
  excludedUnattributedRecords: number;
}

interface ScopeResolution extends ScopeMembership {
  workspaceKey: string;
  repositoryKey: string | null;
  scopeDecision: ScopeDecision;
  scopeReason: string;
  provenance?: WorkspaceAttribution["provenance"];
}

interface ScopeResolver {
  resolve(
    agent: UsageRecord["agent"],
    sessionKey: string,
    workspaceCandidate: string | null | undefined,
    repositoryCandidate?: string | null,
  ): ScopeResolution;
}

function canonicalExistingPath(path: string): string | null {
  if (!isAbsolute(path) || !existsSync(path)) return null;
  try {
    return normalize(realpathSync.native(path));
  } catch {
    return null;
  }
}

function gitCommonDirectory(path: string): string | null {
  const result = spawnSync("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const value = result.stdout.trim();
  return value.length > 0 && isAbsolute(value) ? canonicalExistingPath(value) : null;
}

function lexicalPath(candidate: string): string | null {
  if (!isAbsolute(candidate)) return null;
  try {
    return canonicalizePotentialPath(candidate, "workspace path");
  } catch {
    return null;
  }
}

export function createScopeResolver(config: Config, store?: CollectorStore): ScopeResolver {
  const workspaceRoots = config.workspaceRoots.map((root) => canonicalExistingPath(root) ?? normalize(root));
  const discovery = discoverGitRepositories(config.workspaceRoots, config.repositories);
  const repositories = discovery.repositories.map((repository) => ({
    path: repository.path,
    commonDirectory: repository.commonDir,
  }));
  const historical = (config.historicalWorkspaces ?? []).map((mapping) => ({
    ...mapping,
    path: lexicalPath(mapping.path) ?? normalize(mapping.path),
    repositoryPath: lexicalPath(mapping.repositoryPath) ?? normalize(mapping.repositoryPath),
  }));
  const cache = new Map<string, ScopeResolution>();

  const includedRepository = (repositoryPath: string): boolean =>
    repositories.some((repository) =>
      repository.path === repositoryPath ||
      isPathWithin(repository.path, repositoryPath) ||
      isPathWithin(repositoryPath, repository.path),
    ) ||
    config.repositories.some((repository) => {
      const configured = lexicalPath(repository.path) ?? normalize(repository.path);
      return configured === repositoryPath;
    }) ||
    workspaceRoots.some((root) => isPathWithin(root, repositoryPath));

  return {
    resolve(agent, sessionKey, workspaceCandidate, repositoryCandidate) {
      const cacheKey = `${agent}\0${sessionKey}\0${workspaceCandidate ?? ""}\0${repositoryCandidate ?? ""}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;

      const workspaceLexical = typeof workspaceCandidate === "string" ? lexicalPath(workspaceCandidate) : null;
      const workspaceLive = typeof workspaceCandidate === "string" ? canonicalExistingPath(workspaceCandidate) : null;
      const repositoryLive = typeof repositoryCandidate === "string" ? canonicalExistingPath(repositoryCandidate) : null;
      const liveCandidates = [workspaceLive, repositoryLive].filter((value): value is string => value !== null);
      const liveIdentities = [...new Set(liveCandidates.map(gitCommonDirectory).filter((value): value is string => value !== null))];
      let resolution: ScopeResolution;

      if (liveIdentities.length > 1) {
        resolution = {
          workspaceKey: workspaceLive ?? workspaceLexical ?? "unattributed",
          repositoryKey: null,
          scopeDecision: "unattributed",
          scopeReason: "attribution-conflict",
        };
      } else {
        const liveIdentity = liveIdentities[0] ?? null;
        const identityRepository = liveIdentity === null
          ? null
          : repositories.find((repository) => repository.commonDirectory === liveIdentity) ?? null;
        const insideRoot =
          liveCandidates.some((candidate) => workspaceRoots.some((root) => isPathWithin(root, candidate))) ||
          (workspaceLexical !== null && workspaceRoots.some((root) => isPathWithin(root, workspaceLexical)));

        if (identityRepository !== null) {
          resolution = {
            workspaceKey: workspaceLive ?? repositoryLive ?? workspaceLexical ?? identityRepository.path,
            repositoryKey: identityRepository.path,
            scopeDecision: "included",
            scopeReason: "repository-identity",
            provenance: "repository-identity",
          };
        } else if (liveIdentity !== null) {
          resolution = {
            workspaceKey: workspaceLive ?? repositoryLive ?? workspaceLexical ?? "unattributed",
            repositoryKey: null,
            scopeDecision: "out-of-scope",
            scopeReason: "unrelated-live-repository",
          };
        } else if (insideRoot) {
          resolution = {
            workspaceKey: workspaceLive ?? repositoryLive ?? workspaceLexical!,
            repositoryKey: null,
            scopeDecision: "included",
            scopeReason: "configured-root",
          };
        } else {
          const historicalMatch = workspaceLexical === null
            ? undefined
            : historical.find((mapping) =>
              mapping.match === "exact"
                ? mapping.path === workspaceLexical
                : isPathWithin(mapping.path, workspaceLexical),
            );
          if (historicalMatch !== undefined && includedRepository(historicalMatch.repositoryPath)) {
            resolution = {
              workspaceKey: workspaceLexical!,
              repositoryKey: historicalMatch.repositoryPath,
              scopeDecision: "included",
              scopeReason: `historical-${historicalMatch.match}`,
              provenance: `historical-${historicalMatch.match}`,
            };
          } else {
            const verified = workspaceLexical === null || store === undefined
              ? null
              : store.database.query(`
                  SELECT repository_key, provenance FROM workspace_attributions
                  WHERE agent = ? AND session_key = ? AND workspace_key = ?
                `).get(agent, sessionKey, workspaceLexical) as {
                  repository_key: string;
                  provenance: WorkspaceAttribution["provenance"];
                } | null;
            if (verified !== null && includedRepository(verified.repository_key)) {
              resolution = {
                workspaceKey: workspaceLexical!,
                repositoryKey: verified.repository_key,
                scopeDecision: "included",
                scopeReason: "cached-attribution",
              };
            } else {
              resolution = {
                workspaceKey: workspaceLexical ?? "unattributed",
                repositoryKey: null,
                scopeDecision: workspaceLexical === null ? "unattributed" : "out-of-scope",
                scopeReason: workspaceLexical === null ? "attribution-unavailable" : "outside-configured-scope",
              };
            }
          }
        }
      }
      cache.set(cacheKey, resolution);
      return resolution;
    },
  };
}

function completeness(record: UsageRecord): number {
  let score = record.quality === "recorded" ? 100 : record.quality === "partial" ? 50 : 0;
  for (const value of [record.uncachedInput, record.cacheRead, record.cacheWrite, record.output, record.reasoning, record.total]) {
    if (value !== null) score += 1;
  }
  if (record.atMs !== null) score += 1;
  if (record.costMicrousd !== null) score += 1;
  return score;
}

function deduplicateUsage(records: readonly UsageRecord[]): UsageRecord[] {
  const byOrigin = new Map<string, UsageRecord>();
  for (const record of records) {
    const prior = byOrigin.get(record.originKey);
    if (prior === undefined) {
      byOrigin.set(record.originKey, record);
      continue;
    }
    const priorCompleteness = completeness(prior);
    const currentCompleteness = completeness(record);
    if (currentCompleteness < priorCompleteness) continue;
    const priorAccounting = [
      prior.atMs, prior.provider, prior.model, prior.uncachedInput, prior.cacheRead, prior.cacheWrite,
      prior.output, prior.reasoning, prior.total, prior.costMicrousd, prior.costKind,
    ];
    const currentAccounting = [
      record.atMs, record.provider, record.model, record.uncachedInput, record.cacheRead, record.cacheWrite,
      record.output, record.reasoning, record.total, record.costMicrousd, record.costKind,
    ];
    const inconsistent = prior.reasons.includes("parse-gap") ||
      (currentCompleteness === priorCompleteness &&
        priorAccounting.some((value, index) => value !== currentAccounting[index]));
    byOrigin.set(record.originKey, inconsistent
      ? {
          ...record,
          quality: "partial",
          reasons: [...new Set([...record.reasons, ...prior.reasons, "parse-gap"])].sort(),
        }
      : record);
  }
  return [...byOrigin.values()];
}

function deduplicateWork(records: readonly WorkInterval[]): WorkInterval[] {
  const byOrigin = new Map<string, WorkInterval>();
  for (const record of records) byOrigin.set(record.originKey, record);
  return [...byOrigin.values()];
}

function deduplicateSessions(records: readonly SessionRecord[]): SessionRecord[] {
  const bySession = new Map<string, SessionRecord>();
  for (const record of records) bySession.set(`${record.agent}\0${record.sessionKey}`, record);
  return [...bySession.values()];
}
function hasAbsoluteAttribution(workspaceKey: string | null | undefined, repositoryKey: string | null | undefined): boolean {
  return (typeof workspaceKey === "string" && isAbsolute(workspaceKey)) ||
    (typeof repositoryKey === "string" && isAbsolute(repositoryKey));
}


function scopeSessionRecords(
  records: readonly SessionRecord[],
  resolver: ScopeResolver,
): {
  records: Array<SessionRecord & ScopeMembership>;
  scopes: Map<string, ScopeResolution>;
  attributions: WorkspaceAttribution[];
} {
  const sessions = deduplicateSessions(records);
  const byKey = new Map(sessions.map((session) => [`${session.agent}\0${session.sessionKey}`, session]));
  const scopes = new Map<string, ScopeResolution>();
  const resolving = new Set<string>();
  const attributions: WorkspaceAttribution[] = [];

  const resolveSession = (session: SessionRecord): ScopeResolution => {
    const key = `${session.agent}\0${session.sessionKey}`;
    const existing = scopes.get(key);
    if (existing !== undefined) return existing;
    if (resolving.has(key)) {
      const conflict: ScopeResolution = {
        workspaceKey: "unattributed",
        repositoryKey: null,
        scopeDecision: "unattributed",
        scopeReason: "attribution-conflict",
      };
      scopes.set(key, conflict);
      return conflict;
    }
    resolving.add(key);
    let scope = resolver.resolve(session.agent, session.sessionKey, session.workspaceKey, session.repositoryKey);
    if (scope.scopeDecision !== "included" && !hasAbsoluteAttribution(session.workspaceKey, session.repositoryKey) && session.parentSessionKey != null) {
      const parent = byKey.get(`${session.agent}\0${session.parentSessionKey}`);
      if (parent !== undefined) scope = resolveSession(parent);
    }
    resolving.delete(key);
    scopes.set(key, scope);
    if (scope.scopeDecision === "included" && scope.repositoryKey !== null && scope.provenance !== undefined) {
      attributions.push({
        agent: session.agent,
        sessionKey: session.sessionKey,
        workspaceKey: scope.workspaceKey,
        repositoryKey: scope.repositoryKey,
        provenance: scope.provenance,
        verifiedAtMs: Date.now(),
      });
    }
    return scope;
  };

  return {
    records: sessions.map((session) => {
      const scope = resolveSession(session);
      return {
        ...session,
        workspaceKey: scope.workspaceKey,
        repositoryKey: scope.repositoryKey,
        scopeDecision: scope.scopeDecision,
        scopeReason: scope.scopeReason,
      };
    }),
    scopes,
    attributions,
  };
}

export function filterAdapterBatch(
  batch: AdapterBatch,
  config: Config,
  sharedResolver?: ScopeResolver,
  observedAtMs = Date.now(),
): Omit<AdapterBatch, "sessions" | "usage" | "workIntervals" | "inputs"> & {
  sessions: Array<SessionRecord & ScopeMembership>;
  usage: Array<UsageRecord & ScopeMembership>;
  workIntervals: Array<WorkInterval & ScopeMembership>;
  inputs: Array<InputRecord & ScopeMembership>;
  excludedUnattributedRecords: number;
  workspaceAttributions: WorkspaceAttribution[];
  scopeEvidence: ScopeEvidence[];
} {
  const resolver = sharedResolver ?? createScopeResolver(config);
  const scopedSessions = scopeSessionRecords(batch.sessions, resolver);
  const sourceBySession = new Map(scopedSessions.records.map((session) => [
    `${session.agent}\0${session.sessionKey}`,
    session.sourceKey,
  ]));
  let excludedUnattributedRecords = scopedSessions.records.filter((session) =>
    session.scopeDecision === "unattributed").length;

  const usage = deduplicateUsage(batch.usage).map((record) => {
    const recordKey = `${record.agent}\0${record.sessionKey}`;
    const sessionScope = scopedSessions.scopes.get(recordKey);
    const scope = hasAbsoluteAttribution(record.workspaceKey, record.repositoryKey)
      ? resolver.resolve(record.agent, record.sessionKey, record.workspaceKey, record.repositoryKey)
      : sessionScope ?? resolver.resolve(record.agent, record.sessionKey, null);
    if (scope.scopeDecision === "unattributed") excludedUnattributedRecords += 1;
    return {
      ...record,
      workspaceKey: scope.workspaceKey,
      repositoryKey: scope.repositoryKey,
      scopeDecision: scope.scopeDecision,
      scopeReason: scope.scopeReason,
    };
  });

  const workIntervals = deduplicateWork(batch.workIntervals).map((record) => {
    const scope = hasAbsoluteAttribution(record.workspaceKey, record.repositoryKey)
      ? resolver.resolve(record.agent, record.sessionKey, record.workspaceKey, record.repositoryKey)
      : scopedSessions.scopes.get(`${record.agent}\0${record.sessionKey}`) ??
        resolver.resolve(record.agent, record.sessionKey, null);
    if (scope.scopeDecision === "unattributed") excludedUnattributedRecords += 1;
    return {
      ...record,
      workspaceKey: scope.workspaceKey,
      repositoryKey: scope.repositoryKey,
      scopeDecision: scope.scopeDecision,
      scopeReason: scope.scopeReason,
    };
  });
  const inputs = mergeInputRecords(batch.inputs).map((record) => {
    const scope = hasAbsoluteAttribution(record.workspaceKey, record.repositoryKey)
      ? resolver.resolve(record.agent, record.sessionKey, record.workspaceKey, record.repositoryKey)
      : scopedSessions.scopes.get(`${record.agent}\0${record.sessionKey}`) ??
        resolver.resolve(record.agent, record.sessionKey, null);
    return {
      ...record,
      workspaceKey: scope.workspaceKey,
      repositoryKey: scope.repositoryKey,
      scopeDecision: scope.scopeDecision,
      scopeReason: scope.scopeReason,
    };
  });

  const scopeEvidence: ScopeEvidence[] = usage.map((record) => ({
    originKey: record.originKey,
    sourceKey: sourceBySession.get(`${record.agent}\0${record.sessionKey}`) ?? batch.source.sourceKey,
    agent: record.agent,
    sessionKey: record.sessionKey,
    workspaceKey: record.workspaceKey,
    repositoryKey: record.repositoryKey,
    atMs: record.atMs,
    provider: record.provider,
    knownTotal: record.total,
    decision: record.scopeDecision,
    reason: record.scopeReason,
    lastSeenMs: observedAtMs,
  }));

  const diagnosticCounts = { ...(batch.source.diagnosticCounts ?? {}) };
  const reasons = [...(batch.source.reasons ?? [])];
  if (excludedUnattributedRecords > 0) {
    diagnosticCounts["unattributed-session"] = (diagnosticCounts["unattributed-session"] ?? 0) + excludedUnattributedRecords;
    reasons.push("unattributed-session");
  }

  return {
    ...batch,
    source: {
      ...batch.source,
      diagnosticCounts,
      reasons: [...new Set(reasons)].sort(),
      tokenQuality: excludedUnattributedRecords > 0 && batch.source.tokenQuality === "recorded" ? "partial" : batch.source.tokenQuality,
      workQuality: excludedUnattributedRecords > 0 && batch.source.workQuality === "recorded" ? "partial" : batch.source.workQuality,
    },
    sessions: scopedSessions.records,
    usage,
    workIntervals,
    inputs,
    excludedUnattributedRecords,
    workspaceAttributions: scopedSessions.attributions,
    scopeEvidence,
  };
}

interface StoredScopeRow {
  origin_key: string;
  agent: UsageRecord["agent"];
  session_key: string;
  workspace_key: string | null;
  repository_key: string | null;
}

function reconcileStoredScope(store: CollectorStore, resolver: ScopeResolver, observedAtMs: number): void {
  const sessions = store.database.query(`
    SELECT origin_key, agent, session_key, workspace_key, repository_key FROM sessions
  `).all() as StoredScopeRow[];
  for (const row of sessions) {
    const scope = resolver.resolve(row.agent, row.session_key, row.workspace_key, row.repository_key);
    store.database.query(`
      UPDATE sessions SET workspace_key = ?, repository_key = ?, scope_decision = ?, scope_reason = ?
      WHERE agent = ? AND session_key = ?
    `).run(
      scope.workspaceKey, scope.repositoryKey, scope.scopeDecision, scope.scopeReason,
      row.agent, row.session_key,
    );
  }

  const usage = store.database.query(`
    SELECT origin_key, agent, session_key, workspace_key, repository_key, at_ms, provider, total
    FROM usage
  `).all() as Array<StoredScopeRow & {
    at_ms: number | null;
    provider: string;
    total: number | null;
  }>;
  for (const row of usage) {
    const scope = resolver.resolve(row.agent, row.session_key, row.workspace_key, row.repository_key);
    store.database.query(`
      UPDATE usage SET workspace_key = ?, repository_key = ?, scope_decision = ?, scope_reason = ?
      WHERE origin_key = ?
    `).run(scope.workspaceKey, scope.repositoryKey, scope.scopeDecision, scope.scopeReason, row.origin_key);
    store.upsertScopeEvidence({
      originKey: row.origin_key,
      agent: row.agent,
      sessionKey: row.session_key,
      workspaceKey: scope.workspaceKey,
      repositoryKey: scope.repositoryKey,
      atMs: row.at_ms,
      provider: row.provider,
      knownTotal: row.total,
      decision: scope.scopeDecision,
      reason: scope.scopeReason,
      lastSeenMs: observedAtMs,
    });
  }

  const intervals = store.database.query(`
    SELECT origin_key, agent, session_key, workspace_key, repository_key FROM work_intervals
  `).all() as StoredScopeRow[];
  for (const row of intervals) {
    const scope = resolver.resolve(row.agent, row.session_key, row.workspace_key, row.repository_key);
    store.database.query(`
      UPDATE work_intervals SET workspace_key = ?, repository_key = ?, scope_decision = ?, scope_reason = ?
      WHERE origin_key = ?
    `).run(scope.workspaceKey, scope.repositoryKey, scope.scopeDecision, scope.scopeReason, row.origin_key);
  }

  const inputs = store.database.query(`
    SELECT origin_key, agent, session_key, workspace_key, repository_key FROM input_events
  `).all() as StoredScopeRow[];
  for (const row of inputs) {
    const scope = resolver.resolve(row.agent, row.session_key, row.workspace_key, row.repository_key);
    store.database.query(`
      UPDATE input_events SET workspace_key = ?, repository_key = ?, scope_decision = ?, scope_reason = ?
      WHERE origin_key = ?
    `).run(scope.workspaceKey, scope.repositoryKey, scope.scopeDecision, scope.scopeReason, row.origin_key);
  }
}

export async function collectIntoStore(
  config: Config,
  store: CollectorStore,
  options: Omit<CollectOptions, "store"> = {},
): Promise<CollectionSummary> {
  const rebuild = options.rebuild ?? false;
  const cutoffMs = options.cutoffMs ?? Date.now();
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new TypeError("cutoffMs must be a nonnegative safe integer");
  const adapters = options.adapters ?? SOURCE_ADAPTERS;
  const startedAtMs = Date.now();
  const runKey = randomUUID();
  store.writeBatch({
    collectionRuns: [{ runKey, startedAtMs, cutoffMs, status: "running", rebuild, diagnosticCounts: {} }],
  });
  const resolver = createScopeResolver(config, store);

  let status: CollectionSummary["status"] = "completed";
  let unallocatedUsageRecords = 0;
  let excludedAmbiguousRecords = 0;
  let excludedUnattributedRecords = 0;
  let adaptersCollected = 0;
  let provenanceDiagnosticCounts: Record<string, number> = {};
  try {
    for (const adapter of adapters) {
      const context: AdapterContext = {
        config,
        store,
        rebuild,
        cutoffMs,
        reconcileAll: options.reconcileAll ?? rebuild,
      };
      const collected = await adapter.collect(context);
      if (collected.source.agent !== adapter.agent) {
        throw new Error(`Adapter ${adapter.agent} returned a source record for another agent`);
      }
      if (collected.inputSourceState.agent !== adapter.agent) {
        throw new Error(`Adapter ${adapter.agent} returned input state for another agent`);
      }
      const batch = filterAdapterBatch(collected, config, resolver, cutoffMs);
      const sourceAvailable = batch.source.state === "available" || batch.source.state === "partial";
      const previousInputState = store.getInputSourceState(batch.inputSourceState.sourceKey);
      const effectiveInputState = batch.inputSourceState.quality === "unavailable"
        ? {
            ...batch.inputSourceState,
            reasons: [...new Set([
              ...storedInputReasons(previousInputState),
              ...batch.inputSourceState.reasons,
            ])].sort(),
            lastSuccessfulScanMs: typeof previousInputState?.last_successful_scan_ms === "number"
              ? previousInputState.last_successful_scan_ms
              : null,
          }
        : batch.inputSourceState;
      store.transaction(() => {
        if (!sourceAvailable) {
          // Inventory freshness changes, while retained facts are reclassified
          // against the current scope without being erased.
          store.writeBatch({
            sources: [batch.source],
            inputSourceStates: [effectiveInputState],
          });
        } else {
          store.writeBatch({
            sources: [batch.source],
            sessions: batch.sessions,
            usage: batch.usage,
            workIntervals: batch.workIntervals,
            inputs: batch.inputs,
            inputSourceStates: [effectiveInputState],
            counterSnapshots: batch.counterSnapshots,
            fileCursors: batch.fileCursors,
            workspaceAttributions: batch.workspaceAttributions,
            scopeEvidence: batch.scopeEvidence,
          });
        }
        reconcileStoredScope(store, resolver, cutoffMs);
      });
      adaptersCollected += 1;
      unallocatedUsageRecords += batch.unallocatedUsageRecords;
      excludedAmbiguousRecords += batch.excludedAmbiguousRecords;
      excludedUnattributedRecords += batch.excludedUnattributedRecords;
      if (
        batch.source.state !== "available"
        || batch.source.tokenQuality !== "recorded"
        || batch.source.workQuality !== "recorded"
        || effectiveInputState.quality !== "recorded"
      ) {
        status = "partial";
      }
    }

    provenanceDiagnosticCounts = await collectInputProvenance(config, store, { rebuild, cutoffMs });
    if (
      (provenanceDiagnosticCounts["input-provenance-unreadable"] ?? 0) > 0
      || (provenanceDiagnosticCounts["input-provenance-unsupported"] ?? 0) > 0
      || (provenanceDiagnosticCounts["input-provenance-parse-gap"] ?? 0) > 0
    ) {
      status = "partial";
    }

    const completedAtMs = Math.max(startedAtMs, Date.now());
    store.writeBatch({
      collectionRuns: [{
        runKey,
        startedAtMs,
        cutoffMs,
        completedAtMs,
        successfulScanMs: completedAtMs,
        status,
        rebuild,
        diagnosticCounts: {
          "unallocated-history": unallocatedUsageRecords,
          "duplicate-ambiguity": excludedAmbiguousRecords,
          "unattributed-session": excludedUnattributedRecords,
          ...provenanceDiagnosticCounts,
        },
      }],
    });
    return {
      runKey,
      startedAtMs,
      completedAtMs,
      cutoffMs,
      status,
      adaptersCollected,
      unallocatedUsageRecords,
      excludedAmbiguousRecords,
      excludedUnattributedRecords,
    };
  } catch (error) {
    const completedAtMs = Math.max(startedAtMs, Date.now());
    store.writeBatch({
      collectionRuns: [{
        runKey,
        startedAtMs,
        cutoffMs,
        completedAtMs,
        status: "failed",
        rebuild,
        diagnosticCounts: { "collection-failure": 1 },
      }],
    });
    throw error;
  }
}

export async function collectActivity(config: Config, options: CollectOptions = {}): Promise<CollectionSummary> {
  return withWriterLock(config.stateDir, async () => {
    const store = options.store ?? openCollectorStore(config.stateDir);
    try {
      return await collectIntoStore(config, store, options);
    } finally {
      if (options.store === undefined) store.close();
    }
  });
}

export async function collectConfiguredActivity(configPath?: string, options: Omit<CollectOptions, "store"> = {}): Promise<CollectionSummary> {
  const config = loadConfig(configPath);
  return collectActivity(config, options);
}
