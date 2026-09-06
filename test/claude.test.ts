import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config";
import {
  claudeAdapter,
  normalizeClaudeRecords,
  type ClaudeRawRecord,
} from "../src/sources/claude";
import { CollectorStore } from "../src/store";


const FIRST = "2026-04-02T10:00:00.000Z";
const LATER = "2026-04-02T10:01:00.000Z";

function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "assistant",
    sessionId: "parent-session",
    cwd: "/synthetic/company/project",
    timestamp: FIRST,
    uuid: "transcript-block-a",
    requestId: "request-one",
    message: {
      id: "message-one",
      model: "claude-synthetic",
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 13_844,
        cache_creation_input_tokens: 8_310,
        output_tokens: 200,
      },
    },
    ...overrides,
  };
}

function raw(
  record: unknown,
  sourcePath: string | undefined = "/synthetic/original.jsonl",
  lineNumber = 1,
  sourceCreatedMs = 1,
): ClaudeRawRecord {
  return { record, sourcePath: sourcePath ?? "/synthetic/original.jsonl", lineNumber, sourceCreatedMs };
}

function withMessage(record: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  return { ...record, message: { ...(record.message as Record<string, unknown>), ...changes } };
}

describe("Claude normalization", () => {
  test("deduplicates repeated assistant blocks and treats prompt buckets as disjoint", () => {
    const first = assistant({ uuid: "thinking-block" });
    const second = assistant({ uuid: "text-block" });
    const third = assistant({ uuid: "tool-use-block" });
    const result = normalizeClaudeRecords([raw(first, undefined, 1), raw(second, undefined, 2), raw(third, undefined, 3)]);

    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({
      uncachedInput: 2,
      cacheRead: 13_844,
      cacheWrite: 8_310,
      output: 200,
      reasoning: null,
      total: 22_356,
      costMicrousd: null,
      costKind: "unknown",
      quality: "recorded",
    });
    expect(result.diagnosticCounts.duplicateObservations).toBe(2);
    expect(result.workIntervals).toEqual([]);
  });

  test("uses the first observation timestamp with the latest complete counters", () => {
    const incomplete = withMessage(assistant(), {
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 13_844,
        output_tokens: 200,
      },
    });
    const complete = withMessage(assistant({ timestamp: LATER, uuid: "completed-block" }), {
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 4,
        output_tokens: 5,
        output_tokens_details: { thinking_tokens: 2 },
      },
    });
    const result = normalizeClaudeRecords([raw(incomplete, undefined, 1), raw(complete, undefined, 2)]);

    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({
      atMs: Date.parse(FIRST),
      uncachedInput: 3,
      cacheRead: 20,
      cacheWrite: 4,
      output: 5,
      reasoning: 2,
      total: 32,
    });
  });

  test("counts independent parent and child calls while assigning the child an independent lane", () => {
    const parent = assistant();
    const child = assistant({
      agentId: "child-agent",
      cwd: undefined,
      timestamp: LATER,
      uuid: "child-transcript-block",
      requestId: "request-child",
      message: {
        id: "message-child",
        model: "claude-synthetic",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 30,
        },
      },
    });
    const result = normalizeClaudeRecords([
      raw(parent, "/synthetic/parent-session.jsonl", 1),
      raw(child, "/synthetic/parent-session/subagents/agent-child.jsonl", 1, 2),
    ]);

    expect(result.usage).toHaveLength(2);
    expect(result.usage.reduce((sum, usage) => sum + (usage.total ?? 0), 0)).toBe(22_396);
    expect(new Set(result.usage.map((usage) => usage.sessionKey)).size).toBe(2);
    const childUsage = result.usage.find((usage) => usage.total === 40);
    expect(childUsage?.workspaceKey).toBe("/synthetic/company/project");
    const childSession = result.sessions.find((session) => session.sessionKey === childUsage?.sessionKey);
    expect(childSession?.parentSessionKey).not.toBeNull();
  });

  test("keeps canonical original ownership when a fork replays the same response", () => {
    const original = assistant({ cwd: "/synthetic/outside" });
    const copied = assistant({
      sessionId: "fork-session",
      cwd: "/synthetic/company/project",
      uuid: "fork-copy-block",
    });
    const branchCall = assistant({
      sessionId: "fork-session",
      cwd: "/synthetic/company/project",
      timestamp: LATER,
      uuid: "fork-new-block",
      requestId: "fork-new-request",
      message: {
        id: "fork-new-message",
        model: "claude-synthetic",
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 2,
        },
      },
    });
    const result = normalizeClaudeRecords([
      raw(original, "/synthetic/original.jsonl", 1, 1),
      raw(copied, "/synthetic/fork.jsonl", 1, 2),
      raw(branchCall, "/synthetic/fork.jsonl", 2, 2),
    ]);

    expect(result.usage).toHaveLength(2);
    expect(result.usage.reduce((sum, usage) => sum + (usage.total ?? 0), 0)).toBe(22_359);
    const inherited = result.usage.find((usage) => usage.total === 22_356);
    expect(inherited?.workspaceKey).toBe("/synthetic/outside");
    expect(result.diagnosticCounts.forkCopies).toBe(1);
  });

  test("ignores parent aggregates, cost-state, and turn-duration as accounting or work", () => {
    const parentSummary = {
      type: "user",
      sessionId: "parent-session",
      cwd: "/synthetic/company/project",
      timestamp: LATER,
      message: { usage: { input_tokens: 999_999 } },
      toolUseResult: { usage: { input_tokens: 999_999 } },
    };
    const costState = {
      type: "cost-state",
      sessionId: "parent-session",
      cwd: "/synthetic/company/project",
      timestamp: LATER,
      totalCostUSD: 999,
    };
    const duration = {
      type: "system",
      subtype: "turn_duration",
      sessionId: "parent-session",
      cwd: "/synthetic/company/project",
      timestamp: LATER,
      durationMs: 60_000,
    };
    const result = normalizeClaudeRecords([raw(assistant()), raw(parentSummary, undefined, 2), raw(costState, undefined, 3), raw(duration, undefined, 4)]);

    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]?.total).toBe(22_356);
    expect(result.workIntervals).toEqual([]);
    expect(result.diagnosticCounts.ignoredParentSummaries).toBe(2);
  });
});
describe("Claude adapter collection", () => {
  test("upgrades an appended incomplete response once without moving its first timestamp", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vito-claude-collect-test-"));
    const sourceDirectory = join(directory, "source");
    const workspace = join(directory, "workspace");
    mkdirSync(sourceDirectory);
    mkdirSync(workspace);
    const sourcePath = join(sourceDirectory, "session-one.jsonl");
    const incomplete = withMessage(assistant({ cwd: workspace }), {
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 20,
        output_tokens: 5,
      },
    });
    const complete = withMessage(assistant({ cwd: workspace, timestamp: LATER, uuid: "completed-block" }), {
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 4,
        output_tokens: 5,
      },
    });
    writeFileSync(sourcePath, `${JSON.stringify(incomplete)}\n`);

    const config = {
      version: 1,
      workspaceRoots: [workspace],
      timezone: "UTC",
      stateDir: join(directory, "state"),
      sources: { claude: [sourceDirectory], codex: [], omp: [], opencode: [], hermes: [] },
      repositories: [],
      publication: { repository: "synthetic/activity", branch: "main" },
    } satisfies Config;
    const store = CollectorStore.open(config.stateDir);
    try {
      const context = {
        config,
        store,
        rebuild: false,
        cutoffMs: Date.parse("2026-04-02T11:00:00.000Z"),
        reconcileAll: false,
      };
      const first = await claudeAdapter.collect(context);
      expect(first.usage).toHaveLength(1);
      expect(first.usage[0]?.total).toBeNull();
      store.writeBatch({
        sources: [first.source],
        sessions: first.sessions,
        usage: first.usage,
        fileCursors: first.fileCursors,
      });

      appendFileSync(sourcePath, `${JSON.stringify(complete)}\n`);
      const second = await claudeAdapter.collect(context);
      expect(second.usage).toHaveLength(1);
      expect(second.usage[0]).toMatchObject({ atMs: Date.parse(FIRST), total: 32 });
      store.writeBatch({
        sources: [second.source],
        sessions: second.sessions,
        usage: second.usage,
        fileCursors: second.fileCursors,
      });

      expect(
        store.database.query("SELECT count(*) AS count FROM usage").get(),
      ).toEqual({ count: 1 });
      expect(
        store.database.query("SELECT at_ms, total FROM usage").get(),
      ).toEqual({ at_ms: Date.parse(FIRST), total: 32 });
      expect(second.source.workQuality).toBe("unavailable");
      expect(second.workIntervals).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});


