import { describe, expect, test } from "bun:test";
import type { UsageRecord } from "../src/contracts";
import { priceUsage } from "../src/pricing";

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    originKey: "price-request", agent: "codex", sessionKey: "session", workspaceKey: "/workspace",
    repositoryKey: null, turnKey: null, requestKey: null, atMs: 1,
    provider: "openai", model: "gpt-5.6-sol",
    uncachedInput: 1000, cacheRead: 2000, cacheWrite: 100, output: 500, reasoning: 400, total: 3600,
    costMicrousd: null, costKind: "unknown", quality: "recorded", reasons: [],
    ...overrides,
  };
}

describe("API-equivalent request valuation", () => {
  test("charges disjoint buckets once regardless of source amounts or included plans", () => {
    // $0.004 input + $0.0008 cache reads + $0.0005 writes + $0.01 output.
    expect(priceUsage(usage()).usd).toBe(0.0153);
    expect(priceUsage(usage({ costKind: "included", costMicrousd: 0 })).usd).toBe(0.0153);
    expect(priceUsage(usage({ costKind: "provider-reported", costMicrousd: 9_000_000, reasoning: 0 })).usd).toBe(0.0153);
  });

  test("switches the full request tariff only above the cached-inclusive prompt boundary", () => {
    const short = usage({ uncachedInput: 2000, cacheRead: 270_000, cacheWrite: 0, output: 1000, total: 273_000 });
    expect(priceUsage(short).usd).toBe(0.136);
    expect(priceUsage({ ...short, cacheRead: 270_001, total: 273_001 }).usd).toBe(0.2620008);
    // Output length cannot trigger a long-prompt tariff.
    expect(priceUsage({ ...short, output: 100_000, total: 372_000 }).usd).toBe(2.116);
  });

  test("values coding-plan models at their first-party API prices rather than zero", () => {
    const kimi = usage({ provider: "kimi-for-coding", model: "k3", uncachedInput: 1000, cacheRead: 2000, cacheWrite: 0, output: 500, total: 3500 });
    expect(priceUsage(kimi).usd).toBe(0.0111);
    expect(priceUsage({ ...kimi, provider: "moonshotai", model: "kimi-k3" }).usd).toBe(0.0111);
    expect(priceUsage({ ...kimi, provider: "zai-coding-plan", model: "glm-5.2" }).usd).toBe(0.00412);
    expect(priceUsage({ ...kimi, provider: "unrelated-provider" })).toEqual({ usd: null, reason: "unpriced-model" });
  });

  test("uses the pinned five-minute cache-write tariff for Claude without double-counting input", () => {
    expect(priceUsage(usage({ provider: "unknown", model: "claude-opus-5" })).usd).toBe(0.019125);
  });

  test("distinguishes unpriced usage, incomplete counters, and genuine zero", () => {
    expect(priceUsage(usage({ model: "gpt-5.6-sol-unknown-revision" }))).toEqual({ usd: null, reason: "unpriced-model" });
    expect(priceUsage(usage({ uncachedInput: null, cacheWrite: null }))).toEqual({ usd: null, reason: "incomplete-token-breakdown" });
    expect(priceUsage(usage({ total: 3601 }))).toEqual({ usd: null, reason: "incomplete-token-breakdown" });
    expect(priceUsage(usage({ reasoning: 501 }))).toEqual({ usd: null, reason: "incomplete-token-breakdown" });
    expect(priceUsage(usage({ model: "unknown", uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 })))
      .toEqual({ usd: 0, reason: null });
    expect(priceUsage(usage({ model: "gpt-5.5" }))).toEqual({ usd: null, reason: "unpriced-model" });
  });

  test("preserves sub-microdollar usage and refuses unsafe money arithmetic", () => {
    expect(priceUsage(usage({ model: "gpt-5.6-luna", uncachedInput: 0, cacheRead: 1, cacheWrite: 0, output: 0, reasoning: 0, total: 1 })).usd).toBe(0.00000002);
    expect(priceUsage(usage({ uncachedInput: Number.MAX_SAFE_INTEGER, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: Number.MAX_SAFE_INTEGER })))
      .toEqual({ usd: null, reason: "parse-gap" });
  });
});
