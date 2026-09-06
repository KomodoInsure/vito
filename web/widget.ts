import type { EChartsOption } from "echarts";
import { init, use, type EChartsType } from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type {
  Agent,
  Metric,
  PublicCost,
  PublicDay,
  PublicSnapshot,
  PublicUsage,
  PublicWorkGroup,
  Quality,
  WorkStats,
} from "../src/contracts";

use([LineChart, PieChart, AriaComponent, GridComponent, TooltipComponent, SVGRenderer]);

export const SUPPORTED_VIEWS = [
  "calendar",
  "models",
  "uptime",
  "concurrency",
  "agent-hours",
  "parallelism",
  "rhythm",
  "cache",
  "commits",
  "cost",
  "all",
] as const;
export type WidgetView = (typeof SUPPORTED_VIEWS)[number];
export type WidgetRange = 7 | 30 | 90 | 365;
export type WidgetTheme = "auto" | "light" | "dark";
export const AGENT_VALUES: Agent[] = ["codex", "claude", "omp", "opencode", "hermes"];
const PUBLIC_REASON_VALUES = [
  "missing-source",
  "unsupported-schema",
  "parse-gap",
  "unknown-model",
  "unpriced-model",
  "incomplete-token-breakdown",
  "unallocated-history",
  "counter-discontinuity",
  "duplicate-ambiguity",
  "upstream-owned",
  "timing-unavailable",
  "open-interval",
  "unattributed-session",
  "stale-ref",
] as const;
const PUBLIC_SOURCE_STATES = [
  "available",
  "partial",
  "not-found",
  "installed-no-history",
  "excluded-wrapper",
  "unsupported-schema",
] as const;
const PUBLIC_LABEL_PATTERN = /^[A-Za-z0-9._\-/:+()\[\]]{1,128}$/;
const SECRET_LABEL_PREFIX = /^(?:sk-|ghp_|gho_|ghs_|github_pat_)/i;
const MODEL_SEPARATOR = " · ";
const RESOURCE_SEPARATOR = "\u241f";
const RANGE_VALUES: Record<string, WidgetRange> = { "7": 7, "30": 30, "90": 90, "365": 365 };

export interface WidgetOptions {
  view: WidgetView;
  range: WidgetRange;
  theme: WidgetTheme;
  harness: Agent | "all";
}

export function parseWidgetOptions(
  params: URLSearchParams,
  enabledHarnesses: readonly Agent[] = AGENT_VALUES,
): WidgetOptions {
  const viewValue = params.get("view");
  const rangeValue = params.get("range");
  const themeValue = params.get("theme");
  const harnessValue = params.get("harness");
  return {
    view: SUPPORTED_VIEWS.includes(viewValue as WidgetView) ? (viewValue as WidgetView) : "all",
    range: rangeValue === null ? 30 : (RANGE_VALUES[rangeValue] ?? 30),
    theme: themeValue === "light" || themeValue === "dark" || themeValue === "auto" ? themeValue : "auto",
    harness:
      harnessValue !== null && enabledHarnesses.includes(harnessValue as Agent)
        ? (harnessValue as Agent)
        : "all",
  };
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const allowed = [...keys].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQuality(value: unknown): value is Quality {
  return value === "recorded" || value === "partial" || value === "unavailable";
}

function isPublicReasons(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every((reason) => PUBLIC_REASON_VALUES.includes(reason as (typeof PUBLIC_REASON_VALUES)[number]))) return false;
  return value.every((reason, index) => index === 0 || value[index - 1]! < reason);
}

function isPublicLabel(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_LABEL_PATTERN.test(value) && !value.includes("://") && !SECRET_LABEL_PREFIX.test(value);
}

function isPublicDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isMetric(value: unknown, valueCheck: (candidate: unknown) => boolean): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["value", "status", "reasons"]) &&
    (value.value === null || valueCheck(value.value)) &&
    isQuality(value.status) &&
    isPublicReasons(value.reasons)
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUsage(value: unknown): value is PublicUsage {
  if (!isObject(value) || !hasOnlyKeys(value, ["total", "uncachedInput", "cacheRead", "cacheWrite", "output", "reasoning", "otherRecorded", "cacheReadBasis"])) return false;
  const counterKeys = ["total", "uncachedInput", "cacheRead", "cacheWrite", "output", "reasoning", "otherRecorded"] as const;
  if (!counterKeys.every((key) => isMetric(value[key], isCount))) return false;
  return isMetric(value.cacheReadBasis, (basis) =>
    isObject(basis) && hasOnlyKeys(basis, ["readTokens", "promptTokens"]) && isCount(basis.readTokens) && isCount(basis.promptTokens),
  );
}

function isUsd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isPricingSource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isCost(value: unknown): value is PublicCost {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["apiEquivalentUsd", "pricedRecords", "unpricedRecords", "pricedTokens", "unpricedTokens", "sourceEstimatedUsd", "providerReportedUsd", "unknownRecords", "includedRecords"]) &&
    isMetric(value.apiEquivalentUsd, isUsd) &&
    isCount(value.pricedRecords) && isCount(value.unpricedRecords) &&
    isCount(value.pricedTokens) && isCount(value.unpricedTokens) &&
    isMetric(value.sourceEstimatedUsd, isUsd) &&
    isMetric(value.providerReportedUsd, isUsd) &&
    isCount(value.unknownRecords) &&
    isCount(value.includedRecords)
  );
}

function isWorkStats(value: unknown): value is WorkStats {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["activeMs", "inferenceMs", "agentMs", "parallelMs", "histogram", "unavailableMs"]) ||
    !isCount(value.activeMs) ||
    !isCount(value.inferenceMs) ||
    !isCount(value.agentMs) ||
    !isCount(value.parallelMs) ||
    !isCount(value.unavailableMs) ||
    !Array.isArray(value.histogram)
  ) return false;
  let previous = -1;
  for (const entry of value.histogram) {
    if (
      !isObject(entry) ||
      !hasOnlyKeys(entry, ["agents", "elapsedMs"]) ||
      !isCount(entry.agents) ||
      !isCount(entry.elapsedMs) ||
      entry.elapsedMs === 0 ||
      entry.agents <= previous
    ) return false;
    previous = entry.agents;
  }
  return true;
}

function isWorkGroup(value: unknown): value is PublicWorkGroup {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["work", "byHarness"]) &&
    isMetric(value.work, isWorkStats) &&
    Array.isArray(value.byHarness) &&
    value.byHarness.every((entry) =>
      isObject(entry) && hasOnlyKeys(entry, ["harness", "work"]) && AGENT_VALUES.includes(entry.harness as Agent) && isMetric(entry.work, isWorkStats),
    )
  );
}

function isScopeCount(value: unknown): boolean {
  return isObject(value) &&
    hasOnlyKeys(value, ["records", "knownTokens", "unknownTotalRecords"]) &&
    isCount(value.records) &&
    isCount(value.knownTokens) &&
    isCount(value.unknownTotalRecords) &&
    value.unknownTotalRecords <= value.records;
}

function isScopeCoverage(value: unknown): boolean {
  return isObject(value) &&
    hasOnlyKeys(value, ["byHarness"]) &&
    Array.isArray(value.byHarness) &&
    value.byHarness.every((entry) =>
      isObject(entry) &&
      hasOnlyKeys(entry, ["harness", "included", "outOfScope", "unattributed"]) &&
      AGENT_VALUES.includes(entry.harness as Agent) &&
      isScopeCount(entry.included) &&
      isScopeCount(entry.outOfScope) &&
      isScopeCount(entry.unattributed),
    );
}

function isDay(value: unknown): value is PublicDay {
  if (!isObject(value) || !hasOnlyKeys(value, ["date", "elapsedMs", "usage", "cost", "usageRows", "work", "hours", "commits", "scope"])) return false;
  return (
    isPublicDate(value.date) && isCount(value.elapsedMs) &&
    isUsage(value.usage) && isCost(value.cost) && isWorkGroup(value.work) &&
    isMetric(value.commits, isCount) && isScopeCoverage(value.scope) &&
    Array.isArray(value.usageRows) && value.usageRows.every((row) =>
      isObject(row) && hasOnlyKeys(row, ["harness", "provider", "model", "usage", "cost"]) &&
      AGENT_VALUES.includes(row.harness as Agent) && isPublicLabel(row.provider) && isPublicLabel(row.model) && isUsage(row.usage) && isCost(row.cost),
    ) &&
    Array.isArray(value.hours) && value.hours.every((hour) =>
      isObject(hour) && hasOnlyKeys(hour, ["start", "elapsedMs", "work"]) && isInstant(hour.start) &&
      isCount(hour.elapsedMs) && isWorkGroup(hour.work),
    )
  );
}

