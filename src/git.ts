import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { Config, RepositoryConfig } from "./config";
import type { Quality } from "./contracts";
import type { CommitRecord, SourceRecord } from "./store";

const PRUNED_DIRECTORY_NAMES: Record<string, true> = {
  ".angular": true,
  ".build": true,
  ".cache": true,
  ".dart_tool": true,
  ".gradle": true,
  ".mypy_cache": true,
  ".next": true,
  ".nuxt": true,
  ".parcel-cache": true,
  ".pnpm": true,
  ".pytest_cache": true,
  ".ruff_cache": true,
  ".svelte-kit": true,
  ".tox": true,
  ".turbo": true,
  ".venv": true,
  ".yarn": true,
  DerivedData: true,
  Pods: true,
  __pycache__: true,
  bower_components: true,
  build: true,
  coverage: true,
  dist: true,
  node_modules: true,
  out: true,
  target: true,
  vendor: true,
  venv: true,
};

const DEFAULT_REMOTE = "origin";
const HEX_OBJECT_ID = /^[0-9a-f]{40,64}$/;

export type GitDiagnosticCode =
  | "common-dir-unavailable"
  | "duplicate-config-conflict"
  | "invalid-commit-output"
  | "missing-default-ref"
  | "repository-invalid"
  | "root-unavailable"
  | "shallow-history"
  | "shallow-state-unavailable"
  | "stale-ref"
  | "symlink-escape";

export interface GitDiagnostic {
  code: GitDiagnosticCode;
  severity: "info" | "partial" | "unavailable";
}

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
}

export type GitCommandRunner = (
  repositoryPath: string,
  args: readonly string[],
) => GitCommandResult;

export interface DiscoveredRepository {
  /** Private collector identity. Never place this value in public artifacts. */
  repositoryKey: string;
  /** Private canonical worktree path used only for local Git reads. */
  path: string;
  /** Private canonical common Git directory used for worktree deduplication. */
  commonDir: string;
  remote: string;
  defaultBranch?: string;
}

export interface GitDiscoveryResult {
  repositories: DiscoveredRepository[];
  diagnostics: GitDiagnostic[];
}

export type CommitFact = CommitRecord;

export interface RepositoryCommitSnapshot {
  repositoryKey: string;
  path: string;
  commonDir: string;
  ref: string | null;
  tipOid: string | null;
  commits: CommitFact[];
  collectedAtMs: number;
  fetchEvidenceMs: number | null;
  remoteFreshness: "unknown";
  shallow: boolean;
  quality: Quality;
  reasons: Array<"missing-source" | "parse-gap" | "stale-ref">;
  diagnostics: GitDiagnostic[];
}

export interface CommitMembershipStore {
  replaceRepositoryCommits(
    repositoryKey: string,
    tipOid: string | null,
    commits: readonly CommitFact[],
    metadata: { collectedAtMs: number; shallow: boolean },
  ): void;
  upsertSource(record: SourceRecord): void;
}

export interface GitCollectionResult {
  repositories: RepositoryCommitSnapshot[];
  diagnostics: GitDiagnostic[];
}

interface CandidateRepository {
  path: string;
  commonDir: string;
  configured: RepositoryConfig | null;
  configurationConflict: boolean;
}

interface ResolvedDefaultRef {
  kind: "resolved";
  ref: string;
  tipOid: string;
}

interface EmptyRepository {
  kind: "empty";
}

interface MissingDefaultRef {
  kind: "missing";
}

type DefaultRefResolution =
  | ResolvedDefaultRef
  | EmptyRepository
  | MissingDefaultRef;

