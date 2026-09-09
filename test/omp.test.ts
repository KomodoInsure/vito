import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config";
import {
  discoverOmpSessionFiles,
  normalizeOmpSessions,
  ompAdapter,
  type OmpSessionInput,
} from "../src/sources/omp";
import { CollectorStore } from "../src/store";

const workspace = "/synthetic/company/project";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixtureConfig(sourcePaths: string[]): Config {
  return {
    version: 1,
    workspaceRoots: [workspace],
    timezone: "UTC",
    stateDir: "/synthetic/state",
    sources: { omp: sourcePaths },
    repositories: [],
    publication: { repository: "fixture/activity", branch: "main" },
  };
}

function header(id: string, timestamp: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "session", version: 3, id, cwd: workspace, timestamp, ...extra };
}

function assistant(
  id: string,
  responseId: string,
  input: number,
  output: number,
  options: {
    at?: string;
    start?: number;
    end?: number;
    cost?: number;
    total?: number;
    parentId?: string;
    model?: string;
  } = {},
): Record<string, unknown> {
  const at = options.at ?? "2026-09-06T12:00:02.000Z";
  return {
    type: "message",
    id,
    parentId: options.parentId ?? "branch-root",
    timestamp: at,
    message: {
      role: "assistant",
      responseId,
      provider: "synthetic-provider",
      model: options.model ?? "synthetic-model",
      timestamp: options.start ?? Date.parse(at) - 1_000,
      completedAt: options.end ?? Date.parse(at),
      usage: {
        input,
        cacheRead: 0,
        cacheWrite: 0,
        output,
        reasoningTokens: 0,
        totalTokens: options.total ?? input + output,
        cost: { total: options.cost ?? 0 },
      },
    },
  };
}

function user(
  id: string,
  at: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId: "parent",
    timestamp: at,
    message: {
      role: "user",
      content: [{ type: "text", text: "private input" }],
      timestamp: Date.parse(at),
      attribution: "user",
      ...overrides,
    },
  };
}

describe("OMP discovery", () => {
  test("accepts version-3 headers after a title and only recognized parent/child files", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vito-omp-")));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const parent = join(project, "2026-09-06T12-00-00_parent.jsonl");
    const artifacts = parent.slice(0, -".jsonl".length);
    const child = join(artifacts, "agent-child.jsonl");
    const ignored = join(project, "unrelated.jsonl");
    const ignoredLocal = join(artifacts, "local", "copy.jsonl");
    mkdirSync(join(artifacts, "local"), { recursive: true });
    writeFileSync(parent, [
      JSON.stringify({ type: "title", title: "synthetic fixture" }),
      JSON.stringify(header("parent", "2026-09-06T12:00:00.000Z")),
      "",
    ].join("\n"));
    writeFileSync(child, `${JSON.stringify(header("child", "2026-09-06T12:00:01.000Z", { parentSession: "parent" }))}\n`);
    writeFileSync(ignored, `${JSON.stringify(header("ignored", "2026-09-06T12:00:02.000Z"))}\n`);
    writeFileSync(ignoredLocal, `${JSON.stringify(header("ignored-local", "2026-09-06T12:00:03.000Z"))}\n`);

    const config = fixtureConfig([root]);
    expect(discoverOmpSessionFiles(config)).toEqual([child, parent].sort());
    await expect(ompAdapter.discover(config)).resolves.toEqual([
      expect.objectContaining({
        agent: "omp",
        state: "available",
        capabilities: { tokens: "recorded", work: "partial" },
        paths: [child, parent].sort(),
      }),
    ]);
  });
});

