import { resolve } from "node:path";

import {
  initializeConfig as initializeConfigFile,
  loadConfig,
  resolveConfigPath,
} from "./config";
import type { Config } from "./config";
import { discoverSources, formatDiscoveryOutput } from "./discover";
import { exportStaticSite } from "./export";
import type { ExportResult } from "./export";
import { collectGitCommits } from "./git";
import type { GitCollectionResult } from "./git";
import { collectIntoStore } from "./ingest";
import type { CollectionSummary } from "./ingest";
import { buildScopeReport, type ScopeReport } from "./metrics";
import { withWriterLock } from "./lock";
import {
  publishActivity,
  readPublicationState,
  setupPages,
} from "./publish";
import type { PublicationState, PublishResult } from "./publish";
import { startPreview } from "./preview";
import {
  installSchedule,
  scheduleStatus,
  uninstallSchedule,
} from "./schedule";
import { openCollectorStore } from "./store";
import type { DiscoveryEntry } from "./sources/types";
import type { CollectorStore } from "./store";

export type InitCommand = {
  kind: "init";
  workspaceRoots: string[];
  pagesRepository: string;
  timezone?: string;
  stateDir?: string;
};

export type RunnableCommand =
  | { kind: "discover" }
  | { kind: "collect"; rebuild: boolean }
  | { kind: "export"; out: string; at?: string }
  | { kind: "scope"; days: number; at: string }
  | { kind: "preview"; dir: string; port: number }
  | { kind: "publish"; dryRun: boolean }
  | { kind: "pages-setup" }
  | { kind: "tick" }
  | { kind: "schedule"; action: "install" | "status" | "uninstall" };

export type CliCommand = InitCommand | RunnableCommand;

export interface ParsedInvocation {
  configPath?: string;
  command: CliCommand;
}

export interface CommandContext {
  configPath?: string;
}

export interface CommandRunner {
  run(command: RunnableCommand, context: CommandContext): void | Promise<void>;
}

interface PreviewServer {
  port: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface CliOperations {
  loadConfig(configPath?: string): Config | Promise<Config>;
  resolveConfigPath(configPath?: string): string;
  discoverSources(config?: Config): Promise<DiscoveryEntry[]>;
  formatDiscoveryOutput(entries: readonly DiscoveryEntry[]): string;
  withWriterLock<T>(stateDir: string, operation: () => T | Promise<T>): Promise<T>;
  openCollectorStore(stateDir: string): CollectorStore;
  collectIntoStore(
    config: Config,
    store: CollectorStore,
    options?: { rebuild?: boolean; cutoffMs?: number; reconcileAll?: boolean },
  ): Promise<CollectionSummary>;
  collectGitCommits(
    config: Pick<Config, "workspaceRoots" | "repositories">,
    store: CollectorStore,
    options?: { collectedAtMs?: number },
  ): GitCollectionResult;
  exportStaticSite(
    config: Config,
    store: CollectorStore,
    options: { outDir: string; at?: string },
  ): ExportResult;
  buildScopeReport(config: Config, store: CollectorStore, days: number, cutoffMs: number): ScopeReport;
  startPreview(directory: string, port: number): PreviewServer;
  waitForPreviewStop(server: PreviewServer): Promise<void>;
  publishActivity(
    config: Config,
    options?: { dryRun?: boolean; lockHeld?: boolean; at?: string },
  ): Promise<PublishResult>;
  setupPages(
    config: Config,
    options?: { lockHeld?: boolean },
  ): Promise<PublishResult>;
  readPublicationState(config: Config): Pick<PublicationState, "lastSuccessfulPublicationAt"> | null;
  installSchedule(config: Config, configPath: string): Promise<unknown>;
  scheduleStatus(config: Config, configPath: string): Promise<unknown>;
  uninstallSchedule(config: Config, configPath: string): Promise<unknown>;
  now(): number;
}

export interface InitInput {
  configPath?: string;
  workspaceRoots: string[];
  pagesRepository: string;
  timezone?: string;
  stateDir?: string;
}

export interface InitResult {
  configPath: string;
}

export interface CliDependencies {
  initializeConfig?: (input: InitInput) => Promise<InitResult>;
  requireConfig?: (configPath?: string) => Promise<void>;
  operations?: CliOperations;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}


const COMMANDS_REQUIRING_CONFIG: Record<RunnableCommand["kind"], boolean> = {
  discover: false,
  collect: true,
  export: true,
  preview: false,
  scope: true,
  publish: true,
  "pages-setup": true,
  tick: true,
  schedule: true,
};


function usage(message: string): never {
  throw new CliUsageError(message);
}

function takeValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    usage(`${option} requires a value.`);
  }
  return value;
}

