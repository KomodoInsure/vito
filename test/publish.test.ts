import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config";
import { publicSnapshotSchema } from "../src/contracts";
import { EXPORT_FILES } from "../src/export";
import { CollectorStore } from "../src/store";
import {
  defaultGitTransport,
  PAGES_MARKER,
  PAGES_MARKER_FILE,
  PUBLISH_AUTHOR_EMAIL,
  PUBLISH_AUTHOR_NAME,
  PUBLISH_COMMIT_MESSAGE,
  PUBLICATION_STATE_FILE,
  publishActivity,
  readPublicationState,
  setupPages,
  type GitTransport,
  type PagesResponse,
  type PagesTransport,
} from "../src/publish";

const CUTOFF = "2026-09-06T12:34:56.789Z";
const LATER_CUTOFF = "2026-09-06T13:34:56.789Z";
const SITE_URL = "https://pages.example.test/vito/";
const temporaryDirectories: string[] = [];

interface Fixture {
  root: string;
  workspace: string;
  state: string;
  remote: string;
  config: Config;
  pages: FixturePagesTransport;
}

interface RecordedRequest {
  method: "GET" | "POST";
  path: string;
  body: unknown;
}

class FixturePagesTransport implements PagesTransport {
  readonly requests: RecordedRequest[] = [];
  repositoryResponse: PagesResponse;
  contentsResponse: PagesResponse = { status: 200, body: [] };
  markerResponse: PagesResponse = { status: 404, body: null };
  pagesResponse: PagesResponse = { status: 404, body: null };
  postResponse: PagesResponse = {
    status: 201,
    body: {
      html_url: SITE_URL,
      source: { branch: "main", path: "/docs" },
    },
  };

  constructor(cloneUrl: string) {
    this.repositoryResponse = {
      status: 200,
      body: { private: false, visibility: "public", clone_url: cloneUrl },
    };
  }

  markManaged(): void {
    this.contentsResponse = {
      status: 200,
      body: [{ name: PAGES_MARKER_FILE, type: "file" }, { name: "docs", type: "dir" }],
    };
    this.markerResponse = {
      status: 200,
      body: {
        type: "file",
        content: Buffer.from(`${JSON.stringify(PAGES_MARKER, null, 2)}\n`).toString("base64"),
      },
    };
  }

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<PagesResponse> {
    this.requests.push({ method, path, body });
    if (path === "/repos/fixture/vito-pages" && method === "GET") return this.repositoryResponse;
    if (path === "/repos/fixture/vito-pages/contents" && method === "GET") return this.contentsResponse;
    if (path === `/repos/fixture/vito-pages/contents/${PAGES_MARKER_FILE}` && method === "GET") return this.markerResponse;
    if (path === "/repos/fixture/vito-pages/pages" && method === "GET") return this.pagesResponse;
    if (path === "/repos/fixture/vito-pages/pages" && method === "POST") {
      this.pagesResponse = this.postResponse;
      return this.postResponse;
    }
    return { status: 500, body: null };
  }
}

function runGit(args: readonly string[], cwd?: string, extraEnv: Record<string, string> = {}): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vito publisher test with spaces-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "PRIVATE_WORKSPACE_SENTINEL");
  const state = join(root, "private state");
  const remote = join(root, "pages remote.git");
  mkdirSync(workspace);
  runGit(["init", "--bare", "--initial-branch=main", remote]);
  const config: Config = {
    version: 1,
    workspaceRoots: [workspace],
    timezone: "UTC",
    stateDir: state,
    sources: { codex: [], claude: [], omp: [], opencode: [], hermes: [] },
    repositories: [],
    publication: { repository: "fixture/vito-pages", branch: "main" },
  };
  return { root, workspace, state, remote, config, pages: new FixturePagesTransport(remote) };
}

