import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config";
import type { PublicSnapshot, UsageRecord } from "../src/contracts";
import {
  EXPORT_FILES,
  EXPORT_OWNERSHIP_FILE,
  ExportError,
  exportStaticSite,
} from "../src/export";
import { createPreviewHandler, PreviewError } from "../src/preview";
import { PRICING_METADATA } from "../src/pricing";
import { CollectorStore } from "../src/store";

const temporaryDirectories: string[] = [];
const openStores: CollectorStore[] = [];

interface Fixture {
  root: string;
  workspace: string;
  state: string;
  assets: string;
  output: string;
  config: Config;
  store: CollectorStore;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vito-export-test-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "PRIVATE_SENTINEL_workspace");
  const state = join(root, "state");
  const assets = join(root, "built-assets");
  const output = join(root, "public-export");
  mkdirSync(workspace);
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), '<!doctype html><link rel="stylesheet" href="./styles.css"><iframe src="./widget.html?view=all"></iframe>\n');
  writeFileSync(join(assets, "widget.html"), '<!doctype html><link rel="stylesheet" href="./styles.css"><script type="module" src="./widget.js"></script>\n');
  writeFileSync(join(assets, "widget.js"), 'fetch("./activity.json");\n');
  writeFileSync(join(assets, "styles.css"), ":root { color-scheme: light dark; }\n");
  writeFileSync(join(assets, "LICENSE"), "Apache-2.0 fixture license\n");
  writeFileSync(join(assets, "NOTICE"), "Synthetic project notice\n");
  writeFileSync(join(assets, "THIRD_PARTY_NOTICES"), "Synthetic dependency notices\n");
  const config: Config = {
    version: 1,
    workspaceRoots: [workspace],
    timezone: "UTC",
    stateDir: state,
    sources: { codex: [], claude: [], omp: [], opencode: [], hermes: [] },
    repositories: [],
    publication: { repository: "fixture/vito-pages", branch: "main" },
  };
  const store = CollectorStore.open(state);
  openStores.push(store);
  return { root, workspace, state, assets, output, config, store };
}

function snapshot(cutoffMs: number, usageRecords = 0): PublicSnapshot {
  const instant = new Date(cutoffMs).toISOString();
  return {
    schemaVersion: 3,
    pricing: { ...PRICING_METADATA, sources: [...PRICING_METADATA.sources] },
    organization: "Agent Native",
    timezone: "UTC",
    generatedAt: instant,
    cutoff: instant,
    periodStart: "2025-09-07",
    periodEnd: "2026-09-06",
    collectionStatus: "ok",
    sources: [],
    coverage: {
      unallocatedUsageRecords: usageRecords,
      excludedAmbiguousRecords: 0,
      scopeStatus: "recorded",
      undated: { byHarness: [] },
    },
    days: [],
  };
}

