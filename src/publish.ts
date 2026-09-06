import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Config } from "./config";
import { publicSnapshotSchema, type PublicSnapshot } from "./contracts";
import { EXPORT_FILES, exportStaticSite, type ExportResult } from "./export";
import { collectIntoStore } from "./ingest";
import { collectGitCommits } from "./git";
import { withWriterLock } from "./lock";
import { openCollectorStore } from "./store";

export const PAGES_MARKER_FILE = ".vito-pages.json";
export const PUBLICATION_STATE_FILE = "publication-state.json";
export const PAGES_MARKER = Object.freeze({ schemaVersion: 1 as const, generator: "vito" as const });
export const PUBLISH_COMMIT_MESSAGE = "Update Agent Native activity";
export const PUBLISH_AUTHOR_NAME = "Agent Native Activity";
export const PUBLISH_AUTHOR_EMAIL = "activity@users.noreply.github.com";
export const WIDGET_VIEWS = [
  "calendar",
  "models",
  "uptime",
  "concurrency",
  "agent-hours",
  "parallelism",
  "rhythm",
  "composition",
  "cache",
  "commits",
  "cost",
  "all",
] as const;

const MANAGED_ROOT_FILES = [PAGES_MARKER_FILE, "docs"] as const;
const STAGED_PATHS = [PAGES_MARKER_FILE, ...EXPORT_FILES.map((file) => `docs/${file}`)] as const;
const MARKER_TEXT = `${JSON.stringify(PAGES_MARKER, null, 2)}\n`;
const GITHUB_TOKEN_PATTERN = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})/;

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A deliberately narrow seam: every entry is passed directly to the git executable. */
export interface GitTransport {
  run(args: readonly string[], options?: { cwd?: string }): Promise<ProcessResult>;
}

export interface PagesResponse {
  status: number;
  body: unknown;
}

/** GitHub API seam used for fixture responses without exposing a configurable command. */
export interface PagesTransport {
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<PagesResponse>;
}

export interface PublishOptions {
  dryRun?: boolean;
  lockHeld?: boolean;
  at?: string;
  transport?: PagesTransport;
  git?: GitTransport;
}

export interface SnapshotCoverage {
  periodStart: string;
  periodEnd: string;
  collectionStatus: "ok" | "partial";
  unallocatedUsageRecords: number;
  excludedAmbiguousRecords: number;
}

export interface PublishResult {
  exportDirectory: string;
  exportedFiles: string[];
  snapshotCoverage: SnapshotCoverage;
  changed: boolean;
  pushed: boolean;
  commit?: string;
  siteUrl?: string;
  widgetUrls?: Record<(typeof WIDGET_VIEWS)[number], string>;
}

export interface PublicationState {
  schemaVersion: 1;
  lastSuccessfulPublicationAt: string;
  repository: string;
  commit: string;
  siteUrl: string | null;
}

interface RepositoryInfo {
  cloneUrl: string;
}

interface PagesInfo {
  siteUrl: string;
}

export class PublishError extends Error {
  override readonly name = "PublishError";
}