function rejectDuplicate(seen: Set<string>, option: string): void {
  if (seen.has(option)) usage(`${option} may only be specified once.`);
  seen.add(option);
}


function parsePagesRepository(value: string): string {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/.exec(value);
  if (!match || match[2] === "." || match[2] === "..") {
    usage("--pages-repo must be a GitHub repository in owner/name form.");
  }
  return value;
}

function parseTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return value;
  } catch {
    usage("--timezone must be a valid IANA timezone.");
  }
}

function parseInstant(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (match === null) usage("--at must be an ISO instant with a Z or numeric UTC offset.");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  const validCalendarDate =
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day;
  if (
    !validCalendarDate ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText ?? "0") > 59 ||
    Number(offsetHourText ?? "0") > 23 ||
    Number(offsetMinuteText ?? "0") > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    usage("--at must be an ISO instant with a Z or numeric UTC offset.");
  }
  return value;
}

function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value)) usage("--port must be an integer from 1 to 65535.");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    usage("--port must be an integer from 1 to 65535.");
  }
  return port;
}

function parseInit(argv: readonly string[]): InitCommand {
  const seen = new Set<string>();
  const workspaceRoots: string[] = [];
  const workspaceValues = new Set<string>();
  let pagesRepository: string | undefined;
  let timezone: string | undefined;
  let stateDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined) break;
    if (option === "--workspace") {
      const workspace = resolve(takeValue(argv, index, option));
      if (workspaceValues.has(workspace)) usage(`Duplicate --workspace value: ${workspace}`);
      workspaceValues.add(workspace);
      workspaceRoots.push(workspace);
      index += 1;
      continue;
    }
    if (option === "--pages-repo") {
      rejectDuplicate(seen, option);
      pagesRepository = parsePagesRepository(takeValue(argv, index, option));
      index += 1;
      continue;
    }
    if (option === "--timezone") {
      rejectDuplicate(seen, option);
      timezone = parseTimezone(takeValue(argv, index, option));
      index += 1;
      continue;
    }
    if (option === "--state-dir") {
      rejectDuplicate(seen, option);
      stateDir = resolve(takeValue(argv, index, option));
      index += 1;
      continue;
    }
    if (option === "--config") usage("--config is global and must appear before the command.");
    usage(`Unknown argument for init: ${option}`);
  }

  if (workspaceRoots.length === 0) usage("init requires at least one --workspace <path>.");
  if (pagesRepository === undefined) usage("init requires --pages-repo <owner/name>.");
  const command: InitCommand = { kind: "init", workspaceRoots, pagesRepository };
  if (timezone !== undefined) command.timezone = timezone;
  if (stateDir !== undefined) command.stateDir = stateDir;
  return command;
}

function parseNoArguments(kind: "discover" | "tick", argv: readonly string[]): RunnableCommand {
  if (argv.length > 0) {
    if (argv[0] === "--config") usage("--config is global and must appear before the command.");
    usage(`Unknown argument for ${kind}: ${argv[0]}`);
  }
  return { kind };
}

function parseCollect(argv: readonly string[]): RunnableCommand {
  let rebuild = false;
  for (const option of argv) {
    if (option === "--rebuild") {
      if (rebuild) usage("--rebuild may only be specified once.");
      rebuild = true;
    } else if (option === "--config") {
      usage("--config is global and must appear before the command.");
    } else {
      usage(`Unknown argument for collect: ${option}`);
    }
  }
  return { kind: "collect", rebuild };
}

function parseExport(argv: readonly string[]): RunnableCommand {
  const seen = new Set<string>();
  let out: string | undefined;
  let at: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined) break;
    if (option === "--out") {
      rejectDuplicate(seen, option);
      out = resolve(takeValue(argv, index, option));
      index += 1;
    } else if (option === "--at") {
      rejectDuplicate(seen, option);
      at = parseInstant(takeValue(argv, index, option));
      index += 1;
    } else if (option === "--config") {
      usage("--config is global and must appear before the command.");
    } else {
      usage(`Unknown argument for export: ${option}`);
    }
  }
  if (out === undefined) usage("export requires --out <directory>.");
  const command: RunnableCommand = { kind: "export", out };
  if (at !== undefined) command.at = at;
  return command;
}

