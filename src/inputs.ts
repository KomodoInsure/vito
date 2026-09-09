import { inputRecordSchema, type InputRecord } from "./contracts";
import type { CollectorStore } from "./store";

function ownerOrder(left: InputRecord, right: InputRecord): number {
  const leftAt = left.atMs ?? Number.MAX_SAFE_INTEGER;
  const rightAt = right.atMs ?? Number.MAX_SAFE_INTEGER;
  return leftAt - rightAt
    || left.sessionKey.localeCompare(right.sessionKey)
    || left.nativeSessionId.localeCompare(right.nativeSessionId)
    || left.sourceKey.localeCompare(right.sourceKey);
}

function sameOwner(left: InputRecord, right: InputRecord): boolean {
  return left.agent === right.agent
    && left.sessionKey === right.sessionKey
    && left.nativeSessionId === right.nativeSessionId
    && left.nativeInputId === right.nativeInputId;
}

function mergeEvidence(result: InputRecord, observations: readonly InputRecord[]): void {
  const stickyConflict = observations.some((record) => record.originEvidence === "conflict");
  const explicitOrigins = new Set(observations
    .filter((record) => record.origin !== "unknown")
    .map((record) => record.origin));
  const controllers = new Set(observations
    .map((record) => record.controller)
    .filter((controller): controller is string => controller !== null));

  result.controller = stickyConflict ? null : controllers.size === 1 ? [...controllers][0]! : null;
  if (stickyConflict || explicitOrigins.size > 1) {
    result.origin = "unknown";
    result.originEvidence = "conflict";
    result.reasons = [...new Set([...result.reasons, "input-origin-conflict"])].sort();
    return;
  }

  const explicitOrigin = [...explicitOrigins][0];
  if (explicitOrigin === undefined) {
    result.origin = "unknown";
    result.originEvidence = "none";
    return;
  }

  result.origin = explicitOrigin;
  result.originEvidence = observations.some((record) =>
    record.origin === explicitOrigin && record.originEvidence === "source")
    ? "source"
    : "provenance";
}

/**
 * Merge native observations by their stable event key without allowing copied
 * history or an unknown rescan to replace established ownership/evidence.
 */
export function mergeInputRecords(
  records: readonly InputRecord[],
  retained: readonly InputRecord[] = [],
): InputRecord[] {
  const currentByKey = new Map<string, InputRecord[]>();
  const retainedByKey = new Map<string, InputRecord[]>();
  for (const record of records) {
    const bucket = currentByKey.get(record.originKey) ?? [];
    bucket.push(record);
    currentByKey.set(record.originKey, bucket);
  }
  for (const record of retained) {
    const bucket = retainedByKey.get(record.originKey) ?? [];
    bucket.push(record);
    retainedByKey.set(record.originKey, bucket);
  }

  const keys = new Set([...currentByKey.keys(), ...retainedByKey.keys()]);
  const merged: InputRecord[] = [];
  for (const key of [...keys].sort()) {
    const current = currentByKey.get(key) ?? [];
    const previous = retainedByKey.get(key) ?? [];
    const observations = [...previous, ...current];
    if (observations.length === 0) continue;

    const establishedOwner = previous
      .filter((record) => record.kind !== "replay")
      .sort(ownerOrder)[0] ?? previous.sort(ownerOrder)[0];
    const owner = establishedOwner ?? [...current].sort(ownerOrder)[0]!;
    const currentOwner = current.filter((record) => sameOwner(record, owner)).at(-1);
    const selected = currentOwner ?? owner;
    const result: InputRecord = { ...selected, reasons: [...selected.reasons] };

    const incompatibleCopyTime = observations.some((record) =>
      !sameOwner(record, owner)
      && record.atMs !== null
      && owner.atMs !== null
      && record.atMs !== owner.atMs);
    if (incompatibleCopyTime) {
      result.kind = "unknown";
      result.quality = "partial";
      result.reasons = [...new Set([...result.reasons, "input-kind-unknown"])].sort();
    }

    mergeEvidence(result, observations);
    merged.push(result);
  }
  return merged;
}
export function storedInputReasons(
  row: Readonly<Record<string, unknown>> | null,
): string[] {
  if (typeof row?.reasons_json !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(row.reasons_json);
    return Array.isArray(parsed) && parsed.every((reason) => typeof reason === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}


export function storedInputRecord(row: Readonly<Record<string, unknown>>): InputRecord | null {
  const reasons = storedInputReasons(row);
  const parsed = inputRecordSchema.safeParse({
    originKey: row.origin_key,
    sourceKey: row.source_key,
    agent: row.agent,
    sessionKey: row.session_key,
    nativeSessionId: row.native_session_id,
    nativeInputId: row.native_input_id,
    workspaceKey: row.workspace_key,
    repositoryKey: row.repository_key,
    atMs: row.at_ms,
    kind: row.kind,
    lane: row.lane,
    controller: row.controller,
    origin: row.origin,
    originEvidence: row.origin_evidence,
    quality: row.quality,
    reasons,
  });
  return parsed.success ? parsed.data : null;
}

export function retainedInputRecords(
  store: CollectorStore,
  originKeys: Iterable<string>,
): InputRecord[] {
  const retained: InputRecord[] = [];
  for (const originKey of new Set(originKeys)) {
    const row = store.getInput(originKey);
    if (row === null) continue;
    const parsed = storedInputRecord(row);
    if (parsed !== null) retained.push(parsed);
  }
  return retained;
}
