import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { z } from "zod";
import { AGENTS, type Agent } from "./contracts";

export interface RepositoryConfig {
  path: string;
  remote: string;
  defaultBranch?: string;
}

export type HistoricalWorkspaceMatch = "exact" | "descendants";

export interface HistoricalWorkspaceConfig {
  path: string;
  repositoryPath: string;
  match: HistoricalWorkspaceMatch;
}

export interface Config {
  version: 1;
  companyName?: string;
  workspaceRoots: string[];
  timezone: string;
  stateDir: string;
  sources: Partial<Record<Agent, string[]>>;
  repositories: RepositoryConfig[];
  historicalWorkspaces?: HistoricalWorkspaceConfig[];
  publication: { repository: string; branch: "main" };
}

export interface InitializeConfigInput {
  companyName?: string;
  configPath?: string;
  workspaceRoots: string[];
  pagesRepository: string;
  timezone?: string;
  stateDir?: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const absoluteNormalizedPathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), "Path must be absolute")
  .refine((value) => normalize(value) === value, "Path must be normalized");

const ownerPart = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;
const repositoryPart = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

export function isValidGitHubRepository(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && ownerPart.test(parts[0] ?? "") && repositoryPart.test(parts[1] ?? "");
}

export function isValidIanaTimezone(value: string): boolean {
  if (value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export const repositoryConfigSchema = z
  .object({
    path: absoluteNormalizedPathSchema,
    remote: z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/),
    defaultBranch: z.string().min(1).max(255).optional(),
  })
  .strict();

export const historicalWorkspaceConfigSchema = z
  .object({
    path: absoluteNormalizedPathSchema,
    repositoryPath: absoluteNormalizedPathSchema,
    match: z.enum(["exact", "descendants"]),
  })
  .strict();

const sourcesSchema = z
  .object({
    codex: z.array(absoluteNormalizedPathSchema).optional(),
    claude: z.array(absoluteNormalizedPathSchema).optional(),
    omp: z.array(absoluteNormalizedPathSchema).optional(),
    opencode: z.array(absoluteNormalizedPathSchema).optional(),
    hermes: z.array(absoluteNormalizedPathSchema).optional(),
  })
  .strict();

export const configSchema: z.ZodType<Config> = z
  .object({
    version: z.literal(1),
    companyName: z.string().trim().min(1).max(80).optional().default("Komodo Risk Inc"),
    workspaceRoots: z.array(absoluteNormalizedPathSchema).min(1),
    timezone: z.string().refine(isValidIanaTimezone, "Invalid IANA timezone"),
    stateDir: absoluteNormalizedPathSchema,
    sources: sourcesSchema,
    repositories: z.array(repositoryConfigSchema),
    historicalWorkspaces: z.array(historicalWorkspaceConfigSchema).optional().default([]),
    publication: z
      .object({
        repository: z.string().refine(isValidGitHubRepository, "Expected owner/repository"),
        branch: z.literal("main"),
      })
      .strict(),
  })
  .strict();

export function getDefaultConfigPath(): string {
  return join(homedir(), ".config", "vito", "config.json");
}

export function getDefaultStateDir(): string {
  return join(homedir(), ".local", "share", "vito");
}

export function resolveConfigPath(configPath?: string): string {
  const selected = configPath ?? getDefaultConfigPath();
  if (!isAbsolute(selected)) throw new ConfigError("Configuration path must be absolute");
  return canonicalizePotentialPath(selected, "configuration path");
}

export function canonicalizeExistingPath(input: string, label = "path"): string {
  if (!isAbsolute(input)) throw new ConfigError(`${label} must be absolute`);
  let canonical: string;
  try {
    canonical = realpathSync.native(input);
  } catch {
    throw new ConfigError(`${label} does not exist: ${input}`);
  }
  return normalize(canonical);
}

export function canonicalizePotentialPath(input: string, label = "path"): string {
  if (!isAbsolute(input)) throw new ConfigError(`${label} must be absolute`);
  const normalized = normalize(input);
  let existing = normalized;
  const missingComponents: string[] = [];

  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new ConfigError(`Cannot resolve ${label}: ${input}`);
    missingComponents.push(basename(existing));
    existing = parent;
  }

  let canonical = realpathSync.native(existing);
  for (const component of missingComponents.reverse()) canonical = join(canonical, component);
  return normalize(canonical);
}

