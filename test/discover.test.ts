import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { Agent } from "../src/contracts";
import {
  discoverInventorySources,
  discoverSources,
  formatDiscoveryOutput,
} from "../src/discover";
import type { DiscoveryEntry, SourceAdapter } from "../src/sources/types";

const temporaryDirectories: string[] = [];
const accountingAgents: Agent[] = ["codex", "claude", "omp", "opencode", "hermes"];

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "vito-discover-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureConfig(root: string, sources: Config["sources"]): Config {
  return {
    version: 1,
    workspaceRoots: [join(root, "workspace")],
    timezone: "UTC",
    stateDir: join(root, "state"),
    sources,
    repositories: [],
    publication: { repository: "komodorisk/activity", branch: "main" },
  };
}

function discoveryEntry(
  agent: Agent,
  state: DiscoveryEntry["state"],
  paths: string[],
): DiscoveryEntry {
  return {
    agent,
    state,
    capabilities:
      state === "available"
        ? { tokens: "recorded", work: agent === "claude" || agent === "hermes" ? "unavailable" : "recorded" }
        : { tokens: "unavailable", work: "unavailable" },
    paths,
    diagnosticCounts: { recognizedPaths: paths.length },
    reasons: state === "available" ? [] : ["missing-source"],
  };
}

function fixtureAdapter(agent: Agent, conventionalPath: string): SourceAdapter {
  return {
    agent,
    async discover(config) {
      const hasOverride = config !== undefined && Object.prototype.hasOwnProperty.call(config.sources, agent);
      const paths = hasOverride ? (config.sources[agent] ?? []) : [conventionalPath];
      return [discoveryEntry(agent, paths.length > 0 ? "available" : "not-found", paths)];
    },
    async collect() {
      throw new Error("Collection is outside discovery tests");
    },
  };
}

function fixtureAdapters(home: string): SourceAdapter[] {
  return accountingAgents.map((agent) => fixtureAdapter(agent, join(home, "accounting", agent)));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("metadata-only source discovery", () => {
  test("enumerates accounting adapters and inventory-only tools in deterministic order", async () => {
    const home = temporaryHome();
    const kimiExecutable = join(home, ".kimi-code", "bin", "kimi");
    const grokPersistence = join(home, "Library", "Application Support", "Grok Bot", "sand-client-persistence");
    mkdirSync(join(home, ".kimi-code", "bin"), { recursive: true });
    mkdirSync(grokPersistence, { recursive: true });
    writeFileSync(kimiExecutable, "DO_NOT_PRINT_SECRET_SENTINEL");
    writeFileSync(join(grokPersistence, "z.blob"), "DO_NOT_PRINT_SECRET_SENTINEL");
    writeFileSync(join(grokPersistence, "a.blob"), "DO_NOT_PRINT_SECRET_SENTINEL");

    const entries = await discoverSources(undefined, { homeDir: home, adapters: fixtureAdapters(home) });

    expect(entries.map((entry) => entry.agent)).toEqual([
      "codex",
      "claude",
      "omp",
      "opencode",
      "hermes",
      "kimi",
      "grok",
    ]);
    expect(entries.map((entry) => entry.state)).toEqual([
      "available",
      "available",
      "available",
      "available",
      "available",
      "installed-no-history",
      "unsupported-schema",
    ]);
    expect(entries.find((entry) => entry.agent === "claude")?.capabilities).toEqual({
      tokens: "recorded",
      work: "unavailable",
    });
    expect(entries.find((entry) => entry.agent === "grok")?.paths).toEqual([
      join(grokPersistence, "a.blob"),
      join(grokPersistence, "z.blob"),
    ]);

    const output = formatDiscoveryOutput(entries);
    expect(output).toContain('"unsupportedFiles": 2');
    expect(output).not.toContain("DO_NOT_PRINT_SECRET_SENTINEL");
    expect(await discoverSources(undefined, { homeDir: home, adapters: fixtureAdapters(home) })).toEqual(entries);
  });

  test("distinguishes an absent inventory source from an installed unsupported schema", () => {
    const absentHome = temporaryHome();
    expect(discoverInventorySources(absentHome).map(({ agent, state }) => [agent, state])).toEqual([
      ["kimi", "not-found"],
      ["grok", "not-found"],
    ]);

    const installedHome = temporaryHome();
    const persistence = join(
      installedHome,
      "Library",
      "Application Support",
      "Grok Bot",
      "sand-client-persistence",
    );
    mkdirSync(persistence, { recursive: true });
    writeFileSync(join(persistence, "history.blob"), "synthetic transcript body that discovery must not read");

    expect(discoverInventorySources(installedHome).find((entry) => entry.agent === "grok")).toMatchObject({
      state: "unsupported-schema",
      capabilities: { tokens: "unavailable", work: "unavailable" },
      diagnosticCounts: { recognizedPaths: 1, unsupportedFiles: 1 },
    });
  });

  test("passes config unchanged so explicit roots replace defaults and empty lists disable adapters", async () => {
    const home = temporaryHome();
    const codexOverride = join(home, "configured", "codex.jsonl");
    const config = fixtureConfig(home, {
      codex: [codexOverride],
      claude: [],
    });

    const entries = await discoverSources(config, { homeDir: home, adapters: fixtureAdapters(home) });
    expect(entries.find((entry) => entry.agent === "codex")).toMatchObject({
      state: "available",
      paths: [codexOverride],
      diagnosticCounts: { recognizedPaths: 1 },
    });
    expect(entries.find((entry) => entry.agent === "claude")).toMatchObject({
      state: "not-found",
      paths: [],
      diagnosticCounts: { recognizedPaths: 0 },
    });
    expect(entries.find((entry) => entry.agent === "omp")?.paths).toEqual([
      join(home, "accounting", "omp"),
    ]);
    expect(entries.find((entry) => entry.agent === "codex")?.paths).not.toContain(
      join(home, "accounting", "codex"),
    );
  });

  test("contains adapter discovery failures without leaking raw error text", async () => {
    const home = temporaryHome();
    const failing = fixtureAdapter("codex", join(home, "codex"));
    failing.discover = async () => {
      throw new Error("DO_NOT_PRINT_SECRET_SENTINEL");
    };

    const entries = await discoverSources(undefined, { homeDir: home, adapters: [failing] });
    expect(entries[0]).toEqual({
      agent: "codex",
      state: "partial",
      capabilities: { tokens: "unavailable", work: "unavailable" },
      paths: [],
      diagnosticCounts: { discoveryErrors: 1 },
      reasons: ["parse-gap"],
    });
    expect(formatDiscoveryOutput(entries)).not.toContain("DO_NOT_PRINT_SECRET_SENTINEL");
  });
});