function fail(message: string): never {
  throw new PublishError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertRegularFile(path: string, label: string): void {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular file: ${path}`);
}

function assertRealDirectory(path: string, label: string): void {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(`${label} must be a real directory: ${path}`);
}

function exactEntries(directory: string, expectedEntries: readonly string[], label: string): void {
  assertRealDirectory(directory, label);
  const actual = readdirSync(directory).sort();
  const expected = [...expectedEntries].sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    fail(`${label} has unrelated contents; expected exactly ${expected.join(", ")}`);
  }
}

function parseMarker(content: string): void {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    fail("Invalid Vito Pages marker");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "generator,schemaVersion" ||
    value.schemaVersion !== 1 ||
    value.generator !== "vito"
  ) {
    fail("Invalid Vito Pages marker");
  }
}

function assertMarker(path: string): void {
  assertRegularFile(path, "Vito Pages marker");
  parseMarker(readFileSync(path, "utf8"));
}

function privateStrings(config: Config): string[] {
  return [
    config.stateDir,
    join(config.stateDir, "activity.sqlite"),
    ...config.workspaceRoots,
    ...config.repositories.map((repository) => repository.path),
    ...Object.values(config.sources).flatMap((paths) => paths ?? []),
  ].filter((value, index, values) => value.length > 1 && values.indexOf(value) === index);
}

function assertPublicContent(content: string, config: Config, label: string): void {
  if (GITHUB_TOKEN_PATTERN.test(content)) fail(`${label} contains a credential-like value`);
  for (const value of privateStrings(config)) {
    if (content.includes(value) || content.includes(JSON.stringify(value).slice(1, -1))) {
      fail(`${label} contains a private configured path`);
    }
  }
}

function assertExport(exportResult: ExportResult, config: Config): void {
  exactEntries(exportResult.outDir, EXPORT_FILES, "Generated export");
  for (const file of EXPORT_FILES) {
    const path = join(exportResult.outDir, file);
    assertRegularFile(path, `Generated asset ${file}`);
    assertPublicContent(readFileSync(path, "utf8"), config, `Generated asset ${file}`);
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(readFileSync(join(exportResult.outDir, "activity.json"), "utf8"));
  } catch {
    fail("Generated activity.json is not valid JSON");
  }
  const parsed = publicSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) fail(`Generated activity.json failed public schema validation: ${parsed.error.message}`);
  if (JSON.stringify(parsed.data) !== JSON.stringify(exportResult.snapshot)) {
    fail("Generated activity.json does not match the exported snapshot");
  }
}

function assertManagedCheckout(checkout: string, exportResult?: ExportResult, config?: Config): void {
  assertRealDirectory(checkout, "Pages checkout");
  exactEntries(checkout, [".git", ...MANAGED_ROOT_FILES], "Pages checkout");
  assertMarker(join(checkout, PAGES_MARKER_FILE));
  const docs = join(checkout, "docs");
  exactEntries(docs, EXPORT_FILES, "Pages docs directory");
  for (const file of EXPORT_FILES) {
    const published = join(docs, file);
    assertRegularFile(published, `Pages asset ${file}`);
    if (exportResult !== undefined) {
      const generated = join(exportResult.outDir, file);
      if (!Bun.file(published).size || Bun.file(published).size !== Bun.file(generated).size) {
        if (readFileSync(published).compare(readFileSync(generated)) !== 0) fail(`Pages asset differs from generated export: ${file}`);
      } else if (readFileSync(published).compare(readFileSync(generated)) !== 0) {
        fail(`Pages asset differs from generated export: ${file}`);
      }
    }
    if (config !== undefined) assertPublicContent(readFileSync(published, "utf8"), config, `Pages asset ${file}`);
  }
  const parsed = publicSnapshotSchema.safeParse(JSON.parse(readFileSync(join(docs, "activity.json"), "utf8")));
  if (!parsed.success) fail(`Staged activity.json failed public schema validation: ${parsed.error.message}`);
}

export const defaultGitTransport: GitTransport = {
  async run(args, options = {}) {
    const child = Bun.spawn(["git", ...args], {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  },
};

export const defaultPagesTransport: PagesTransport = {
  async request(method, path, body) {
    const args = ["gh", "api", path, "--method", method, "--header", "Accept: application/vnd.github+json"];
    const input = body === undefined ? undefined : JSON.stringify(body);
    if (input !== undefined) args.push("--input", "-");
    const stdio = input === undefined
      ? (["ignore", "pipe", "pipe"] as const)
      : (["pipe", "pipe", "pipe"] as const);
    const child = Bun.spawn(args, {
      stdin: stdio[0],
      stdout: stdio[1],
      stderr: stdio[2],
      env: process.env,
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    if (input !== undefined) {
      if (child.stdin === undefined) fail("GitHub API subprocess stdin pipe was unavailable");
      child.stdin.write(input);
      await child.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      child.exited,
    ]);
    if (exitCode !== 0) {
      if (/\bHTTP 404\b/.test(stderr)) return { status: 404, body: null };
      fail(`GitHub API request failed: ${stderr.trim() || `gh exited ${exitCode}`}`);
    }
    let parsed: unknown = null;
    if (stdout.trim().length > 0) {
      try {
        parsed = JSON.parse(stdout);
      } catch {
        fail("GitHub API returned invalid JSON");
      }
    }
    return { status: method === "POST" ? 201 : 200, body: parsed };
  },
};

async function gitResult(git: GitTransport, args: readonly string[], cwd?: string): Promise<ProcessResult> {
  return git.run(args, cwd === undefined ? undefined : { cwd });
}

async function gitCommand(git: GitTransport, args: readonly string[], cwd?: string): Promise<string> {
  const result = await gitResult(git, args, cwd);
  if (result.exitCode !== 0) {
    fail(`git ${args[0] ?? "command"} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return result.stdout.trim();
}

async function repositoryInfo(config: Config, transport: PagesTransport): Promise<RepositoryInfo> {
  const response = await transport.request("GET", `/repos/${config.publication.repository}`);
  if (response.status === 404) {
    fail(`GitHub repository ${config.publication.repository} does not exist; create this dedicated public repository first`);
  }
  if (response.status !== 200 || !isRecord(response.body)) fail("GitHub repository lookup returned an unexpected response");
  const visibility = response.body.visibility;
  if (response.body.private !== false || (visibility !== undefined && visibility !== "public")) {
    fail(`GitHub repository ${config.publication.repository} must be public`);
  }
  const cloneUrl = response.body.clone_url;
  if (typeof cloneUrl !== "string" || cloneUrl.length === 0 || /[\r\n\0]/.test(cloneUrl)) {
    fail("GitHub repository lookup did not return a safe clone URL");
  }
  if (GITHUB_TOKEN_PATTERN.test(cloneUrl)) fail("GitHub repository clone URL must not contain credentials");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(cloneUrl)) {
    let parsed: URL;
    try {
      parsed = new URL(cloneUrl);
    } catch {
      fail("GitHub repository lookup did not return a valid clone URL");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      fail("GitHub repository clone URL must not contain credentials");
    }
  }
  return { cloneUrl };
}

