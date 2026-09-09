import { createHash } from "node:crypto";
import { z } from "zod";

import type { Config } from "../config";
import {
  agentSchema,
  type InputProvenanceRecord,
  type InputRecord,
} from "../contracts";
import { mergeInputRecords, storedInputRecord } from "../inputs";
import type { CollectorStore } from "../store";
import { resolveSourcePath, scanJsonl, sourcePathKey, type JsonlScanResult } from "./jsonl";

const SOURCE_KEY = "input-provenance";
const MAX_LINE_BYTES = 65_536;

const DIAGNOSTIC_KEYS = [
  "input-provenance-unreadable",
  "input-provenance-unsupported",
  "input-provenance-parse-gap",
  "input-provenance-tail",
  "input-provenance-pending",
  "input-provenance-ambiguous",
] as const;

type ProvenanceDiagnostic = (typeof DIAGNOSTIC_KEYS)[number];
type ProvenanceDiagnostics = Partial<Record<ProvenanceDiagnostic, number>>;

interface StoredProvenance {
  agent: InputProvenanceRecord["agent"];
  native_session_id: string;
  native_input_id: string;
  origin: InputProvenanceRecord["origin"];
  controller: string | null;
}

interface StoredInput extends Record<string, unknown> {
  origin_key: string;
  agent: InputRecord["agent"];
  native_session_id: string;
  native_input_id: string;
  at_ms: number | null;
  kind: InputRecord["kind"];
  origin_evidence: InputRecord["originEvidence"];
  native_controller: string | null;
  native_origin: InputRecord["origin"] | null;
  native_origin_evidence: "source" | "none" | null;
}

export const inputProvenanceEventSchema = z
  .object({
    version: z.literal(1),
    agent: agentSchema,
    sessionId: z.string().min(1),
    inputId: z.string().min(1),
    status: z.literal("delivered"),
    origin: z.enum(["human", "automated"]),
    controller: z.string().min(1).max(128).optional(),
  })
  .strict();

function addDiagnostic(
  diagnostics: ProvenanceDiagnostics,
  key: ProvenanceDiagnostic,
  count: number,
): void {
  if (count <= 0) return;
  diagnostics[key] = (diagnostics[key] ?? 0) + count;
}

function claimOriginKey(record: Omit<InputProvenanceRecord, "originKey">): string {
  return createHash("sha256").update(JSON.stringify([
    record.agent,
    record.nativeSessionId,
    record.nativeInputId,
    record.origin,
    record.controller,
  ])).digest("hex");
}

function tupleKey(
  agent: InputProvenanceRecord["agent"],
  nativeSessionId: string,
  nativeInputId: string,
): string {
  return JSON.stringify([agent, nativeSessionId, nativeInputId]);
}

function retainedClaims(store: CollectorStore): StoredProvenance[] {
  return store.database.query(`
    SELECT agent, native_session_id, native_input_id, origin, controller
    FROM input_provenance
    ORDER BY agent, native_session_id, native_input_id, origin, controller
  `).all() as StoredProvenance[];
}

function retainedMatchingInputs(store: CollectorStore): StoredInput[] {
  return store.database.query(`
    SELECT input_events.*,
      input_native_evidence.controller AS native_controller,
      input_native_evidence.origin AS native_origin,
      input_native_evidence.origin_evidence AS native_origin_evidence
    FROM input_events
    INNER JOIN (
      SELECT DISTINCT agent, native_session_id, native_input_id
      FROM input_provenance
    ) AS claims
      ON claims.agent = input_events.agent
      AND claims.native_session_id = input_events.native_session_id
      AND claims.native_input_id = input_events.native_input_id
    LEFT JOIN input_native_evidence
      ON input_native_evidence.origin_key = input_events.origin_key
    ORDER BY input_events.agent, input_events.native_session_id,
      input_events.native_input_id, input_events.origin_key
  `).all() as StoredInput[];
}

function nativeInputRecord(row: StoredInput): InputRecord {
  const current = storedInputRecord(row);
  if (current === null) throw new Error("Stored input failed provenance reconciliation validation");
  if (row.native_origin_evidence === null || row.native_origin === null) {
    if (current.originEvidence !== "provenance") return current;
    return {
      ...current,
      controller: null,
      origin: "unknown",
      originEvidence: "none",
      reasons: current.reasons.filter((reason) => reason !== "input-origin-conflict"),
    };
  }
  return {
    ...current,
    controller: row.native_controller,
    origin: row.native_origin,
    originEvidence: row.native_origin_evidence,
    reasons: current.reasons.filter((reason) => reason !== "input-origin-conflict"),
  };
}