describe("OMP normalization", () => {
  test("deduplicates inherited fork history, preserves the original estimate, and counts new branch and child calls", () => {
    const originalPath = "/synthetic/sessions/project/2026-09-06T12-00-00_original.jsonl";
    const forkPath = "/synthetic/sessions/project/2026-09-06T12-05-00_fork.jsonl";
    const childPath = "/synthetic/sessions/project/2026-09-06T12-00-00_original/agent-child.jsonl";
    const inherited = assistant("entry-inherited", "response-inherited", 80, 20, { cost: 0.25 });
    const copiedWithZeroCost = structuredClone(inherited);
    ((copiedWithZeroCost.message as Record<string, unknown>).usage as Record<string, unknown>).cost = { total: 0 };

    const inputs: OmpSessionInput[] = [
      {
        path: originalPath,
        records: [
          { type: "title", title: "synthetic fixture" },
          header("original", "2026-09-06T12:00:00.000Z"),
          inherited,
        ],
      },
      {
        path: forkPath,
        records: [
          header("fork", "2026-09-06T12:05:00.000Z", { previousSessionFiles: [originalPath] }),
          copiedWithZeroCost,
          assistant("entry-new", "response-new", 15, 5, { at: "2026-09-06T12:05:02.000Z" }),
        ],
      },
      {
        path: childPath,
        records: [
          header("child", "2026-09-06T12:01:00.000Z", { parentSession: "original" }),
          assistant("entry-child", "response-child", 30, 10, { at: "2026-09-06T12:01:02.000Z" }),
        ],
      },
    ];

    const result = normalizeOmpSessions(inputs);

    expect(result.usage.map((record) => record.total).sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual([20, 40, 100]);
    expect(result.usage.reduce((sum, record) => sum + (record.total ?? 0), 0)).toBe(160);
    expect(result.usage.filter((record) => record.costKind === "source-estimate")).toHaveLength(1);
    expect(result.usage.find((record) => record.total === 100)?.costMicrousd).toBe(250_000);
    expect(result.workIntervals).toHaveLength(3);

    const childSession = result.sessions.find((session) => session.sessionKey === result.usage.find((record) => record.total === 40)?.sessionKey);
    expect(childSession?.parentSessionKey).not.toBeNull();
    expect(childSession?.rootSessionKey).toBe(childSession?.parentSessionKey);
  });

  test("deduplicates message/model_usage mirrors by provider response identity without discarding independent branches", () => {
    const message = assistant("assistant-entry", "shared-response", 20, 5, { parentId: "branch-a" });
    const mirror = {
      type: "model_usage",
      id: "usage-entry",
      parentId: "branch-a",
      timestamp: "2026-09-06T12:00:02.000Z",
      responseId: "shared-response",
      provider: "synthetic-provider",
      model: "synthetic-model",
      usage: {
        input: 20,
        cacheRead: 0,
        cacheWrite: 0,
        output: 5,
        reasoningTokens: 0,
        totalTokens: 25,
        cost: { total: 0 },
      },
    };
    const otherBranch = assistant("other-entry", "other-response", 20, 5, { parentId: "branch-b", at: "2026-09-06T12:00:04.000Z" });

    const result = normalizeOmpSessions([{
      path: "/synthetic/sessions/project/2026-09-06T12-00-00_session.jsonl",
      records: [header("session", "2026-09-06T12:00:00.000Z"), message, mirror, otherBranch],
    }]);

    expect(result.usage).toHaveLength(2);
    expect(result.usage.reduce((sum, record) => sum + (record.total ?? 0), 0)).toBe(50);
    expect(result.workIntervals).toHaveLength(2);
  });

  test("retains orchestration residuals, treats zero cost as unknown, and never manufactures missing intervals", () => {
    const valid = assistant("valid", "response-valid", 10, 5, {
      start: 1_000,
      end: 2_000,
      total: 22,
      cost: 0,
    });
    const completionAndDurationOnly = assistant("duration-only", "response-duration", 4, 1, {
      at: "2026-09-06T12:00:03.000Z",
      start: 2_000,
      end: 3_000,
    });
    const durationMessage = completionAndDurationOnly.message as Record<string, unknown>;
    delete durationMessage.timestamp;
    durationMessage.duration = 1_000;
    const open = assistant("open", "response-open", 3, 1, { at: "2026-09-06T12:00:04.000Z" });
    delete (open.message as Record<string, unknown>).completedAt;
    const toolAggregate = {
      type: "message",
      id: "tool-result",
      timestamp: "2026-09-06T12:00:05.000Z",
      message: {
        role: "toolResult",
        completedAt: 5_000,
        details: {
          usage: { input: 9_999, cacheRead: 0, cacheWrite: 0, output: 9_999, totalTokens: 19_998 },
        },
      },
    };
    const standalone = {
      type: "model_usage",
      id: "standalone",
      timestamp: "2026-09-06T12:00:06.000Z",
      provider: "synthetic-provider",
      model: "synthetic-model",
      usage: { input: 2, cacheRead: 3, cacheWrite: 4, output: 5, reasoningTokens: 2, totalTokens: 14, cost: { total: 0 } },
    };

    const result = normalizeOmpSessions([{
      path: "/synthetic/sessions/project/2026-09-06T12-00-00_timing.jsonl",
      records: [header("timing", "2026-09-06T12:00:00.000Z"), valid, completionAndDurationOnly, open, toolAggregate, standalone],
    }]);

    expect(result.usage).toHaveLength(4);
    expect(result.usage.some((record) => record.total === 19_998)).toBe(false);
    expect(result.usage.find((record) => record.total === 22)).toMatchObject({
      uncachedInput: 10,
      output: 5,
      total: 22,
      costMicrousd: null,
      costKind: "unknown",
      quality: "recorded",
    });
    expect(result.usage.find((record) => record.total === 14)?.output).toBe(5);
    expect(result.usage.find((record) => record.total === 14)?.reasoning).toBe(2);
    expect(result.workIntervals).toEqual([
      expect.objectContaining({ startMs: 1_000, endMs: 2_000, kind: "inference" }),
    ]);
    expect(result.diagnosticCounts["timing-unavailable"]).toBe(3);
    expect(result.diagnosticCounts["open-interval"]).toBe(1);
  });

  test("rejects unsupported headers and marks malformed component accounting partial", () => {
    const invalidUsage = assistant("invalid", "response-invalid", 4, 1);
    ((invalidUsage.message as Record<string, unknown>).usage as Record<string, unknown>).cacheRead = -1;
    const result = normalizeOmpSessions([
      {
        path: "/synthetic/sessions/project/2026-09-06T12-00-00_bad-version.jsonl",
        records: [{ type: "session", version: 2, id: "old", cwd: workspace }],
      },
      {
        path: "/synthetic/sessions/project/2026-09-06T12-01-00_partial.jsonl",
        records: [header("partial", "2026-09-06T12:01:00.000Z"), invalidUsage],
      },
    ]);

    expect(result.sessions).toHaveLength(1);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({ cacheRead: null, quality: "partial", reasons: ["parse-gap"] });
  });
  test("classifies ordinary and steering submissions and persists family replays", () => {
    const originalPath = "/synthetic/sessions/project/2026-09-06T12-00-00_original.jsonl";
    const forkPath = "/synthetic/sessions/project/2026-09-06T12-05-00_fork.jsonl";
    const copied = user("shared-entry", "2026-09-06T12:00:01.000Z");
    const result = normalizeOmpSessions([
      {
        path: originalPath,
        records: [
          header("original", "2026-09-06T12:00:00.000Z"),
          copied,
          user("ordinary", "2026-09-06T12:00:02.000Z"),
          user("steering", "2026-09-06T12:00:03.000Z", { steering: true }),
        ],
      },
      {
        path: forkPath,
        records: [
          header("fork", "2026-09-06T12:05:00.000Z", { previousSessionFiles: [originalPath] }),
          structuredClone(copied),
          user("new-fork-input", "2026-09-06T12:05:01.000Z"),
        ],
      },
    ]);

    expect(result.inputs.filter((input) => input.kind === "submission")).toHaveLength(4);
    expect(result.inputs.filter((input) => input.kind === "replay")).toHaveLength(1);
    expect(result.inputs.find((input) => input.nativeSessionId === "fork" && input.nativeInputId === "shared-entry"))
      .toMatchObject({ kind: "replay" });
    expect(result.inputs.every((input) => input.origin === "unknown" && input.controller === null)).toBe(true);
    expect(new Set(result.inputs.map((input) => input.originKey)).size).toBe(5);
  });

  test("marks unestablished attribution and missing-predecessor ambiguity without inventing submissions", () => {
    const missing = "/synthetic/sessions/project/missing-original.jsonl";
    const result = normalizeOmpSessions([{
      path: "/synthetic/sessions/project/2026-09-06T12-05-00_copy.jsonl",
      records: [
        header("copy", "2026-09-06T12:05:00.000Z", { previousSessionFiles: [missing] }),
        user("predating", "2026-09-06T12:00:00.000Z"),
        user("ambiguous", "2026-09-06T12:06:00.000Z"),
        user("unsupported-attribution", "2026-09-06T12:07:00.000Z", { attribution: "system" }),
      ],
    }]);
    expect(Object.fromEntries(result.inputs.map((input) => [input.nativeInputId, input.kind]))).toEqual({
      predating: "replay",
      ambiguous: "unknown",
      "unsupported-attribution": "unknown",
    });
    expect(result.inputQuality).toBe("partial");
    expect(result.inputReasons).toContain("input-history-incomplete");
  });

  test("uses a unique native-session origin while retaining family metadata", () => {
    const originalPath = "/synthetic/sessions/project/2026-09-06T12-00-00_original.jsonl";
    const result = normalizeOmpSessions([
      { path: originalPath, records: [header("original", "2026-09-06T12:00:00.000Z")] },
      {
        path: "/synthetic/sessions/project/2026-09-06T12-05-00_fork.jsonl",
        records: [header("fork", "2026-09-06T12:05:00.000Z", { previousSessionFiles: [originalPath] })],
      },
    ]);
    expect(result.sessions[0]?.originKey).not.toBe(result.sessions[1]?.originKey);
    expect(new Set(result.sessions.map((session) => session.canonicalSessionKey)).size).toBe(1);
  });

  test("preserves a stored replay when its original file disappears", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vito-omp-replay-")));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const path = join(project, "2026-09-06T12-05-00_fork.jsonl");
    const records = [
      header("fork", "2026-09-06T12:05:00.000Z"),
      user("shared-entry", "2026-09-06T12:05:01.000Z"),
    ];
    mkdirSync(project, { recursive: true });
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const stateDir = join(root, "state");
    const store = CollectorStore.open(stateDir);
    try {
      const retained = normalizeOmpSessions([{ path, records }]).inputs[0]!;
      store.writeBatch({ inputs: [{ ...retained, kind: "replay" }] });
      const config = { ...fixtureConfig([root]), stateDir };
      const batch = await ompAdapter.collect({
        config,
        store,
        rebuild: true,
        cutoffMs: Date.parse("2026-09-07T00:00:00.000Z"),
        reconcileAll: true,
      });
      expect(batch.inputs.find((input) => input.nativeInputId === "shared-entry")?.kind).toBe("replay");
    } finally {
      store.close();
    }
  });

});