function decodeApiContent(body: unknown): string | null {
  if (!isRecord(body) || body.type !== "file" || typeof body.content !== "string") return null;
  try {
    return Buffer.from(body.content.replace(/\s/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function requireDedicatedRepository(config: Config, transport: PagesTransport): Promise<void> {
  const root = await transport.request("GET", `/repos/${config.publication.repository}/contents`);
  if (root.status === 404) return;
  if (root.status !== 200 || !Array.isArray(root.body)) fail("Cannot inspect destination repository contents");
  if (root.body.length === 0) return;
  const marker = await transport.request("GET", `/repos/${config.publication.repository}/contents/${PAGES_MARKER_FILE}`);
  if (marker.status !== 200) fail("Destination repository is not empty and is not marked as Vito-managed");
  const content = decodeApiContent(marker.body);
  if (content === null) fail("Destination repository has an unreadable Vito marker");
  parseMarker(content);
}

function parsePagesInfo(response: PagesResponse): PagesInfo {
  if ((response.status !== 200 && response.status !== 201) || !isRecord(response.body)) {
    fail("GitHub Pages API returned an unexpected response");
  }
  const source = response.body.source;
  if (!isRecord(source) || source.branch !== "main" || source.path !== "/docs") {
    fail("GitHub Pages is configured for a different branch or path; refusing to replace it");
  }
  const siteUrl = response.body.html_url;
  if (typeof siteUrl !== "string" || siteUrl.length === 0) fail("GitHub Pages response did not include html_url");
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    fail("GitHub Pages html_url is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") fail("GitHub Pages html_url must be HTTP(S)");
  if (parsed.username !== "" || parsed.password !== "") fail("GitHub Pages html_url must not contain credentials");
  return { siteUrl: parsed.toString() };
}

async function inspectPages(config: Config, transport: PagesTransport, setup: boolean): Promise<PagesInfo | null> {
  const response = await transport.request("GET", `/repos/${config.publication.repository}/pages`);
  if (response.status === 404) {
    if (setup) return null;
    fail("GitHub Pages is not configured; run `vito pages setup` first");
  }
  return parsePagesInfo(response);
}

async function createPages(config: Config, transport: PagesTransport): Promise<PagesInfo> {
  return parsePagesInfo(await transport.request("POST", `/repos/${config.publication.repository}/pages`, {
    build_type: "legacy",
    source: { branch: "main", path: "/docs" },
  }));
}

async function remoteHead(git: GitTransport, checkout: string): Promise<string | null> {
  const result = await gitResult(git, ["ls-remote", "--heads", "origin", "refs/heads/main"], checkout);
  if (result.exitCode !== 0) fail(`Cannot inspect remote main branch: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  const line = result.stdout.trim();
  if (line === "") return null;
  const match = /^([0-9a-fA-F]{40,64})\s+refs\/heads\/main(?:\s*)$/.exec(line);
  if (match === null) fail("Remote main branch returned an unexpected reference");
  return match[1]!.toLowerCase();
}
async function fetchRemoteHead(git: GitTransport, checkout: string, expected: string): Promise<void> {
  await gitCommand(git, ["fetch", "--quiet", "--no-tags", "origin", "refs/heads/main"], checkout);
  const fetched = await gitCommand(git, ["rev-parse", "--verify", "FETCH_HEAD"], checkout);
  if (fetched.toLowerCase() !== expected) {
    fail("Remote main changed while preparing the Pages publication; retry safely");
  }
}


async function localHead(git: GitTransport, checkout: string): Promise<string | null> {
  const result = await gitResult(git, ["rev-parse", "--verify", "HEAD"], checkout);
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(value)) fail("Local Pages checkout has an invalid HEAD");
  return value;
}

async function assertExpectedCheckout(git: GitTransport, checkout: string, expectedRemote: string): Promise<void> {
  assertManagedCheckout(checkout);
  const status = await gitCommand(git, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], checkout);
  if (status.length !== 0) fail("Pages checkout has unexpected local changes");
  const branch = await gitCommand(git, ["symbolic-ref", "--quiet", "--short", "HEAD"], checkout);
  if (branch !== "main") fail("Pages checkout is not on the managed main branch");
  const configuredRemote = await gitCommand(git, ["remote", "get-url", "origin"], checkout);
  if (configuredRemote !== expectedRemote) fail("Pages checkout origin does not match the configured publication repository");
}

async function prepareCheckout(
  config: Config,
  git: GitTransport,
  cloneUrl: string,
  setup: boolean,
): Promise<{ checkout: string; remote: string | null; local: string | null; pending: boolean }> {
  const checkout = join(config.stateDir, "pages");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDir, 0o700);
  if (!exists(checkout)) {
    if (!setup) fail("Managed Pages checkout is missing; run `vito pages setup` first");
    await gitCommand(git, ["clone", "--origin", "origin", "--no-checkout", "--", cloneUrl, checkout]);
    const remote = await remoteHead(git, checkout);
    if (remote === null) {
      await gitCommand(git, ["checkout", "--orphan", "main"], checkout);
      return { checkout, remote: null, local: null, pending: false };
    }
    await gitCommand(git, ["checkout", "main"], checkout);
    assertManagedCheckout(checkout);
    return { checkout, remote, local: await localHead(git, checkout), pending: false };
  }

  await assertExpectedCheckout(git, checkout, cloneUrl);
  const remote = await remoteHead(git, checkout);
  const local = await localHead(git, checkout);
  if (local === null) fail("Managed Pages checkout has no local commit");
  if (remote === null) return { checkout, remote, local, pending: true };
  if (remote === local) return { checkout, remote, local, pending: false };
  await fetchRemoteHead(git, checkout, remote);

  const ancestor = await gitResult(git, ["merge-base", "--is-ancestor", remote, local], checkout);
  if (ancestor.exitCode === 0) return { checkout, remote, local, pending: true };
  if (ancestor.exitCode === 1) fail("Remote main diverged from the managed Pages checkout; refusing to push");
  fail(`Cannot compare local and remote Pages history: ${ancestor.stderr.trim() || `exit ${ancestor.exitCode}`}`);
}

function installGeneratedAssets(checkout: string, exportResult: ExportResult, config: Config): void {
  assertExport(exportResult, config);
  const docs = join(checkout, "docs");
  if (exists(docs)) exactEntries(docs, EXPORT_FILES, "Pages docs directory");
  else mkdirSync(docs, { mode: 0o755 });
  for (const file of EXPORT_FILES) {
    copyFileSync(join(exportResult.outDir, file), join(docs, file));
    chmodSync(join(docs, file), 0o644);
  }
  const marker = join(checkout, PAGES_MARKER_FILE);
  if (exists(marker)) assertMarker(marker);
  else writeFileSync(marker, MARKER_TEXT, { encoding: "utf8", flag: "wx", mode: 0o644 });
  chmodSync(marker, 0o644);
  assertManagedCheckout(checkout, exportResult, config);
}

async function stageAndValidate(git: GitTransport, checkout: string, exportResult: ExportResult, config: Config): Promise<boolean> {
  await gitCommand(git, ["add", "--", ...STAGED_PATHS], checkout);
  const names = await gitCommand(git, ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "-z"], checkout);
  const staged = names === "" ? [] : names.split("\0").filter(Boolean);
  const allowed = new Set<string>(STAGED_PATHS);
  if (staged.some((path) => !allowed.has(path))) fail("Git index contains a path outside the Vito Pages allowlist");
  assertManagedCheckout(checkout, exportResult, config);
  const difference = await gitResult(git, ["diff", "--cached", "--quiet", "--exit-code"], checkout);
  if (difference.exitCode === 0) return false;
  if (difference.exitCode === 1) return true;
  fail(`Cannot inspect staged Pages changes: ${difference.stderr.trim() || `exit ${difference.exitCode}`}`);
}

async function commitChanges(git: GitTransport, checkout: string, amend: boolean): Promise<string> {
  const args = [
    "-c", `user.name=${PUBLISH_AUTHOR_NAME}`,
    "-c", `user.email=${PUBLISH_AUTHOR_EMAIL}`,
    "commit",
  ];
  if (amend) args.push("--amend", "--no-edit");
  else args.push("--message", PUBLISH_COMMIT_MESSAGE);
  await gitCommand(git, args, checkout);
  const commit = await localHead(git, checkout);
  if (commit === null) fail("Git commit did not create a local HEAD");
  return commit;
}

async function push(git: GitTransport, checkout: string): Promise<void> {
  const result = await gitResult(git, ["push", "origin", "HEAD:refs/heads/main"], checkout);
  if (result.exitCode !== 0) fail(`Pages push failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

function coverage(snapshot: PublicSnapshot): SnapshotCoverage {
  return {
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    collectionStatus: snapshot.collectionStatus,
    unallocatedUsageRecords: snapshot.coverage.unallocatedUsageRecords,
    excludedAmbiguousRecords: snapshot.coverage.excludedAmbiguousRecords,
  };
}

function exportedPaths(result: ExportResult): string[] {
  return result.files.map((file) => join(result.outDir, file));
}

function widgetUrls(siteUrl: string): Record<(typeof WIDGET_VIEWS)[number], string> {
  const base = siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
  return Object.fromEntries(WIDGET_VIEWS.map((view) => [view, new URL(`widget.html?view=${view}&range=30&theme=auto`, base).toString()])) as Record<(typeof WIDGET_VIEWS)[number], string>;
}

function publicationStatePath(config: Config): string {
  return join(config.stateDir, PUBLICATION_STATE_FILE);
}

export function readPublicationState(config: Config): PublicationState | null {
  const path = publicationStatePath(config);
  if (!exists(path)) return null;
  assertRegularFile(path, "Publication state");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("Publication state is invalid JSON");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "commit,lastSuccessfulPublicationAt,repository,schemaVersion,siteUrl" ||
    value.schemaVersion !== 1 ||
    typeof value.lastSuccessfulPublicationAt !== "string" ||
    !Number.isFinite(Date.parse(value.lastSuccessfulPublicationAt)) ||
    typeof value.repository !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(typeof value.commit === "string" ? value.commit : "") ||
    (value.siteUrl !== null && typeof value.siteUrl !== "string")
  ) {
    fail("Publication state has an invalid schema");
  }
  const state = value as unknown as PublicationState;
  if (state.repository !== config.publication.repository) {
    fail("Publication state belongs to a different configured repository");
  }
  return state;
}

function writePublicationState(config: Config, commit: string, siteUrl: string): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDir, 0o700);
  const path = publicationStatePath(config);
  if (exists(path)) assertRegularFile(path, "Publication state");
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const state: PublicationState = {
    schemaVersion: 1,
    lastSuccessfulPublicationAt: new Date().toISOString(),
    repository: config.publication.repository,
    commit,
    siteUrl,
  };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

async function collectAndExport(config: Config, at?: string): Promise<ExportResult> {
  const cutoffMs = at === undefined ? Date.now() : Date.parse(at);
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) fail("Publication cutoff must be a valid ISO instant");
  const store = openCollectorStore(config.stateDir);
  try {
    await collectIntoStore(config, store, { cutoffMs });
    collectGitCommits(config, store, { collectedAtMs: cutoffMs });
    return exportStaticSite(config, store, { outDir: join(config.stateDir, "export"), at: cutoffMs });
  } finally {
    store.close();
  }
}

async function runPublication(config: Config, options: PublishOptions, setup: boolean): Promise<PublishResult> {
  const exportResult = await collectAndExport(config, options.at);
  const base: PublishResult = {
    exportDirectory: exportResult.outDir,
    exportedFiles: exportedPaths(exportResult),
    snapshotCoverage: coverage(exportResult.snapshot),
    changed: false,
    pushed: false,
  };
  if (options.dryRun) return base;

  const transport = options.transport ?? defaultPagesTransport;
  const git = options.git ?? defaultGitTransport;
  const repository = await repositoryInfo(config, transport);
  if (setup) await requireDedicatedRepository(config, transport);
  const existingPages = await inspectPages(config, transport, setup);
  const prepared = await prepareCheckout(config, git, repository.cloneUrl, setup);
  installGeneratedAssets(prepared.checkout, exportResult, config);
  const changed = await stageAndValidate(git, prepared.checkout, exportResult, config);
  let commit = prepared.local;
  if (changed) commit = await commitChanges(git, prepared.checkout, prepared.pending);
  if (commit === null) fail("Pages checkout has no publishable commit");

  const shouldPush = prepared.remote !== commit;
  if (shouldPush) await push(git, prepared.checkout);
  const pages = existingPages ?? await createPages(config, transport);
  writePublicationState(config, commit, pages.siteUrl);
  return {
    ...base,
    changed,
    pushed: shouldPush,
    commit,
    siteUrl: pages.siteUrl,
    widgetUrls: widgetUrls(pages.siteUrl),
  };
}

async function withOptionalLock(config: Config, options: PublishOptions, setup: boolean): Promise<PublishResult> {
  if (options.lockHeld) return runPublication(config, options, setup);
  return withWriterLock(config.stateDir, () => runPublication(config, options, setup));
}

export function publishActivity(config: Config, options: PublishOptions = {}): Promise<PublishResult> {
  return withOptionalLock(config, options, false);
}

export function setupPages(config: Config, options: PublishOptions = {}): Promise<PublishResult> {
  return withOptionalLock(config, options, true);
}
