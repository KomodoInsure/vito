import type { UsageRecord } from "./contracts";

/** Current-rate valuation, not an attempt to reconstruct historical invoices. */
export const PRICING_METADATA = {
  asOf: "2026-09-06",
  basis: "standard-api" as const,
  sources: [
    "https://developers.openai.com/api/docs/pricing",
    "https://platform.claude.com/docs/en/about-claude/pricing",
    "https://platform.kimi.ai/docs/pricing/chat-k3",
    "https://docs.z.ai/guides/overview/pricing",
    "https://ai.google.dev/gemini-api/docs/pricing",
  ],
};

interface Rates {
  /** USD per million tokens. Null means this bucket has no published rate. */
  input: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number;
}

interface ModelPrice extends Rates {
  longContext?: Rates & { aboveInputTokens: number };
}

// Canonical first-party API prices, independent of the harness or subscription.
// Cache-write prices use the standard five-minute duration where applicable.
const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-6-astra": {
    input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50,
    longContext: { aboveInputTokens: 272_000, input: 20, cacheRead: 2, cacheWrite: 25, output: 75 },
  },
  "gpt-5.6-sol": {
    input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20,
    longContext: { aboveInputTokens: 272_000, input: 8, cacheRead: 0.8, cacheWrite: 10, output: 30 },
  },
  "gpt-5.6-terra": {
    input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12,
    longContext: { aboveInputTokens: 272_000, input: 4, cacheRead: 0.4, cacheWrite: 5, output: 18 },
  },
  "gpt-5.6-luna": {
    input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2,
    longContext: { aboveInputTokens: 272_000, input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 },
  },
  "gpt-5.5": {
    input: 5, cacheRead: 0.5, cacheWrite: null, output: 30,
    longContext: { aboveInputTokens: 272_000, input: 10, cacheRead: 1, cacheWrite: null, output: 45 },
  },
  "claude-fable-5": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "claude-fable-5.1": { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "kimi-k3": { input: 3, cacheRead: 0.3, cacheWrite: null, output: 15 },
  "glm-5.2": { input: 1.4, cacheRead: 0.26, cacheWrite: null, output: 4.4 },
  "gemini-3.6-flash": { input: 0.75, cacheRead: 0.075, cacheWrite: null, output: 3.75 },
};

function canonicalModel(record: UsageRecord): string {
  // Explicit routing aliases only: no prefix/family guessing for unknown models.
  if (record.model === "k3" && ["kimi-code", "kimi-for-coding", "moonshotai"].includes(record.provider)) return "kimi-k3";
  if (record.model === "gpt-5.6" && ["openai", "openai-codex"].includes(record.provider)) return "gpt-5.6-sol";
  if (record.provider === "openrouter" && record.model.startsWith("anthropic/")) return record.model.slice("anthropic/".length);
  return record.model;
}

export interface UsagePrice {
  usd: number | null;
  reason: "unpriced-model" | "incomplete-token-breakdown" | "parse-gap" | null;
}

function isCounter(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

/** Price a request's disjoint buckets; reasoning is already a subset of output. */
export function priceUsage(record: UsageRecord): UsagePrice {
  const { uncachedInput, cacheRead, cacheWrite, output, total } = record;
  if (!isCounter(uncachedInput) || !isCounter(cacheRead) || !isCounter(cacheWrite) || !isCounter(output) || !isCounter(total)) {
    return { usd: null, reason: "incomplete-token-breakdown" };
  }
  const prompt = uncachedInput + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(prompt + output) || prompt + output !== total ||
    (record.reasoning !== null && (!isCounter(record.reasoning) || record.reasoning > output))) {
    return { usd: null, reason: "incomplete-token-breakdown" };
  }
  if (total === 0) return { usd: 0, reason: null };
  const model = canonicalModel(record);
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  if (!price) return { usd: null, reason: "unpriced-model" };
  const rates = price.longContext && prompt > price.longContext.aboveInputTokens ? price.longContext : price;
  if ((cacheRead > 0 && rates.cacheRead === null) || (cacheWrite > 0 && rates.cacheWrite === null)) {
    return { usd: null, reason: "unpriced-model" };
  }
  // USD/M tokens * 1000 = nanodollars/token. Pinned rates have <=3 decimals;
  // integer arithmetic avoids request-by-request microdollar rounding losses.
  const nanoUsd = uncachedInput * Math.round(rates.input * 1000) +
    cacheRead * Math.round((rates.cacheRead ?? 0) * 1000) +
    cacheWrite * Math.round((rates.cacheWrite ?? 0) * 1000) +
    output * Math.round(rates.output * 1000);
  return Number.isSafeInteger(nanoUsd)
    ? { usd: nanoUsd / 1_000_000_000, reason: null }
    : { usd: null, reason: "parse-gap" };
}
