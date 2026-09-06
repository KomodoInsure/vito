import { createHash } from "node:crypto";
import { open, realpath, stat as statPath, type FileHandle } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

import { isPathWithin } from "../config";
import type { FileCursor } from "../store";

const FINGERPRINT_BYTES = 4_096;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface JsonlRecordLocation {
  lineNumber: number;
  startOffset: number;
  endOffset: number;
}

export type JsonlRecordDisposition = "accept" | "skip" | "unsupported-schema";

export interface JsonlScanOptions {
  sourceKey: string;
  pathKey?: string;
  path: string;
  previousCursor?: FileCursor | Record<string, unknown> | null;
  maxLineBytes?: number;
  classify?: (record: unknown, location: JsonlRecordLocation) => JsonlRecordDisposition;
  onRecord: (record: unknown, location: JsonlRecordLocation) => void | Promise<void>;
}

export interface JsonlDiagnostics {
  completeLines: number;
  acceptedRecords: number;
  parseGaps: number;
  unsupportedSchema: number;
  unterminatedTailBytes: number;
  replayed: boolean;
  replayReason: "new" | "identity-changed" | "truncated" | "prefix-changed" | "tail-changed" | null;
}

export interface JsonlScanResult {
  cursor: FileCursor;
  diagnostics: JsonlDiagnostics;
}


function cursorText(cursor: FileCursor | Record<string, unknown>, camel: keyof FileCursor, snake: string): string | undefined {
  const value = (cursor as Record<string, unknown>)[camel as string] ?? (cursor as Record<string, unknown>)[snake];
  return value === undefined || value === null ? undefined : String(value);
}