export function isPublicSnapshot(value: unknown): value is PublicSnapshot {
  if (!isObject(value) || !hasOnlyKeys(value, ["schemaVersion", "pricing", "organization", "timezone", "generatedAt", "cutoff", "periodStart", "periodEnd", "collectionStatus", "sources", "coverage", "days"])) return false;
  return (
    value.schemaVersion === 3 && value.organization === "Agent Native" &&
    isObject(value.pricing) && hasOnlyKeys(value.pricing, ["asOf", "basis", "sources"]) &&
    isPublicDate(value.pricing.asOf) && value.pricing.basis === "standard-api" &&
    Array.isArray(value.pricing.sources) && value.pricing.sources.every(isPricingSource) &&
    typeof value.timezone === "string" && value.timezone.length >= 1 && value.timezone.length <= 128 &&
    isInstant(value.generatedAt) && isInstant(value.cutoff) &&
    isPublicDate(value.periodStart) && isPublicDate(value.periodEnd) &&
    (value.collectionStatus === "ok" || value.collectionStatus === "partial") &&
    Array.isArray(value.sources) && value.sources.every((source) =>
      isObject(source) && hasOnlyKeys(source, ["agent", "state", "tokens", "work", "reasons"]) &&
      typeof source.agent === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(source.agent) &&
      PUBLIC_SOURCE_STATES.includes(source.state as (typeof PUBLIC_SOURCE_STATES)[number]) &&
      isQuality(source.tokens) && isQuality(source.work) && isPublicReasons(source.reasons),
    ) &&
    isObject(value.coverage) &&
    hasOnlyKeys(value.coverage, ["unallocatedUsageRecords", "excludedAmbiguousRecords", "scopeStatus", "undated"]) &&
    isCount(value.coverage.unallocatedUsageRecords) &&
    isCount(value.coverage.excludedAmbiguousRecords) &&
    isQuality(value.coverage.scopeStatus) &&
    isScopeCoverage(value.coverage.undated) &&
    Array.isArray(value.days) && value.days.every(isDay)
  );
}

function mergedReasons<T>(metrics: readonly Metric<T>[]): string[] {
  return [...new Set(metrics.flatMap((metric) => metric.reasons))].sort();
}

function aggregateNumberMetrics(metrics: readonly Metric<number>[]): Metric<number> {
  const present = metrics.filter((metric): metric is Metric<number> & { value: number } => metric.value !== null);
  if (present.length === 0) return { value: null, status: "unavailable", reasons: mergedReasons(metrics) };
  const status: Quality = metrics.every((metric) => metric.status === "recorded" && metric.value !== null) ? "recorded" : "partial";
  const value = present.reduce((sum, metric) => sum + metric.value, 0);
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) {
    return { value: null, status: "unavailable", reasons: [...new Set([...mergedReasons(metrics), "parse-gap"])].sort() };
  }
  return { value, status, reasons: mergedReasons(metrics) };
}

function aggregateBasisMetrics(metrics: readonly PublicUsage["cacheReadBasis"][]): PublicUsage["cacheReadBasis"] {
  const present = metrics.filter((metric): metric is typeof metric & { value: { readTokens: number; promptTokens: number } } => metric.value !== null);
  if (present.length === 0) return { value: null, status: "unavailable", reasons: mergedReasons(metrics) };
  return {
    value: {
      readTokens: present.reduce((sum, metric) => sum + metric.value.readTokens, 0),
      promptTokens: present.reduce((sum, metric) => sum + metric.value.promptTokens, 0),
    },
    status: metrics.every((metric) => metric.status === "recorded" && metric.value !== null) ? "recorded" : "partial",
    reasons: mergedReasons(metrics),
  };
}

export function aggregateUsage(usages: readonly PublicUsage[]): PublicUsage {
  return {
    total: aggregateNumberMetrics(usages.map((usage) => usage.total)),
    uncachedInput: aggregateNumberMetrics(usages.map((usage) => usage.uncachedInput)),
    cacheRead: aggregateNumberMetrics(usages.map((usage) => usage.cacheRead)),
    cacheWrite: aggregateNumberMetrics(usages.map((usage) => usage.cacheWrite)),
    output: aggregateNumberMetrics(usages.map((usage) => usage.output)),
    reasoning: aggregateNumberMetrics(usages.map((usage) => usage.reasoning)),
    otherRecorded: aggregateNumberMetrics(usages.map((usage) => usage.otherRecorded)),
    cacheReadBasis: aggregateBasisMetrics(usages.map((usage) => usage.cacheReadBasis)),
  };
}

export function aggregateCost(costs: readonly PublicCost[]): PublicCost {
  const apiEquivalentUsd = aggregateNumberMetrics(costs.map((cost) => cost.apiEquivalentUsd));
  if (apiEquivalentUsd.value === null && apiEquivalentUsd.reasons.includes("parse-gap")) apiEquivalentUsd.status = "partial";
  const coverage = (key: "pricedRecords" | "unpricedRecords" | "pricedTokens" | "unpricedTokens" | "unknownRecords" | "includedRecords") => {
    let total = 0;
    for (const cost of costs) {
      if (cost[key] > Number.MAX_SAFE_INTEGER - total) {
        throw new RangeError("Cost coverage exceeds safe integer range");
      }
      total += cost[key];
    }
    return total;
  };
  const result = {
    apiEquivalentUsd,
    pricedRecords: coverage("pricedRecords"),
    unpricedRecords: coverage("unpricedRecords"),
    pricedTokens: coverage("pricedTokens"),
    unpricedTokens: coverage("unpricedTokens"),
    sourceEstimatedUsd: aggregateNumberMetrics(costs.map((cost) => cost.sourceEstimatedUsd)),
    providerReportedUsd: aggregateNumberMetrics(costs.map((cost) => cost.providerReportedUsd)),
    unknownRecords: coverage("unknownRecords"),
    includedRecords: coverage("includedRecords"),
  };
  if (result.unpricedRecords > 0 && apiEquivalentUsd.value !== null) {
    apiEquivalentUsd.status = "partial";
  }
  return result;
}

function workMetricForHarness(group: PublicWorkGroup, harness: Agent | "all"): Metric<WorkStats> {
  if (harness === "all") return group.work;
  return group.byHarness.find((entry) => entry.harness === harness)?.work ?? { value: null, status: "unavailable", reasons: ["timing-unavailable"] };
}

export function aggregateWork(
  items: readonly { elapsedMs: number; work: Metric<WorkStats> }[],
): Metric<WorkStats> {
  const histogram = new Map<number, number>();
  let activeMs = 0;
  let inferenceMs = 0;
  let agentMs = 0;
  let parallelMs = 0;
  let unavailableMs = 0;
  let measured = 0;
  for (const item of items) {
    if (item.work.value === null) {
      unavailableMs += item.elapsedMs;
      continue;
    }
    measured += 1;
    activeMs += item.work.value.activeMs;
    inferenceMs += item.work.value.inferenceMs;
    agentMs += item.work.value.agentMs;
    parallelMs += item.work.value.parallelMs;
    unavailableMs += item.work.value.unavailableMs;
    for (const entry of item.work.value.histogram) histogram.set(entry.agents, (histogram.get(entry.agents) ?? 0) + entry.elapsedMs);
  }
  if (measured === 0) return { value: null, status: "unavailable", reasons: mergedReasons(items.map((item) => item.work)) };
  return {
    value: {
      activeMs,
      inferenceMs,
      agentMs,
      parallelMs,
      histogram: [...histogram].filter(([, elapsedMs]) => elapsedMs > 0).sort(([a], [b]) => a - b).map(([agents, elapsedMs]) => ({ agents, elapsedMs })),
      unavailableMs,
    },
    status: items.every((item) => item.work.status === "recorded" && item.work.value !== null) ? "recorded" : "partial",
    reasons: mergedReasons(items.map((item) => item.work)),
  };
}

