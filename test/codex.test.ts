import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Config } from "../src/config";
import { buildPublicSnapshot } from "../src/metrics";
import { CollectorStore } from "../src/store";
import {
  codexAdapter,
  normalizeCodexJsonl,
  normalizeCodexUsage,
  type CodexJsonlNormalizationResult,
} from "../src/sources/codex";

const BASE = Date.parse("2026-09-06T00:00:00.000Z");

function record(type: string, payload: Record<string, unknown>, seconds: number, ordinal: number): Record<string, unknown> {
  return {
    timestamp: new Date(BASE + seconds * 1_000).toISOString(),
    ordinal,
    type,
    payload,
  };
}

function header(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return record("session_meta", {
    id: "synthetic-session",
    cwd: "/synthetic/workspace",
    model_provider: "synthetic-provider",
    ...extra,
  }, 0, 0);
}

function turn(seconds = 1): Record<string, unknown> {
  return record("turn_context", {
    turn_id: "synthetic-turn",
    cwd: "/synthetic/workspace/segment",
    model: "synthetic-model",
  }, seconds, 1);
}

function counters(input: number, output: number, cached = 0, cacheWrite = 0, reasoning = 0): Record<string, number> {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function modern(
  responseId: string,
  usage: Record<string, number>,
  seconds: number,
  ordinal: number,
): Record<string, unknown> {
  return record("token_usage_record", {
    response_id: responseId,
    thread_id: "synthetic-session",
    turn_id: "synthetic-turn",
    usage,
  }, seconds, ordinal);
}

function cumulative(
  usage: Record<string, number>,
  seconds: number,
  ordinal: number,
): Record<string, unknown> {
  return record("event_msg", {
    type: "token_count",
    info: { total_token_usage: usage },
  }, seconds, ordinal);
}

function emptyCumulative(seconds: number, ordinal: number): Record<string, unknown> {
  return record("event_msg", {
    type: "token_count",
    info: null,
  }, seconds, ordinal);
}

function userInput(
  id: string,
  kinds: string[] | null,
  seconds: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return record("response_item", {
    type: "message",
    role: "user",
    id,
    ...(kinds === null ? {} : {
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds, turn_id: "shared-accounting-turn" },
    }),
    ...extra,
  }, seconds, seconds);
}

function jsonl(records: readonly Record<string, unknown>[]): string {
  return `${records.map((value) => JSON.stringify(value)).join("\n")}\n`;
}
function summedTotal(result: CodexJsonlNormalizationResult): number {
  return result.usage.reduce((sum, usage) => sum + (usage.total ?? 0), 0);
}



