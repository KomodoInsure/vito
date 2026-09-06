import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename } from "node:path";

import { EXPORT_FILES, resolveExportAsset } from "./export";
import { publicSnapshotSchema } from "./contracts";

const CONTENT_TYPES: Record<(typeof EXPORT_FILES)[number], string> = {
  ".nojekyll": "application/octet-stream",
  "activity.json": "application/json; charset=utf-8",
  "index.html": "text/html; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "widget.html": "text/html; charset=utf-8",
  "widget.js": "text/javascript; charset=utf-8",
};

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-cache",
  // ECharts' native HTML tooltips emit style attributes; scripts and stylesheets remain same-origin.
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export class PreviewError extends Error {
  override readonly name = "PreviewError";
}

interface PreviewAsset {
  body: string;
  contentType: string;
}

export type PreviewHandler = (request: Request) => Response;

function prepareAssets(directory: string): Record<string, PreviewAsset> {
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PreviewError(`Preview directory must be a real directory: ${directory}`);
  }
  const root = realpathSync(directory);
  const entries = readdirSync(root).sort();
  const expected = [...EXPORT_FILES].sort();
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    throw new PreviewError(`Preview directory must contain exactly the Vito export manifest: ${expected.join(", ")}`);
  }

  const assets: Record<string, PreviewAsset> = {};
  try {
    for (const file of EXPORT_FILES) {
      const path = resolveExportAsset(root, file);
      assets[file] = { body: readFileSync(path, "utf8"), contentType: CONTENT_TYPES[file] };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid asset";
    throw new PreviewError(`Cannot load preview export: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(assets["activity.json"]!.body);
  } catch {
    throw new PreviewError("Invalid exported activity.json: malformed JSON");
  }
  const validation = publicSnapshotSchema.safeParse(parsed);
  if (!validation.success) throw new PreviewError(`Invalid exported activity.json: ${validation.error.message}`);
  return assets;
}

function requestedAsset(request: Request): (typeof EXPORT_FILES)[number] | null {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(?<path>\/[^?#]*)?/.exec(request.url);
  const rawPath = match?.groups?.path ?? "/";
  const rawSegments = rawPath.split("/");
  const decodedSegments: string[] = [];
  for (const rawSegment of rawSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (segment === "." || segment === ".." || segment.includes("\\") || segment.includes("/") || segment.includes("\0")) {
      return null;
    }
    decodedSegments.push(segment);
  }

  const pathname = decodedSegments.join("/");
  const selected = pathname.endsWith("/") ? "index.html" : basename(pathname);
  return (EXPORT_FILES as readonly string[]).includes(selected) ? selected as (typeof EXPORT_FILES)[number] : null;
}

export function createPreviewHandler(directory: string): PreviewHandler {
  const assets = prepareAssets(directory);
  return (request: Request): Response => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed\n", {
        status: 405,
        headers: { ...SECURITY_HEADERS, Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const file = requestedAsset(request);
    if (file === null) {
      return new Response("Not Found\n", {
        status: 404,
        headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const asset = assets[file]!;
    return new Response(request.method === "HEAD" ? null : asset.body, {
      status: 200,
      headers: { ...SECURITY_HEADERS, "Content-Type": asset.contentType },
    });
  };
}

export function startPreview(directory: string, port = 4173): Bun.Server<undefined> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new PreviewError("Preview port must be an integer from 1 to 65535");
  const fetch = createPreviewHandler(directory);
  return Bun.serve({ hostname: "127.0.0.1", port, fetch });
}
