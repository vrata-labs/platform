import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRoomPermissions, type RoomRole } from "@vrata/shared-types";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import { PDFDocument } from "pdf-lib";

test("document upload policy matches real file boundaries, survives bad configuration and keeps storage failures private", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "vrata-document-policy-"));
  const env = { VRATA_DISABLE_AUTOSTART: "1", CONTROL_PLANE_ADMIN_TOKEN: "owned-document-policy-admin",
    STATE_TOKEN_SECRET: "owned-document-policy-state-secret", DOCUMENT_LOCAL_UPLOAD_ROOT: root,
    DOCUMENT_UPLOAD_MAX_BYTES: "1024", PDF_PRESENTATION_MAX_PAGES: "2" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  const { startApiServer } = await import("./index.js");
  const server = startApiServer(0); if (!server.listening) await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, roomId = "owned-document-policy-room";
  assert.equal((await fetch(`${origin}/api/rooms`, { method: "POST", headers: { "content-type": "application/json", "x-vrata-admin-token": env.CONTROL_PLANE_ADMIN_TOKEN },
    body: JSON.stringify({ roomId, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned document policy" }) })).status, 201);
  const token = (role: RoomRole) => signRoomSessionToken({ tenantId: "demo-tenant", roomId, participantId: `owned-${role}`,
    displayName: "Owned policy participant", role, roleSource: "trusted", permissions: getRoomPermissions(role), sessionId: `owned-${role}-session`,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, jti: `owned-${role}-jti` }, env.STATE_TOKEN_SECRET);
  const host = { authorization: `Bearer ${token("host")}` }, member = { authorization: `Bearer ${token("member")}` };
  const url = `${origin}/api/rooms/${roomId}/documents`;
  const upload = (size: number, name = "meeting.txt", type = "text/plain", data?: Uint8Array) => {
    const form = new FormData(); form.set("document", new File([new Uint8Array(data ?? new Uint8Array(size).fill(120))], name, { type }));
    return fetch(url, { method: "POST", headers: host, body: form });
  };
  const initial = await fetch(url, { headers: member }); assert.equal(initial.status, 200);
  const initialBody = await initial.json() as { items: unknown[]; uploadPolicy: { maxFileBytes: number; maxPdfPages: number; acceptedContentTypes: string[] } };
  assert.equal(initialBody.uploadPolicy.maxFileBytes, 1024); assert.equal(initialBody.uploadPolicy.maxPdfPages, 2);
  assert.ok(initialBody.uploadPolicy.acceptedContentTypes.includes("application/pdf"));
  const exact = await upload(1024); assert.equal(exact.status, 201, "multipart headers must not reduce the advertised file limit");
  const accepted = await exact.json() as { document: { documentId: string; sizeBytes: number; downloadUrl: string } };
  assert.equal(accepted.document.sizeBytes, 1024);
  const oversized = await upload(1025); assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "document_too_large" });
  const headerOnly = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers: { ...host, "content-type": "multipart/form-data; boundary=owned-fixture", "content-length": String(1024 + 65536 + 1) } }, response => {
      let body = ""; response.on("data", chunk => { body += chunk; }); response.on("end", () => { resolve({ status: response.statusCode!, body }); request.destroy(); });
    });
    request.on("error", reject); request.setTimeout(5000, () => request.destroy(new Error("header_limit_response_timeout")));
    request.flushHeaders();
  });
  assert.equal(headerOnly.status, 413); assert.deepEqual(JSON.parse(headerOnly.body), { error: "document_too_large" });
  const unsupported = await upload(1, "meeting.html", "text/html"); assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json() as { error: string }).error, "unsupported_document_mime");
  const corrupt = await upload(0, "meeting.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.7\nbroken"));
  assert.equal(corrupt.status, 422); assert.equal((await corrupt.json() as { error: string }).error, "corrupt_pdf");
  const pdf = await PDFDocument.create(); for (let i = 0; i < 3; i++) pdf.addPage([100, 100]);
  const pdfBytes = await pdf.save(); assert.ok(pdfBytes.byteLength < 1024);
  const pages = await upload(0, "pages.pdf", "application/pdf", pdfBytes); assert.equal(pages.status, 422);
  assert.equal((await pages.json() as { error: string }).error, "pdf_page_limit_exceeded");
  process.env.DOCUMENT_UPLOAD_MAX_BYTES = "private-invalid-configuration";
  const viewDuringMisconfiguration = await fetch(url, { headers: member }); assert.equal(viewDuringMisconfiguration.status, 200);
  const library = await viewDuringMisconfiguration.json() as { items: unknown[]; uploadPolicy?: unknown };
  assert.equal(library.items.length, 1); assert.equal(library.uploadPolicy, undefined);
  const invalidLimit = await upload(1); assert.equal(invalidLimit.status, 503);
  assert.equal((await invalidLimit.json() as { error: string }).error, "document_upload_limits_unavailable");
  process.env.DOCUMENT_UPLOAD_MAX_BYTES = "1024";
  const blockedRoot = join(root, "private-not-a-directory"); await writeFile(blockedRoot, "owned fixture");
  process.env.DOCUMENT_LOCAL_UPLOAD_ROOT = blockedRoot;
  const unavailable = await upload(2); assert.equal(unavailable.status, 503);
  const unavailableText = await unavailable.text(); assert.equal(JSON.parse(unavailableText).error, "document_storage_unavailable");
  assert.ok(!unavailableText.includes(root) && !unavailableText.includes("private-not-a-directory"));
  process.env.DOCUMENT_LOCAL_UPLOAD_ROOT = root;
  const listed = await fetch(url, { headers: member }); assert.equal((await listed.json() as { items: unknown[] }).items.length, 1, "rejected uploads create no metadata rows");
  assert.deepEqual(await readdir(join(root, "documents", "demo-tenant", roomId)), [accepted.document.documentId], "rejected uploads leave no document blob folders");
  const downloaded = await fetch(`${origin}${accepted.document.downloadUrl}`, { headers: member }); assert.equal(downloaded.status, 200);
  assert.equal((await downloaded.arrayBuffer()).byteLength, 1024);
  await unlink(join(root, "documents", "demo-tenant", roomId, accepted.document.documentId, "meeting.txt"));
  const missingBlob = await fetch(`${origin}${accepted.document.downloadUrl}`, { headers: member }); assert.equal(missingBlob.status, 503);
  const missingText = await missingBlob.text(); assert.equal(JSON.parse(missingText).error, "document_storage_unavailable"); assert.ok(!missingText.includes(root));
});
