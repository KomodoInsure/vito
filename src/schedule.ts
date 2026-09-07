import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "./config";

export const SCHEDULE_LABEL = "com.komodorisk.vito";
const PLIST_FILENAME = `${SCHEDULE_LABEL}.plist`;
const PUBLICATION_STATE_FILENAME = "publication-state.json";
const DATABASE_FILENAME = "activity.sqlite";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LaunchctlTransport {
  run(executable: string, args: readonly string[]): CommandResult | Promise<CommandResult>;
}

export interface ScheduleOptions {
  bunPath?: string;
  gitPath?: string;
  ghPath?: string;
  launchctlPath?: string;
  projectDir?: string;
  homeDir?: string;
  plistPath?: string;
  guiUid?: number;
  launchctl?: LaunchctlTransport;
}

export interface ScheduleInstallResult {
  label: typeof SCHEDULE_LABEL;
  plistPath: string;
  installed: true;
  bootstrapped: boolean;
}

export interface ScheduleStatus {
  label: typeof SCHEDULE_LABEL;
  plistPath: string;
  installed: boolean;
  managed: boolean;
  loaded: boolean;
  lastCollectionAt: string | null;
  lastPublicationAt: string | null;
  siteUrl: string | null;
}

export interface ScheduleUninstallResult {
  label: typeof SCHEDULE_LABEL;
  plistPath: string;
  removed: boolean;
  bootedOut: boolean;
}

export class ScheduleError extends Error {
  override readonly name = "ScheduleError";
}

interface ResolvedSchedule {
  bunPath: string;
  gitPath: string;
  ghPath: string;
  launchctlPath: string;
  projectDir: string;
  configPath: string;
  plistPath: string;
  logsDir: string;
  stdoutPath: string;
  stderrPath: string;
  uid: number;
  launchctl: LaunchctlTransport;
}

interface PublicationState {
  lastSuccessfulPublicationAt: string;
  siteUrl: string | null;
}

const defaultLaunchctl: LaunchctlTransport = {
  run(executable, args) {
    const result = Bun.spawnSync([executable, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  },
};

function fail(message: string): never {
  throw new ScheduleError(message);
}

function resolveExistingPath(path: string, label: string, kind: "file" | "directory"): string {
  if (!isAbsolute(path)) fail(`${label} must be an absolute path: ${path}`);
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    fail(`${label} does not exist: ${path}`);
  }
  const metadata = statSync(canonical);
  if (kind === "file" ? !metadata.isFile() : !metadata.isDirectory()) {
    fail(`${label} must be a ${kind}: ${path}`);
  }
  return canonical;
}

function resolveExecutable(path: string | undefined, command: string, label: string): string {
  const candidate = path ?? Bun.which(command);
  if (candidate === null || candidate === undefined) fail(`${label} executable was not found in PATH.`);
  return resolveExistingPath(candidate, label, "file");
}

function resolveUid(uid: number | undefined): number {
  const candidate = uid ?? process.getuid?.();
  if (!Number.isSafeInteger(candidate) || candidate === undefined || candidate < 0) {
    fail("Unable to resolve the current GUI user ID.");
  }
  return candidate;
}

function resolveSchedule(config: Config, configPath: string, options: ScheduleOptions): ResolvedSchedule {
  const bunPath = resolveExecutable(options.bunPath ?? process.execPath, "bun", "Bun");
  const gitPath = resolveExecutable(options.gitPath, "git", "Git");
  const ghPath = resolveExecutable(options.ghPath, "gh", "GitHub CLI");
  const launchctlPath = resolveExecutable(options.launchctlPath, "launchctl", "launchctl");
  const projectDir = resolveExistingPath(
    options.projectDir ?? fileURLToPath(new URL("..", import.meta.url)),
    "Vito project directory",
    "directory",
  );
  const canonicalConfigPath = resolveExistingPath(configPath, "Configuration", "file");
  const home = options.homeDir ?? homedir();
  if (!isAbsolute(home)) fail(`Home directory must be an absolute path: ${home}`);
  const plistPath = options.plistPath ?? join(home, "Library", "LaunchAgents", PLIST_FILENAME);
  if (!isAbsolute(plistPath)) fail(`LaunchAgent plist path must be absolute: ${plistPath}`);
  if (!isAbsolute(config.stateDir)) fail(`State directory must be an absolute path: ${config.stateDir}`);
  const logsDir = join(config.stateDir, "logs");

  return {
    bunPath,
    gitPath,
    ghPath,
    launchctlPath,
    projectDir,
    configPath: canonicalConfigPath,
    plistPath,
    logsDir,
    stdoutPath: join(logsDir, "schedule.stdout.log"),
    stderrPath: join(logsDir, "schedule.stderr.log"),
    uid: resolveUid(options.guiUid),
    launchctl: options.launchctl ?? defaultLaunchctl,
  };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function uniqueDirectories(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const directory = dirname(path);
    if (!seen.has(directory)) {
      seen.add(directory);
      result.push(directory);
    }
  }
  return result;
}

function renderResolvedPlist(resolved: ResolvedSchedule): string {
  const cliPath = join(resolved.projectDir, "src", "cli.ts");
  if (!existsSync(cliPath) || !statSync(cliPath).isFile()) fail(`Vito CLI entry point does not exist: ${cliPath}`);
  const path = uniqueDirectories([resolved.bunPath, resolved.gitPath, resolved.ghPath]).join(":");
  const argumentsList = [resolved.bunPath, "run", cliPath, "--config", resolved.configPath, "tick"];
  const argumentsXml = argumentsList.map((argument) => `      <string>${xml(argument)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SCHEDULE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xml(resolved.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(resolved.stderrPath)}</string>
    <key>Umask</key>
    <integer>63</integer>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xml(path)}</string>
    </dict>
  </dict>
</plist>
`;
}

export function renderLaunchdPlist(
  config: Config,
  configPath: string,
  options: ScheduleOptions = {},
): string {
  return renderResolvedPlist(resolveSchedule(config, configPath, options));
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`Expected a private directory: ${path}`);
  chmodSync(path, 0o700);
}

function ensureLaunchAgentDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`LaunchAgents parent must be a real directory: ${path}`);
  }
}