function cursorNumber(cursor: FileCursor | Record<string, unknown>, camel: keyof FileCursor, snake: string): number | undefined {
  const value = (cursor as Record<string, unknown>)[camel as string] ?? (cursor as Record<string, unknown>)[snake];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function readRange(
  handle: FileHandle,
  start: number,
  length: number,
): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const result = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(result, offset, length - offset, start + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === length ? result : result.subarray(0, offset);
}

async function fingerprintsAt(
  handle: FileHandle,
  committedOffset: number,
): Promise<{ prefix: string; tail: string }> {
  const prefixLength = Math.min(committedOffset, FINGERPRINT_BYTES);
  const tailLength = Math.min(committedOffset, FINGERPRINT_BYTES);
  const [prefix, tail] = await Promise.all([
    readRange(handle, 0, prefixLength),
    readRange(handle, committedOffset - tailLength, tailLength),
  ]);
  return {
    prefix: createHash("sha256").update(prefix).digest("hex"),
    tail: createHash("sha256").update(tail).digest("hex"),
  };
}


/** Resolve a canonical source path and reject escapes from an optional recognized root. */
export async function resolveSourcePath(input: string, recognizedRoot?: string): Promise<string> {
  if (!isAbsolute(input)) throw new Error("Source path must be absolute");
  const canonical = normalize(await realpath(input));
  if (recognizedRoot !== undefined) {
    if (!isAbsolute(recognizedRoot)) throw new Error("Recognized source root must be absolute");
    const canonicalRoot = normalize(await realpath(recognizedRoot));
    if (!isPathWithin(canonicalRoot, canonical)) throw new Error("Source path escapes its recognized root");
  }
  return canonical;
}

export function sourcePathKey(sourceKey: string, canonicalPath: string): string {
  return createHash("sha256").update(sourceKey).update("\0").update(canonicalPath).digest("hex");
}

/**
 * Streams one stable snapshot of a JSONL file. Only newline-terminated records are
 * delivered and checkpointed. The caller must commit the returned cursor in the
 * same transaction as records derived from this scan.
 */
export async function scanJsonl(options: JsonlScanOptions): Promise<JsonlScanResult> {
  const canonicalPath = await resolveSourcePath(options.path);
  const pathKey = options.pathKey ?? sourcePathKey(options.sourceKey, canonicalPath);
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) throw new TypeError("maxLineBytes must be a positive safe integer");

  const handle = await open(canonicalPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("JSONL source is not a regular file");
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("JSONL source size is unsupported");

    const device = String(stat.dev);
    const inode = String(stat.ino);
    let startOffset = 0;
    let replayReason: JsonlDiagnostics["replayReason"] = "new";
    const previous = options.previousCursor;
    if (previous) {
      const previousDevice = cursorText(previous, "device", "device");
      const previousInode = cursorText(previous, "inode", "inode");
      const previousOffset = cursorNumber(previous, "byteOffset", "byte_offset");
      const previousPrefix = cursorText(previous, "prefixFingerprint", "prefix_fingerprint");
      const previousTail = cursorText(previous, "tailFingerprint", "tail_fingerprint");
      if (previousDevice !== device || previousInode !== inode || previousOffset === undefined) {
        replayReason = "identity-changed";
      } else if (stat.size < previousOffset) {
        replayReason = "truncated";
      } else {
        const current = await fingerprintsAt(handle, previousOffset);
        if (current.prefix !== previousPrefix) replayReason = "prefix-changed";
        else if (current.tail !== previousTail) replayReason = "tail-changed";
        else {
          startOffset = previousOffset;
          replayReason = null;
        }
      }
    }

    const snapshotSize = stat.size;
    let completeOffset = startOffset;
    let lineStart = startOffset;
    let lineNumber = 0;
    let carry = Buffer.alloc(0);
    let discardingOversizedLine = false;
    let completeLines = 0;
    let acceptedRecords = 0;
    let parseGaps = 0;
    let unsupportedSchema = 0;

    if (startOffset < snapshotSize) {
      const stream = handle.createReadStream({ start: startOffset, end: snapshotSize - 1, autoClose: false });
      let chunkStart = startOffset;
      for await (const rawChunk of stream) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        let segmentStart = 0;
        for (let index = 0; index < chunk.length; index += 1) {
          if (chunk[index] !== 0x0a) continue;
          const segment = chunk.subarray(segmentStart, index);
          const endOffset = chunkStart + index + 1;
          completeLines += 1;
          lineNumber += 1;
          if (discardingOversizedLine || carry.length + segment.length > maxLineBytes) {
            parseGaps += 1;
          } else {
            let line = carry.length === 0 ? segment : Buffer.concat([carry, segment], carry.length + segment.length);
            if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
            if (line.length > 0) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(line.toString("utf8"));
              } catch {
                parseGaps += 1;
                parsed = undefined;
              }
              if (parsed !== undefined) {
                const location = { lineNumber, startOffset: lineStart, endOffset };
                const disposition = options.classify?.(parsed, location) ?? "accept";
                if (disposition === "unsupported-schema") unsupportedSchema += 1;
                else if (disposition === "accept") {
                  await options.onRecord(parsed, location);
                  acceptedRecords += 1;
                }
              }
            }
          }
          carry = Buffer.alloc(0);
          discardingOversizedLine = false;
          completeOffset = endOffset;
          lineStart = endOffset;
          segmentStart = index + 1;
        }
        const remainder = chunk.subarray(segmentStart);
        if (!discardingOversizedLine && remainder.length > 0) {
          if (carry.length + remainder.length > maxLineBytes) {
            carry = Buffer.alloc(0);
            discardingOversizedLine = true;
          } else {
            carry = carry.length === 0 ? Buffer.from(remainder) : Buffer.concat([carry, remainder], carry.length + remainder.length);
          }
        }
        chunkStart += chunk.length;
      }
    }
    const finalPathStat = await statPath(canonicalPath);
    if (String(finalPathStat.dev) !== device || String(finalPathStat.ino) !== inode || finalPathStat.size < snapshotSize) {
      throw new Error("JSONL source changed identity or truncated during scan");
    }
    if (finalPathStat.size === snapshotSize && finalPathStat.mtimeMs !== stat.mtimeMs) {
      throw new Error("JSONL source changed while it was being scanned");
    }


    const fingerprints = await fingerprintsAt(handle, completeOffset);
    const mtimeMs = Math.max(0, Math.floor(stat.mtimeMs));
    return {
      cursor: {
        sourceKey: options.sourceKey,
        pathKey,
        sourcePath: canonicalPath,
        device,
        inode,
        byteOffset: completeOffset,
        sizeBytes: snapshotSize,
        mtimeMs,
        prefixFingerprint: fingerprints.prefix,
        tailFingerprint: fingerprints.tail,
      },
      diagnostics: {
        completeLines,
        acceptedRecords,
        parseGaps,
        unsupportedSchema,
        unterminatedTailBytes: snapshotSize - completeOffset,
        replayed: replayReason !== null && previous != null,
        replayReason,
      },
    };
  } finally {
    await handle.close();
  }
}
