import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

import type { Config } from "./config";
import { canonicalizePotentialPath, pathsOverlap } from "./config";
import type { PublicSnapshot } from "./contracts";
import { publicSnapshotSchema } from "./contracts";
import { buildPublicSnapshot } from "./metrics";
import type { CollectorStore } from "./store";

export const STATIC_ASSET_FILES = [".nojekyll", "index.html", "widget.html", "widget.js", "styles.css"] as const;
export const EXPORT_FILES = [...STATIC_ASSET_FILES, "activity.json"] as const;
export const EXPORT_OWNERSHIP_FILE = "export-paths.json";

const BUILT_ASSET_FILES = ["index.html", "widget.html", "widget.js", "styles.css"] as const;
const OWNERSHIP_SCHEMA_VERSION = 1;

type SnapshotBuilder = (config: Config, store: CollectorStore, cutoffMs: number) => PublicSnapshot;

export interface ExportOptions {
  outDir: string;
  at?: string | number | Date;
  assetsDir?: string;
  buildSnapshot?: SnapshotBuilder;
}
export interface ExportResult {
  outDir: string;
  snapshot: PublicSnapshot;
  files: readonly string[];
}

interface ExportOwnership {
  schemaVersion: 1;
  paths: string[];
}

export class ExportError extends Error {
  override readonly name = "ExportError";
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function fail(message: string): never {
  throw new ExportError(message);
}

function cutoffMilliseconds(at: ExportOptions["at"]): number {
  const value = at === undefined ? Date.now() : at instanceof Date ? at.valueOf() : typeof at === "number" ? at : Date.parse(at);
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).valueOf())) {
    fail("Export cutoff must be a finite nonnegative millisecond instant");
  }
  return value;
}