function inspectManagedPlist(path: string, expected: string): { installed: boolean; managed: boolean } {
  if (!existsSync(path)) return { installed: false, managed: false };
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) return { installed: true, managed: false };
  return { installed: true, managed: readFileSync(path, "utf8") === expected };
}

async function runLaunchctl(resolved: ResolvedSchedule, args: readonly string[]): Promise<CommandResult> {
  try {
    return await resolved.launchctl.run(resolved.launchctlPath, args);
  } catch (error) {
    fail(`launchctl could not be executed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function isLoaded(resolved: ResolvedSchedule): Promise<boolean> {
  const result = await runLaunchctl(resolved, ["print", `gui/${resolved.uid}/${SCHEDULE_LABEL}`]);
  return result.exitCode === 0;
}

function commandFailure(action: string, result: CommandResult): never {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  fail(`launchctl ${action} failed: ${detail}`);
}

function writeManagedPlist(path: string, content: string): void {
  ensureLaunchAgentDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    // A hard link publishes the fully written file without ever replacing a
    // plist that appeared after the ownership check.
    linkSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(path)) {
      fail(`Refusing to replace an existing LaunchAgent plist: ${path}`);
    }
    fail(`Unable to write LaunchAgent plist: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function installSchedule(
  config: Config,
  configPath: string,
  options: ScheduleOptions = {},
): Promise<ScheduleInstallResult> {
  const resolved = resolveSchedule(config, configPath, options);
  const expected = renderResolvedPlist(resolved);
  const inspection = inspectManagedPlist(resolved.plistPath, expected);
  if (inspection.installed && !inspection.managed) {
    fail(`Refusing to replace an unrelated or modified LaunchAgent plist: ${resolved.plistPath}`);
  }

  ensurePrivateDirectory(resolved.logsDir);
  if (!inspection.installed) {
    writeManagedPlist(resolved.plistPath, expected);
    const result = await runLaunchctl(resolved, ["bootstrap", `gui/${resolved.uid}`, resolved.plistPath]);
    if (result.exitCode !== 0) commandFailure("bootstrap", result);
    return { label: SCHEDULE_LABEL, plistPath: resolved.plistPath, installed: true, bootstrapped: true };
  }

  chmodSync(resolved.plistPath, 0o600);
  if (await isLoaded(resolved)) {
    return { label: SCHEDULE_LABEL, plistPath: resolved.plistPath, installed: true, bootstrapped: false };
  }
  const result = await runLaunchctl(resolved, ["bootstrap", `gui/${resolved.uid}`, resolved.plistPath]);
  if (result.exitCode !== 0) commandFailure("bootstrap", result);
  return { label: SCHEDULE_LABEL, plistPath: resolved.plistPath, installed: true, bootstrapped: true };
}

function readLastCollectionAt(stateDir: string): string | null {
  const databasePath = join(stateDir, DATABASE_FILENAME);
  if (!existsSync(databasePath)) return null;
  let database: Database | undefined;
  try {
    const metadata = lstatSync(databasePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
    database = new Database(databasePath, { readonly: true, strict: true });
    const row = database.query(`
      SELECT MAX(COALESCE(completed_at_ms, successful_scan_ms, cutoff_ms)) AS at_ms
      FROM collection_runs
      WHERE status IN ('completed', 'partial')
    `).get() as { at_ms: number | null } | null;
    const atMs = row?.at_ms;
    return typeof atMs === "number" && Number.isSafeInteger(atMs) && atMs >= 0
      ? new Date(atMs).toISOString()
      : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function readPublicationState(config: Config): PublicationState | null {
  const path = join(config.stateDir, PUBLICATION_STATE_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const expectedKeys = ["schemaVersion", "lastSuccessfulPublicationAt", "repository", "commit", "siteUrl"];
    if (Object.keys(record).sort().join("\0") !== [...expectedKeys].sort().join("\0")) return null;
    if (
      record.schemaVersion !== 1 ||
      record.repository !== config.publication.repository ||
      typeof record.lastSuccessfulPublicationAt !== "string" ||
      !Number.isFinite(Date.parse(record.lastSuccessfulPublicationAt)) ||
      typeof record.commit !== "string" ||
      record.commit.length === 0 ||
      (record.siteUrl !== null && typeof record.siteUrl !== "string")
    ) return null;
    return {
      lastSuccessfulPublicationAt: new Date(record.lastSuccessfulPublicationAt).toISOString(),
      siteUrl: record.siteUrl as string | null,
    };
  } catch {
    return null;
  }
}

export async function scheduleStatus(
  config: Config,
  configPath: string,
  options: ScheduleOptions = {},
): Promise<ScheduleStatus> {
  const resolved = resolveSchedule(config, configPath, options);
  const expected = renderResolvedPlist(resolved);
  const inspection = inspectManagedPlist(resolved.plistPath, expected);
  const publication = readPublicationState(config);
  return {
    label: SCHEDULE_LABEL,
    plistPath: resolved.plistPath,
    installed: inspection.installed,
    managed: inspection.managed,
    loaded: await isLoaded(resolved),
    lastCollectionAt: readLastCollectionAt(config.stateDir),
    lastPublicationAt: publication?.lastSuccessfulPublicationAt ?? null,
    siteUrl: publication?.siteUrl ?? null,
  };
}

export async function uninstallSchedule(
  config: Config,
  configPath: string,
  options: ScheduleOptions = {},
): Promise<ScheduleUninstallResult> {
  const resolved = resolveSchedule(config, configPath, options);
  const expected = renderResolvedPlist(resolved);
  const inspection = inspectManagedPlist(resolved.plistPath, expected);
  if (!inspection.installed) {
    return { label: SCHEDULE_LABEL, plistPath: resolved.plistPath, removed: false, bootedOut: false };
  }
  if (!inspection.managed) {
    fail(`Refusing to remove an unrelated or modified LaunchAgent plist: ${resolved.plistPath}`);
  }

  let bootedOut = false;
  if (await isLoaded(resolved)) {
    const result = await runLaunchctl(resolved, ["bootout", `gui/${resolved.uid}`, resolved.plistPath]);
    if (result.exitCode !== 0) commandFailure("bootout", result);
    bootedOut = true;
  }
  rmSync(resolved.plistPath);
  return { label: SCHEDULE_LABEL, plistPath: resolved.plistPath, removed: true, bootedOut };
}