export interface ResourceFilter {
  provider: string;
  model: string;
}

function selectedRows(day: PublicDay, harness: Agent | "all", resource: ResourceFilter | null = null) {
  return day.usageRows.filter((row) =>
    (harness === "all" || row.harness === harness) &&
    (resource === null || (row.provider === resource.provider && row.model === resource.model)),
  );
}

export function aggregateResources(days: readonly PublicDay[], harness: Agent | "all", resource: ResourceFilter | null = null) {
  if (harness === "all" && resource === null) {
    return { usage: aggregateUsage(days.map((day) => day.usage)), cost: aggregateCost(days.map((day) => day.cost)) };
  }
  const rows = days.flatMap((day) => selectedRows(day, harness, resource));
  return { usage: aggregateUsage(rows.map((row) => row.usage)), cost: aggregateCost(rows.map((row) => row.cost)) };
}

export interface SeriesResult {
  keys: string[];
  values: Array<{ date: string; values: Record<string, number | null>; fullTotal: number | null }>;
}

export function buildUsageSeries(days: readonly PublicDay[], harness: Agent | "all", grouping: "model" | "harness"): SeriesResult {
  const totals = new Map<string, number>();
  const raw = days.map((day) => {
    const values = new Map<string, number | null>();
    let fullTotal = 0;
    let hasTotal = false;
    for (const row of selectedRows(day, harness)) {
      const value = row.usage.total.value;
      const key = grouping === "harness" ? row.harness : `${row.provider}${MODEL_SEPARATOR}${row.model}`;
      totals.set(key, (totals.get(key) ?? 0) + (value ?? 0));
      if (value === null) {
        values.set(key, null);
        continue;
      }
      hasTotal = true;
      fullTotal += value;
      if (values.get(key) !== null) values.set(key, (values.get(key) ?? 0) + value);
    }
    return { date: day.date, values, fullTotal: hasTotal ? fullTotal : null };
  });
  const ranked = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const unknown = ranked.filter(([key]) => key === `unknown${MODEL_SEPARATOR}unknown` || key.endsWith(`${MODEL_SEPARATOR}unknown`));
  const known = ranked.filter(([key]) => !unknown.some(([unknownKey]) => unknownKey === key));
  const top = known.slice(0, 6).map(([key]) => key);
  const other = known.slice(6).map(([key]) => key);
  const keys = [...top, ...(other.length > 0 ? ["Other"] : []), ...unknown.map(([key]) => key)];
  return {
    keys,
    values: raw.map((point) => {
      const values: Record<string, number | null> = {};
      for (const key of top) values[key] = point.values.get(key) === null ? null : point.values.get(key) ?? 0;
      if (other.length > 0) values.Other = other.some((key) => point.values.get(key) === null)
        ? null : other.reduce((sum, key) => sum + (point.values.get(key) ?? 0), 0);
      for (const [key] of unknown) values[key] = point.values.get(key) === null ? null : point.values.get(key) ?? 0;
      if (point.fullTotal === null) for (const key of keys) values[key] = null;
      return { date: point.date, values, fullTotal: point.fullTotal };
    }),
  };
}

export interface RhythmCell {
  weekday: number;
  hour: number;
  elapsedMs: number;
  activeMs: number;
  agentMs: number;
  unavailableMs: number;
  available: boolean;
}

export function buildRhythm(days: readonly PublicDay[], harness: Agent | "all", timezone: string): RhythmCell[] {
  const cells = Array.from({ length: 7 * 24 }, (_, index) => ({
    weekday: Math.floor(index / 24), hour: index % 24, elapsedMs: 0, activeMs: 0, agentMs: 0, unavailableMs: 0, available: false,
  }));
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "numeric", hourCycle: "h23" });
  const weekdayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  for (const day of days) {
    for (const slot of day.hours) {
      const parts = formatter.formatToParts(new Date(slot.start));
      const weekday = weekdayIndex[parts.find((part) => part.type === "weekday")?.value ?? "Sun"] ?? 0;
      const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
      const cell = cells[weekday * 24 + hour]!;
      cell.elapsedMs += slot.elapsedMs;
      const metric = workMetricForHarness(slot.work, harness);
      if (metric.value === null) {
        cell.unavailableMs += slot.elapsedMs;
      } else {
        cell.available = true;
        cell.activeMs += metric.value.activeMs;
        cell.agentMs += metric.value.agentMs;
        cell.unavailableMs += metric.value.unavailableMs;
      }
    }
  }
  return cells;
}

