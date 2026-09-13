import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, normalize } from "node:path";

function contentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "application/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

export async function serveStatic(response: ServerResponse, filePath: string): Promise<boolean> {
  const normalized = normalize(filePath);
  if (!existsSync(normalized)) return false;
  const [data, metadata] = await Promise.all([readFile(normalized), stat(normalized)]);
  response.writeHead(200, {
    "content-type": contentType(normalized),
    "content-length": String(metadata.size)
  });
  response.end(data);
  return true;
}

export function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-request-id,x-vrata-admin-token,x-vrata-internal-token,x-noah-admin-token,x-noah-internal-token",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

export function text(response: ServerResponse, statusCode: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store"
  });
  response.end(body);
}

export function attachment(response: ServerResponse, statusCode: number, body: string | Buffer, filename: string, contentType: string): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]+/g, "-")}"`,
    "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store"
  });
  response.end(body);
}