export function isPathWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && pathFromParent !== "..");
}

export function pathsOverlap(first: string, second: string): boolean {
  return isPathWithin(first, second) || isPathWithin(second, first);
}

function uniqueCanonicalPaths(paths: string[], label: string, mustBeDirectory: boolean): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const input of paths) {
    const canonical = canonicalizeExistingPath(input, label);
    if (mustBeDirectory && !statSync(canonical).isDirectory()) {
      throw new ConfigError(`${label} must be a directory: ${input}`);
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result;
}

function validatePrivateLocations(
  stateDir: string,
  workspaceRoots: string[],
  sources: Partial<Record<Agent, string[]>>,
  repositories: RepositoryConfig[],
  historicalWorkspaces: HistoricalWorkspaceConfig[],
): void {
  const sourcePaths = AGENTS.flatMap((agent) => sources[agent] ?? []);
  const protectedPaths = [
    ...workspaceRoots,
    ...repositories.map((repository) => repository.path),
    ...sourcePaths,
    ...historicalWorkspaces.map((workspace) => workspace.path),
  ];
  for (const protectedPath of protectedPaths) {
    if (pathsOverlap(stateDir, protectedPath)) {
      throw new ConfigError(`State directory overlaps protected source, repository, or historical path: ${protectedPath}`);
    }
  }
  for (const historical of historicalWorkspaces) {
    for (const sourcePath of sourcePaths) {
      if (pathsOverlap(historical.path, sourcePath)) {
        throw new ConfigError(`Historical workspace overlaps private source path: ${historical.path}`);
      }
    }
  }
}

function canonicalizeConfig(config: Config): Config {
  const workspaceRoots = uniqueCanonicalPaths(config.workspaceRoots, "workspace root", true);
  const stateDir = canonicalizePotentialPath(config.stateDir, "state directory");
  const sources: Partial<Record<Agent, string[]>> = {};

  for (const agent of AGENTS) {
    if (!Object.prototype.hasOwnProperty.call(config.sources, agent)) continue;
    const configured = config.sources[agent] ?? [];
    sources[agent] = configured.map((sourcePath) => canonicalizePotentialPath(sourcePath, `${agent} source path`));
  }

  const repositories = config.repositories.map((repository) => {
    const canonicalPath = canonicalizePotentialPath(repository.path, "repository path");
    return repository.defaultBranch === undefined
      ? { path: canonicalPath, remote: repository.remote }
      : { path: canonicalPath, remote: repository.remote, defaultBranch: repository.defaultBranch };
  });

  const historicalWorkspaces = (config.historicalWorkspaces ?? []).map((historical) => ({
    path: canonicalizePotentialPath(historical.path, "historical workspace path"),
    repositoryPath: canonicalizePotentialPath(historical.repositoryPath, "historical repository path"),
    match: historical.match,
  }));
  const includedRepositoryPaths = [
    ...workspaceRoots,
    ...repositories.map((repository) => repository.path),
  ];
  for (const historical of historicalWorkspaces) {
    if (!includedRepositoryPaths.some((included) =>
      isPathWithin(included, historical.repositoryPath) || isPathWithin(historical.repositoryPath, included))) {
      throw new ConfigError(`Historical workspace has no included repository target: ${historical.repositoryPath}`);
    }
  }
  for (let index = 0; index < historicalWorkspaces.length; index += 1) {
    const current = historicalWorkspaces[index]!;
    for (const other of historicalWorkspaces.slice(index + 1)) {
      const overlap =
        (current.match === "descendants" && isPathWithin(current.path, other.path)) ||
        (other.match === "descendants" && isPathWithin(other.path, current.path)) ||
        current.path === other.path;
      if (overlap) throw new ConfigError(`Ambiguous historical workspace mappings overlap: ${current.path} and ${other.path}`);
    }
  }

  validatePrivateLocations(stateDir, workspaceRoots, sources, repositories, historicalWorkspaces);
  return {
    version: 1,
    companyName: config.companyName ?? "Komodo Risk Inc",
    workspaceRoots,
    timezone: config.timezone,
    stateDir,
    sources,
    repositories,
    historicalWorkspaces,
    publication: { repository: config.publication.repository, branch: "main" },
  };
}

export function loadConfig(configPath?: string): Config {
  const resolvedPath = resolveConfigPath(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new ConfigError(`Cannot read configuration at ${resolvedPath}: ${detail}`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`Invalid configuration at ${resolvedPath}: ${z.prettifyError(parsed.error)}`);
  return configSchema.parse(canonicalizeConfig(parsed.data));
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!statSync(path).isDirectory()) throw new ConfigError(`Private path is not a directory: ${path}`);
  chmodSync(path, 0o700);
}

function ensureConfigParent(path: string, owned: boolean): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  } else if (!statSync(parent).isDirectory()) {
    throw new ConfigError(`Configuration parent is not a directory: ${parent}`);
  } else if (owned) {
    chmodSync(parent, 0o700);
  }
}

