import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  configSchema,
  configuredSourcePaths,
  initializeConfig,
  loadConfig,
  validateOutputPath,
} from "../src/config";
import { publicSnapshotSchema, sanitizePublicLabel } from "../src/contracts";
import { PRICING_METADATA } from "../src/pricing";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vito-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixturePaths() {
  const root = temporaryDirectory();
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  return {
    root,
    workspace,
    configPath: join(root, "private", "config.json"),
    stateDir: join(root, "state"),
  };
}

describe("configuration initialization", () => {
  test("writes canonical private configuration once", () => {
    const paths = fixturePaths();
    const initialized = initializeConfig({
      configPath: paths.configPath,
      companyName: "Komodo",
      workspaceRoots: [paths.workspace],
      pagesRepository: "agent-native/activity",
      timezone: "America/New_York",
      stateDir: paths.stateDir,
    });

    expect(initialized.config.companyName).toBe("Komodo");
    expect(initialized.config.workspaceRoots).toEqual([realpathSync(paths.workspace)]);
    expect(initialized.config.sources).toEqual({});
    expect(statSync(paths.configPath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
    expect(loadConfig(paths.configPath)).toEqual(initialized.config);

    expect(() =>
      initializeConfig({
        configPath: paths.configPath,
        workspaceRoots: [paths.workspace],
        pagesRepository: "agent-native/activity",
        stateDir: paths.stateDir,
      }),
    ).toThrow(ConfigError);
    expect(JSON.parse(readFileSync(paths.configPath, "utf8"))).toEqual(initialized.config);
  });

  test("rejects relative and missing workspace paths", () => {
    const paths = fixturePaths();
    expect(() =>
      initializeConfig({
        configPath: paths.configPath,
        workspaceRoots: ["relative/workspace"],
        pagesRepository: "agent-native/activity",
        stateDir: paths.stateDir,
      }),
    ).toThrow("workspace root must be absolute");

    expect(() =>
      initializeConfig({
        configPath: paths.configPath,
        workspaceRoots: [join(paths.root, "missing")],
        pagesRepository: "agent-native/activity",
        stateDir: paths.stateDir,
      }),
    ).toThrow("does not exist");

    expect(() =>
      initializeConfig({
        configPath: "relative-config.json",
        workspaceRoots: [paths.workspace],
        pagesRepository: "agent-native/activity",
        stateDir: paths.stateDir,
      }),
    ).toThrow("Configuration path must be absolute");
  });

  test("rejects invalid timezone and destination repository syntax", () => {
    const paths = fixturePaths();
    expect(() =>
      initializeConfig({
        configPath: paths.configPath,
        workspaceRoots: [paths.workspace],
        pagesRepository: "not-a-repository",
        stateDir: paths.stateDir,
      }),
    ).toThrow("owner/repository");

    expect(() =>
      initializeConfig({
        configPath: paths.configPath,
        workspaceRoots: [paths.workspace],
        pagesRepository: "agent-native/activity",
        timezone: "Mars/Olympus_Mons",
        stateDir: paths.stateDir,
      }),
    ).toThrow("Invalid IANA timezone");
  });

  test("rejects state and output paths that overlap protected trees", () => {
    const paths = fixturePaths();
    expect(() =>
      initializeConfig({
        configPath: paths.configPath,
        workspaceRoots: [paths.workspace],
        pagesRepository: "agent-native/activity",
        stateDir: join(paths.workspace, ".vito"),
      }),
    ).toThrow("overlaps protected");

    const initialized = initializeConfig({
      configPath: paths.configPath,
      workspaceRoots: [paths.workspace],
      pagesRepository: "agent-native/activity",
      stateDir: paths.stateDir,
    });
    expect(() => validateOutputPath(initialized.config, join(paths.workspace, "public"))).toThrow("overlaps protected");
    expect(validateOutputPath(initialized.config, join(paths.stateDir, "export"))).toBe(
      join(realpathSync(paths.stateDir), "export"),
    );
  });

  test("rejects a loaded state directory that overlaps an explicit source", () => {
    const paths = fixturePaths();
    const initialized = initializeConfig({
      configPath: paths.configPath,
      workspaceRoots: [paths.workspace],
      pagesRepository: "agent-native/activity",
      stateDir: paths.stateDir,
    });
    const unsafe = { ...initialized.config, sources: { codex: [join(paths.stateDir, "source")] } };
    writeFileSync(paths.configPath, `${JSON.stringify(unsafe)}\n`);
    chmodSync(paths.configPath, 0o600);
    expect(() => loadConfig(paths.configPath)).toThrow("overlaps protected");
  });

  test("distinguishes absent source configuration from an explicit empty list", () => {
    const paths = fixturePaths();
    const initialized = initializeConfig({
      configPath: paths.configPath,
      workspaceRoots: [paths.workspace],
      pagesRepository: "agent-native/activity",
      stateDir: paths.stateDir,
    });
    expect(configuredSourcePaths(initialized.config, "codex", ["/conventional/codex"])).toEqual([
      "/conventional/codex",
    ]);

    const explicit = { ...initialized.config, sources: { codex: [] } };
    writeFileSync(paths.configPath, `${JSON.stringify(explicit)}\n`, { mode: 0o600 });
    chmodSync(paths.configPath, 0o600);
    expect(configuredSourcePaths(loadConfig(paths.configPath), "codex", ["/conventional/codex"])).toEqual([]);
  });

  test("strictly rejects unknown configuration fields", () => {
    const paths = fixturePaths();
    const candidate = {
      version: 1,
      workspaceRoots: [paths.workspace],
      timezone: "UTC",
      stateDir: paths.stateDir,
      sources: { codex: [], hidden: [] },
      repositories: [],
      publication: { repository: "agent-native/activity", branch: "main" },
    };
    expect(configSchema.safeParse(candidate).success).toBe(false);
  });

  test("canonicalizes explicit historical mappings and rejects ambiguous or private roots", () => {
    const paths = fixturePaths();
    mkdirSync(join(paths.root, "private"), { recursive: true });
    const repository = join(paths.workspace, "repository");
    const historical = join(paths.root, "historical", "deleted");
    mkdirSync(repository, { recursive: true });
    const candidate = {
      version: 1 as const,
      workspaceRoots: [paths.workspace],
      timezone: "UTC",
      stateDir: paths.stateDir,
      sources: { codex: [] },
      repositories: [],
      historicalWorkspaces: [{
        path: historical,
        repositoryPath: repository,
        match: "descendants" as const,
      }],
      publication: { repository: "agent-native/activity", branch: "main" as const },
    };
    writeFileSync(paths.configPath, `${JSON.stringify(candidate)}\n`, { mode: 0o600 });
    const loaded = loadConfig(paths.configPath);
    expect(loaded.companyName).toBe("Agent Native");
    expect(loaded.historicalWorkspaces).toEqual([{
      path: join(realpathSync(paths.root), "historical", "deleted"),
      repositoryPath: realpathSync(repository),
      match: "descendants",
    }]);

    const ambiguous = {
      ...candidate,
      historicalWorkspaces: [
        ...candidate.historicalWorkspaces,
        { path: join(historical, "one"), repositoryPath: repository, match: "exact" as const },
      ],
    };
    writeFileSync(paths.configPath, `${JSON.stringify(ambiguous)}\n`, { mode: 0o600 });
    expect(() => loadConfig(paths.configPath)).toThrow("Ambiguous historical workspace mappings");

    const privateRoot = {
      ...candidate,
      historicalWorkspaces: [{
        path: join(paths.root, "private-source"),
        repositoryPath: repository,
        match: "descendants" as const,
      }],
      sources: { codex: [join(paths.root, "private-source")] },
    };
    writeFileSync(paths.configPath, `${JSON.stringify(privateRoot)}\n`, { mode: 0o600 });
    expect(() => loadConfig(paths.configPath)).toThrow("overlaps private source");
  });
});

describe("public contract safety", () => {
  const snapshot = {
    schemaVersion: 3 as const,
    pricing: { ...PRICING_METADATA, sources: [...PRICING_METADATA.sources] },
    organization: "Agent Native" as const,
    timezone: "UTC",
    generatedAt: "2026-09-06T12:00:00.000Z",
    cutoff: "2026-09-06T12:00:00.000Z",
    periodStart: "2026-09-06",
    periodEnd: "2026-09-06",
    collectionStatus: "ok" as const,
    sources: [
      {
        agent: "codex",
        state: "available" as const,
        tokens: "recorded" as const,
        work: "partial" as const,
        reasons: ["timing-unavailable" as const],
      },
    ],
    coverage: {
      unallocatedUsageRecords: 0,
      excludedAmbiguousRecords: 0,
      scopeStatus: "recorded" as const,
      undated: { byHarness: [] },
    },
    days: [],
  };

  test("rejects private extras and unknown nested fields", () => {
    expect(publicSnapshotSchema.safeParse({ ...snapshot, schemaVersion: 1 }).success).toBe(false);
    expect(publicSnapshotSchema.safeParse({ ...snapshot, pricing: undefined }).success).toBe(false);
    expect(publicSnapshotSchema.safeParse({
      ...snapshot,
      pricing: { ...snapshot.pricing, sources: ["http://pricing.example/rates"] },
    }).success).toBe(false);
    expect(publicSnapshotSchema.safeParse({ ...snapshot, workspacePath: "/private/work" }).success).toBe(false);
    expect(
      publicSnapshotSchema.safeParse({
        ...snapshot,
        sources: [{ ...snapshot.sources[0], sourcePath: "/private/transcript.jsonl" }],
      }).success,
    ).toBe(false);
  });

  test("rejects nonfinite public numbers", () => {
    expect(
      publicSnapshotSchema.safeParse({
        ...snapshot,
        coverage: { ...snapshot.coverage, unallocatedUsageRecords: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
  });

  test("sanitizes unsafe provider and model labels", () => {
    expect(sanitizePublicLabel("openai/gpt-5.6")).toBe("openai/gpt-5.6");
    expect(sanitizePublicLabel("https://private.example/model")).toBe("unknown");
    expect(sanitizePublicLabel("sk-secret-value")).toBe("unknown");
    expect(sanitizePublicLabel("<img src=x onerror=alert(1)>")).toBe("unknown");
    expect(sanitizePublicLabel("x".repeat(129))).toBe("unknown");
  });
});
