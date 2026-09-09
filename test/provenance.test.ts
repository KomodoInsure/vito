import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config";
import type { InputRecord } from "../src/contracts";
import { collectIntoStore } from "../src/ingest";
import {
  collectInputProvenance,
  inputProvenanceEventSchema,
} from "../src/sources/provenance";
import { CollectorStore } from "../src/store";

const temporaryDirectories: string[] = [];
const openStores: CollectorStore[] = [];
const CUTOFF = Date.parse("2026-09-09T12:00:00Z");

interface Fixture {
  root: string;
  workspace: string;
  state: string;
  provenance: string;
  config: Config;
  store: CollectorStore;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vito-provenance-test-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const provenance = join(root, "provenance", "events.jsonl");
  mkdirSync(workspace);
  mkdirSync(join(root, "provenance"));
  const config: Config = {
    version: 1,
    workspaceRoots: [workspace],
    timezone: "UTC",
    stateDir: state,
    sources: { codex: [], claude: [], omp: [], opencode: [], hermes: [] },
    repositories: [],
    historicalWorkspaces: [],
    inputProvenance: [provenance],
    publication: { repository: "fixture/vito-pages", branch: "main" },
  };
  const store = CollectorStore.open(state);
  openStores.push(store);
  return { root, workspace, state, provenance, config, store };
}

function input(
  originKey: string,
  nativeInputId: string,
  overrides: Partial<InputRecord> = {},
): InputRecord & { scopeDecision: "included"; scopeReason: string } {
  return {
    originKey,
    sourceKey: "codex:fixture",
    agent: "codex",
    sessionKey: `session-key:${originKey}`,
    nativeSessionId: "native-session",
    nativeInputId,
    workspaceKey: "workspace-key",
    repositoryKey: null,
    atMs: CUTOFF - 1_000,
    kind: "submission",
    lane: "main",
    controller: null,
    origin: "unknown",
    originEvidence: "none",
    quality: "recorded",
    reasons: [],
    scopeDecision: "included",
    scopeReason: "configured-root",
    ...overrides,
  };
}

function event(
  inputId: string,
  origin: "human" | "automated",
  controller?: string,
): {
  version: 1;
  agent: "codex";
  sessionId: string;
  inputId: string;
  status: "delivered";
  origin: "human" | "automated";
  controller?: string;
} {
  return {
    version: 1,
    agent: "codex",
    sessionId: "native-session",
    inputId,
    status: "delivered",
    origin,
    ...(controller === undefined ? {} : { controller }),
  };
}