function addDeveloperRepository(value: Fixture): string {
  const repository = join(value.workspace, "developer-repository");
  mkdirSync(repository);
  runGit(["init", "--initial-branch=main"], repository);
  writeFileSync(join(repository, "source.txt"), "developer source must not be published\n");
  runGit(["add", "--", "source.txt"], repository);
  runGit(
    ["-c", "user.name=Fixture Developer", "-c", "user.email=developer@example.test", "commit", "-m", "fixture commit"],
    repository,
    { GIT_AUTHOR_DATE: CUTOFF, GIT_COMMITTER_DATE: CUTOFF },
  );
  const head = runGit(["rev-parse", "HEAD"], repository);
  runGit(["update-ref", "refs/remotes/origin/main", head], repository);
  runGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repository);
  value.config.repositories = [{ path: repository, remote: "origin" }];
  return repository;
}
function seedUnrelatedMarkedRemote(value: Fixture): void {
  const checkout = join(value.root, "unrelated marked repository");
  mkdirSync(checkout);
  runGit(["init", "--initial-branch=main"], checkout);
  writeFileSync(join(checkout, PAGES_MARKER_FILE), `${JSON.stringify(PAGES_MARKER, null, 2)}\n`);
  writeFileSync(join(checkout, "README.md"), "unrelated public content\n");
  runGit(["add", "--", PAGES_MARKER_FILE, "README.md"], checkout);
  runGit([
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.test",
    "commit", "-m", "unrelated marked tree",
  ], checkout);
  runGit(["remote", "add", "origin", value.remote], checkout);
  runGit(["push", "origin", "HEAD:refs/heads/main"], checkout);
}


function remoteGit(value: Fixture, args: readonly string[]): string {
  return runGit([`--git-dir=${value.remote}`, ...args]);
}

function remotePaths(value: Fixture): string[] {
  const output = remoteGit(value, ["ls-tree", "-r", "--name-only", "main"]);
  return output === "" ? [] : output.split("\n");
}

function remoteFile(value: Fixture, path: string): string {
  return remoteGit(value, ["show", `main:${path}`]);
}

function publicationStateBytes(value: Fixture): Buffer {
  return readFileSync(join(value.state, PUBLICATION_STATE_FILE));
}

function commitCount(value: Fixture): number {
  return Number(remoteGit(value, ["rev-list", "--count", "main"]));
}

function successfulPages(value: Fixture): void {
  value.pages.markManaged();
  value.pages.pagesResponse = value.pages.postResponse;
}