function parseScope(argv: readonly string[]): RunnableCommand {
  const seen = new Set<string>();
  let days: number | undefined;
  let at: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--days") {
      rejectDuplicate(seen, option);
      const value = takeValue(argv, index, option);
      if (!/^[1-9]\d*$/.test(value)) usage("--days must be a positive integer.");
      days = Number(value);
      if (!Number.isSafeInteger(days)) usage("--days must be a positive safe integer.");
      index += 1;
    } else if (option === "--at") {
      rejectDuplicate(seen, option);
      at = parseInstant(takeValue(argv, index, option));
      index += 1;
    } else if (option === "--config") {
      usage("--config is global and must appear before the command.");
    } else {
      usage(`Unknown argument for scope: ${option}`);
    }
  }
  if (days === undefined) usage("scope requires --days <N>.");
  if (at === undefined) usage("scope requires --at <ISO timestamp>.");
  return { kind: "scope", days, at };
}

function parsePreview(argv: readonly string[]): RunnableCommand {
  const seen = new Set<string>();
  let dir: string | undefined;
  let port = 4173;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined) break;
    if (option === "--dir") {
      rejectDuplicate(seen, option);
      dir = resolve(takeValue(argv, index, option));
      index += 1;
    } else if (option === "--port") {
      rejectDuplicate(seen, option);
      port = parsePort(takeValue(argv, index, option));
      index += 1;
    } else if (option === "--config") {
      usage("--config is global and must appear before the command.");
    } else {
      usage(`Unknown argument for preview: ${option}`);
    }
  }
  if (dir === undefined) usage("preview requires --dir <directory>.");
  return { kind: "preview", dir, port };
}

function parsePublish(argv: readonly string[]): RunnableCommand {
  let dryRun = false;
  for (const option of argv) {
    if (option === "--dry-run") {
      if (dryRun) usage("--dry-run may only be specified once.");
      dryRun = true;
    } else if (option === "--config") {
      usage("--config is global and must appear before the command.");
    } else {
      usage(`Unknown argument for publish: ${option}`);
    }
  }
  return { kind: "publish", dryRun };
}

function parsePages(argv: readonly string[]): RunnableCommand {
  if (argv.length === 0) usage("pages requires the 'setup' subcommand.");
  if (argv[0] !== "setup") usage(`Unknown pages subcommand: ${argv[0]}`);
  if (argv.length > 1) {
    if (argv[1] === "--config") usage("--config is global and must appear before the command.");
    usage(`Unknown argument for pages setup: ${argv[1]}`);
  }
  return { kind: "pages-setup" };
}

function parseSchedule(argv: readonly string[]): RunnableCommand {
  if (argv.length === 0) usage("schedule requires install, status, or uninstall.");
  const action = argv[0];
  if (action !== "install" && action !== "status" && action !== "uninstall") {
    usage(`Unknown schedule subcommand: ${action}`);
  }
  if (argv.length > 1) {
    if (argv[1] === "--config") usage("--config is global and must appear before the command.");
    usage(`Unknown argument for schedule ${action}: ${argv[1]}`);
  }
  return { kind: "schedule", action };
}

export function parseArgs(argv: readonly string[]): ParsedInvocation {
  let index = 0;
  let configPath: string | undefined;
  if (argv[index] === "--config") {
    configPath = resolve(takeValue(argv, index, "--config"));
    index += 2;
    if (argv[index] === "--config") usage("--config may only be specified once.");
  }

  const commandName = argv[index];
  if (commandName === undefined) usage("A command is required.");
  if (commandName.startsWith("--")) usage(`Unknown global option: ${commandName}`);
  const rest = argv.slice(index + 1);

  let command: CliCommand;
  switch (commandName) {
    case "init":
      command = parseInit(rest);
      break;
    case "discover":
      command = parseNoArguments("discover", rest);
      break;
    case "collect":
      command = parseCollect(rest);
      break;
    case "export":
      command = parseExport(rest);
      break;
    case "scope":
      command = parseScope(rest);
      break;
    case "preview":
      command = parsePreview(rest);
      break;
    case "publish":
      command = parsePublish(rest);
      break;
    case "pages":
      command = parsePages(rest);
      break;
    case "tick":
      command = parseNoArguments("tick", rest);
      break;
    case "schedule":
      command = parseSchedule(rest);
      break;
    default:
      usage(`Unknown command: ${commandName}`);
  }

  return configPath === undefined ? { command } : { configPath, command };
}