export const defaultGitCommandRunner: GitCommandRunner = (
  repositoryPath,
  args,
) => {
  try {
    const result = Bun.spawnSync(
      ["git", "-C", repositoryPath, ...args],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
    };
  } catch {
    return { exitCode: 127, stdout: "" };
  }
};

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeRoot(root: string): string | null {
  if (!isAbsolute(root)) return null;
  try {
    const canonical = realpathSync(root);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function hasGitMarker(directory: string): boolean {
  try {
    const marker = lstatSync(join(directory, ".git"));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

function repositoryKey(commonDir: string): string {
  return createHash("sha256").update(commonDir).digest("hex");
}

function canonicalCommonDir(
  repositoryPath: string,
  runner: GitCommandRunner,
): string | null {
  const result = runner(repositoryPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.exitCode !== 0) return null;
  const reported = result.stdout.trim();
  if (!isAbsolute(reported)) return null;
  try {
    const canonical = realpathSync(reported);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function walkRoot(
  root: string,
  candidates: Set<string>,
  diagnostics: GitDiagnostic[],
): void {
  const visit = (directory: string): void => {
    try {
      const marker = lstatSync(join(directory, ".git"));
      if (marker.isSymbolicLink()) {
        diagnostics.push({ code: "symlink-escape", severity: "unavailable" });
      } else if (marker.isDirectory() || marker.isFile()) {
        candidates.add(directory);
      }
    } catch {
      // Most directories are not repository roots.
    }

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      diagnostics.push({ code: "root-unavailable", severity: "unavailable" });
      return;
    }

    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        PRUNED_DIRECTORY_NAMES[entry.name] === true
      ) continue;
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = realpathSync(child);
          if (!isWithin(root, target)) {
            diagnostics.push({ code: "symlink-escape", severity: "unavailable" });
          }
        } catch {
          diagnostics.push({ code: "symlink-escape", severity: "unavailable" });
        }
        continue;
      }
      if (entry.isDirectory()) visit(child);
    }
  };

  visit(root);
}

function normalizedConfiguredRepository(
  configured: RepositoryConfig,
  _roots: readonly string[],
  diagnostics: GitDiagnostic[],
): RepositoryConfig | null {
  if (!isAbsolute(configured.path)) {
    diagnostics.push({ code: "repository-invalid", severity: "unavailable" });
    return null;
  }
  try {
    const canonical = realpathSync(configured.path);
    if (!statSync(canonical).isDirectory()) {
      diagnostics.push({ code: "repository-invalid", severity: "unavailable" });
      return null;
    }
    return { ...configured, path: canonical };
  } catch {
    diagnostics.push({ code: "repository-invalid", severity: "unavailable" });
    return null;
  }
}

function sameConfiguration(
  left: RepositoryConfig,
  right: RepositoryConfig,
): boolean {
  return (
    left.remote === right.remote &&
    (left.defaultBranch ?? null) === (right.defaultBranch ?? null)
  );
}

export function discoverGitRepositories(
  workspaceRoots: readonly string[],
  configuredRepositories: readonly RepositoryConfig[] = [],
  runner: GitCommandRunner = defaultGitCommandRunner,
): GitDiscoveryResult {
  const diagnostics: GitDiagnostic[] = [];
  const normalizedRoots = workspaceRoots
    .map(normalizeRoot)
    .filter((value): value is string => {
      if (value === null) {
        diagnostics.push({ code: "root-unavailable", severity: "unavailable" });
      }
      return value !== null;
    });
  const roots = [...new Set(normalizedRoots)].sort();

  const candidates = new Set<string>();
  for (const root of roots) walkRoot(root, candidates, diagnostics);

  const configuredByPath = new Map<string, RepositoryConfig>();
  const conflictingConfiguredPaths = new Set<string>();
  for (const configured of configuredRepositories) {
    const normalized = normalizedConfiguredRepository(configured, roots, diagnostics);
    if (normalized === null) continue;
    const existing = configuredByPath.get(normalized.path);
    if (existing !== undefined && !sameConfiguration(existing, normalized)) {
      conflictingConfiguredPaths.add(normalized.path);
      diagnostics.push({
        code: "duplicate-config-conflict",
        severity: "unavailable",
      });
    } else {
      configuredByPath.set(normalized.path, normalized);
    }
    if (hasGitMarker(normalized.path)) {
      candidates.add(normalized.path);
    } else {
      diagnostics.push({ code: "repository-invalid", severity: "unavailable" });
    }
  }

  const byCommonDir = new Map<string, CandidateRepository[]>();
  for (const candidatePath of [...candidates].sort()) {
    const commonDir = canonicalCommonDir(candidatePath, runner);
    if (commonDir === null) {
      diagnostics.push({ code: "common-dir-unavailable", severity: "unavailable" });
      continue;
    }
    const candidate: CandidateRepository = {
      path: candidatePath,
      commonDir,
      configured: configuredByPath.get(candidatePath) ?? null,
      configurationConflict: conflictingConfiguredPaths.has(candidatePath),
    };
    const matches = byCommonDir.get(commonDir);
    if (matches === undefined) byCommonDir.set(commonDir, [candidate]);
    else matches.push(candidate);
  }

  const repositories: DiscoveredRepository[] = [];
  for (
    const [commonDir, matches] of [...byCommonDir].sort(([left], [right]) =>
      left.localeCompare(right)
    )
  ) {
    if (matches.some((match) => match.configurationConflict)) continue;
    const configured = matches
      .map((match) => match.configured)
      .filter((value): value is RepositoryConfig => value !== null);
    if (
      configured.some((value) => !sameConfiguration(configured[0]!, value))
    ) {
      diagnostics.push({
        code: "duplicate-config-conflict",
        severity: "unavailable",
      });
      continue;
    }
    const selected = (configured.length > 0
      ? matches.find((match) => match.configured !== null)
      : matches.find((match) => {
          try {
            return realpathSync(join(match.path, ".git")) === commonDir;
          } catch {
            return false;
          }
        }) ?? matches[0])!;
    const override = configured[0];
    repositories.push({
      repositoryKey: repositoryKey(commonDir),
      path: selected.path,
      commonDir,
      remote: override?.remote ?? DEFAULT_REMOTE,
      ...(override?.defaultBranch === undefined
        ? {}
        : { defaultBranch: override.defaultBranch }),
    });
  }

  repositories.sort((left, right) =>
    left.repositoryKey.localeCompare(right.repositoryKey)
  );
  return { repositories, diagnostics };
}

function verifyCommit(
  repository: DiscoveredRepository,
  revision: string,
  runner: GitCommandRunner,
): string | null {
  const result = runner(repository.path, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${revision}^{commit}`,
  ]);
  if (result.exitCode !== 0) return null;
  const oid = result.stdout.trim().toLowerCase();
  return HEX_OBJECT_ID.test(oid) ? oid : null;
}

function resolveDefaultRef(
  repository: DiscoveredRepository,
  runner: GitCommandRunner,
): DefaultRefResolution {
  let ref: string | null = null;
  if (repository.defaultBranch !== undefined) {
    ref = `refs/remotes/${repository.remote}/${repository.defaultBranch}`;
  } else {
    const symbolic = runner(repository.path, [
      "symbolic-ref",
      "--quiet",
      `refs/remotes/${repository.remote}/HEAD`,
    ]);
    if (symbolic.exitCode === 0) {
      const candidate = symbolic.stdout.trim();
      const requiredPrefix = `refs/remotes/${repository.remote}/`;
      if (candidate.startsWith(requiredPrefix) && candidate.length > requiredPrefix.length) {
        ref = candidate;
      }
    }
  }

  if (ref !== null) {
    const tipOid = verifyCommit(repository, ref, runner);
    if (tipOid !== null) return { kind: "resolved", ref, tipOid };
  }

  const anyCommit = runner(repository.path, ["rev-list", "--all", "--max-count=1"]);
  if (anyCommit.exitCode === 0 && anyCommit.stdout.trim() === "") return { kind: "empty" };
  return { kind: "missing" };
}

function detectShallow(
  repository: DiscoveredRepository,
  runner: GitCommandRunner,
): boolean | null {
  const result = runner(repository.path, ["rev-parse", "--is-shallow-repository"]);
  if (result.exitCode !== 0) return null;
  if (result.stdout.trim() === "true") return true;
  if (result.stdout.trim() === "false") return false;
  return null;
}

function fetchEvidenceMs(
  repository: DiscoveredRepository,
  runner: GitCommandRunner,
): number | null {
  const result = runner(repository.path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "FETCH_HEAD",
  ]);
  if (result.exitCode !== 0) return null;
  const path = result.stdout.trim();
  if (!isAbsolute(path)) return null;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return null;
    const canonical = realpathSync(path);
    if (!isWithin(repository.commonDir, canonical)) return null;
    const mtimeMs = Math.trunc(statSync(canonical).mtimeMs);
    return Number.isSafeInteger(mtimeMs) && mtimeMs >= 0 ? mtimeMs : null;
  } catch {
    return null;
  }
}

function readReachableCommits(
  repository: DiscoveredRepository,
  tipOid: string,
  runner: GitCommandRunner,
): { commits: CommitFact[]; malformed: boolean } {
  const result = runner(repository.path, [
    "log",
    "--format=%H%x09%ct",
    tipOid,
    "--",
  ]);
  if (result.exitCode !== 0) return { commits: [], malformed: true };

  const commits = new Map<string, CommitFact>();
  let malformed = false;
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    if (fields.length !== 2) {
      malformed = true;
      continue;
    }
    const oid = fields[0]!.toLowerCase();
    const seconds = Number(fields[1]);
    const committerMs = seconds * 1_000;
    if (
      !HEX_OBJECT_ID.test(oid) ||
      !Number.isSafeInteger(seconds) ||
      seconds < 0 ||
      !Number.isSafeInteger(committerMs)
    ) {
      malformed = true;
      continue;
    }
    commits.set(oid, { repositoryKey: repository.repositoryKey, oid, committerMs });
  }

  return {
    commits: [...commits.values()].sort((left, right) =>
      left.oid.localeCompare(right.oid)
    ),
    malformed,
  };
}

function uniqueSortedReasons(
  reasons: RepositoryCommitSnapshot["reasons"],
): RepositoryCommitSnapshot["reasons"] {
  return [...new Set(reasons)].sort();
}

function gitSourceInventory(
  snapshot: RepositoryCommitSnapshot,
): SourceRecord {
  const diagnosticCounts: Record<string, number> = {};
  for (const diagnostic of snapshot.diagnostics) {
    diagnosticCounts[diagnostic.code] =
      (diagnosticCounts[diagnostic.code] ?? 0) + 1;
  }
  return {
    sourceKey: `git:${snapshot.repositoryKey}`,
    agent: "git",
    kind: "git-repository",
    sourcePath: snapshot.path,
    state: snapshot.quality === "recorded" ? "available" : "partial",
    tokenQuality: "unavailable",
    workQuality: "unavailable",
    reasons: snapshot.reasons,
    diagnosticCounts,
    lastSeenMs: snapshot.fetchEvidenceMs,
    ...(snapshot.quality === "unavailable" ||
      snapshot.reasons.includes("parse-gap")
      ? {}
      : { lastSuccessfulScanMs: snapshot.collectedAtMs }),
    cutoffMs: snapshot.collectedAtMs,
    updatedAtMs: snapshot.collectedAtMs,
  };
}

export function scanGitRepository(
  repository: DiscoveredRepository,
  collectedAtMs: number,
  runner: GitCommandRunner = defaultGitCommandRunner,
): RepositoryCommitSnapshot {
  if (!Number.isSafeInteger(collectedAtMs) || collectedAtMs < 0) {
    throw new RangeError("collectedAtMs must be a nonnegative safe integer");
  }

  const diagnostics: GitDiagnostic[] = [];
  const resolution = resolveDefaultRef(repository, runner);
  if (resolution.kind === "missing") {
    diagnostics.push({ code: "missing-default-ref", severity: "unavailable" });
    return {
      ...repository,
      ref: null,
      tipOid: null,
      commits: [],
      collectedAtMs,
      fetchEvidenceMs: fetchEvidenceMs(repository, runner),
      remoteFreshness: "unknown",
      shallow: detectShallow(repository, runner) === true,
      quality: "unavailable",
      reasons: ["stale-ref"],
      diagnostics,
    };
  }

  const shallowState = detectShallow(repository, runner);
  const shallow = shallowState === true;
  const evidenceMs = fetchEvidenceMs(repository, runner);
  const reasons: RepositoryCommitSnapshot["reasons"] = [];
  if (shallowState === null) {
    diagnostics.push({
      code: "shallow-state-unavailable",
      severity: "partial",
    });
    reasons.push("parse-gap");
  } else if (shallow) {
    diagnostics.push({ code: "shallow-history", severity: "partial" });
    reasons.push("missing-source");
  }

  if (resolution.kind === "empty") {
    return {
      ...repository,
      ref: null,
      tipOid: null,
      commits: [],
      collectedAtMs,
      fetchEvidenceMs: evidenceMs,
      remoteFreshness: "unknown",
      shallow,
      quality: reasons.length === 0 ? "recorded" : "partial",
      reasons: uniqueSortedReasons(reasons),
      diagnostics,
    };
  }
  if (evidenceMs === null) {
    diagnostics.push({ code: "stale-ref", severity: "partial" });
    reasons.push("stale-ref");
  }

  const reachable = readReachableCommits(repository, resolution.tipOid, runner);
  if (reachable.malformed) {
    diagnostics.push({ code: "invalid-commit-output", severity: "partial" });
    reasons.push("parse-gap");
  }
  return {
    ...repository,
    ref: resolution.ref,
    tipOid: resolution.tipOid,
    commits: reachable.commits,
    collectedAtMs,
    fetchEvidenceMs: evidenceMs,
    remoteFreshness: "unknown",
    shallow,
    quality: reasons.length === 0 ? "recorded" : "partial",
    reasons: uniqueSortedReasons(reasons),
    diagnostics,
  };
}

export function collectGitCommits(
  config: Pick<Config, "workspaceRoots" | "repositories">,
  store: CommitMembershipStore,
  options: {
    collectedAtMs?: number;
    runner?: GitCommandRunner;
  } = {},
): GitCollectionResult {
  const runner = options.runner ?? defaultGitCommandRunner;
  const collectedAtMs = options.collectedAtMs ?? Date.now();
  const discovery = discoverGitRepositories(
    config.workspaceRoots,
    config.repositories,
    runner,
  );
  const repositories: RepositoryCommitSnapshot[] = [];
  const diagnostics = [...discovery.diagnostics];

  for (const repository of discovery.repositories) {
    const snapshot = scanGitRepository(repository, collectedAtMs, runner);
    repositories.push(snapshot);
    diagnostics.push(...snapshot.diagnostics);
    if (
      snapshot.quality !== "unavailable" &&
      !snapshot.reasons.includes("parse-gap")
    ) {
      store.replaceRepositoryCommits(
        snapshot.repositoryKey,
        snapshot.tipOid,
        snapshot.commits,
        { collectedAtMs: snapshot.collectedAtMs, shallow: snapshot.shallow },
      );
    }
    store.upsertSource(gitSourceInventory(snapshot));
  }

  return { repositories, diagnostics };
}