async function initialSetup(value: Fixture, git: GitTransport = defaultGitTransport) {
  const result = await setupPages(value.config, { at: CUTOFF, transport: value.pages, git });
  successfulPages(value);
  return result;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pages publisher", () => {
  test("collects Git, publishes only the exact public tree, configures Pages, and is idempotent", async () => {
    const value = fixture();
    const developerRepository = addDeveloperRepository(value);
    const first = await initialSetup(value);

    const expectedPaths = [
      PAGES_MARKER_FILE,
      ...EXPORT_FILES.map((file) => `docs/${file}`),
    ].sort();
    expect(remotePaths(value).sort()).toEqual(expectedPaths);
    expect(JSON.parse(remoteFile(value, PAGES_MARKER_FILE))).toEqual(PAGES_MARKER);

    const snapshotText = remoteFile(value, "docs/activity.json");
    const snapshot = publicSnapshotSchema.parse(JSON.parse(snapshotText));
    expect(snapshot.days.reduce((sum, day) => sum + (day.commits.value ?? 0), 0)).toBe(1);
    for (const path of expectedPaths) {
      const content = remoteFile(value, path);
      expect(content).not.toContain(value.workspace);
      expect(content).not.toContain(developerRepository);
      expect(content).not.toContain("developer source must not be published");
      expect(content).not.toContain("github_pat_PRIVATE_SECRET_VALUE_1234567890");
    }

    const treeEntries = remoteGit(value, ["ls-tree", "-r", "main"]).split("\n");
    expect(treeEntries).toHaveLength(expectedPaths.length);
    expect(treeEntries.every((entry) => /^100644 blob [0-9a-f]{40,64}\t/.test(entry))).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.pushed).toBe(true);
    expect(first.siteUrl).toBe(SITE_URL);
    expect(first.widgetUrls?.calendar).toBe(`${SITE_URL}widget.html?view=calendar&range=30&theme=auto`);
    expect(first.exportedFiles.map((path) => path.slice(first.exportDirectory.length + 1)).sort()).toEqual([...EXPORT_FILES].sort());
    expect(commitCount(value)).toBe(1);
    expect(remoteGit(value, ["log", "-1", "--format=%an%n%ae%n%s"])).toBe(
      `${PUBLISH_AUTHOR_NAME}\n${PUBLISH_AUTHOR_EMAIL}\n${PUBLISH_COMMIT_MESSAGE}`,
    );

    const post = value.pages.requests.find((request) => request.method === "POST");
    expect(post).toEqual({
      method: "POST",
      path: "/repos/fixture/vito-pages/pages",
      body: { build_type: "legacy", source: { branch: "main", path: "/docs" } },
    });

    const second = await publishActivity(value.config, {
      at: CUTOFF,
      transport: value.pages,
      git: defaultGitTransport,
    });
    expect(second.changed).toBe(false);
    expect(second.pushed).toBe(false);
    expect(second.commit).toBe(first.commit);
    expect(commitCount(value)).toBe(1);
    expect(remoteFile(value, "docs/activity.json")).toBe(snapshotText);
    expect(readPublicationState(value.config)).toMatchObject({
      schemaVersion: 1,
      repository: "fixture/vito-pages",
      commit: first.commit,
      siteUrl: SITE_URL,
    });
    expect(() => readPublicationState({
      ...value.config,
      publication: { repository: "fixture/a-different-repository", branch: "main" },
    })).toThrow("belongs to a different configured repository");
  }, 30_000);

  test("upgrades a managed checkout from an older public snapshot schema", async () => {
    const value = fixture();
    await initialSetup(value);
    const checkout = join(value.state, "pages");
    writeFileSync(join(checkout, "docs", "activity.json"), `${JSON.stringify({ schemaVersion: 1 })}\n`);
    runGit(["add", "--", "docs/activity.json"], checkout);
    runGit([
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.test",
      "commit", "-m", "legacy public snapshot",
    ], checkout);
    runGit(["push", "origin", "HEAD:refs/heads/main"], checkout);

    const result = await publishActivity(value.config, {
      at: LATER_CUTOFF,
      transport: value.pages,
      git: defaultGitTransport,
    });

    expect(result.pushed).toBe(true);
    expect(publicSnapshotSchema.parse(JSON.parse(remoteFile(value, "docs/activity.json"))).schemaVersion).toBe(3);
  }, 30_000);

  test("upgrades a managed checkout from the pre-NOTICE file set", async () => {
    const value = fixture();
    await initialSetup(value);
    const checkout = join(value.state, "pages");
    runGit(["rm", "--", "docs/NOTICE"], checkout);
    runGit([
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.test",
      "commit", "-m", "legacy Pages file set",
    ], checkout);
    runGit(["push", "origin", "HEAD:refs/heads/main"], checkout);

    const result = await publishActivity(value.config, {
      at: LATER_CUTOFF,
      transport: value.pages,
      git: defaultGitTransport,
    });

    expect(result.pushed).toBe(true);
    expect(remotePaths(value).sort()).toEqual([
      PAGES_MARKER_FILE,
      ...EXPORT_FILES.map((file) => `docs/${file}`),
    ].sort());
  }, 30_000);

  test("refuses dirty managed contents and remote divergence without changing success state", async () => {
    const dirty = fixture();
    await initialSetup(dirty);
    const dirtyState = publicationStateBytes(dirty);
    appendFileSync(join(dirty.state, "pages", "docs", "index.html"), "dirty developer edit\n");
    await expect(publishActivity(dirty.config, {
      at: LATER_CUTOFF,
      transport: dirty.pages,
      git: defaultGitTransport,
    })).rejects.toThrow("unexpected local changes");
    expect(publicationStateBytes(dirty)).toEqual(dirtyState);
    expect(readFileSync(join(dirty.state, "pages", "docs", "index.html"), "utf8")).toContain("dirty developer edit");

    const diverged = fixture();
    await initialSetup(diverged);
    const divergedState = publicationStateBytes(diverged);
    const other = join(diverged.root, "remote writer");
    runGit(["clone", "--", diverged.remote, other]);
    appendFileSync(join(other, "docs", "styles.css"), "\n.remote-change { color: red; }\n");
    runGit(["add", "--", "docs/styles.css"], other);
    runGit(["-c", "user.name=Other", "-c", "user.email=other@example.test", "commit", "-m", "remote change"], other);
    runGit(["push", "origin", "HEAD:refs/heads/main"], other);

    await expect(publishActivity(diverged.config, {
      at: LATER_CUTOFF,
      transport: diverged.pages,
      git: defaultGitTransport,
    })).rejects.toThrow("Remote main diverged");
    expect(publicationStateBytes(diverged)).toEqual(divergedState);
    expect(commitCount(diverged)).toBe(2);
  }, 30_000);

  test("keeps publication state unchanged on push failure and retries the one pending commit", async () => {
    const value = fixture();
    await initialSetup(value);
    const priorState = publicationStateBytes(value);
    const priorRemoteCommit = remoteGit(value, ["rev-parse", "main"]);
    const failingGit: GitTransport = {
      async run(args, options) {
        if (args[0] === "push") return { exitCode: 1, stdout: "", stderr: "synthetic push failure" };
        return defaultGitTransport.run(args, options);
      },
    };

    await expect(publishActivity(value.config, {
      at: LATER_CUTOFF,
      transport: value.pages,
      git: failingGit,
    })).rejects.toThrow("synthetic push failure");
    expect(publicationStateBytes(value)).toEqual(priorState);
    expect(remoteGit(value, ["rev-parse", "main"])).toBe(priorRemoteCommit);
    expect(runGit(["rev-list", "--count", "HEAD"], join(value.state, "pages"))).toBe("2");

    const retry = await publishActivity(value.config, {
      at: LATER_CUTOFF,
      transport: value.pages,
      git: defaultGitTransport,
    });
    expect(retry.changed).toBe(false);
    expect(retry.pushed).toBe(true);
    expect(commitCount(value)).toBe(2);
    expect(readPublicationState(value.config)?.commit).toBe(retry.commit);
  }, 30_000);

  test("recovers a successful push whose acknowledgement was lost without a duplicate commit", async () => {
    const value = fixture();
    const lostAcknowledgementGit: GitTransport = {
      async run(args, options) {
        const result = await defaultGitTransport.run(args, options);
        if (args[0] === "push" && result.exitCode === 0) {
          return { exitCode: 1, stdout: result.stdout, stderr: "synthetic lost acknowledgement" };
        }
        return result;
      },
    };

    await expect(setupPages(value.config, {
      at: CUTOFF,
      transport: value.pages,
      git: lostAcknowledgementGit,
    })).rejects.toThrow("synthetic lost acknowledgement");
    expect(commitCount(value)).toBe(1);
    expect(existsSync(join(value.state, PUBLICATION_STATE_FILE))).toBe(false);
    value.pages.markManaged();

    const recovered = await setupPages(value.config, {
      at: CUTOFF,
      transport: value.pages,
      git: defaultGitTransport,
    });
    expect(recovered.changed).toBe(false);
    expect(recovered.pushed).toBe(false);
    expect(commitCount(value)).toBe(1);
    expect(remotePaths(value).sort()).toEqual([
      PAGES_MARKER_FILE,
      ...EXPORT_FILES.map((file) => `docs/${file}`),
    ].sort());
    expect(readPublicationState(value.config)?.commit).toBe(recovered.commit);
  }, 30_000);


  test("rejects a provenance path leaked into generated assets before publication", async () => {
    const value = fixture();
    const provenanceDirectory = join(value.root, "provenance");
    const provenancePath = join(provenanceDirectory, "PRIVATE_PROVENANCE_SENTINEL.jsonl");
    mkdirSync(provenanceDirectory);
    writeFileSync(provenancePath, "");
    value.config.inputProvenance = [provenancePath];
    let mutated = false;
    const transport: PagesTransport = {
      async request(method, path, body) {
        if (!mutated) {
          mutated = true;
          appendFileSync(join(value.state, "export", "styles.css"), `\\n${provenancePath}\\n`);
        }
        return value.pages.request(method, path, body);
      },
    };

    await expect(setupPages(value.config, {
      at: CUTOFF,
      transport,
      git: defaultGitTransport,
    })).rejects.toThrow(/private configured path/i);
    expect(readdirSync(join(value.remote, "refs", "heads"))).toEqual([]);
  }, 30_000);

  test("rejects forbidden provenance fields added after export and before publication", async () => {
    const value = fixture();
    const controller = "PRIVATE_PUBLISH_CONTROLLER_SENTINEL";
    const store = CollectorStore.open(value.state);
    try {
      store.writeBatch({
        inputProvenance: [{
          originKey: "ignored-by-store",
          agent: "codex",
          nativeSessionId: "session",
          nativeInputId: "input",
          origin: "human",
          controller,
        }],
      });
    } finally {
      store.close();
    }
    let mutated = false;
    const transport: PagesTransport = {
      async request(method, path, body) {
        if (!mutated) {
          mutated = true;
          const activityPath = join(value.state, "export", "activity.json");
          const snapshot = publicSnapshotSchema.parse(JSON.parse(readFileSync(activityPath, "utf8")));
          const leaked = {
            ...snapshot,
            controller,
            nativeSessionId: "private-native-session",
            nativeInputId: "private-native-input",
          };
          writeFileSync(activityPath, `${JSON.stringify(leaked, null, 2)}\n`);
        }
        return value.pages.request(method, path, body);
      },
    };

    await expect(setupPages(value.config, {
      at: CUTOFF,
      transport,
      git: defaultGitTransport,
    })).rejects.toThrow(/public schema validation/i);
    expect(readdirSync(join(value.remote, "refs", "heads"))).toEqual([]);
  }, 30_000);
  test("requires an existing public dedicated repository and preserves unrelated destinations", async () => {
    const value = fixture();

    const missing = new FixturePagesTransport(value.remote);
    missing.repositoryResponse = { status: 404, body: null };
    await expect(setupPages(value.config, { at: CUTOFF, transport: missing })).rejects.toThrow(
      "does not exist; create this dedicated public repository first",
    );

    const privateRepository = new FixturePagesTransport(value.remote);
    privateRepository.repositoryResponse = {
      status: 200,
      body: { private: true, visibility: "private", clone_url: value.remote },
    };
    await expect(setupPages(value.config, { at: CUTOFF, transport: privateRepository })).rejects.toThrow("must be public");

    const credentialUrl = new FixturePagesTransport(value.remote);
    credentialUrl.repositoryResponse = {
      status: 200,
      body: {
        private: false,
        visibility: "public",
        clone_url: "https://user:github_pat_PRIVATE_SECRET_VALUE_1234567890@example.test/repository.git",
      },
    };
    await expect(setupPages(value.config, { at: CUTOFF, transport: credentialUrl })).rejects.toThrow(
      "clone URL must not contain credentials",
    );

    const unrelated = new FixturePagesTransport(value.remote);
    unrelated.contentsResponse = { status: 200, body: [{ name: "README.md", type: "file" }] };
    await expect(setupPages(value.config, { at: CUTOFF, transport: unrelated })).rejects.toThrow(
      "not empty and is not marked as Vito-managed",
    );
    expect(readdirSync(join(value.remote, "refs", "heads"))).toEqual([]);
    expect(existsSync(join(value.state, "pages"))).toBe(false);

    const markedButUnrelated = fixture();
    seedUnrelatedMarkedRemote(markedButUnrelated);
    markedButUnrelated.pages.markManaged();
    await expect(setupPages(markedButUnrelated.config, {
      at: CUTOFF,
      transport: markedButUnrelated.pages,
      git: defaultGitTransport,
    })).rejects.toThrow("has unrelated contents");
    expect(remotePaths(markedButUnrelated).sort()).toEqual([PAGES_MARKER_FILE, "README.md"].sort());
  }, 30_000);

  test("rejects conflicting or credential-bearing Pages settings before changing the checkout", async () => {
    const value = fixture();
    value.pages.pagesResponse = {
      status: 200,
      body: {
        html_url: SITE_URL,
        source: { branch: "gh-pages", path: "/" },
      },
    };

    await expect(publishActivity(value.config, {
      at: CUTOFF,
      transport: value.pages,
      git: defaultGitTransport,
    })).rejects.toThrow("configured for a different branch or path");
    expect(existsSync(join(value.state, "pages"))).toBe(false);
    expect(value.pages.requests.some((request) => request.method === "POST")).toBe(false);

    value.pages.pagesResponse = {
      status: 200,
      body: {
        html_url: "https://user:secret@pages.example.test/vito/",
        source: { branch: "main", path: "/docs" },
      },
    };
    await expect(publishActivity(value.config, {
      at: CUTOFF,
      transport: value.pages,
      git: defaultGitTransport,
    })).rejects.toThrow("html_url must not contain credentials");
    expect(existsSync(join(value.state, "pages"))).toBe(false);
  }, 30_000);
});