function writeLines(path: string, records: readonly unknown[], tail = ""): void {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length > 0 ? "\n" : ""}${tail}`);
}

function storedInput(value: Fixture, originKey: string): Record<string, unknown> {
  const row = value.store.getInput(originKey);
  if (row === null) throw new Error(`Missing input ${originKey}`);
  return row;
}

function provenanceCount(store: CollectorStore): number {
  const row: unknown = store.database.query("SELECT count(*) AS count FROM input_provenance").get();
  if (typeof row !== "object" || row === null || !("count" in row) || typeof row.count !== "number") {
    throw new TypeError("Expected a numeric provenance count");
  }
  return row.count;
}

function cursorCount(store: CollectorStore): number {
  const row: unknown = store.database.query(
    "SELECT count(*) AS count FROM file_cursors WHERE source_key = 'input-provenance'",
  ).get();
  if (typeof row !== "object" || row === null || !("count" in row) || typeof row.count !== "number") {
    throw new TypeError("Expected a numeric cursor count");
  }
  return row.count;
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("input provenance event contract", () => {
  test("accepts only the strict version-one delivered event shape", () => {
    const valid = event("native-input", "human", "arbitrary-controller-alpha");
    expect(inputProvenanceEventSchema.parse(valid)).toEqual(valid);
    expect(inputProvenanceEventSchema.safeParse({ ...valid, status: "queued" }).success).toBe(false);
    expect(inputProvenanceEventSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
    expect(inputProvenanceEventSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(inputProvenanceEventSchema.safeParse({ ...valid, controller: "" }).success).toBe(false);
    expect(inputProvenanceEventSchema.safeParse({ ...valid, controller: "x".repeat(129) }).success).toBe(false);
  });
});

describe("input provenance collection", () => {
  test("deduplicates delivered claims and enriches exact native inputs from arbitrary controllers", async () => {
    const value = fixture();
    value.store.writeBatch({ inputs: [
      input("input-one", "one"),
      input("input-two", "two"),
      input("input-three", "three"),
    ] });
    writeLines(value.provenance, [
      event("one", "human", "arbitrary-controller-alpha"),
      event("one", "human", "arbitrary-controller-alpha"),
      event("two", "automated", "unrelated-controller-beta"),
      event("three", "human", "arbitrary-controller-alpha"),
      event("three", "human", "unrelated-controller-beta"),
    ]);

    expect(await collectInputProvenance(value.config, value.store, { rebuild: false, cutoffMs: CUTOFF })).toEqual({});
    expect(provenanceCount(value.store)).toBe(4);
    expect(cursorCount(value.store)).toBe(1);
    expect(storedInput(value, "input-one")).toMatchObject({
      origin: "human",
      origin_evidence: "provenance",
      controller: "arbitrary-controller-alpha",
    });
    expect(storedInput(value, "input-two")).toMatchObject({
      origin: "automated",
      origin_evidence: "provenance",
      controller: "unrelated-controller-beta",
    });
    expect(storedInput(value, "input-three")).toMatchObject({
      origin: "human",
      origin_evidence: "provenance",
      controller: null,
    });

    expect(await collectInputProvenance(value.config, value.store, { rebuild: true, cutoffMs: CUTOFF })).toEqual({});
    expect(provenanceCount(value.store)).toBe(4);
  });

  test("makes contrary claims a sticky conflict without degrading input quality", async () => {
    const value = fixture();
    value.store.writeBatch({ inputs: [
      input("input-conflict", "conflict"),
      input("source-conflict", "source-conflict", {
        origin: "human",
        originEvidence: "source",
        controller: "native-controller",
      }),
    ] });
    writeLines(value.provenance, [
      event("conflict", "human", "controller-one"),
      event("conflict", "automated", "controller-two"),
      event("source-conflict", "automated", "feed-controller"),
    ]);

    expect(await collectInputProvenance(value.config, value.store, { rebuild: false, cutoffMs: CUTOFF })).toEqual({});
    for (const originKey of ["input-conflict", "source-conflict"]) {
      expect(storedInput(value, originKey)).toMatchObject({
        origin: "unknown",
        origin_evidence: "conflict",
        controller: null,
        quality: "recorded",
        reasons_json: '["input-origin-conflict"]',
      });
    }

    writeLines(value.provenance, [event("conflict", "human", "controller-one")]);
    await collectInputProvenance(value.config, value.store, { rebuild: true, cutoffMs: CUTOFF });
    expect(storedInput(value, "input-conflict")).toMatchObject({ origin: "unknown", origin_evidence: "conflict" });
  });

  test("restores explicit native source evidence when a conflicted tuple later becomes ambiguous", async () => {
    const value = fixture();
    value.store.writeBatch({ inputs: [input("native-source", "transition", {
      origin: "human",
      originEvidence: "source",
      controller: "native-controller",
    })] });
    writeLines(value.provenance, [event("transition", "automated", "feed-controller")]);
    await collectInputProvenance(value.config, value.store, { rebuild: false, cutoffMs: CUTOFF });
    expect(storedInput(value, "native-source")).toMatchObject({
      origin: "unknown",
      origin_evidence: "conflict",
      controller: null,
    });

    value.store.writeBatch({ inputs: [input("other-partition", "transition", {
      sourceKey: "codex:other-partition",
      sessionKey: "other-session",
    })] });
    expect(await collectInputProvenance(
      { ...value.config, inputProvenance: [] },
      value.store,
      { rebuild: false, cutoffMs: CUTOFF },
    )).toEqual({ "input-provenance-ambiguous": 1 });
    expect(storedInput(value, "native-source")).toMatchObject({
      origin: "human",
      origin_evidence: "source",
      controller: "native-controller",
      reasons_json: "[]",
    });
  });

  test("preserves contrary retained-claim conflicts when matching submissions become ambiguous", async () => {
    const value = fixture();
    value.store.writeBatch({ inputs: [
      input("none-conflict", "ambiguous-none"),
      input("source-conflict-sticky", "ambiguous-source", {
        origin: "human",
        originEvidence: "source",
        controller: "native-controller",
      }),
    ] });
    writeLines(value.provenance, [
      event("ambiguous-none", "human", "controller-one"),
      event("ambiguous-none", "automated", "controller-two"),
      event("ambiguous-source", "human", "controller-one"),
      event("ambiguous-source", "automated", "controller-two"),
    ]);
    await collectInputProvenance(value.config, value.store, { rebuild: false, cutoffMs: CUTOFF });
    for (const originKey of ["none-conflict", "source-conflict-sticky"]) {
      expect(storedInput(value, originKey)).toMatchObject({
        origin: "unknown",
        origin_evidence: "conflict",
        controller: null,
        reasons_json: '["input-origin-conflict"]',
      });
    }

    value.store.writeBatch({ inputs: [
      input("none-other-partition", "ambiguous-none", {
        sourceKey: "codex:none-other-partition",
        sessionKey: "none-other-session",
      }),
      input("source-other-partition", "ambiguous-source", {
        sourceKey: "codex:source-other-partition",
        sessionKey: "source-other-session",
      }),
    ] });
    expect(await collectInputProvenance(
      { ...value.config, inputProvenance: [] },
      value.store,
      { rebuild: false, cutoffMs: CUTOFF },
    )).toEqual({ "input-provenance-ambiguous": 2 });
    for (const originKey of ["none-conflict", "source-conflict-sticky"]) {
      expect(storedInput(value, originKey)).toMatchObject({
        origin: "unknown",
        origin_evidence: "conflict",
        controller: null,
        reasons_json: '["input-origin-conflict"]',
      });
    }
  });

  test("keeps native/feed controller disagreement null across repeated reconciliation", async () => {
    const value = fixture();
    value.store.writeBatch({ inputs: [input("controller-disagreement", "controller-disagreement", {
      controller: "native-controller",
    })] });
    writeLines(value.provenance, [
      event("controller-disagreement", "human", "feed-controller"),
    ]);

    await collectInputProvenance(value.config, value.store, { rebuild: false, cutoffMs: CUTOFF });
    expect(storedInput(value, "controller-disagreement")).toMatchObject({
      origin: "human",
      origin_evidence: "provenance",
      controller: null,
    });
    await collectInputProvenance(
      { ...value.config, inputProvenance: [] },
      value.store,
      { rebuild: false, cutoffMs: CUTOFF },
    );
    expect(storedInput(value, "controller-disagreement")).toMatchObject({
      origin: "human",
      origin_evidence: "provenance",
      controller: null,
    });
  });

  test("retains an early claim through feed deletion and reconciles it after the native input arrives", async () => {
    const value = fixture();
    writeLines(value.provenance, [event("late", "human", "early-controller")]);

    expect(await collectInputProvenance(value.config, value.store, { rebuild: false, cutoffMs: CUTOFF })).toEqual({
      "input-provenance-pending": 1,
    });
    rmSync(value.provenance);
    value.store.writeBatch({ inputs: [input("input-late", "late")] });

    const summary = await collectIntoStore(
      { ...value.config, inputProvenance: [] },
      value.store,
      { adapters: [], cutoffMs: CUTOFF },
    );
    expect(summary.status).toBe("completed");
    expect(storedInput(value, "input-late")).toMatchObject({
      origin: "human",
      origin_evidence: "provenance",
      controller: "early-controller",
    });
  });

  test("clears stale provenance-only attribution when a formerly unique match becomes ambiguous", async () => {
    const value = fixture();
    value.store.writeBatch({ inputs: [input("original", "same-id")] });
    writeLines(value.provenance, [event("same-id", "human", "feed-controller")]);
    await collectInputProvenance(value.config, value.store, { rebuild: false, cutoffMs: CUTOFF });
    expect(storedInput(value, "original")).toMatchObject({ origin: "human", origin_evidence: "provenance" });

    value.store.writeBatch({ inputs: [
      input("second-partition", "same-id", {
        sourceKey: "codex:other-partition",
        sessionKey: "another-session-key",
        controller: "native-controller",
        origin: "automated",
        originEvidence: "source",
      }),
      input("replay-copy", "same-id", { kind: "replay", sessionKey: "copy-session-key" }),
    ] });
    const diagnostics = await collectInputProvenance(
      { ...value.config, inputProvenance: [] },
      value.store,
      { rebuild: false, cutoffMs: CUTOFF },
    );

    expect(diagnostics).toEqual({ "input-provenance-ambiguous": 1 });
    expect(storedInput(value, "original")).toMatchObject({ origin: "unknown", origin_evidence: "none", controller: null });
    expect(storedInput(value, "second-partition")).toMatchObject({
      origin: "automated",
      origin_evidence: "source",
      controller: "native-controller",
    });
    expect(storedInput(value, "replay-copy")).toMatchObject({ origin: "unknown", origin_evidence: "none" });
  });

  test("keeps unmatched, future, undated, and non-submission tuples pending without fallback", async () => {
    const value = fixture();
    value.store.writeBatch({ inputs: [
      input("wrong-id", "different-id"),
      input("future", "future", { atMs: CUTOFF + 1 }),
      input("undated", "undated", { atMs: null }),
      input("context", "context", { kind: "context" }),
    ] });

    writeLines(value.provenance, [
      event("missing", "human"),
      event("future", "human"),
      event("undated", "human"),
      event("context", "human"),
    ]);

    expect(await collectInputProvenance(value.config, value.store, { rebuild: false, cutoffMs: CUTOFF })).toEqual({
      "input-provenance-pending": 4,
    });
    for (const originKey of ["wrong-id", "future", "undated", "context"]) {
      expect(storedInput(value, originKey)).toMatchObject({ origin: "unknown", origin_evidence: "none" });
    }
  });

  test("clears provenance when a previously matched native row is no longer a dated submission", async () => {
    const value = fixture();
    value.store.writeBatch({ inputs: [input("reclassified", "reclassified")] });
    writeLines(value.provenance, [event("reclassified", "human", "feed-controller")]);
    await collectInputProvenance(value.config, value.store, { rebuild: false, cutoffMs: CUTOFF });
    value.store.database.query(`
      UPDATE input_events SET kind = 'context'
      WHERE origin_key = 'reclassified'
    `).run();

    expect(await collectInputProvenance(
      { ...value.config, inputProvenance: [] },
      value.store,
      { rebuild: false, cutoffMs: CUTOFF },
    )).toEqual({ "input-provenance-pending": 1 });
    expect(storedInput(value, "reclassified")).toMatchObject({
      kind: "context",
      origin: "unknown",
      origin_evidence: "none",
      controller: null,
    });
  });

  test("reports invalid records, malformed lines, incomplete tails, and unreadable files without blocking other feeds", async () => {
    const value = fixture();
    const second = join(value.root, "provenance", "second.jsonl");
    const missing = join(value.root, "provenance", "missing.jsonl");
    const tailRecord = JSON.stringify(event("tail", "human", "tail-controller"));
    const tailSplit = Math.floor(tailRecord.length / 2);
    const tailPrefix = tailRecord.slice(0, tailSplit);
    const tailSuffix = tailRecord.slice(tailSplit);
    writeFileSync(value.provenance, [
      JSON.stringify(event("valid", "human")),
      JSON.stringify({ ...event("queued", "human"), status: "queued" }),
      JSON.stringify({ ...event("version", "human"), version: 9 }),
      JSON.stringify({ ...event("rejected", "human"), status: "rejected" }),
      JSON.stringify({ ...event("extra", "human"), extra: true }),
      "{malformed",
      tailPrefix,
    ].join("\n"));
    writeLines(second, [event("second", "automated", "second-controller")]);

    const diagnostics = await collectInputProvenance(
      { ...value.config, inputProvenance: [value.provenance, missing, second] },
      value.store,
      { rebuild: false, cutoffMs: CUTOFF },
    );
    expect(diagnostics).toEqual({
      "input-provenance-unreadable": 1,
      "input-provenance-unsupported": 4,
      "input-provenance-parse-gap": 1,
      "input-provenance-tail": Buffer.byteLength(tailPrefix),
      "input-provenance-pending": 2,
    });
    expect(provenanceCount(value.store)).toBe(2);
    expect(cursorCount(value.store)).toBe(2);

    appendFileSync(value.provenance, `${tailSuffix}\n`);
    expect(await collectInputProvenance(
      { ...value.config, inputProvenance: [value.provenance, second] },
      value.store,
      { rebuild: false, cutoffMs: CUTOFF },
    )).toEqual({ "input-provenance-pending": 3 });
    expect(provenanceCount(value.store)).toBe(3);
  });

  test("rolls back claims and their cursor together when a ledger write fails", async () => {
    const value = fixture();
    writeLines(value.provenance, [event("write-failure", "human")]);
    value.store.database.exec(`
      CREATE TRIGGER fail_provenance_write
      BEFORE INSERT ON input_provenance
      BEGIN
        SELECT RAISE(ABORT, 'synthetic ledger failure');
      END;
    `);

    await expect(collectIntoStore(
      value.config,
      value.store,
      { adapters: [], cutoffMs: CUTOFF },
    )).rejects.toThrow("synthetic ledger failure");
    expect(provenanceCount(value.store)).toBe(0);
    expect(cursorCount(value.store)).toBe(0);
  });

  test("merges fixed diagnostics into the collection run and marks only read/schema gaps partial", async () => {
    const value = fixture();
    writeFileSync(value.provenance, `${JSON.stringify({ ...event("queued", "human"), status: "queued" })}\n{bad}\n`);

    const summary = await collectIntoStore(value.config, value.store, { adapters: [], cutoffMs: CUTOFF });
    expect(summary.status).toBe("partial");
    const storedRun: unknown = value.store.database
      .query("SELECT diagnostic_counts_json FROM collection_runs WHERE run_key = ?")
      .get(summary.runKey);
    if (
      typeof storedRun !== "object"
      || storedRun === null
      || !("diagnostic_counts_json" in storedRun)
      || typeof storedRun.diagnostic_counts_json !== "string"
    ) {
      throw new TypeError("Expected stored collection-run diagnostics");
    }
    expect(JSON.parse(storedRun.diagnostic_counts_json)).toEqual({
      "duplicate-ambiguity": 0,
      "input-provenance-parse-gap": 1,
      "input-provenance-unsupported": 1,
      "unallocated-history": 0,
      "unattributed-session": 0,
    });
  });
});