const formatInteger = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const formatDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const formatCompactInteger = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const formatPercent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const formatHumanDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function humanDate(date: string): string {
  return formatHumanDate.format(new Date(`${date}T12:00:00Z`));
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let tooltipSequence = 0;

function infoTooltip(label: string, text: string): HTMLElement {
  const wrapper = element("span", "info-tip");
  const trigger = element("button", "info-trigger", "?");
  const tooltip = element("span", "info-content", text);
  const id = `metric-tooltip-${tooltipSequence += 1}`;
  trigger.type = "button";
  trigger.setAttribute("aria-label", `Explain ${label}`);
  trigger.setAttribute("aria-describedby", id);
  tooltip.id = id;
  tooltip.setAttribute("role", "tooltip");
  wrapper.append(trigger, tooltip);
  return wrapper;
}

function attachCellTooltip(
  trigger: HTMLElement,
  tooltip: HTMLElement,
  container: HTMLElement,
  text: string,
): void {
  const show = (left: number) => {
    tooltip.textContent = text;
    tooltip.style.left = `${Math.min(Math.max(left, 4), Math.max(container.clientWidth - 280, 4))}px`;
    tooltip.style.top = "8px";
    tooltip.hidden = false;
  };
  trigger.addEventListener("pointerenter", (event) => {
    show((event as PointerEvent).clientX - container.getBoundingClientRect().left + container.scrollLeft);
  });
  trigger.addEventListener("pointermove", (event) => {
    show((event as PointerEvent).clientX - container.getBoundingClientRect().left + container.scrollLeft);
  });
  trigger.addEventListener("pointerleave", () => { tooltip.hidden = true; });
  trigger.addEventListener("focus", () => {
    const triggerBounds = trigger.getBoundingClientRect();
    show(triggerBounds.left - container.getBoundingClientRect().left + container.scrollLeft);
  });
  trigger.addEventListener("blur", () => { tooltip.hidden = true; });
}

function replaceChildren(parent: Element, ...children: (Node | string)[]): void {
  parent.replaceChildren(...children);
}

function createPanel(title: string, description: string, expandable = false): { root: HTMLElement; body: HTMLElement; header: HTMLElement } {
  const root = element(expandable ? "details" : "section", "panel");
  if (expandable) (root as HTMLDetailsElement).open = true;
  const header = expandable ? element("summary") : element("header", "panel-header");
  const heading = element("h2", undefined, title);
  const text = element("p", "panel-note", description);
  const titleBox = element("div");
  titleBox.append(heading, text);
  header.append(titleBox);
  const body = element("div", expandable ? "details-body" : undefined);
  root.append(header, body);
  return { root, body, header };
}

function createSegmented(options: Array<{ value: string; label: string }>, selected: string, label: string, onSelect: (value: string) => void): HTMLElement {
  const group = element("div", "segmented");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  for (const option of options) {
    const button = element("button", undefined, option.label);
    button.type = "button";
    button.dataset.value = option.value;
    button.setAttribute("aria-pressed", String(option.value === selected));
    button.addEventListener("click", () => onSelect(option.value));
    group.append(button);
  }
  return group;
}

function metricText(value: number | null, formatter: (value: number) => string): string {
  return value === null ? "Unavailable" : formatter(value);
}


function renderMetricCard(
  title: string,
  value: string,
  secondary: string,
  explanation: string,
  secondaryExplanation?: string,
): HTMLElement {
  const card = element("article", "panel metric-card");
  card.dataset.metric = title.toLowerCase().replaceAll(" ", "-");
  const heading = element("div", "metric-heading");
  heading.append(element("h2", undefined, title), infoTooltip(title, explanation));
  const number = element("p", "metric-value", value);
  number.dataset.value = value;
  const detail = element("p", "metric-secondary", secondary);
  if (secondaryExplanation !== undefined) detail.append(" ", infoTooltip(secondary, secondaryExplanation));
  card.append(heading, number, detail);
  return card;
}

const SERIES_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"] as const;

function seriesColor(key: string, index: number): string {
  if (key === "Other") return "var(--series-other)";
  if (key === "unknown" || key.endsWith(`${MODEL_SEPARATOR}unknown`)) return "var(--series-unknown)";
  return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

function selectedDays(snapshot: PublicSnapshot, range: WidgetRange): PublicDay[] {
  return snapshot.days.slice(-range);
}

interface RenderState {
  options: WidgetOptions;
  grouping: "model" | "harness";
  rhythmMetric: "active" | "agent";
  resource: ResourceFilter | null;
  hiddenSeries: Set<string>;
  chartMounts: Array<() => () => void>;
}

function renderToolbar(snapshot: PublicSnapshot, state: RenderState, rerender: () => void): HTMLElement {
  const toolbar = element("form", "toolbar");
  toolbar.addEventListener("submit", (event) => event.preventDefault());
  const rangeLabel = element("label", "control");
  rangeLabel.append(element("span", undefined, "Range"));
  const rangeSelect = element("select");
  rangeSelect.setAttribute("aria-label", "Reporting range");
  for (const value of [7, 30, 90, 365] as WidgetRange[]) {
    const option = element("option", undefined, `${value} days`);
    option.value = String(value);
    option.selected = state.options.range === value;
    rangeSelect.append(option);
  }
  rangeSelect.addEventListener("change", () => { state.options.range = Number(rangeSelect.value) as WidgetRange; state.resource = null; rerender(); });
  rangeLabel.append(rangeSelect);

  const harnessLabel = element("label", "control");
  harnessLabel.append(element("span", undefined, "Harness"));
  const harnessSelect = element("select");
  harnessSelect.setAttribute("aria-label", "Harness filter");
  const allOption = element("option", undefined, "All harnesses");
  allOption.value = "all";
  allOption.selected = state.options.harness === "all";
  harnessSelect.append(allOption);
  for (const harness of enabledHarnesses(snapshot)) {
    const option = element("option", undefined, harness);
    option.value = harness;
    option.selected = state.options.harness === harness;
    harnessSelect.append(option);
  }
  harnessSelect.addEventListener("change", () => { state.options.harness = harnessSelect.value as Agent | "all"; state.resource = null; state.hiddenSeries.clear(); rerender(); });
  harnessLabel.append(harnessSelect);

  const themeLabel = element("label", "control");
  themeLabel.append(element("span", undefined, "Theme"));
  const themeSelect = element("select");
  themeSelect.setAttribute("aria-label", "Color theme");
  for (const value of ["auto", "light", "dark"] as WidgetTheme[]) {
    const option = element("option", undefined, value[0]!.toUpperCase() + value.slice(1));
    option.value = value;
    option.selected = state.options.theme === value;
    themeSelect.append(option);
  }
  themeSelect.addEventListener("change", () => { state.options.theme = themeSelect.value as WidgetTheme; applyTheme(state.options.theme); });
  themeLabel.append(themeSelect);
  toolbar.append(rangeLabel);
  if (state.options.view !== "commits") toolbar.append(harnessLabel);
  toolbar.append(themeLabel);
  return toolbar;
}

function enabledHarnesses(snapshot: PublicSnapshot): Agent[] {
  const fromData = new Set<Agent>();
  for (const day of snapshot.days) {
    for (const row of day.usageRows) fromData.add(row.harness);
    for (const row of day.work.byHarness) fromData.add(row.harness);
  }
  return AGENT_VALUES.filter((agent) => fromData.has(agent) || snapshot.sources.some((source) => source.agent === agent && source.state !== "not-found"));
}

function renderCalendar(days: PublicDay[], state: RenderState, commits: boolean): HTMLElement {
  const mode = commits ? "commits" : "tokens";
  const panel = createPanel(
    commits ? "Commits on default branches" : "Daily token traffic",
    commits ? "Company-wide default-branch history." : "Daily totals for the selected range.",
  );
  const values = days.map((day) => commits ? day.commits.value : aggregateResources([day], state.options.harness).usage.total.value);
  const positive = values.filter((value): value is number => value !== null && value > 0).sort((a, b) => a - b);
  const max = positive.at(-1) ?? 0;
  const shell = element("div", "calendar-shell");
  const tooltip = element("div", "cell-tooltip");
  tooltip.hidden = true;
  tooltip.setAttribute("role", "tooltip");
  const grid = element("div", "calendar");
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", mode === "tokens" ? "Daily token traffic" : "Daily default-branch commits");
  const firstOffset = days.length > 0 ? new Date(`${days[0]!.date}T12:00:00Z`).getUTCDay() : 0;
  days.forEach((day, index) => {
    const value = values[index];
    const button = element("button", "calendar-day");
    button.type = "button";
    button.style.gridRow = String(((firstOffset + index) % 7) + 1);
    button.style.gridColumn = String(Math.floor((firstOffset + index) / 7) + 1);
    button.dataset.date = day.date;
    button.dataset.value = value === null ? "unavailable" : String(value);
    button.dataset.missing = String(value === null);
    const level = value === null || value <= 0 || max === 0 ? 0 : Math.max(1, Math.ceil((value / max) * 4));
    button.dataset.level = String(level);
    const valueLabel = value === null ? `no recorded ${mode}` : `${commits ? formatInteger.format(value) : formatCompactInteger.format(value)} ${mode}`;
    const tooltipText = `${humanDate(day.date)}: ${valueLabel}`;
    button.setAttribute("aria-label", tooltipText);
    attachCellTooltip(button, tooltip, shell, tooltipText);
    grid.append(button);
  });
  shell.append(grid, tooltip);
  panel.body.append(shell);
  const legend = element("div", "legend");
  legend.append(element("span", undefined, "Less"));
  for (let level = 0; level <= 4; level += 1) {
    const swatch = element("span", "legend-swatch");
    swatch.dataset.level = String(level);
    swatch.style.background = level === 0 ? "var(--missing)" : `color-mix(in srgb, var(--accent) ${level * 22}%, var(--panel))`;
    legend.append(swatch);
  }
  legend.append(element("span", undefined, "More"));
  panel.body.append(legend);
  if (mode === "commits") {
    const active = days.filter((day) => (day.commits.value ?? 0) > 0).length;
    panel.body.append(element("p", "panel-note", `${active} commit-active ${active === 1 ? "day" : "days"}.`));
  }
  return panel.root;
}

function mountChart(state: RenderState, host: HTMLElement, option: () => EChartsOption, ready?: (chart: EChartsType) => void): void {
  state.chartMounts.push(() => {
    const chart = init(host, undefined, { renderer: "svg" });
    const update = () => chart.setOption(option(), { notMerge: true });
    update();
    ready?.(chart);
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(host);
    const theme = new MutationObserver(update);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      resize.disconnect();
      theme.disconnect();
      media.removeEventListener("change", update);
      chart.dispose();
    };
  });
}


function renderModels(days: PublicDay[], state: RenderState, rerender: () => void): HTMLElement {
  const panel = createPanel("Token mix", "Daily token totals. Shares always use the full selected population, even when a series is hidden.");
  panel.header.append(createSegmented([
    { value: "model", label: "Models" }, { value: "harness", label: "Harnesses" },
  ], state.grouping, "Series grouping", (value) => { state.grouping = value as "model" | "harness"; state.hiddenSeries.clear(); rerender(); }));
  const series = buildUsageSeries(days, state.options.harness, state.grouping);
  if (series.keys.length === 0) {
    panel.body.append(element("p", "error-state", "Token series unavailable for this selection."));
    return panel.root;
  }
  const chartHost = element("div", "area-chart");
  chartHost.setAttribute("role", "img");
  chartHost.setAttribute("aria-label", `Daily tokens grouped by ${state.grouping}; exact values available in the token data table.`);
  panel.body.append(chartHost);
  const inspect = element("label", "control");
  inspect.append(element("span", undefined, "Inspect day"));
  const select = element("select");
  select.setAttribute("aria-label", "Inspect daily token chart");
  for (const [index, point] of series.values.entries()) {
    const option = element("option", undefined, `${humanDate(point.date)} · ${metricText(point.fullTotal, (value) => `${formatCompactInteger.format(value)} tokens`)}`);
    option.value = String(index);
    select.append(option);
  }
  inspect.append(select);
  panel.body.append(inspect);
  mountChart(state, chartHost, () => {
    const palette = getComputedStyle(document.documentElement);
    const color = (css: string) => palette.getPropertyValue(css.slice(4, -1)).trim();
    return {
      animation: false,
      aria: { enabled: true },
      grid: { left: 8, right: 12, top: 20, bottom: 12, containLabel: true },
      textStyle: { color: palette.getPropertyValue("--text").trim(), fontFamily: palette.fontFamily },
      tooltip: {
        trigger: "axis", confine: true, renderMode: "html", className: "chart-library-tooltip",
        backgroundColor: palette.getPropertyValue("--panel").trim(),
        borderColor: palette.getPropertyValue("--border").trim(),
        textStyle: { color: palette.getPropertyValue("--text").trim() },
      },
      xAxis: {
        type: "category", boundaryGap: false, data: series.values.map((point) => point.date),
        axisLabel: { color: palette.getPropertyValue("--muted").trim(), hideOverlap: true, formatter: (value: string) => humanDate(value) },
        axisLine: { lineStyle: { color: palette.getPropertyValue("--border").trim() } },
      },
      yAxis: {
        type: "value", min: 0,
        axisLabel: { color: palette.getPropertyValue("--muted").trim(), formatter: (value: number) => formatCompactInteger.format(value) },
        splitLine: { lineStyle: { color: palette.getPropertyValue("--border").trim() } },
      },
      series: series.keys.flatMap((key, index) => state.hiddenSeries.has(key) ? [] : [{
        name: key, type: "line" as const, stack: "tokens", smooth: false, connectNulls: false,
        showSymbol: series.values.length === 1,
        itemStyle: { color: color(seriesColor(key, index)) },
        lineStyle: { width: 1, color: color(seriesColor(key, index)) },
        areaStyle: { color: color(seriesColor(key, index)), opacity: 0.82 },
        data: series.values.map((point) => point.values[key] ?? null),
        tooltip: { valueFormatter: (value: unknown, dataIndex: number) => {
          if (typeof value !== "number") return "Unavailable";
          const total = series.values[dataIndex]?.fullTotal;
          return `${formatCompactInteger.format(value)} tokens${total !== null && total !== undefined && total > 0 ? ` (${formatPercent.format(value / total)} of full total)` : ""}`;
        } },
      }]),
    };
  }, (chart) => {
    const show = () => chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: Number(select.value) });
    select.addEventListener("change", show);
    select.addEventListener("focus", show);
    select.addEventListener("blur", () => chart.dispatchAction({ type: "hideTip" }));
  });
  const legend = element("div", "series-legend");
  for (const [seriesIndex, key] of series.keys.entries()) {
    const button = element("button", "series-toggle");
    button.type = "button";
    button.setAttribute("aria-pressed", String(!state.hiddenSeries.has(key)));
    button.setAttribute("aria-label", `${state.hiddenSeries.has(key) ? "Show" : "Hide"} ${key}`);
    const dot = element("span", "series-dot");
    dot.style.background = seriesColor(key, seriesIndex);
    button.append(dot, document.createTextNode(key));
    button.addEventListener("click", () => { state.hiddenSeries.has(key) ? state.hiddenSeries.delete(key) : state.hiddenSeries.add(key); rerender(); });
    legend.append(button);
  }
  panel.body.append(legend);
  const details = element("details", "data-disclosure");
  details.append(element("summary", undefined, "Exact daily token data"));
  const wrap = element("div", "table-wrap");
  const table = element("table");
  table.append(element("caption", "sr-only", "Daily tokens by series, including hidden series"));
  const head = element("thead");
  const header = element("tr");
  for (const label of ["Date", ...series.keys, "Full total"]) header.append(element("th", undefined, label));
  head.append(header);
  const body = element("tbody");
  for (const point of series.values) {
    const row = element("tr");
    row.append(element("td", undefined, point.date));
    for (const key of series.keys) row.append(element("td", undefined, metricText(point.values[key] ?? null, (value) => formatInteger.format(value))));
    row.append(element("td", undefined, metricText(point.fullTotal, (value) => formatInteger.format(value))));
    body.append(row);
  }
  table.append(head, body);
  wrap.append(table);
  details.append(wrap);
  panel.body.append(details);
  return panel.root;
}