describe("Codex usage normalization", () => {
  test("counts a modern response and its cumulative mirror exactly once", () => {
    const response = modern("synthetic-response", counters(10, 4, 2), 2, 2);
    const result = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      response,
      response,
      cumulative(counters(10, 4, 2), 3, 3),
    ]));

    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({
      provider: "synthetic-provider",
      model: "synthetic-model",
      workspaceKey: "/synthetic/workspace/segment",
      uncachedInput: 8,
      cacheRead: 2,
      cacheWrite: 0,
      output: 4,
      total: 14,
      costMicrousd: null,
      costKind: "unknown",
      quality: "recorded",
    });
  });

  test("emits only the uncovered legacy remainder across a legacy-to-modern transition", () => {
    const result = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      cumulative(counters(8, 2), 2, 2),
      modern("synthetic-modern", counters(4, 1), 3, 3),
      cumulative(counters(20, 5), 4, 4),
    ]));

    expect(result.usage).toHaveLength(3);
    expect(result.usage.map((usage) => usage.total).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([5, 10, 10]);
    expect(summedTotal(result)).toBe(25);
  });

  test("ignores an empty event without losing the next cumulative increment", () => {
    const result = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      cumulative(counters(8, 2), 2, 2),
      emptyCumulative(3, 3),
      cumulative(counters(20, 5), 4, 4),
    ]));

    expect(summedTotal(result)).toBe(25);
    expect(result.counterSnapshots[0]).toMatchObject({ total: 25, epoch: 0 });
  });

  test("keeps modern reconciliation state across an empty cumulative event", () => {
    const result = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      cumulative(counters(8, 2), 2, 2),
      modern("between-checkpoints", counters(4, 1), 3, 3),
      emptyCumulative(4, 4),
      cumulative(counters(12, 3), 5, 5),
    ]));

    expect(summedTotal(result)).toBe(15);
    expect(result.usage).toHaveLength(2);
    expect(result.counterSnapshots[0]).toMatchObject({ total: 15, epoch: 0 });
  });

  test("an empty event before the first checkpoint preserves baseline rules", () => {
    const complete = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      emptyCumulative(2, 2),
      cumulative(counters(8, 2), 3, 3),
    ]));
    const imported = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      emptyCumulative(2, 2),
      cumulative(counters(8, 2), 3, 3),
    ]), { completeHistory: false });

    expect(summedTotal(complete)).toBe(10);
    expect(imported.usage).toHaveLength(0);
    expect(imported.unallocatedUsageRecords).toBe(1);
  });

  test("repeated cumulative totals emit zero delta", () => {
    const result = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      cumulative(counters(30, 10), 2, 2),
      cumulative(counters(30, 10), 3, 3),
      cumulative(counters(30, 10), 4, 4),
    ]));

    expect(result.usage).toHaveLength(1);
    expect(summedTotal(result)).toBe(40);
  });

  test("uses an imported first total as an unknown baseline and allocates only a later delta", () => {
    const result = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      cumulative(counters(80, 20), 2, 2),
      cumulative(counters(110, 30), 3, 3),
    ]), { completeHistory: false });

    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]?.total).toBe(40);
    expect(result.unallocatedUsageRecords).toBe(1);
    expect(result.reasons).toContain("unallocated-history");
    expect(result.counterSnapshots[0]).toMatchObject({ quality: "partial", epoch: 0 });
  });

  test("a counter reset starts a partial unknown-baseline epoch without billing the reset value", () => {
    const result = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      cumulative(counters(80, 20), 2, 2),
      cumulative(counters(8, 2), 3, 3),
      cumulative(counters(18, 2), 4, 4),
    ]));

    expect(summedTotal(result)).toBe(110);
    expect(result.reasons).toContain("counter-discontinuity");
    expect(result.counterSnapshots[0]).toMatchObject({ quality: "partial", epoch: 1, total: 20 });
  });

  test("deduplicates replayed responses and retains an unterminated final line", () => {
    const response = modern("replayed-response", counters(7, 3), 2, 2);
    const complete = jsonl([header(), turn(), response, response]);
    const truncated = JSON.stringify(modern("not-complete", counters(99, 1), 3, 3)).slice(0, -8);
    const result = normalizeCodexJsonl(complete + truncated);

    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]?.total).toBe(10);
    expect(result.completeByteOffset).toBe(Buffer.byteLength(complete));
    expect(result.diagnosticCounts["parse-gap"]).toBeUndefined();
  });

  test("uses the accounting envelope timestamp rather than a folder or reset timestamp", () => {
    const accountingAt = BASE + 37_000;
    const result = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      modern("timestamped-response", counters(3, 2), 37, 2),
    ]));

    expect(result.usage[0]?.atMs).toBe(accountingAt);
  });

  test("preserves a reported total and marks an unreconciled cache-write breakdown partial", () => {
    const normalized = normalizeCodexUsage({
      input_tokens: 5,
      cached_input_tokens: 4,
      cache_write_input_tokens: 3,
      output_tokens: 2,
      reasoning_output_tokens: 1,
      total_tokens: 7,
    });

    expect(normalized).toMatchObject({
      components: { uncachedInput: null, cacheRead: 4, cacheWrite: 3, output: 2, reasoning: 1, total: 7 },
      quality: "partial",
      reasons: ["parse-gap"],
    });
  });
});