function assertRegularFile(path: string, label: string): void {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file: ${path}`);
}

function assertDirectory(path: string, label: string): void {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`${label} must be a real directory: ${path}`);
}

function protectedOutputPaths(config: Config): string[] {
  return [
    ...config.workspaceRoots,
    ...config.repositories.map((repository) => repository.path),
    ...(config.historicalWorkspaces ?? []).map((workspace) => workspace.path),
    ...Object.values(config.sources).flatMap((paths) => paths ?? []),
  ].map((path) => canonicalizePotentialPath(path, "protected source or repository path"));
}

function assertOutsideProtectedPaths(candidate: string, protectedPaths: readonly string[]): void {
  for (const protectedPath of protectedPaths) {
    if (pathsOverlap(candidate, protectedPath)) {
      fail(`Output directory overlaps protected source or repository path: ${protectedPath}`);
    }
  }
}

function ensureParentDirectory(path: string): void {
  const parent = dirname(path);
  if (!pathExists(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertDirectory(parent, "Export parent");
}

function isAbsoluteStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string" && isAbsolute(entry));
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownershipPath(config: Config): string {
  return join(config.stateDir, EXPORT_OWNERSHIP_FILE);
}

function readOwnership(config: Config): ExportOwnership {
  const path = ownershipPath(config);
  if (!pathExists(path)) return { schemaVersion: 1, paths: [] };
  assertRegularFile(path, "Export ownership registry");

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    fail(`Cannot read export ownership registry: ${detail}`);
  }
  if (!isUnknownRecord(value)) fail("Invalid export ownership registry");
  const record = value;
  const ownershipPaths = record.paths;
  if (
    Object.keys(record).sort().join(",") !== "paths,schemaVersion" ||
    record.schemaVersion !== OWNERSHIP_SCHEMA_VERSION ||
    !isAbsoluteStringArray(ownershipPaths)
  ) {
    fail("Invalid export ownership registry");
  }
  const paths = [...new Set(ownershipPaths)].sort();
  if (paths.length !== ownershipPaths.length || paths.some((entry, index) => entry !== ownershipPaths[index])) {
    fail("Export ownership registry paths must be unique and sorted");
  }
  return { schemaVersion: 1, paths };
}

function writeOwnership(config: Config, ownership: ExportOwnership): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDir, 0o700);
  const path = ownershipPath(config);
  if (pathExists(path)) assertRegularFile(path, "Export ownership registry");
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(ownership, null, 2)}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function canonicalOutput(config: Config, input: string): string {
  if (!isAbsolute(input)) fail("Export directory must be absolute");
  const protectedPaths = protectedOutputPaths(config);
  const candidate = canonicalizePotentialPath(normalize(input), "output directory");
  assertOutsideProtectedPaths(candidate, protectedPaths);
  ensureParentDirectory(candidate);
  const canonical = canonicalizePotentialPath(candidate, "output directory");
  assertOutsideProtectedPaths(canonical, protectedPaths);
  return canonical;
}

function canonicalAssetsDirectory(input: string): string {
  const path = realpathSync(input);
  assertDirectory(path, "Built asset directory");
  return path;
}

function assertExactManifest(directory: string): void {
  assertDirectory(directory, "Export directory");
  const actual = readdirSync(directory).sort();
  const expected = [...EXPORT_FILES].sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    fail(`Export directory has unexpected contents; expected exactly ${expected.join(", ")}`);
  }
  for (const file of EXPORT_FILES) assertRegularFile(join(directory, file), `Export asset ${file}`);
}

function validateSnapshot(snapshot: unknown, expectedInstant: string): PublicSnapshot {
  const result = publicSnapshotSchema.safeParse(snapshot);
  if (!result.success) fail(`Public snapshot validation failed: ${result.error.message}`);
  if (result.data.cutoff !== expectedInstant || result.data.generatedAt !== expectedInstant) {
    fail("Public snapshot cutoff and generatedAt must equal the export cutoff");
  }
  return result.data;
}

function privateStrings(config: Config, store: CollectorStore): string[] {
  return [
    config.stateDir,
    store.path,
    ...config.workspaceRoots,
    ...config.repositories.map((repository) => repository.path),
    ...(config.historicalWorkspaces ?? []).map((workspace) => workspace.path),
    ...Object.values(config.sources).flatMap((paths) => paths ?? []),
  ].filter((value, index, values) => value.length > 1 && values.indexOf(value) === index);
}

function assertNoPrivateStrings(content: string, config: Config, store: CollectorStore): void {
  for (const value of privateStrings(config, store)) {
    if (content.includes(value) || content.includes(JSON.stringify(value).slice(1, -1))) {
      fail("Public snapshot contains a private configured path");
    }
  }
}

function stageExport(
  stagingDirectory: string,
  assetsDirectory: string,
  snapshot: PublicSnapshot,
  config: Config,
  store: CollectorStore,
): void {
  for (const file of BUILT_ASSET_FILES) {
    const source = join(assetsDirectory, file);
    assertRegularFile(source, `Built asset ${file}`);
    copyFileSync(source, join(stagingDirectory, file), constants.COPYFILE_EXCL);
    chmodSync(join(stagingDirectory, file), 0o644);
  }

  const widgetSource = readFileSync(join(stagingDirectory, "widget.js"), "utf8");
  if (/\bsourceMappingURL\s*=/.test(widgetSource)) fail("Built widget.js must not reference a source map");

  writeFileSync(join(stagingDirectory, ".nojekyll"), "", { encoding: "utf8", flag: "wx", mode: 0o644 });
  chmodSync(join(stagingDirectory, ".nojekyll"), 0o644);
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  assertNoPrivateStrings(serialized, config, store);
  writeFileSync(join(stagingDirectory, "activity.json"), serialized, { encoding: "utf8", flag: "wx", mode: 0o644 });
  chmodSync(join(stagingDirectory, "activity.json"), 0o644);

  assertExactManifest(stagingDirectory);
  const reparsed = JSON.parse(readFileSync(join(stagingDirectory, "activity.json"), "utf8"));
  const validated = publicSnapshotSchema.safeParse(reparsed);
  if (!validated.success) fail(`Staged activity.json failed validation: ${validated.error.message}`);
  for (const file of EXPORT_FILES) {
    const content = readFileSync(join(stagingDirectory, file), "utf8");
    assertNoPrivateStrings(content, config, store);
  }
}

function replaceOwnedExport(stagingDirectory: string, outputDirectory: string): void {
  assertExactManifest(outputDirectory);
  for (const file of STATIC_ASSET_FILES) renameSync(join(stagingDirectory, file), join(outputDirectory, file));
  renameSync(join(stagingDirectory, "activity.json"), join(outputDirectory, "activity.json"));
  assertExactManifest(outputDirectory);
}

export function exportStaticSite(config: Config, store: CollectorStore, options: ExportOptions): ExportResult {
  const cutoffMs = cutoffMilliseconds(options.at);
  const expectedInstant = new Date(cutoffMs).toISOString();
  const outputDirectory = canonicalOutput(config, options.outDir);
  const assetsDirectory = canonicalAssetsDirectory(options.assetsDir ?? resolve(import.meta.dir, "..", "dist", "web"));
  const ownership = readOwnership(config);
  const existing = pathExists(outputDirectory);
  const owned = ownership.paths.includes(outputDirectory);

  if (existing && !owned) fail(`Refusing to overwrite an export directory not owned by Vito: ${outputDirectory}`);
  if (!existing && owned) fail(`Owned export directory is missing; remove its private ownership entry before reusing the path: ${outputDirectory}`);
  if (existing) {
    assertDirectory(outputDirectory, "Owned export directory");
    if (realpathSync(outputDirectory) !== outputDirectory) fail("Owned export directory no longer resolves to its recorded path");
    assertExactManifest(outputDirectory);
  }

  const snapshot = validateSnapshot((options.buildSnapshot ?? buildPublicSnapshot)(config, store, cutoffMs), expectedInstant);
  const stagingDirectory = mkdtempSync(join(dirname(outputDirectory), `.${basename(outputDirectory)}.vito-stage-`));
  chmodSync(stagingDirectory, 0o700);

  try {
    stageExport(stagingDirectory, assetsDirectory, snapshot, config, store);
    if (existing) {
      replaceOwnedExport(stagingDirectory, outputDirectory);
      rmSync(stagingDirectory, { recursive: true });
    } else {
      const nextOwnership: ExportOwnership = {
        schemaVersion: 1,
        paths: [...ownership.paths, outputDirectory].sort(),
      };
      writeOwnership(config, nextOwnership);
      try {
        renameSync(stagingDirectory, outputDirectory);
      } catch (error) {
        writeOwnership(config, ownership);
        throw error;
      }
      chmodSync(outputDirectory, 0o755);
    }
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return { outDir: outputDirectory, snapshot, files: EXPORT_FILES };
}

export function resolveExportAsset(directory: string, file: string): string {
  if (!(EXPORT_FILES as readonly string[]).includes(file)) fail(`Unsupported export asset: ${file}`);
  const root = realpathSync(directory);
  const candidate = realpathSync(join(root, file));
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    fail(`Export asset escapes its directory: ${file}`);
  }
  assertRegularFile(candidate, `Export asset ${file}`);
  return candidate;
}