describe("Claude discovery", () => {
  test("recognizes only parent and subagent JSONL and reports timing as unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vito-claude-test-"));
    try {
      const project = join(directory, "project");
      const subagents = join(project, "session-one", "subagents");
      const toolResults = join(project, "tool-results");
      mkdirSync(subagents, { recursive: true });
      mkdirSync(toolResults, { recursive: true });
      writeFileSync(join(project, "session-one.jsonl"), `${JSON.stringify(assistant())}\n`);
      writeFileSync(join(subagents, "agent-child.jsonl"), `${JSON.stringify(assistant({ agentId: "child-agent" }))}\n`);
      writeFileSync(join(subagents, "not-an-agent.jsonl"), `${JSON.stringify(assistant())}\n`);
      writeFileSync(join(toolResults, "copied.jsonl"), `${JSON.stringify(assistant())}\n`);
      writeFileSync(join(project, "history.jsonl"), `${JSON.stringify(assistant())}\n`);

      const config = {
        version: 1,
        workspaceRoots: [directory],
        timezone: "UTC",
        stateDir: join(directory, "state"),
        sources: { claude: [directory], codex: [], omp: [], opencode: [], hermes: [] },
        repositories: [],
        publication: { repository: "synthetic/activity", branch: "main" },
      } satisfies Config;
      const [entry] = await claudeAdapter.discover(config);
      expect(entry).toMatchObject({
        agent: "claude",
        state: "available",
        capabilities: { tokens: "recorded", work: "unavailable" },
        diagnosticCounts: { recognizedFiles: 2 },
        reasons: ["timing-unavailable"],
      });

      const disabled = { ...config, sources: { ...config.sources, claude: [] } } satisfies Config;
      const [disabledEntry] = await claudeAdapter.discover(disabled);
      expect(disabledEntry?.state).toBe("not-found");
      expect(disabledEntry?.capabilities.work).toBe("unavailable");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