function rangeWork(days: PublicDay[], harness: Agent | "all"): Metric<WorkStats> {
  return aggregateWork(days.map((day) => ({ elapsedMs: day.elapsedMs, work: workMetricForHarness(day.work, harness) })));
}
function longestRun(values: readonly boolean[]): number {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    current = value ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

export function inferenceStreaks(days: readonly PublicDay[], harness: Agent | "all"): { hourly: number | null; daily: number | null } {
  const hourlyActivity: boolean[] = [];
  const dailyActivity: boolean[] = [];
  let hasEvidence = false;
  for (const day of days) {
    let dayHasInference = false;
    for (const hour of day.hours) {
      const work = workMetricForHarness(hour.work, harness).value;
      if (work !== null) hasEvidence = true;
      const active = work !== null && work.inferenceMs > 0;
      hourlyActivity.push(active);
      dayHasInference ||= active;
    }
    dailyActivity.push(dayHasInference);
  }
  return hasEvidence
    ? { hourly: longestRun(hourlyActivity), daily: longestRun(dailyActivity) }
    : { hourly: null, daily: null };
}


function renderCards(days: PublicDay[], state: RenderState, view: WidgetView): HTMLElement {
  const resources = aggregateResources(days, state.options.harness);
  const work = rangeWork(days, state.options.harness);
  const elapsedMs = days.reduce((sum, day) => sum + day.elapsedMs, 0);
  const stats = work.value;
  const activeHours = stats === null ? null : stats.activeMs / 3_600_000;
  const uptime = stats === null || elapsedMs === 0 ? null : stats.activeMs / elapsedMs;
  const averageConcurrency = stats === null || elapsedMs === 0 ? null : stats.agentMs / elapsedMs;
  const busyConcurrency = stats === null || stats.activeMs === 0 ? null : stats.agentMs / stats.activeMs;
  const agentHours = stats === null ? null : stats.agentMs / 3_600_000;
  const streaks = inferenceStreaks(days, state.options.harness);
  const cards = element("section", "cards");
  cards.setAttribute("aria-label", "Activity summary");
  cards.dataset.activeMs = stats === null ? "unavailable" : String(stats.activeMs);
  cards.dataset.agentMs = stats === null ? "unavailable" : String(stats.agentMs);
  cards.dataset.parallelMs = stats === null ? "unavailable" : String(stats.parallelMs);
  cards.dataset.elapsedMs = String(elapsedMs);
  cards.dataset.uptime = uptime === null ? "unavailable" : String(uptime);
  cards.dataset.averageConcurrency = averageConcurrency === null ? "unavailable" : String(averageConcurrency);
  cards.dataset.busyConcurrency = busyConcurrency === null ? "unavailable" : String(busyConcurrency);
  cards.dataset.hourlyInferenceStreak = streaks.hourly === null ? "unavailable" : String(streaks.hourly);
  cards.dataset.dailyInferenceStreak = streaks.daily === null ? "unavailable" : String(streaks.daily);
  if (view === "all") cards.append(renderMetricCard(
    "Total tokens",
    metricText(resources.usage.total.value, (value) => formatCompactInteger.format(value)),
    resources.usage.total.value === null
      ? `Across ${state.options.harness === "all" ? "all harnesses" : state.options.harness}`
      : `${formatInteger.format(resources.usage.total.value)} recorded across ${state.options.harness === "all" ? "all harnesses" : state.options.harness}`,
    "Sum of recorded input, cache-read, cache-write, and output tokens in the selected range. Reasoning tokens are already included in output and are not added twice.",
  ));
  if (view === "all") cards.append(renderMetricCard(
    "Inference streaks",
    metricText(streaks.hourly, (value) => `${formatInteger.format(value)} ${value === 1 ? "hour" : "hours"}`),
    `Daily streak: ${metricText(streaks.daily, (value) => `${formatInteger.format(value)} ${value === 1 ? "day" : "days"}`)}`,
    "Longest run of consecutive elapsed hours containing recorded inference. The daily streak counts consecutive local calendar days with recorded inference.",
  ));
  if (view === "all" || view === "uptime") cards.append(renderMetricCard(
    "Measured uptime",
    metricText(uptime, (value) => formatPercent.format(value)),
    `Active hours: ${metricText(activeHours, (value) => formatDecimal.format(value))}`,
    "Active wall-clock time divided by the selected range.",
  ));
  if (view === "all" || view === "concurrency") cards.append(renderMetricCard(
    "Average concurrent agents",
    metricText(averageConcurrency, (value) => formatDecimal.format(value)),
    `While busy: ${metricText(busyConcurrency, (value) => formatDecimal.format(value))}`,
    "Agent-hours divided by the selected range.",
    "Agent-hours divided by active time. Two agents active for one hour produces 2.0.",
  ));
  if (view === "all" || view === "agent-hours") cards.append(renderMetricCard(
    "Agent-hours",
    metricText(agentHours, (value) => formatDecimal.format(value)),
    "Time-weighted agent activity",
    "Active time summed across independent agent lanes. Two agents active for one hour contribute two agent-hours.",
  ));
  return cards;
}


interface ActiveConcurrencyBin {
  label: string;
  elapsedMs: number;
  color: string;
}

function activeConcurrencyBins(stats: WorkStats): ActiveConcurrencyBin[] {
  const bins = [
    { label: "1 agent", test: (n: number) => n === 1, color: "var(--parallel-1)" },
    { label: "2 agents", test: (n: number) => n === 2, color: "var(--parallel-2)" },
    { label: "3 agents", test: (n: number) => n === 3, color: "var(--parallel-3)" },
    { label: "4 agents", test: (n: number) => n === 4, color: "var(--parallel-4)" },
    { label: "5–7 agents", test: (n: number) => n >= 5 && n <= 7, color: "var(--parallel-5)" },
    { label: "8+ agents", test: (n: number) => n >= 8, color: "var(--parallel-6)" },
  ];
  return bins
    .map((bin) => ({
      label: bin.label,
      elapsedMs: stats.histogram
        .filter((entry) => bin.test(entry.agents))
        .reduce((sum, entry) => sum + entry.elapsedMs, 0),
      color: bin.color,
    }))
    .filter((bin) => bin.elapsedMs > 0);
}

function renderParallelism(days: PublicDay[], state: RenderState, standalone: boolean): HTMLElement {
  const panel = createPanel("Parallel work", "Concurrency distribution during recorded active time. Idle and unavailable time are excluded from the donut.", !standalone);
  const work = rangeWork(days, state.options.harness);
  const stats = work.value;
  panel.root.dataset.activeMs = stats === null ? "unavailable" : String(stats.activeMs);
  panel.root.dataset.agentMs = stats === null ? "unavailable" : String(stats.agentMs);
  panel.root.dataset.parallelMs = stats === null ? "unavailable" : String(stats.parallelMs);
  panel.root.dataset.unavailableMs = stats === null ? "unavailable" : String(stats.unavailableMs);
  if (stats === null) {
    panel.body.append(element("p", "error-state", "Measured work timing is unavailable for this selection."));
    return panel.root;
  }
  const bins = activeConcurrencyBins(stats);
  const activeTotal = bins.reduce((sum, bin) => sum + bin.elapsedMs, 0);
  if (activeTotal > 0) {
    const visual = element("div", "parallel-visual");
    const donut = element("div", "parallel-donut");
    const chartHost = element("div", "parallel-chart");
    donut.setAttribute("role", "img");
    donut.setAttribute("aria-label", `Concurrency during recorded active time. ${bins.map((bin) => `${bin.label}: ${formatPercent.format(bin.elapsedMs / activeTotal)}`).join(", ")}`);
    const center = element("span", "donut-center");
    center.append(
      element("strong", undefined, `${formatDecimal.format(activeTotal / 3_600_000)}h`),
      element("span", undefined, "active time"),
    );
    donut.append(chartHost, center);
    const legend = element("div", "parallel-legend");
    const keys: HTMLButtonElement[] = [];
    for (const bin of bins) {
      const key = element("button", "parallel-key");
      key.type = "button";
      key.setAttribute("aria-label", `${bin.label}: ${formatPercent.format(bin.elapsedMs / activeTotal)} of active time, ${formatDecimal.format(bin.elapsedMs / 3_600_000)} hours`);
      const swatch = element("span", "legend-swatch");
      swatch.style.background = bin.color;
      key.append(swatch, document.createTextNode(`${bin.label} · ${formatPercent.format(bin.elapsedMs / activeTotal)}`));
      legend.append(key);
      keys.push(key);
    }
    visual.append(donut, legend);
    panel.body.append(visual);
    mountChart(state, chartHost, () => {
      const palette = getComputedStyle(document.documentElement);
      return {
        animation: false,
        aria: { enabled: true },
        textStyle: { color: palette.getPropertyValue("--text").trim(), fontFamily: palette.fontFamily },
        tooltip: {
          trigger: "item", confine: true, renderMode: "html", className: "chart-library-tooltip",
          backgroundColor: palette.getPropertyValue("--panel").trim(),
          borderColor: palette.getPropertyValue("--border").trim(),
          textStyle: { color: palette.getPropertyValue("--text").trim() },
          valueFormatter: (value) => typeof value === "number" ? `${formatDecimal.format(value / 3_600_000)}h · ${formatPercent.format(value / activeTotal)}` : "Unavailable",
        },
        series: [{
          name: "Recorded active time", type: "pie", radius: ["50%", "92%"],
          label: { show: false }, emphasis: { scale: false },
          data: bins.map((bin) => ({
            name: bin.label, value: bin.elapsedMs,
            itemStyle: { color: palette.getPropertyValue(bin.color.slice(4, -1)).trim() },
          })),
        }],
      };
    }, (chart) => {
      for (const [index, key] of keys.entries()) {
        const show = () => {
          chart.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex: index });
          chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: index });
        };
        key.addEventListener("focus", show);
        key.addEventListener("click", show);
        key.addEventListener("blur", () => {
          chart.dispatchAction({ type: "downplay", seriesIndex: 0, dataIndex: index });
          chart.dispatchAction({ type: "hideTip" });
        });
      }
    });
  } else {
    panel.body.append(element("p", "error-state", "No recorded active time is available for this selection."));
  }
  const parallelShare = stats.activeMs === 0 ? null : stats.parallelMs / stats.activeMs;
  const busyConcurrency = stats.activeMs === 0 ? null : stats.agentMs / stats.activeMs;
  const list = element("dl", "stat-list");
  const entries: Array<[string, string]> = [
    ["Parallel-work share", metricText(parallelShare, (value) => formatPercent.format(value))],
    ["Average agents while active", metricText(busyConcurrency, (value) => formatDecimal.format(value))],
  ];
  for (const [label, value] of entries) list.append(element("dt", undefined, label), element("dd", undefined, value));
  panel.body.append(list);
  return panel.root;
}

