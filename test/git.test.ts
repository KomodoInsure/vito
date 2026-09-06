import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  collectGitCommits,
  defaultGitCommandRunner,
  discoverGitRepositories,
  type CommitFact,
  type CommitMembershipStore,
  type GitCommandRunner,
} from "../src/git";
import type { SourceRecord } from "../src/store";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vito-git-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`git ${args[0] ?? ""} failed: ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function createRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Vito Test");
  git(path, "config", "user.email", "vito@example.invalid");
  writeFileSync(join(path, "tracked.txt"), "root\n");
  git(path, "add", "tracked.txt");
  git(path, "commit", "-m", "root");
}

class MemoryMembershipStore implements CommitMembershipStore {
  readonly memberships = new Map<
    string,
    {
      tipOid: string | null;
      commits: Map<string, CommitFact>;
      collectedAtMs: number;
      shallow: boolean;
    }
  >();
  readonly replacements: string[] = [];
  readonly sources = new Map<string, SourceRecord>();

  replaceRepositoryCommits(
    repositoryKey: string,
    tipOid: string | null,
    commits: readonly CommitFact[],
    metadata: { collectedAtMs: number; shallow: boolean },
  ): void {
    const replacement = new Map(commits.map((commit) => [commit.oid, commit]));
    this.memberships.set(repositoryKey, {
      tipOid,
      commits: replacement,
      ...metadata,
    });
    this.replacements.push(repositoryKey);
  }

  upsertSource(record: SourceRecord): void {
    this.sources.set(record.sourceKey, structuredClone(record));
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Git default-branch collection", () => {
  test("bounds discovery, deduplicates worktrees, and replaces force-pushed membership without mutating repositories", () => {
    const fixture = realpathSync(temporaryDirectory());
    const workspace = join(fixture, "workspace");
    const source = join(workspace, "project");
    const remote = join(fixture, "project.git");
    mkdirSync(workspace, { recursive: true });
    createRepository(source);
    mkdirSync(remote);
    git(remote, "init", "--bare");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "-u", "origin", "main");
    git(source, "remote", "set-head", "origin", "main");
    const rootOid = git(source, "rev-parse", "HEAD");

    git(source, "checkout", "-b", "merged-feature");
    writeFileSync(join(source, "merged.txt"), "merged\n");
    git(source, "add", "merged.txt");
    git(source, "commit", "-m", "merged feature");
    const mergedFeatureOid = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "main");
    git(source, "merge", "--no-ff", "merged-feature", "-m", "merge feature");
    const mergeOid = git(source, "rev-parse", "HEAD");
    git(source, "push", "origin", "main");

    git(source, "checkout", "-b", "unmerged-feature");
    writeFileSync(join(source, "unmerged.txt"), "not reachable\n");
    git(source, "add", "unmerged.txt");
    git(source, "commit", "-m", "unmerged feature");
    const unmergedOid = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "main");

    const linkedWorktree = join(workspace, "linked-worktree");
    git(source, "worktree", "add", "-b", "linked", linkedWorktree, "main");

    const ignoredRepository = join(workspace, "node_modules", "ignored");
    createRepository(ignoredRepository);
    const outsidePrefixLookalike = join(fixture, "workspace-lookalike", "outside");
    createRepository(outsidePrefixLookalike);
    symlinkSync(outsidePrefixLookalike, join(workspace, "escaped-repository"));

    const missingHead = join(workspace, "missing-head");
    const missingRemote = join(fixture, "missing.git");
    createRepository(missingHead);
    mkdirSync(missingRemote);
    git(missingRemote, "init", "--bare");
    git(missingHead, "remote", "add", "origin", missingRemote);

    const discovery = discoverGitRepositories([workspace]);
    expect(discovery.repositories).toHaveLength(2);
    expect(discovery.diagnostics).toContainEqual({
      code: "symlink-escape",
      severity: "unavailable",
    });
    expect(JSON.stringify(discovery.diagnostics)).not.toContain(fixture);
    const missingRepositoryKey = discovery.repositories.find(
      (repository) => repository.path === missingHead,
    )!.repositoryKey;

    const sourceBefore = {
      head: git(source, "rev-parse", "HEAD"),
      branch: git(source, "symbolic-ref", "HEAD"),
      status: git(source, "status", "--porcelain=v1"),
      tracked: readFileSync(join(source, "tracked.txt"), "utf8"),
    };
    const observedCommands: string[][] = [];
    const runner: GitCommandRunner = (repositoryPath, args) => {
      observedCommands.push([...args]);
      return defaultGitCommandRunner(repositoryPath, args);
    };
    const store = new MemoryMembershipStore();
    const retainedOid = "f".repeat(40);
    store.memberships.set(missingRepositoryKey, {
      tipOid: retainedOid,
      commits: new Map([
        [
          retainedOid,
          {
            repositoryKey: missingRepositoryKey,
            oid: retainedOid,
            committerMs: 1,
          },
        ],
      ]),
      collectedAtMs: 1,
      shallow: false,
    });
    const first = collectGitCommits(
      { workspaceRoots: [workspace], repositories: [] },
      store,
      { collectedAtMs: 1_788_739_200_000, runner },
    );

    const projectSnapshot = first.repositories.find((entry) => entry.path === source);
    const unavailableSnapshot = first.repositories.find((entry) => entry.path === missingHead);
    expect(projectSnapshot).toBeDefined();
    expect(projectSnapshot?.quality).toBe("partial");
    expect(projectSnapshot?.reasons).toContain("stale-ref");
    expect(projectSnapshot?.diagnostics).toContainEqual({
      code: "stale-ref",
      severity: "partial",
    });
    expect(unavailableSnapshot?.quality).toBe("unavailable");
    expect(unavailableSnapshot?.diagnostics).toContainEqual({
      code: "missing-default-ref",
      severity: "unavailable",
    });
    expect([
      ...store.memberships.get(missingRepositoryKey)!.commits.keys(),
    ]).toEqual([retainedOid]);
    expect(JSON.stringify(first.diagnostics)).not.toContain(fixture);
    expect(new Set(projectSnapshot!.commits.map((commit) => commit.oid))).toEqual(
      new Set([rootOid, mergedFeatureOid, mergeOid]),
    );
    expect(projectSnapshot!.commits.map((commit) => commit.oid)).not.toContain(unmergedOid);
    expect(store.replacements).toEqual([projectSnapshot!.repositoryKey]);

    git(source, "update-ref", "refs/remotes/origin/main", rootOid);
    const stateAfterFixtureForcePush = {
      head: git(source, "rev-parse", "HEAD"),
      branch: git(source, "symbolic-ref", "HEAD"),
      status: git(source, "status", "--porcelain=v1"),
      tracked: readFileSync(join(source, "tracked.txt"), "utf8"),
    };
    const second = collectGitCommits(
      { workspaceRoots: [workspace], repositories: [] },
      store,
      { collectedAtMs: 1_788_739_260_000, runner },
    );
    const replacedSnapshot = second.repositories.find((entry) => entry.path === source)!;
    expect(replacedSnapshot.commits.map((commit) => commit.oid)).toEqual([rootOid]);
    expect([...store.memberships.get(replacedSnapshot.repositoryKey)!.commits]).toEqual([
      [rootOid, expect.objectContaining({ oid: rootOid })],
    ]);
    expect(store.replacements).toEqual([
      projectSnapshot!.repositoryKey,
      replacedSnapshot.repositoryKey,
    ]);

    expect({
      head: git(source, "rev-parse", "HEAD"),
      branch: git(source, "symbolic-ref", "HEAD"),
      status: git(source, "status", "--porcelain=v1"),
      tracked: readFileSync(join(source, "tracked.txt"), "utf8"),
    }).toEqual(stateAfterFixtureForcePush);
    expect(sourceBefore).toEqual(stateAfterFixtureForcePush);
    expect(
      observedCommands.some((args) =>
        ["checkout", "fetch", "pull", "push", "reset", "stash", "switch"].includes(
          args[0] ?? "",
        ),
      ),
    ).toBe(false);
  });

  test("uses an explicit remote branch but never guesses one when symbolic HEAD is absent", () => {
    const fixture = realpathSync(temporaryDirectory());
    const workspace = join(fixture, "workspace");
    const source = join(workspace, "project");
    const remote = join(fixture, "upstream.git");
    mkdirSync(workspace, { recursive: true });
    createRepository(source);
    mkdirSync(remote);
    git(remote, "init", "--bare");
    git(source, "remote", "add", "upstream", remote);
    const oid = git(source, "rev-parse", "HEAD");
    writeFileSync(join(source, ".git", "FETCH_HEAD"), "");
    git(source, "update-ref", "refs/remotes/upstream/release", oid);
    writeFileSync(join(source, ".git", "shallow"), `${oid}\n`);

    const store = new MemoryMembershipStore();
    const implicit = collectGitCommits(
      { workspaceRoots: [workspace], repositories: [] },
      store,
      { collectedAtMs: 1_788_739_200_000 },
    );
    expect(implicit.repositories[0]?.quality).toBe("unavailable");
    expect(store.replacements).toHaveLength(0);

    const explicit = collectGitCommits(
      {
        workspaceRoots: [workspace],
        repositories: [{ path: source, remote: "upstream", defaultBranch: "release" }],
      },
      store,
      { collectedAtMs: 1_788_739_260_000 },
    );
    expect(explicit.repositories[0]?.tipOid).toBe(oid);
    expect(explicit.repositories[0]?.commits.map((commit) => commit.oid)).toEqual([oid]);
    expect(explicit.repositories[0]?.shallow).toBe(true);
    expect(explicit.repositories[0]?.quality).toBe("partial");
    expect(explicit.repositories[0]?.reasons).toContain("missing-source");
    expect(typeof explicit.repositories[0]?.fetchEvidenceMs).toBe("number");
    const inventory = store.sources.get(
      `git:${explicit.repositories[0]!.repositoryKey}`,
    );
    expect(inventory?.lastSeenMs).toBe(
      explicit.repositories[0]!.fetchEvidenceMs,
    );
    expect(inventory?.lastSuccessfulScanMs).toBe(1_788_739_260_000);
    expect(store.replacements).toHaveLength(1);
  });
});