async function initializeConfig(input: InitInput): Promise<InitResult> {
  return initializeConfigFile(input);
}

async function requireConfig(configPath?: string): Promise<void> {
  loadConfig(configPath);
}

async function waitForPreviewStop(server: PreviewServer): Promise<void> {
  const signals: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];
  let finish = (): void => {};
  const stopped = new Promise<void>((resolve) => {
    finish = (): void => resolve();
    for (const signal of signals) process.once(signal, finish);
  });
  try {
    await stopped;
  } finally {
    for (const signal of signals) process.removeListener(signal, finish);
    await server.stop(true);
  }
}

function startCliPreview(directory: string, port: number): PreviewServer {
  const server = startPreview(directory, port);
  const boundPort = server.port;
  if (
    typeof boundPort !== "number" ||
    !Number.isSafeInteger(boundPort) ||
    boundPort < 1 ||
    boundPort > 65_535
  ) {
    server.stop(true);
    throw new Error("Preview server did not report a valid bound port");
  }
  return {
    port: boundPort,
    stop: (closeActiveConnections) => server.stop(closeActiveConnections),
  };
}

function defaultOperations(): CliOperations {
  return {
    loadConfig,
    resolveConfigPath,
    discoverSources,
    formatDiscoveryOutput,
    withWriterLock: (stateDir, operation) => withWriterLock(stateDir, operation),
    openCollectorStore,
    collectIntoStore,
    collectGitCommits,
    exportStaticSite,
    buildScopeReport,
    startPreview: startCliPreview,
    waitForPreviewStop,
    publishActivity,
    setupPages,
    readPublicationState,
    installSchedule,
    scheduleStatus,
    uninstallSchedule,
    now: Date.now,
  };
}

function publicationOutput(verb: string, result: PublishResult): string {
  return `${verb} ${JSON.stringify({
    exportDirectory: result.exportDirectory,
    exportedFiles: result.exportedFiles,
    snapshotCoverage: result.snapshotCoverage,
    changed: result.changed,
    pushed: result.pushed,
    commit: result.commit ?? null,
    siteUrl: result.siteUrl ?? null,
    widgetUrls: result.widgetUrls ?? {},
  })}`;
}

async function collectOnce(
  config: Config,
  rebuild: boolean,
  operations: CliOperations,
): Promise<{ activity: CollectionSummary; git: GitCollectionResult }> {
  const store = operations.openCollectorStore(config.stateDir);
  try {
    const activity = await operations.collectIntoStore(config, store, { rebuild });
    const git = operations.collectGitCommits(config, store, { collectedAtMs: activity.cutoffMs });
    return { activity, git };
  } finally {
    store.close();
  }
}