function renderRhythm(days: PublicDay[], state: RenderState, timezone: string, standalone: boolean, rerender: () => void): HTMLElement {
  const panel = createPanel("Work rhythm", "Recorded activity by local weekday and hour.", !standalone);
  panel.header.append(createSegmented([{ value: "active", label: "Active fraction" }, { value: "agent", label: "Agent-hours" }], state.rhythmMetric, "Rhythm value", (value) => { state.rhythmMetric = value as "active" | "agent"; rerender(); }));
  const cells = buildRhythm(days, state.options.harness, timezone);
  const values = cells.map((cell) => !cell.available ? null : state.rhythmMetric === "active" ? cell.activeMs / Math.max(cell.elapsedMs, 1) : cell.agentMs / 3_600_000);
  const max = Math.max(...values.filter((value): value is number => value !== null), 0);
  const tooltip = element("div", "cell-tooltip");
  tooltip.hidden = true;
  tooltip.setAttribute("role", "tooltip");
  const wrap = element("div", "rhythm-wrap");
  const grid = element("div", "rhythm");
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", `Work rhythm in ${timezone}`);
  grid.append(element("span", "rhythm-label"));
  for (let hour = 0; hour < 24; hour += 1) grid.append(element("span", "rhythm-label", hour % 3 === 0 ? String(hour) : ""));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    grid.append(element("span", "rhythm-label", weekdays[weekday]));
    for (let hour = 0; hour < 24; hour += 1) {
      const cell = cells[weekday * 24 + hour]!;
      const value = values[weekday * 24 + hour];
      const button = element("button", "rhythm-cell");
      button.type = "button";
      button.dataset.missing = String(value === null);
      button.dataset.value = value === null ? "unavailable" : String(value);
      const intensity = value === null || max === 0 ? 0 : Math.max(.12, value / max);
      if (value !== null) button.style.background = `color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, var(--panel))`;
      const displayValue = value === null ? "no recorded activity" : state.rhythmMetric === "active" ? formatPercent.format(value) : `${formatDecimal.format(value)} agent-hours`;
      const tooltipText = `${weekdays[weekday]} ${String(hour).padStart(2, "0")}:00: ${displayValue}`;
      button.setAttribute("aria-label", tooltipText);
      attachCellTooltip(button, tooltip, wrap, tooltipText);
      grid.append(button);
    }
  }
  wrap.append(grid, tooltip);
  panel.body.append(wrap, element("p", "qualifier", state.rhythmMetric === "active" ? "Color shows active time as a share of each local hour." : "Color shows summed agent-hours."));
  return panel.root;
}