describe("Codex input normalization", () => {
  test("classifies ID-bearing user response items independently from accounting turns", () => {
    const result = normalizeCodexJsonl(jsonl([
      header({ originator: "fixture-controller" }),
      userInput("submission-a", ["user.text"], 1),
      userInput("submission-b", ["agents_md.instructions", "user.text"], 2),
      userInput("context", ["agents_md.instructions"], 3),
      userInput("unknown", null, 4),
      record("event_msg", { type: "user_message", message: "not a stable input" }, 5, 5),
    ]));

    expect(result.inputs).toHaveLength(4);
    expect(result.inputs.map((input) => ({
      id: input.nativeInputId,
      kind: input.kind,
      controller: input.controller,
      origin: input.origin,
      lane: input.lane,
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: "context", kind: "context", controller: "fixture-controller", origin: "unknown", lane: "main" },
      { id: "submission-a", kind: "submission", controller: "fixture-controller", origin: "unknown", lane: "main" },
      { id: "submission-b", kind: "submission", controller: "fixture-controller", origin: "unknown", lane: "main" },
      { id: "unknown", kind: "unknown", controller: "fixture-controller", origin: "unknown", lane: "main" },
    ]);
    expect(result.inputReasons).toEqual(["input-history-incomplete", "input-kind-unknown"]);
    const unsupported = normalizeCodexJsonl(jsonl([
      header(),
      record("event_msg", { type: "user_message", message: "not a stable input" }, 5, 5),
    ]));
    expect(unsupported.inputs).toEqual([]);
    expect(unsupported.inputReasons).toEqual(["input-history-incomplete"]);
    const mixed = normalizeCodexJsonl(jsonl([
      header(),
      userInput("verified", ["user.text"], 1),
      record("event_msg", { type: "user_message", turn_id: "unmatched-turn" }, 2, 2),
    ]));
    expect(mixed.inputReasons).toEqual(["input-history-incomplete"]);
    const sameTurnDistinctSubmission = normalizeCodexJsonl(jsonl([
      header(),
      userInput("verified", ["user.text"], 1),
      record("event_msg", {
        type: "user_message",
        id: "distinct-unsupported",
        turn_id: "shared-accounting-turn",
      }, 2, 2),
    ]));
    expect(sameTurnDistinctSubmission.inputReasons).toEqual(["input-history-incomplete"]);
    const nativeIdMirror = normalizeCodexJsonl(jsonl([
      header(),
      userInput("verified", ["user.text"], 1),
      record("event_msg", {
        type: "user_message",
        id: "verified",
        turn_id: "different-accounting-turn",
      }, 2, 2),
    ]));
    expect(nativeIdMirror.inputReasons).toEqual([]);
  });

  test("emits a unique session origin for each native session while preserving accounting identities", () => {
    const first = normalizeCodexJsonl(jsonl([header({ id: "fork-a", origin_session_id: "root" })]));
    const second = normalizeCodexJsonl(jsonl([header({ id: "fork-b", origin_session_id: "root" })]));
    expect(first.sessions[0]?.originKey).not.toBe(second.sessions[0]?.originKey);
    expect(first.sessions[0]?.canonicalSessionKey).toBe("root");
    expect(second.sessions[0]?.canonicalSessionKey).toBe("root");
  });
});

describe("Codex measured work normalization", () => {
  test("includes timed inference and tool items while excluding projections and waits", () => {
    const included = [
      ["Reasoning", "inference"],
      ["AgentMessage", "inference"],
      ["CommandExecution", "tool"],
      ["FileChange", "tool"],
      ["WebSearch", "tool"],
      ["McpToolCall", "tool"],
      ["DynamicToolCall", "tool"],
    ] as const;
    const excluded = ["UserMessage", "SubAgentActivity", "Plan", "CollabAgentWait"];
    const records: Array<Record<string, unknown>> = [header(), turn()];
    let ordinal = 2;
    for (const [type] of included) {
      records.push(record("event_msg", {
        type: "item_completed",
        item: { id: `included-${ordinal}`, type, started_at_ms: BASE + ordinal * 10, completed_at_ms: BASE + ordinal * 10 + 5 },
      }, ordinal, ordinal));
      ordinal += 1;
    }
    for (const type of excluded) {
      records.push(record("event_msg", {
        type: "item_completed",
        item: { id: `excluded-${ordinal}`, type, started_at_ms: BASE + ordinal * 10, completed_at_ms: BASE + ordinal * 10 + 5 },
      }, ordinal, ordinal));
      ordinal += 1;
    }
    records.push(record("event_msg", {
      type: "item_completed",
      item: {
        id: "excluded-input-tool",
        type: "DynamicToolCall",
        name: "request_user_input",
        started_at_ms: BASE + 900,
        completed_at_ms: BASE + 950,
      },
    }, 20, 20));

    const result = normalizeCodexJsonl(jsonl(records));
    expect(result.workIntervals.map(({ kind }) => kind)).toEqual(included.map(([, kind]) => kind));
    expect(result.workIntervals[0]).toMatchObject({
      provider: "synthetic-provider",
      model: "synthetic-model",
      workspaceKey: "/synthetic/workspace/segment",
    });
    expect(result.workIntervals.find(({ kind }) => kind === "tool")).toMatchObject({ provider: null, model: null });
  });

  test("does not extend an open item and reports timing coverage", () => {
    const result = normalizeCodexJsonl(jsonl([
      header(),
      turn(),
      record("event_msg", {
        type: "item_completed",
        item: { id: "open-command", type: "CommandExecution", started_at_ms: BASE + 10 },
      }, 2, 2),
    ]));

    expect(result.workIntervals).toEqual([]);
    expect(result.reasons).toContain("open-interval");
    expect(result.diagnosticCounts["open-interval"]).toBe(1);
  });
});

describe("Codex adapter collection", () => {
  test("reads optional lineage metadata read-only and incrementally checkpoints complete JSONL lines", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "vito-codex-test-"));
    const sourceRoot = join(temporary, "codex");
    const stateDir = join(temporary, "state");
    mkdirSync(sourceRoot);
    const rolloutPath = join(sourceRoot, "rollout-synthetic.jsonl");
    writeFileSync(rolloutPath, jsonl([
      header({ id: "synthetic-child" }),
      turn(),
      userInput("historical-input", ["user.text"], 1),
      modern("first-collected-response", counters(6, 4), 2, 2),
    ]));

    const statePath = join(sourceRoot, "state_5.sqlite");
    const sourceDatabase = new Database(statePath);
    sourceDatabase.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    sourceDatabase.run(
      "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL)",
    );
    sourceDatabase
      .query<unknown, [string, string]>("INSERT INTO threads (id, rollout_path) VALUES (?, ?)")
      .run("synthetic-child", rolloutPath);
    sourceDatabase
      .query<unknown, [string, string]>("INSERT INTO thread_spawn_edges VALUES (?, ?)")
      .run("synthetic-parent", "synthetic-child");
    sourceDatabase.close();
    const sourceMtime = statSync(statePath).mtimeMs;

    const config: Config = {
      version: 1,
      workspaceRoots: ["/synthetic/workspace"],
      timezone: "UTC",
      stateDir,
      sources: { codex: [sourceRoot] },
      repositories: [],
      publication: { repository: "synthetic/activity", branch: "main" },
    };
    const store = CollectorStore.open(stateDir);
    try {
      const legacyCursorBatch = await codexAdapter.collect({
        config,
        store,
        rebuild: false,
        cutoffMs: BASE + 60_000,
        reconcileAll: false,
      });
      store.writeBatch({ fileCursors: legacyCursorBatch.fileCursors });
      expect(store.getInputSourceState("codex")).toBeNull();
      const first = await codexAdapter.collect({
        config,
        store,
        rebuild: false,
        cutoffMs: BASE + 60_000,
        reconcileAll: false,
      });
      expect(first.sessions[0]).toMatchObject({
        sessionKey: "synthetic-child",
        parentSessionKey: "synthetic-parent",
      });
      expect(first.inputs.map((input) => input.nativeInputId)).toEqual(["historical-input"]);
      expect(new Set(first.inputs.map((input) => input.sourceKey))).toEqual(
        new Set([first.inputSourceState.sourceKey]),
      );
      expect(first.usage).toHaveLength(1);
      const initialJsonl = jsonl([
        header({ id: "synthetic-child" }),
        userInput("historical-input", ["user.text"], 1),
        turn(),
        modern("first-collected-response", counters(6, 4), 2, 2),
      ]);
      expect(first.fileCursors[0]?.byteOffset).toBe(Buffer.byteLength(initialJsonl));
      store.writeBatch({
        sources: [first.source],
        sessions: first.sessions,
        usage: first.usage,
        inputs: first.inputs,
        inputSourceStates: [first.inputSourceState],
        workIntervals: first.workIntervals,
        counterSnapshots: first.counterSnapshots,
        fileCursors: first.fileCursors,
      });

      const appended = JSON.stringify(modern("second-collected-response", counters(3, 2), 3, 3));
      const unterminated = JSON.stringify(modern("unterminated", counters(90, 10), 4, 4)).slice(0, -5);
      appendFileSync(rolloutPath, `${appended}\n${unterminated}`);
      const second = await codexAdapter.collect({
        config,
        store,
        rebuild: false,
        cutoffMs: BASE + 60_000,
        reconcileAll: false,
      });
      expect(second.usage).toHaveLength(2);
      expect(second.usage.reduce((sum, usage) => sum + (usage.total ?? 0), 0)).toBe(15);
      expect(second.fileCursors[0]?.byteOffset).toBe(
        Buffer.byteLength(initialJsonl) + Buffer.byteLength(`${appended}\n`),
      );
      expect(statSync(statePath).mtimeMs).toBe(sourceMtime);
      store.writeBatch({
        sources: [second.source],
        sessions: second.sessions,
        usage: second.usage,
        inputs: second.inputs,
        inputSourceStates: [second.inputSourceState],
        workIntervals: second.workIntervals,
        counterSnapshots: second.counterSnapshots,
        fileCursors: second.fileCursors,
      });
      writeFileSync(rolloutPath, jsonl([
        header({ id: "synthetic-child" }),
        turn(),
        modern("second-collected-response", counters(3, 2), 3, 3),
      ]));
      const replaced = await codexAdapter.collect({
        config,
        store,
        rebuild: false,
        cutoffMs: BASE + 60_000,
        reconcileAll: false,
      });
      expect(replaced.usage).toHaveLength(1);
      expect(replaced.usage[0]?.total).toBe(5);
    } finally {
      store.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("retries a partial first input backfill and advances success only after recovery", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "vito-codex-input-state-"));
    const sourceRoot = join(temporary, "codex");
    const stateDir = join(temporary, "state");
    const rolloutPath = join(sourceRoot, "rollout-input-state.jsonl");
    mkdirSync(sourceRoot);
    writeFileSync(rolloutPath, jsonl([
      header({ id: "input-state-session" }),
      userInput("input-state-id", null, 1),
    ]));
    const config: Config = {
      version: 1,
      workspaceRoots: ["/synthetic/workspace"],
      timezone: "UTC",
      stateDir,
      sources: { codex: [sourceRoot] },
      repositories: [],
      publication: { repository: "synthetic/activity", branch: "main" },
    };
    const store = CollectorStore.open(stateDir);
    try {
      const first = await codexAdapter.collect({
        config,
        store,
        rebuild: false,
        cutoffMs: BASE + 10_000,
        reconcileAll: false,
      });
      expect(first.inputSourceState).toMatchObject({
        quality: "partial",
        lastSuccessfulScanMs: null,
      });
      store.writeBatch({
        inputs: first.inputs,
        inputSourceStates: [first.inputSourceState],
        fileCursors: first.fileCursors,
      });

      writeFileSync(rolloutPath, jsonl([
        header({ id: "input-state-session" }),
        userInput("input-state-id", ["user.text"], 1),
      ]));
      const second = await codexAdapter.collect({
        config,
        store,
        rebuild: false,
        cutoffMs: BASE + 20_000,
        reconcileAll: false,
      });
      expect(second.inputSourceState).toMatchObject({
        quality: "recorded",
        lastSuccessfulScanMs: BASE + 20_000,
      });
      expect(second.inputs).toEqual([
        expect.objectContaining({ nativeInputId: "input-state-id", kind: "submission" }),
      ]);
    } finally {
      store.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("retains an aggregate partition gap without assigning it to a clean session", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "vito-codex-disappearing-gap-"));
    const sourceRoot = join(temporary, "codex");
    const stateDir = join(temporary, "state");
    const cleanPath = join(sourceRoot, "rollout-clean.jsonl");
    const malformedPath = join(sourceRoot, "rollout-malformed.jsonl");
    mkdirSync(sourceRoot);
    writeFileSync(cleanPath, jsonl([
      header({ id: "clean-session" }),
      userInput("clean-input", ["user.text"], 1),
    ]));
    writeFileSync(
      malformedPath,
      `${JSON.stringify(header({ id: "malformed-session" }))}\n{"malformed":\n`,
    );
    const config: Config = {
      version: 1,
      workspaceRoots: ["/synthetic/workspace"],
      timezone: "UTC",
      stateDir,
      sources: { codex: [sourceRoot] },
      repositories: [],
      publication: { repository: "synthetic/activity", branch: "main" },
    };
    const store = CollectorStore.open(stateDir);
    try {
      const first = await codexAdapter.collect({
        config,
        store,
        rebuild: false,
        cutoffMs: BASE + 10_000,
        reconcileAll: false,
      });
      expect(first.inputSourceState).toMatchObject({
        quality: "partial",
        reasons: ["input-history-incomplete"],
        lastSuccessfulScanMs: null,
      });
      store.writeBatch({
        inputs: first.inputs.map((input) => ({
          ...input,
          origin: "human" as const,
          originEvidence: "source" as const,
        })),
        inputSourceStates: [first.inputSourceState],
        fileCursors: first.fileCursors,
      });

      rmSync(malformedPath);
      const second = await codexAdapter.collect({
        config,
        store,
        rebuild: false,
        cutoffMs: BASE + 20_000,
        reconcileAll: false,
      });
      expect(second.inputSourceState).toMatchObject({
        quality: "partial",
        reasons: ["input-history-incomplete"],
        lastSuccessfulScanMs: null,
      });
      store.writeBatch({
        inputs: second.inputs,
        inputSourceStates: [second.inputSourceState],
        fileCursors: second.fileCursors,
      });

      const group = buildPublicSnapshot(config, store, BASE + 20_000).inputRanges["7"].all;
      expect(group.inputs.value).toEqual({
        inputs: 1,
        activeSessions: 1,
      });
      expect(group.cadence.value).toBeNull();
      expect(group.cadenceCoverage.excluded).toEqual({
        inputHistory: 0,
        mixedScope: 0,
        noRecordedWork: 1,
      });
    } finally {
      store.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("keeps aggregate input coverage partial when a previously scanned partition becomes unsupported", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "vito-codex-partition-state-"));
    const sourceRoot = join(temporary, "codex");
    const stateDir = join(temporary, "state");
    const firstPath = join(sourceRoot, "rollout-first.jsonl");
    const secondPath = join(sourceRoot, "rollout-second.jsonl");
    mkdirSync(sourceRoot);
    writeFileSync(firstPath, jsonl([
      header({ id: "partition-first" }),
      userInput("partition-first-input", ["user.text"], 1),
    ]));
    writeFileSync(secondPath, jsonl([
      header({ id: "partition-second" }),
      userInput("partition-second-input", ["user.text"], 1),
    ]));
    const config: Config = {
      version: 1,
      workspaceRoots: ["/synthetic/workspace"],
      timezone: "UTC",
      stateDir,
      sources: { codex: [sourceRoot] },
      repositories: [],
      publication: { repository: "synthetic/activity", branch: "main" },
    };
    const store = CollectorStore.open(stateDir);
    try {
      const first = await codexAdapter.collect({
        config,
        store,
        rebuild: false,
        cutoffMs: BASE + 10_000,
        reconcileAll: false,
      });
      expect(first.inputSourceState).toMatchObject({
        quality: "recorded",
        reasons: [],
        lastSuccessfulScanMs: BASE + 10_000,
      });
      store.writeBatch({
        inputSourceStates: [first.inputSourceState],
        fileCursors: first.fileCursors,
      });

      writeFileSync(secondPath, jsonl([
        header({ id: "partition-second", version: 2 }),
      ]));
      const second = await codexAdapter.collect({
        config,
        store,
        rebuild: false,
        cutoffMs: BASE + 20_000,
        reconcileAll: false,
      });
      expect(second.inputSourceState).toMatchObject({
        quality: "partial",
        reasons: ["input-history-incomplete"],
        lastSuccessfulScanMs: BASE + 10_000,
      });
    } finally {
      store.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