export function initializeConfig(input: InitializeConfigInput): { configPath: string; config: Config } {
  const configPath = resolveConfigPath(input.configPath);
  if (pathEntryExists(configPath)) throw new ConfigError(`Configuration already exists: ${configPath}`);
  if (input.workspaceRoots.length === 0) throw new ConfigError("At least one workspace root is required");
  if (!isValidGitHubRepository(input.pagesRepository)) {
    throw new ConfigError("Pages repository must use owner/repository syntax");
  }

  const workspaceRoots = uniqueCanonicalPaths(input.workspaceRoots, "workspace root", true);
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timezone || !isValidIanaTimezone(timezone)) throw new ConfigError(`Invalid IANA timezone: ${timezone || "(empty)"}`);
  const stateDir = canonicalizePotentialPath(input.stateDir ?? getDefaultStateDir(), "state directory");
  validatePrivateLocations(stateDir, workspaceRoots, {}, [], []);

  const config: Config = {
    version: 1,
    companyName: input.companyName ?? "Komodo Risk Inc",
    workspaceRoots,
    timezone,
    stateDir,
    sources: {},
    repositories: [],
    historicalWorkspaces: [],
    publication: { repository: input.pagesRepository, branch: "main" },
  };
  configSchema.parse(config);

  ensureConfigParent(configPath, input.configPath === undefined);
  ensurePrivateDirectory(stateDir);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(configPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8" });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (pathEntryExists(configPath)) throw new ConfigError(`Configuration already exists: ${configPath}`);
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new ConfigError(`Cannot write configuration at ${configPath}: ${detail}`);
  }
  closeSync(descriptor);
  chmodSync(configPath, 0o600);
  return { configPath, config };
}

export function configuredSourcePaths(
  config: Config,
  agent: Agent,
  conventionalPaths: readonly string[],
): readonly string[] {
  if (Object.prototype.hasOwnProperty.call(config.sources, agent)) return config.sources[agent] ?? [];
  return conventionalPaths;
}

export function validateOutputPath(config: Config, outputPath: string): string {
  const canonicalOutput = canonicalizePotentialPath(outputPath, "output directory");
  const protectedPaths = [
    ...config.workspaceRoots,
    ...config.repositories.map((repository) => repository.path),
    ...AGENTS.flatMap((agent) => config.sources[agent] ?? []),
  ];
  for (const protectedPath of protectedPaths) {
    if (pathsOverlap(canonicalOutput, protectedPath)) {
      throw new ConfigError(`Output directory overlaps protected source or repository path: ${protectedPath}`);
    }
  }
  return canonicalOutput;
}
