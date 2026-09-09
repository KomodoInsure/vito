import type { Config } from "../config";
import type { Agent, InputRecord, InputSourceState, Quality, UsageRecord, WorkInterval } from "../contracts";
import type {
  CollectorStore,
  CounterSnapshot,
  FileCursor,
  SessionRecord,
  SourceRecord,
} from "../store";

export type DiscoveryState =
  | "available"
  | "partial"
  | "not-found"
  | "installed-no-history"
  | "excluded-wrapper"
  | "unsupported-schema";

export interface SourceCapability {
  tokens: Quality;
  work: Quality;
}

export interface DiscoveryEntry {
  agent: string;
  state: DiscoveryState;
  capabilities: SourceCapability;
  paths: string[];
  diagnosticCounts: Record<string, number>;
  reasons: string[];
}

export interface AdapterContext {
  config: Config;
  store: CollectorStore;
  rebuild: boolean;
  cutoffMs: number;
  reconcileAll: boolean;
}

export interface AdapterBatch {
  source: SourceRecord;
  sessions: SessionRecord[];
  usage: UsageRecord[];
  workIntervals: WorkInterval[];
  inputs: InputRecord[];
  inputSourceState: InputSourceState;
  counterSnapshots: CounterSnapshot[];
  fileCursors: FileCursor[];
  unallocatedUsageRecords: number;
  excludedAmbiguousRecords: number;
}

export interface SourceAdapter {
  agent: Agent;
  discover(config?: Config): Promise<DiscoveryEntry[]>;
  collect(context: AdapterContext): Promise<AdapterBatch>;
}