export function createDefaultCommandRunner(
  operations: CliOperations,
  writeOut: (message: string) => void = console.log,
): CommandRunner {
  return {
    async run(command, context): Promise<void> {
      if (command.kind === "discover") {
        const config = context.configPath === undefined
          ? undefined
          : await operations.loadConfig(context.configPath);
        const entries = await operations.discoverSources(config);
        writeOut(operations.formatDiscoveryOutput(entries).trimEnd());
        return;
      }

      if (command.kind === "preview") {
        const server = operations.startPreview(command.dir, command.port);
        writeOut(`Previewing ${command.dir} at http://127.0.0.1:${server.port}/`);
        await operations.waitForPreviewStop(server);
        return;
      }

      const config = await operations.loadConfig(context.configPath);
      if (command.kind === "collect") {
        const result = await operations.withWriterLock(config.stateDir, () =>
          collectOnce(config, command.rebuild, operations));
        writeOut(`Collected activity ${JSON.stringify({
          status: result.activity.status,
          cutoff: new Date(result.activity.cutoffMs).toISOString(),
          adapters: result.activity.adaptersCollected,
          repositories: result.git.repositories.length,
          gitDiagnostics: result.git.diagnostics.length,
          unallocatedUsageRecords: result.activity.unallocatedUsageRecords,
          excludedAmbiguousRecords: result.activity.excludedAmbiguousRecords,
          excludedUnattributedRecords: result.activity.excludedUnattributedRecords,
        })}`);
        return;
      }

      if (command.kind === "export") {
        const store = operations.openCollectorStore(config.stateDir);
        try {
          const options = command.at === undefined
            ? { outDir: command.out }
            : { outDir: command.out, at: command.at };
          const result = store.readTransaction(() =>
            operations.exportStaticSite(config, store, options));
          writeOut(`Exported activity ${JSON.stringify({
            directory: result.outDir,
            files: result.files,
            periodStart: result.snapshot.periodStart,
            periodEnd: result.snapshot.periodEnd,
            collectionStatus: result.snapshot.collectionStatus,
            coverage: result.snapshot.coverage,
          })}`);
        } finally {
          store.close();
        }
        return;
      }

      if (command.kind === "scope") {
        const store = operations.openCollectorStore(config.stateDir);
        try {
          const report = operations.buildScopeReport(config, store, command.days, Date.parse(command.at));
          writeOut(`Scope report ${JSON.stringify(report)}`);
        } finally {
          store.close();
        }
        return;
      }

      if (command.kind === "publish") {
        const result = await operations.withWriterLock(config.stateDir, () =>
          operations.publishActivity(config, { dryRun: command.dryRun, lockHeld: true }));
        writeOut(publicationOutput(command.dryRun ? "Prepared publication dry run" : "Published activity", result));
        return;
      }

      if (command.kind === "pages-setup") {
        const result = await operations.withWriterLock(config.stateDir, () =>
          operations.setupPages(config, { lockHeld: true }));
        writeOut(publicationOutput("Configured GitHub Pages", result));
        return;
      }

      if (command.kind === "tick") {
        const result = await operations.withWriterLock(config.stateDir, async () => {
          const now = operations.now();
          const state = operations.readPublicationState(config);
          const lastSuccessMs = state === null
            ? null
            : Date.parse(state.lastSuccessfulPublicationAt);
          const publicationDue =
            lastSuccessMs === null ||
            !Number.isFinite(lastSuccessMs) ||
            now - lastSuccessMs >= 15 * 60 * 1_000;
          if (publicationDue) {
            const publication = await operations.publishActivity(config, {
              lockHeld: true,
              at: new Date(now).toISOString(),
            });
            return { publicationDue, publication };
          }
          const collection = await collectOnce(config, false, operations);
          return { publicationDue, collection };
        });
        if (result.publication !== undefined) {
          writeOut(publicationOutput("Tick published activity", result.publication));
        } else {
          writeOut(`Tick collected activity ${JSON.stringify({
            status: result.collection.activity.status,
            cutoff: new Date(result.collection.activity.cutoffMs).toISOString(),
            repositories: result.collection.git.repositories.length,
            publicationDue: false,
          })}`);
        }
        return;
      }

      const configPath = operations.resolveConfigPath(context.configPath);
      const scheduleResult =
        command.action === "status"
          ? await operations.scheduleStatus(config, configPath)
          : await operations.withWriterLock(config.stateDir, () =>
            command.action === "install"
              ? operations.installSchedule(config, configPath)
              : operations.uninstallSchedule(config, configPath));
      writeOut(`Schedule ${command.action} ${JSON.stringify(scheduleResult)}`);
    },
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  runner?: CommandRunner,
  dependencies: CliDependencies = {},
): Promise<number> {
  const writeOut = dependencies.stdout ?? console.log;
  const writeError = dependencies.stderr ?? console.error;

  try {
    const invocation = parseArgs(argv);
    if (invocation.command.kind === "init") {
      const init = dependencies.initializeConfig ?? initializeConfig;
      const input: InitInput = {
        workspaceRoots: invocation.command.workspaceRoots,
        pagesRepository: invocation.command.pagesRepository,
      };
      if (invocation.configPath !== undefined) input.configPath = invocation.configPath;
      if (invocation.command.timezone !== undefined) input.timezone = invocation.command.timezone;
      if (invocation.command.stateDir !== undefined) input.stateDir = invocation.command.stateDir;
      const result = await init(input);
      writeOut(`Initialized Vito configuration at ${result.configPath}`);
      return 0;
    }

    const context: CommandContext =
      invocation.configPath === undefined ? {} : { configPath: invocation.configPath };
    if (runner !== undefined) {
      if (COMMANDS_REQUIRING_CONFIG[invocation.command.kind]) {
        const checkConfig = dependencies.requireConfig ?? requireConfig;
        await checkConfig(invocation.configPath);
      }
      await runner.run(invocation.command, context);
    } else {
      const operations = dependencies.operations ?? defaultOperations();
      await createDefaultCommandRunner(operations, writeOut).run(invocation.command, context);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`vito: ${message}`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