function resourceOptions(days: PublicDay[], harness: Agent | "all"): ResourceFilter[] {
  const keys = new Map<string, ResourceFilter>();
  for (const day of days) for (const row of selectedRows(day, harness)) keys.set(`${row.provider}${RESOURCE_SEPARATOR}${row.model}`, { provider: row.provider, model: row.model });
  return [...keys.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function renderResourceControls(days: PublicDay[], state: RenderState, rerender: () => void): HTMLElement {
  const controls = element("div", "resource-controls");
  const label = element("label", "control");
  label.append(element("span", undefined, "Provider / model"));
  const select = element("select");
  select.setAttribute("aria-label", "Provider and model resource filter");
  const all = element("option", undefined, "All provider/models");
  all.value = "";
  all.selected = state.resource === null;
  select.append(all);
  for (const resource of resourceOptions(days, state.options.harness)) {
    const option = element("option", undefined, `${resource.provider} / ${resource.model}`);
    option.value = `${resource.provider}${RESOURCE_SEPARATOR}${resource.model}`;
    option.selected = state.resource?.provider === resource.provider && state.resource.model === resource.model;
    select.append(option);
  }
  select.addEventListener("change", () => {
    const [provider, model] = select.value.split(RESOURCE_SEPARATOR);
    state.resource = provider !== undefined && model !== undefined ? { provider, model } : null;
    rerender();
  });
  label.append(select);
  controls.append(label);
  return controls;
}


function renderCache(days: PublicDay[], state: RenderState, standalone: boolean, rerender: () => void): HTMLElement {
  const panel = createPanel("Cache-read share", "Read tokens divided by prompt tokens from the same complete observations—not a request cache-hit rate.", !standalone);
  panel.body.append(renderResourceControls(days, state, rerender));
  const basis = aggregateResources(days, state.options.harness, state.resource).usage.cacheReadBasis;
  const ratio = basis.value === null || basis.value.promptTokens === 0 ? null : basis.value.readTokens / basis.value.promptTokens;
  const value = element("p", "metric-value", metricText(ratio, (number) => formatPercent.format(number)));
  value.dataset.value = ratio === null ? "unavailable" : String(ratio);
  panel.body.append(value);
  panel.body.append(element("p", "metric-secondary", basis.value === null ? "Paired basis unavailable" : `${formatInteger.format(basis.value.readTokens)} read tokens / ${formatInteger.format(basis.value.promptTokens)} prompt tokens`));
  return panel.root;
}

const formatUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function formatMoney(metric: Metric<number>): string {
  return metric.value === null ? "Not reported" : formatUsd.format(metric.value);
}

function renderCost(days: PublicDay[], state: RenderState, pricing: PublicSnapshot["pricing"], standalone: boolean, rerender: () => void): HTMLElement {
  const panel = createPanel("API-equivalent cost · not actual spend", `Computed token value at standard API rates as of ${pricing.asOf}. Subscription charges and invoices differ.`, !standalone);
  panel.body.append(renderResourceControls(days, state, rerender));
  const cost = aggregateResources(days, state.options.harness, state.resource).cost;
  const dated = days.map((day) => ({ date: day.date, cost: aggregateResources([day], state.options.harness, state.resource).cost }))
    .filter((entry) => entry.cost.pricedRecords + entry.cost.unpricedRecords > 0);
  const amount = element("p", "metric-value", cost.apiEquivalentUsd.value === null ? "Unavailable" : formatMoney(cost.apiEquivalentUsd));
  amount.dataset.value = cost.apiEquivalentUsd.value === null ? "unavailable" : String(cost.apiEquivalentUsd.value);
  const recordTotal = cost.pricedRecords + cost.unpricedRecords;
  const knownTokens = cost.pricedTokens + cost.unpricedTokens;
  const recordShare = recordTotal > 0 && Number.isSafeInteger(recordTotal) ? ` (${formatPercent.format(cost.pricedRecords / recordTotal)})` : "";
  const tokenShare = knownTokens > 0 && Number.isSafeInteger(knownTokens) ? formatPercent.format(cost.pricedTokens / knownTokens) : "Unavailable";
  panel.body.append(
    amount,
    element("p", "metric-secondary", `${cost.apiEquivalentUsd.status === "partial" ? "Partial estimate · " : ""}${formatInteger.format(cost.pricedRecords)} priced records${recordShare} · ${formatInteger.format(cost.unpricedRecords)} unpriced records`),
    element("p", "panel-note", `${tokenShare} of known tokens priced · ${formatInteger.format(cost.pricedTokens)} priced / ${formatInteger.format(cost.unpricedTokens)} unpriced known tokens. Unknown token totals are excluded from this share, not from unpriced record counts.`),
  );
  if (cost.unpricedRecords > 0) {
    const reasons = cost.apiEquivalentUsd.reasons;
    const missing = [
      ...(reasons.includes("unpriced-model") || reasons.includes("unknown-model") ? ["missing or unsupported model rates"] : []),
      ...(reasons.includes("incomplete-token-breakdown") ? ["incomplete token breakdowns"] : []),
      ...(reasons.includes("parse-gap") ? ["invalid or unsafe token data"] : []),
    ];
    panel.body.append(element("p", "panel-note", `Unpriced usage is excluded, never treated as free${missing.length > 0 ? `: ${missing.join("; ")}` : "."}`));
  }
  const methodology = element("details", "data-disclosure");
  methodology.append(
    element("summary", undefined, "Pricing methodology and secondary cost evidence"),
    element("p", "panel-note", `Historical usage is valued at pinned standard API rates as of ${pricing.asOf}, not the rates billed on each usage date. Default standard processing and Anthropic five-minute cache writes are assumed. Reasoning tokens are counted within output once. No subscription fees, discounts, taxes, or other fees are included.`),
    element("p", "panel-note", "Source estimates and provider-reported charges below are separate evidence. Neither is added to, or substituted for, the API-equivalent estimate."),
  );
  const sources = element("ul", "panel-note");
  for (const source of pricing.sources) {
    const item = element("li");
    const link = element("a", undefined, new URL(source).hostname);
    link.href = source;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    item.append(link);
    sources.append(item);
  }
  methodology.append(sources);
  const grid = element("div", "cost-grid");
  const estimate = element("div", "cost-item");
  estimate.append(element("span", undefined, "Estimated by source"), element("strong", undefined, formatMoney(cost.sourceEstimatedUsd)));
  const provider = element("div", "cost-item");
  provider.append(element("span", undefined, "Reported by provider"), element("strong", undefined, formatMoney(cost.providerReportedUsd)));
  grid.append(estimate, provider);
  methodology.append(grid, element("p", "panel-note", `${formatInteger.format(cost.unknownRecords)} records had no dated USD evidence · ${formatInteger.format(cost.includedRecords)} records were marked included by their source. These are evidence categories, not API-pricing coverage.`));
  const evidenceWrap = element("div", "table-wrap");
  const evidenceTable = element("table");
  evidenceTable.append(element("caption", "sr-only", "Daily secondary cost evidence, separate from API-equivalent estimates"));
  const evidenceHead = element("thead");
  const evidenceHeader = element("tr");
  for (const label of ["Date", "Estimated by source", "Reported by provider", "No cost evidence", "Included plan"]) evidenceHeader.append(element("th", undefined, label));
  evidenceHead.append(evidenceHeader);
  const evidenceBody = element("tbody");
  for (const entry of dated) {
    const row = element("tr");
    row.append(
      element("td", undefined, entry.date),
      element("td", undefined, formatMoney(entry.cost.sourceEstimatedUsd)),
      element("td", undefined, formatMoney(entry.cost.providerReportedUsd)),
      element("td", undefined, formatInteger.format(entry.cost.unknownRecords)),
      element("td", undefined, formatInteger.format(entry.cost.includedRecords)),
    );
    evidenceBody.append(row);
  }
  evidenceTable.append(evidenceHead, evidenceBody);
  evidenceWrap.append(evidenceTable);
  methodology.append(evidenceWrap);
  panel.body.append(methodology);
  const wrap = element("div", "table-wrap");
  const table = element("table");
  const caption = element("caption", "sr-only", "Daily API-equivalent estimates and pricing coverage; not actual spend");
  const head = element("thead");
  const header = element("tr");
  for (const label of ["Date", "API-equivalent USD", "Priced records", "Unpriced records", "Known tokens priced"]) header.append(element("th", undefined, label));
  head.append(header);
  const body = element("tbody");
  for (const { date, cost: daily } of dated) {
    const total = daily.pricedTokens + daily.unpricedTokens;
    const row = element("tr");
    row.append(
      element("td", undefined, date),
      element("td", undefined, daily.apiEquivalentUsd.value === null ? "Unavailable" : `${formatMoney(daily.apiEquivalentUsd)}${daily.apiEquivalentUsd.status === "partial" ? " · partial" : ""}`),
      element("td", undefined, formatInteger.format(daily.pricedRecords)),
      element("td", undefined, formatInteger.format(daily.unpricedRecords)),
      element("td", undefined, total > 0 && Number.isSafeInteger(total) ? formatPercent.format(daily.pricedTokens / total) : "Unavailable"),
    );
    body.append(row);
  }
  table.append(caption, head, body);
  wrap.append(table);
  panel.body.append(wrap);
  return panel.root;
}

function renderDataTable(days: PublicDay[], state: RenderState): HTMLElement {
  const details = element("details", "panel data-disclosure");
  const summary = element("summary", undefined, "Accessible daily data table");
  const wrap = element("div", "table-wrap");
  const table = element("table");
  const caption = element("caption", "sr-only", `Daily activity for the selected ${state.options.range}-day range`);
  const head = element("thead");
  const headRow = element("tr");
  for (const label of ["Date", "Tokens", "Default-branch commits", "Active hours", "Agent-hours"]) headRow.append(element("th", undefined, label));
  head.append(headRow);
  const body = element("tbody");
  for (const day of days) {
    const usage = state.options.harness === "all" ? day.usage : aggregateResources([day], state.options.harness).usage;
    const work = workMetricForHarness(day.work, state.options.harness);
    const row = element("tr");
    row.append(
      element("td", undefined, day.date),
      element("td", undefined, metricText(usage.total.value, (value) => formatInteger.format(value))),
      element("td", undefined, metricText(day.commits.value, (value) => formatInteger.format(value))),
      element("td", undefined, metricText(work.value === null ? null : work.value.activeMs / 3_600_000, (value) => formatDecimal.format(value))),
      element("td", undefined, metricText(work.value === null ? null : work.value.agentMs / 3_600_000, (value) => formatDecimal.format(value))),
    );
    body.append(row);
  }
  table.append(caption, head, body);
  wrap.append(table);
  details.append(summary, wrap);
  return details;
}

function renderFooter(snapshot: PublicSnapshot): HTMLElement {
  const footer = element("footer", "dashboard-footer");
  const updated = new Date(snapshot.cutoff);
  footer.append(element("span", undefined, `${snapshot.timezone} · Last update ${updated.toLocaleString(undefined, { timeZone: snapshot.timezone, dateStyle: "medium", timeStyle: "short" })}`));
  if (Date.now() - updated.valueOf() > 30 * 60_000) footer.append(element("span", "stale", "Stale data · over 30 minutes old"));
  return footer;
}

function shouldRender(current: WidgetView, target: WidgetView): boolean {
  return current === "all" || current === target;
}

function applyTheme(theme: WidgetTheme): void {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}

const dashboardCleanups = new WeakMap<HTMLElement, () => void>();

export function renderDashboard(root: HTMLElement, snapshot: PublicSnapshot, initial: WidgetOptions): void {
  dashboardCleanups.get(root)?.();
  const available = enabledHarnesses(snapshot);
  const state: RenderState = {
    options: { ...initial, harness: initial.harness === "all" || available.includes(initial.harness) ? initial.harness : "all" },
    grouping: "model",
    rhythmMetric: "active",
    resource: null,
    hiddenSeries: new Set(),
    chartMounts: [],
  };
  let chartCleanups: Array<() => void> = [];
  const disposeCharts = () => {
    for (const cleanup of chartCleanups) cleanup();
    chartCleanups = [];
  };
  dashboardCleanups.set(root, disposeCharts);
  const draw = () => {
    disposeCharts();
    state.chartMounts = [];
    const days = selectedDays(snapshot, state.options.range);
    const dashboard = element("div", "dashboard");
    dashboard.dataset.view = state.options.view;
    dashboard.dataset.range = String(state.options.range);
    dashboard.dataset.harness = state.options.harness;
    dashboard.append(renderToolbar(snapshot, state, draw));
    if (["all", "uptime", "concurrency", "agent-hours"].includes(state.options.view)) dashboard.append(renderCards(days, state, state.options.view));
    if (shouldRender(state.options.view, "calendar")) dashboard.append(renderCalendar(days, state, false));
    if (state.options.view === "commits") dashboard.append(renderCalendar(days, state, true));
    if (shouldRender(state.options.view, "models")) dashboard.append(renderModels(days, state, draw));
    if (shouldRender(state.options.view, "parallelism")) dashboard.append(renderParallelism(days, state, state.options.view === "parallelism"));
    if (shouldRender(state.options.view, "rhythm")) dashboard.append(renderRhythm(days, state, snapshot.timezone, state.options.view === "rhythm", draw));
    if (shouldRender(state.options.view, "cache")) dashboard.append(renderCache(days, state, state.options.view === "cache", draw));
    if (shouldRender(state.options.view, "cost")) dashboard.append(renderCost(days, state, snapshot.pricing, state.options.view === "cost", draw));
    dashboard.append(renderDataTable(days, state), renderFooter(snapshot));
    replaceChildren(root, dashboard);
    chartCleanups = state.chartMounts.map((mount) => mount());
  };
  applyTheme(state.options.theme);
  draw();
}

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!(root instanceof HTMLElement)) return;
  const baseOptions = parseWidgetOptions(new URLSearchParams(window.location.search));
  applyTheme(baseOptions.theme);
  try {
    const response = await fetch("./activity.json", { credentials: "same-origin", cache: "no-cache" });
    if (!response.ok) throw new Error(`Activity data request failed (${response.status})`);
    const data: unknown = await response.json();
    if (!isPublicSnapshot(data)) throw new Error("Activity data does not match the public snapshot schema");
    const options = parseWidgetOptions(new URLSearchParams(window.location.search), enabledHarnesses(data));
    renderDashboard(root, data, options);
  } catch (error) {
    const message = element("p", "error-state", error instanceof Error ? error.message : "Activity data is unavailable");
    replaceChildren(root, message);
  }
  for (const copy of document.querySelectorAll<HTMLButtonElement>("[data-copy-target]")) {
    copy.addEventListener("click", async () => {
      const targetId = copy.dataset.copyTarget;
      const example = targetId ? document.getElementById(targetId) : null;
      if (!(example instanceof HTMLInputElement)) return;
      try {
        await navigator.clipboard.writeText(example.value);
        copy.textContent = "Copied";
      } catch {
        example.focus();
        example.select();
        copy.textContent = "Select and copy";
      }
    });
  }
}

if (typeof document !== "undefined") void boot();
