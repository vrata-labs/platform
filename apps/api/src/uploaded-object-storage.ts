import { copyFile, link, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { dirname, extname, join, relative, sep } from "node:path";

import { normalizeSceneBundleRelativePath } from "@vrata/asset-pipeline";

import { resolveSceneBundlePublicUrl } from "./scene-bundle-storage.js";
import type { SceneBundleUploadStorage, DocumentUploadStorage } from "./upload-storage-config.js";

export function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function joinUrlPath(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.split("/").map(encodeURIComponent).join("/"), base).toString();
}

function contentTypeForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".json": return "application/json";
    case ".glb": return "model/gltf-binary";
    case ".gltf": return "model/gltf+json";
    case ".fbx": return "application/octet-stream";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".ktx2": return "image/ktx2";
    default: return "application/octet-stream";
  }
}

async function listFilesRecursive(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(root, absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(root, absolutePath).split(sep).join("/"));
    }
  }
  return files;
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

async function discardResponseBody(response: Response): Promise<void> {
  // PUT/DELETE and unsuccessful GET do not consume their response bodies. Cancel them even when
  // headers arrive early and the server never ends the body; this is transport cleanup, not a
  // statement about whether a remote write has settled. Preserve the original result/status error.
  if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
}

async function putS3Object(storage: Extract<SceneBundleUploadStorage, { type: "s3" }>, key: string, body: Buffer, contentType: string, errorPrefix = "scene_bundle_object_upload_failed", ifAbsent = false, signal?: AbortSignal): Promise<void> {
  const endpoint = storage.endpoint.endsWith("/") ? storage.endpoint : `${storage.endpoint}/`;
  const url = new URL(`${trimSlashes(storage.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`, endpoint);
  const payloadHash = sha256Hex(body);
  const { amzDate, dateStamp } = formatAmzDate(new Date());
  const headers = new Map<string, string>([
    ["content-type", contentType],
    ["host", url.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate]
  ]);
  if (ifAbsent) headers.set("if-none-match", "*");
  const signedHeaders = Array.from(headers.keys()).sort().join(";");
  const canonicalHeaders = Array.from(headers.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}:${value.trim()}\n`).join("");
  const canonicalRequest = ["PUT", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${storage.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${storage.secretAccessKey}`, dateStamp), storage.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${storage.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "authorization": authorization,
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(ifAbsent ? { "if-none-match": "*" } : {})
    },
    body: new Uint8Array(body),
    ...(signal ? { signal } : {})
  });
  try {
    if (!response.ok) throw new Error(`${errorPrefix}:${response.status}`);
  } finally { await discardResponseBody(response); }
}

/** The deterministic temp key belongs to the already-reserved immutable object prefix. Cleanup never
 * enumerates a directory: after proven writer settlement it removes this key and the final key only.
 */
export function immutableUploadTempKey(key: string): string { return `${key}.upload`; }

