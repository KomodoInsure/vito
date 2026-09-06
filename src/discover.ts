import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { claudeAdapter } from "./sources/claude";
import { codexAdapter } from "./sources/codex";
import { hermesAdapter } from "./sources/hermes";
import { ompAdapter } from "./sources/omp";
import { opencodeAdapter } from "./sources/opencode";
import type { DiscoveryEntry, SourceAdapter } from "./sources/types";

const ACCOUNTING_ADAPTERS: readonly SourceAdapter[] = [
  codexAdapter,
  claudeAdapter,
  ompAdapter,
  opencodeAdapter,
  hermesAdapter,
];

const SOURCE_ORDER: Readonly<Record<string, number>> = {
  codex: 0,
  claude: 1,
  omp: 2,
  opencode: 3,
  hermes: 4,
  blume: 5,
  kimi: 6,
  grok: 7,
};

export interface DiscoveryOptions {
  /** Test seam for conventional inventory-only locations. */
  homeDir?: string;
  /** Test seam for adapter orchestration; production uses the five built-in adapters. */
  adapters?: readonly SourceAdapter[];
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function unavailableInventoryEntry(
  agent: string,
  state: DiscoveryEntry["state"],
  paths: string[],
  diagnosticCounts: Record<string, number>,
  reasons: string[],
): DiscoveryEntry {
  return {
    agent,
    state,
    capabilities: { tokens: "unavailable", work: "unavailable" },
    paths,
    diagnosticCounts,
    reasons,
  };
}

function missingInventoryEntry(agent: string): DiscoveryEntry {
  return unavailableInventoryEntry(agent, "not-found", [], { recognizedPaths: 0 }, ["missing-source"]);
}

/**
 * Inspect only names and filesystem metadata for inventory-only tools. No source
 * file is opened here: these tools either duplicate supported ledgers or do not
 * expose the accounting and timing fields required by Vito.
 */
export function discoverInventorySources(homeDir = homedir()): DiscoveryEntry[] {
  const blumeDatabase = join(homeDir, ".blume", "blume.sqlite");
  const kimiExecutable = join(homeDir, ".kimi-code", "bin", "kimi");
  const grokRoot = join(homeDir, "Library", "Application Support", "Grok Bot");
  const grokPersistence = join(grokRoot, "sand-client-persistence");

  const blume = pathExists(blumeDatabase)
    ? unavailableInventoryEntry(
        "blume",
        "excluded-wrapper",
        [blumeDatabase],
        { excludedStores: 1, recognizedPaths: 1 },
        ["upstream-owned"],
      )
    : missingInventoryEntry("blume");

  const kimi = pathExists(kimiExecutable)
    ? unavailableInventoryEntry(
        "kimi",
        "installed-no-history",
        [kimiExecutable],
        { recognizedPaths: 1 },
        ["missing-source"],
      )
    : missingInventoryEntry("kimi");

  let grokBlobPaths: string[] = [];
  if (pathExists(grokPersistence)) {
    try {
      grokBlobPaths = readdirSync(grokPersistence, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".blob"))
        .map((entry) => join(grokPersistence, entry.name))
        .sort((left, right) => left.localeCompare(right));
    } catch {
      return [
        blume,
        kimi,
        unavailableInventoryEntry(
          "grok",
          "partial",
          [grokPersistence],
          { inventoryErrors: 1, recognizedPaths: 0 },
          ["parse-gap"],
        ),
      ];
    }
  }

  const grok =
    grokBlobPaths.length > 0
      ? unavailableInventoryEntry(
          "grok",
          "unsupported-schema",
          grokBlobPaths,
          { recognizedPaths: grokBlobPaths.length, unsupportedFiles: grokBlobPaths.length },
          ["unsupported-schema"],
        )
      : pathExists(grokRoot)
        ? unavailableInventoryEntry(
            "grok",
            "installed-no-history",
            [grokRoot],
            { recognizedPaths: 0 },
            ["missing-source"],
          )
        : missingInventoryEntry("grok");

  return [blume, kimi, grok];
}

function normalizeEntry(entry: DiscoveryEntry): DiscoveryEntry {
  const diagnosticCounts = Object.fromEntries(
    Object.entries(entry.diagnosticCounts).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    agent: entry.agent,
    state: entry.state,
    capabilities: {
      tokens: entry.capabilities.tokens,
      work: entry.capabilities.work,
    },
    paths: [...new Set(entry.paths)].sort((left, right) => left.localeCompare(right)),
    diagnosticCounts,
    reasons: [...new Set(entry.reasons)].sort((left, right) => left.localeCompare(right)),
  };
}

function discoveryFailure(adapter: SourceAdapter): DiscoveryEntry {
  return {
    agent: adapter.agent,
    state: "partial",
    capabilities: { tokens: "unavailable", work: "unavailable" },
    paths: [],
    diagnosticCounts: { discoveryErrors: 1 },
    reasons: ["parse-gap"],
  };
}

/** Aggregate accounting and inventory discovery without requiring company configuration. */
export async function discoverSources(
  config?: Config,
  options: DiscoveryOptions = {},
): Promise<DiscoveryEntry[]> {
  const adapters = options.adapters ?? ACCOUNTING_ADAPTERS;
  const accountingResults = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return await adapter.discover(config);
      } catch {
        // Raw exceptions can contain private paths or source values. Discovery
        // reports only a bounded diagnostic and leaves other adapters usable.
        return [discoveryFailure(adapter)];
      }
    }),
  );

  return [...accountingResults.flat(), ...discoverInventorySources(options.homeDir)]
    .map(normalizeEntry)
    .sort((left, right) => {
      const leftOrder = SOURCE_ORDER[left.agent] ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = SOURCE_ORDER[right.agent] ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.agent.localeCompare(right.agent) || left.paths.join("\0").localeCompare(right.paths.join("\0"));
    });
}

/**
 * Render the private CLI report. Public snapshots must instead select their
 * source fields explicitly and must never call this function.
 */
export function formatDiscoveryOutput(entries: readonly DiscoveryEntry[]): string {
  const report = entries.map((entry) => ({
    agent: entry.agent,
    state: entry.state,
    tokens: entry.capabilities.tokens,
    work: entry.capabilities.work,
    paths: [...entry.paths],
    diagnosticCounts: { ...entry.diagnosticCounts },
    reasons: [...entry.reasons],
  }));
  return `${JSON.stringify(report, null, 2)}\n`;
}
