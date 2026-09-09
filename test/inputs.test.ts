import { describe, expect, test } from "bun:test";

import type { InputRecord } from "../src/contracts";
import { inputRecordSchema, inputSourceStateSchema } from "../src/contracts";
import { mergeInputRecords } from "../src/inputs";

function input(overrides: Partial<InputRecord> = {}): InputRecord {
  return {
    originKey: "codex:input:stable",
    sourceKey: "codex:file:one",
    agent: "codex",
    sessionKey: "session-b",
    nativeSessionId: "native-b",
    nativeInputId: "input-one",
    workspaceKey: "/workspace",
    repositoryKey: null,
    atMs: 200,
    kind: "submission",
    lane: "main",
    controller: null,
    origin: "unknown",
    originEvidence: "none",
    quality: "recorded",
    reasons: [],
    ...overrides,
  };
}

describe("input ledger contracts", () => {
  test("strictly validates private records and controller bounds", () => {
    expect(inputRecordSchema.parse(input())).toEqual(input());
    expect(() => inputRecordSchema.parse({ ...input(), controller: "" })).toThrow();
    expect(() => inputRecordSchema.parse({ ...input(), controller: "x".repeat(129) })).toThrow();
    expect(() => inputRecordSchema.parse({ ...input(), nativeInputId: "", extra: true })).toThrow();
    expect(() => inputRecordSchema.parse({ ...input(), reasons: ["unbounded-reason"] })).toThrow();
    expect(() => inputRecordSchema.parse({ ...input(), origin: "human", originEvidence: "none" })).toThrow();
    expect(() => inputSourceStateSchema.parse({
      sourceKey: "codex",
      agent: "codex",
      parserVersion: 1,
      quality: "recorded",
      reasons: [],
      scannedAtMs: 1,
      lastSuccessfulScanMs: 1,
    })).not.toThrow();
  });
});

describe("mergeInputRecords", () => {
  test("chooses the earliest dated owner before marking incompatible copies partial", () => {
    const later = input({ sessionKey: "session-b", nativeSessionId: "native-b", atMs: 200 });
    const earlier = input({ sessionKey: "session-a", nativeSessionId: "native-a", atMs: 100 });
    const expected = { ...earlier, kind: "unknown" as const, quality: "partial" as const, reasons: ["input-kind-unknown"] };
    expect(mergeInputRecords([later, earlier])).toEqual([expected]);
    expect(mergeInputRecords([earlier, later])).toEqual([expected]);
  });

  test("sorts null timestamps last and breaks equal timestamps by session key", () => {
    const undated = input({ sessionKey: "session-a", nativeSessionId: "native-a", atMs: null });
    const datedB = input({ sessionKey: "session-b", nativeSessionId: "native-b", atMs: 100 });
    const datedA = input({ sessionKey: "session-a", nativeSessionId: "native-a", atMs: 100 });
    expect(mergeInputRecords([undated, datedB])[0]?.sessionKey).toBe("session-b");
    expect(mergeInputRecords([datedB, datedA])[0]?.sessionKey).toBe("session-a");
  });

  test("retains an established owner while accepting a corrected owner classification", () => {
    const retained = input({ sessionKey: "session-b", nativeSessionId: "native-b", atMs: 200, kind: "unknown", quality: "partial", reasons: ["input-kind-unknown"] });
    const copiedEarlier = input({ sessionKey: "session-a", nativeSessionId: "native-a", atMs: 200 });
    const correctedOwner = input({ sessionKey: "session-b", nativeSessionId: "native-b", atMs: 200, kind: "context", quality: "recorded", reasons: [] });
    expect(mergeInputRecords([copiedEarlier, correctedOwner], [retained])).toEqual([correctedOwner]);
  });

  test("turns incompatible copy timestamps into one partial unknown observation", () => {
    const first = input({ sessionKey: "session-a", nativeSessionId: "native-a", atMs: 100 });
    const copy = input({ sessionKey: "session-b", nativeSessionId: "native-b", atMs: 200 });
    expect(mergeInputRecords([copy, first])).toEqual([{ ...first, kind: "unknown", quality: "partial", reasons: ["input-kind-unknown"] }]);
  });

  test("keeps explicit evidence when an unknown rescan arrives", () => {
    const retained = input({ origin: "human", originEvidence: "provenance", controller: "runner" });
    expect(mergeInputRecords([input()], [retained])).toEqual([retained]);
  });

  test("makes contrary explicit origins a sticky conflict without degrading volume quality", () => {
    const human = input({ origin: "human", originEvidence: "source", controller: "runner-a" });
    const automated = input({ origin: "automated", originEvidence: "provenance", controller: "runner-b" });
    const conflict = {
      ...human,
      controller: null,
      origin: "unknown" as const,
      originEvidence: "conflict" as const,
      quality: "recorded" as const,
      reasons: ["input-origin-conflict"],
    };
    expect(mergeInputRecords([automated], [human])).toEqual([conflict]);
    expect(mergeInputRecords([human], [conflict])).toEqual([conflict]);
  });

  test("merges identical claims idempotently and nulls only disagreeing controllers", () => {
    const first = input({ origin: "human", originEvidence: "source", controller: "runner-a" });
    const second = input({ origin: "human", originEvidence: "provenance", controller: "runner-b" });
    expect(mergeInputRecords([second, second], [first])).toEqual([{ ...first, controller: null }]);
  });
});