async function writeLocalImmutableObject(target: string, body: Buffer): Promise<void> {
  const temporary = immutableUploadTempKey(target);
  // wx keeps a still-running or crashed writer's temp file intact. The returned promise includes all
  // local writes, close and cleanup, so a confirmed rejection cannot leave a live local writer behind.
  const file = await open(temporary, "wx");
  let closed = false;
  try {
    await file.writeFile(body);
    await file.sync();
    await file.close(); closed = true;
    // Hard-link publication is atomic and cannot overwrite an existing immutable object.
    await link(temporary, target);
  } finally {
    try { if (!closed) await file.close(); }
    finally { await rm(temporary, { force: true }); }
  }
  const directory = await open(dirname(target), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function writeDocumentObject(storage: DocumentUploadStorage, storageKey: string, body: Buffer, contentType: string, options?: { ifAbsent?: boolean; signal?: AbortSignal }): Promise<void> {
  if (storage.type === "local") {
    const target = join(storage.root, storageKey);
    if (!target.startsWith(`${storage.root}${sep}`)) throw new Error("unsafe_document_storage_key");
    await mkdir(dirname(target), { recursive: true });
    if (options?.ifAbsent) await writeLocalImmutableObject(target, body);
    else await writeFile(target, body);
    return;
  }
  await putS3Object(storage, storageKey, body, contentType, "document_object_upload_failed", options?.ifAbsent, options?.signal);
}

async function deleteS3Object(storage: Extract<DocumentUploadStorage, { type: "s3" }>, key: string, signal?: AbortSignal): Promise<void> {
  const endpoint = storage.endpoint.endsWith("/") ? storage.endpoint : `${storage.endpoint}/`;
  const url = new URL(`${trimSlashes(storage.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`, endpoint);
  const payloadHash = sha256Hex("");
  const { amzDate, dateStamp } = formatAmzDate(new Date());
  const headers = new Map<string, string>([
    ["host", url.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate]
  ]);
  const signedHeaders = Array.from(headers.keys()).sort().join(";");
  const canonicalHeaders = Array.from(headers.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}:${value.trim()}\n`).join("");
  const canonicalRequest = ["DELETE", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${storage.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${storage.secretAccessKey}`, dateStamp), storage.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      "authorization": `AWS4-HMAC-SHA256 Credential=${storage.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    },
    ...(signal ? { signal } : {})
  });
  try {
    if (!response.ok && response.status !== 404) throw new Error(`document_object_delete_failed:${response.status}`);
  } finally { await discardResponseBody(response); }
}

export async function deleteDocumentObject(storage: DocumentUploadStorage, storageKey: string, options?: { signal?: AbortSignal; immutableTemp?: boolean }): Promise<void> {
  if (storage.type === "local") {
    const target = join(storage.root, storageKey);
    if (!target.startsWith(`${storage.root}${sep}`)) throw new Error("unsafe_document_storage_key");
    await rm(target, { force: true });
    if (options?.immutableTemp) await rm(immutableUploadTempKey(target), { force: true });
    return;
  }
  await deleteS3Object(storage, storageKey, options?.signal);
}

export function resolveUploadedDocumentPublicUrl(storage: DocumentUploadStorage, storageKey: string): string {
  if (storage.type === "local") {
    return joinUrlPath(storage.publicBaseUrl, storageKey);
  }
  return resolveSceneBundlePublicUrl(storageKey, process.env, storage.provider);
}

export async function readDocumentObject(storage: DocumentUploadStorage, storageKey: string): Promise<Buffer> {
  if (storage.type === "local") {
    const target = join(storage.root, storageKey);
    if (!target.startsWith(`${storage.root}${sep}`)) throw new Error("unsafe_document_storage_key");
    return readFile(target);
  }
  const response = await fetch(resolveUploadedDocumentPublicUrl(storage, storageKey));
  try {
    if (!response.ok) throw new Error(`document_object_download_failed:${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally { await discardResponseBody(response); }
}

/** Authenticated object read for private code artifacts; never fetch their public URL. */
export async function readPrivateUploadedObject(storage: DocumentUploadStorage, key: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid_private_object_limit");
  if (storage.type === "local") {
    const target = join(storage.root, key);
    if (!target.startsWith(`${storage.root}${sep}`)) throw new Error("unsafe_document_storage_key");
    const file = await open(target, "r");
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new Error("private_object_too_large");
      return buffer.subarray(0, length);
    } finally { await file.close(); }
  }
  const endpoint = storage.endpoint.endsWith("/") ? storage.endpoint : `${storage.endpoint}/`;
  const url = new URL(`${trimSlashes(storage.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`, endpoint);
  const payloadHash = sha256Hex("");
  const { amzDate, dateStamp } = formatAmzDate(new Date());
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const scope = `${dateStamp}/${storage.region}/s3/aws4_request`;
  const canonicalRequest = ["GET", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${storage.secretAccessKey}`, dateStamp), storage.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n")).digest("hex");
  const response = await fetch(url, { headers: {
    authorization: `AWS4-HMAC-SHA256 Credential=${storage.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate
  }, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`private_object_download_failed:${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("private_object_empty_response");
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) throw new Error("private_object_too_large");
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, length);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function publishSceneBundleFiles(storage: SceneBundleUploadStorage, bundleRoot: string, storagePrefix: string): Promise<void> {
  const files = await listFilesRecursive(bundleRoot);
  for (const filePath of files) {
    const normalizedPath = normalizeSceneBundleRelativePath(filePath);
    if (!normalizedPath) throw new Error("unsafe_scene_bundle_file_path");
    const sourcePath = join(bundleRoot, normalizedPath);
    const objectKey = `${storagePrefix}/${normalizedPath}`;
    if (storage.type === "local") {
      const target = join(storage.root, storagePrefix, normalizedPath);
      if (!target.startsWith(`${storage.root}${sep}`)) throw new Error("unsafe_scene_bundle_file_path");
      await mkdir(dirname(target), { recursive: true });
      await copyFile(sourcePath, target);
    } else {
      await putS3Object(storage, objectKey, await readFile(sourcePath), contentTypeForPath(normalizedPath));
    }
  }
}

export function resolveUploadedSceneBundlePublicUrl(storage: SceneBundleUploadStorage, storageKey: string): string {
  if (storage.type === "local") {
    return joinUrlPath(storage.publicBaseUrl, storageKey);
  }
  return resolveSceneBundlePublicUrl(storageKey, process.env, storage.provider);
}