function reconcileRetainedClaims(
  store: CollectorStore,
  cutoffMs: number,
  diagnostics: ProvenanceDiagnostics,
): void {
  const claims = retainedClaims(store);
  if (claims.length === 0) return;

  const claimsByTuple = new Map<string, StoredProvenance[]>();
  for (const claim of claims) {
    const key = tupleKey(claim.agent, claim.native_session_id, claim.native_input_id);
    const records = claimsByTuple.get(key) ?? [];
    records.push(claim);
    claimsByTuple.set(key, records);
  }
  const inputsByTuple = new Map<string, StoredInput[]>();
  for (const record of retainedMatchingInputs(store)) {
    const key = tupleKey(record.agent, record.native_session_id, record.native_input_id);
    const records = inputsByTuple.get(key) ?? [];
    records.push(record);
    inputsByTuple.set(key, records);
  }

  store.transaction(() => {
    for (const [key, tupleClaims] of claimsByTuple) {
      const tupleInputs = inputsByTuple.get(key) ?? [];
      const submissions = new Map<string, StoredInput>();
      for (const record of tupleInputs) {
        if (record.kind !== "submission" || record.at_ms === null || record.at_ms > cutoffMs) continue;
        submissions.set(record.origin_key, record);
      }

      if (submissions.size !== 1) {
        addDiagnostic(
          diagnostics,
          submissions.size === 0 ? "input-provenance-pending" : "input-provenance-ambiguous",
          1,
        );
        for (const row of tupleInputs) {
          if (
            row.origin_evidence !== "provenance"
            && !(row.origin_evidence === "conflict" && row.native_origin_evidence !== null)
          ) {
            continue;
          }
          const native = nativeInputRecord(row);
          store.database.query(`
            UPDATE input_events
            SET controller = ?, origin = ?, origin_evidence = ?, reasons_json = ?
            WHERE origin_key = ?
          `).run(
            native.controller,
            native.origin,
            native.originEvidence,
            JSON.stringify([...new Set(native.reasons)].sort()),
            native.originKey,
          );
        }
        continue;
      }

      const row = submissions.values().next().value;
      if (row === undefined) continue;
      const native = nativeInputRecord(row);
      const observations: InputRecord[] = tupleClaims.map((claim) => ({
        ...native,
        origin: claim.origin,
        originEvidence: "provenance",
        controller: claim.controller,
      }));
      const merged = mergeInputRecords(observations, [native])[0];
      if (merged === undefined) throw new Error("Input provenance reconciliation produced no record");
      store.database.query(`
        UPDATE input_events
        SET controller = ?, origin = ?, origin_evidence = ?, reasons_json = ?
        WHERE origin_key = ?
      `).run(
        merged.controller,
        merged.origin,
        merged.originEvidence,
        JSON.stringify([...new Set(merged.reasons)].sort()),
        merged.originKey,
      );
    }
  });
}

export async function collectInputProvenance(
  config: Config,
  store: CollectorStore,
  options: { rebuild: boolean; cutoffMs: number },
): Promise<Record<string, number>> {
  if (!Number.isSafeInteger(options.cutoffMs) || options.cutoffMs < 0) {
    throw new TypeError("cutoffMs must be a nonnegative safe integer");
  }
  const diagnostics: ProvenanceDiagnostics = {};

  for (const configuredPath of new Set(config.inputProvenance ?? [])) {
    let canonicalPath: string;
    try {
      canonicalPath = await resolveSourcePath(configuredPath);
    } catch {
      addDiagnostic(diagnostics, "input-provenance-unreadable", 1);
      continue;
    }

    const pathKey = sourcePathKey(SOURCE_KEY, canonicalPath);
    const previousCursor = options.rebuild ? null : store.getFileCursor(SOURCE_KEY, pathKey);
    const records: InputProvenanceRecord[] = [];
    let scan: JsonlScanResult;
    try {
      scan = await scanJsonl({
        sourceKey: SOURCE_KEY,
        pathKey,
        path: canonicalPath,
        previousCursor,
        maxLineBytes: MAX_LINE_BYTES,
        classify(record) {
          return inputProvenanceEventSchema.safeParse(record).success ? "accept" : "unsupported-schema";
        },
        onRecord(record) {
          const event = inputProvenanceEventSchema.parse(record);
          const normalized = {
            agent: event.agent,
            nativeSessionId: event.sessionId,
            nativeInputId: event.inputId,
            origin: event.origin,
            controller: event.controller ?? null,
          };
          records.push({ originKey: claimOriginKey(normalized), ...normalized });
        },
      });
    } catch {
      addDiagnostic(diagnostics, "input-provenance-unreadable", 1);
      continue;
    }

    addDiagnostic(diagnostics, "input-provenance-unsupported", scan.diagnostics.unsupportedSchema);
    addDiagnostic(diagnostics, "input-provenance-parse-gap", scan.diagnostics.parseGaps);
    addDiagnostic(diagnostics, "input-provenance-tail", scan.diagnostics.unterminatedTailBytes);
    store.writeBatch({ inputProvenance: records, fileCursors: [scan.cursor] });
  }

  reconcileRetainedClaims(store, options.cutoffMs, diagnostics);
  const result: Record<string, number> = {};
  for (const key of DIAGNOSTIC_KEYS) {
    const value = diagnostics[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