function usage(originKey: string): UsageRecord {
  return {
    originKey,
    agent: "codex",
    sessionKey: "synthetic-session",
    workspaceKey: "private-workspace-key",
    repositoryKey: null,
    turnKey: null,
    requestKey: originKey,
    atMs: 1_700_000_000_000,
    provider: "synthetic",
    model: "fixture-model",
    uncachedInput: 1,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 1,
    costMicrousd: null,
    costKind: "unknown",
    quality: "recorded",
    reasons: [],
  };
}
function databaseCount(store: CollectorStore): number {
  const row: unknown = store.database.query("SELECT COUNT(*) AS count FROM usage").get();
  if (typeof row !== "object" || row === null || !("count" in row) || typeof row.count !== "number") {
    throw new TypeError("Expected a numeric usage count");
  }
  return row.count;
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("static export", () => {
  test("uses buildPublicSnapshot with the one captured cutoff", () => {
    const value = fixture();
    const cutoff = "2026-09-06T12:34:56.789Z";
    const result = exportStaticSite(value.config, value.store, {
      outDir: value.output,
      at: cutoff,
      assetsDir: value.assets,
    });
    expect(result.snapshot.cutoff).toBe(cutoff);
    expect(result.snapshot.generatedAt).toBe(cutoff);
    expect(result.snapshot.days).toHaveLength(365);
  });

  test("is byte-identical at a fixed cutoff and changes only activity data after an append", () => {
    const value = fixture();
    const cutoff = "2026-09-06T12:34:56.789Z";
    const buildSnapshot = (_config: Config, store: CollectorStore, cutoffMs: number) => snapshot(cutoffMs, databaseCount(store));

    const first = exportStaticSite(value.config, value.store, {
      outDir: value.output,
      at: cutoff,
      assetsDir: value.assets,
      buildSnapshot,
    });
    expect(first.outDir).toBe(realpathSync.native(value.output));
    expect(readdirSync(value.output).sort()).toEqual([...EXPORT_FILES].sort());
    const initial = Object.fromEntries(EXPORT_FILES.map((file) => [file, readFileSync(join(value.output, file))]));

    exportStaticSite(value.config, value.store, {
      outDir: value.output,
      at: cutoff,
      assetsDir: value.assets,
      buildSnapshot,
    });
    for (const file of EXPORT_FILES) expect(readFileSync(join(value.output, file))).toEqual(initial[file]);

    value.store.upsertUsage(usage("response:appended"));
    exportStaticSite(value.config, value.store, {
      outDir: value.output,
      at: cutoff,
      assetsDir: value.assets,
      buildSnapshot,
    });
    for (const file of EXPORT_FILES) {
      if (file !== "activity.json") expect(readFileSync(join(value.output, file))).toEqual(initial[file]);
    }
    expect(readFileSync(join(value.output, "activity.json"))).not.toEqual(initial["activity.json"]);
    expect(JSON.parse(readFileSync(join(value.output, "activity.json"), "utf8")).coverage.unallocatedUsageRecords).toBe(1);
    expect(readFileSync(join(value.output, "widget.js"), "utf8")).not.toContain("sourceMappingURL");

    const ownership = join(value.state, EXPORT_OWNERSHIP_FILE);
    expect(statSync(value.output).mode & 0o777).toBe(0o755);
    for (const file of EXPORT_FILES) expect(statSync(join(value.output, file)).mode & 0o777).toBe(0o644);
    expect(existsSync(ownership)).toBe(true);
    expect(statSync(ownership).mode & 0o777).toBe(0o600);
    expect(readdirSync(value.output)).not.toContain(EXPORT_OWNERSHIP_FILE);
    for (const file of EXPORT_FILES) expect(readFileSync(join(value.output, file), "utf8")).not.toContain("PRIVATE_SENTINEL");
  });

  test("rejects non-owned directories, source overlaps, symlink assets, and invalid snapshots", () => {
    const value = fixture();
    const cutoffMs = Date.parse("2026-09-06T12:00:00.000Z");
    mkdirSync(value.output);
    writeFileSync(join(value.output, "unrelated.txt"), "do not replace");
    expect(() => exportStaticSite(value.config, value.store, {
      outDir: value.output,
      at: cutoffMs,
      assetsDir: value.assets,
      buildSnapshot: () => snapshot(cutoffMs),
    })).toThrow(ExportError);
    expect(readFileSync(join(value.output, "unrelated.txt"), "utf8")).toBe("do not replace");

    expect(() => exportStaticSite(value.config, value.store, {
      outDir: join(value.workspace, "nested", "public"),
      at: cutoffMs,
      assetsDir: value.assets,
      buildSnapshot: () => snapshot(cutoffMs),
    })).toThrow(/overlaps protected source/i);
    expect(existsSync(join(value.workspace, "nested"))).toBe(false);

    const badAssets = join(value.root, "bad-assets");
    mkdirSync(badAssets);
    for (const file of ["index.html", "widget.html", "widget.js"] as const) writeFileSync(join(badAssets, file), file);
    symlinkSync(join(value.assets, "styles.css"), join(badAssets, "styles.css"));
    expect(() => exportStaticSite(value.config, value.store, {
      outDir: join(value.root, "symlink-export"),
      at: cutoffMs,
      assetsDir: badAssets,
      buildSnapshot: () => snapshot(cutoffMs),
    })).toThrow(/regular file/i);

    const unknownKey = snapshot(cutoffMs) as unknown as Record<string, unknown>;
    unknownKey.coverage = { unallocatedUsageRecords: 0, excludedAmbiguousRecords: 0, privateValue: "must fail" };
    expect(() => exportStaticSite(value.config, value.store, {
      outDir: join(value.root, "unknown-key-export"),
      at: cutoffMs,
      assetsDir: value.assets,
      buildSnapshot: () => unknownKey as unknown as PublicSnapshot,
    })).toThrow(/validation failed/i);

    const nonfinite = snapshot(cutoffMs);
    nonfinite.coverage.unallocatedUsageRecords = Number.POSITIVE_INFINITY;
    expect(() => exportStaticSite(value.config, value.store, {
      outDir: join(value.root, "nonfinite-export"),
      at: cutoffMs,
      assetsDir: value.assets,
      buildSnapshot: () => nonfinite,
    })).toThrow(/validation failed/i);
  });
});

describe("static preview", () => {
  test("serves only validated relative export assets at project subpaths", async () => {
    const value = fixture();
    const cutoffMs = Date.parse("2026-09-06T12:00:00.000Z");
    exportStaticSite(value.config, value.store, {
      outDir: value.output,
      at: cutoffMs,
      assetsDir: value.assets,
      buildSnapshot: () => snapshot(cutoffMs),
    });
    const handler = createPreviewHandler(value.output);

    const index = handler(new Request("http://127.0.0.1:4173/repo/"));
    expect(index.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('href="./styles.css"');
    expect((await handler(new Request("http://127.0.0.1:4173/repo/widget.js")).text())).toContain('fetch("./activity.json")');
    expect(handler(new Request("http://127.0.0.1:4173/repo/activity.json")).status).toBe(200);
    expect(handler(new Request("http://127.0.0.1:4173/config.json")).status).toBe(404);
    expect(handler(new Request("http://127.0.0.1:4173/activity.sqlite")).status).toBe(404);
    expect(handler(new Request("http://127.0.0.1:4173/repo/%2e%2e%2fstyles.css")).status).toBe(404);
    expect(handler(new Request("http://127.0.0.1:4173/repo/widget.js", { method: "POST" })).status).toBe(405);
  });

  test("rejects a symlink escape before serving", () => {
    const value = fixture();
    const cutoffMs = Date.parse("2026-09-06T12:00:00.000Z");
    exportStaticSite(value.config, value.store, {
      outDir: value.output,
      at: cutoffMs,
      assetsDir: value.assets,
      buildSnapshot: () => snapshot(cutoffMs),
    });
    rmSync(join(value.output, "styles.css"));
    symlinkSync(join(value.state, EXPORT_OWNERSHIP_FILE), join(value.output, "styles.css"));
    expect(() => createPreviewHandler(value.output)).toThrow(PreviewError);
    expect(lstatSync(join(value.output, "styles.css")).isSymbolicLink()).toBe(true);
  });
});
