import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  PUBLIC_DEMO_CLEANUP_KIND,
  PUBLIC_DEMO_INVITE_TTL_SECONDS,
  PUBLIC_DEMO_PDF_PAGE_COUNT,
  PUBLIC_DEMO_SCENE_RELEASE,
  PUBLIC_DEMO_SCENE_COMMIT,
  PUBLIC_DEMO_SCENE_MANIFEST_SHA256,
  PUBLIC_DEMO_STATE_KIND,
  PublicDemoError,
  canonicalizePublicDemoOrigin,
  checkPublicDemo,
  cleanupPublicDemo,
  createPlannedPublicDemoState,
  createPublicDemoApiClient,
  createPublicDemoPdf,
  createRedactedCleanupRecord,
  exclusiveCreateJson,
  parsePublicDemoArgs,
  publicDemoCleanupRecordPath,
  readPublicDemoState,
  redactSensitive,
  seedPublicDemo,
  sha256,
  validatePublicDemoState
} from "./public-demo.mjs";

const adminToken = "unit-admin-token-marker";
const fixedDate = new Date("2026-09-24T12:00:00.000Z");
const fixedNow = () => new Date(fixedDate);

function response(payload, status = 200) {
  return Response.json(payload, { status, headers: { "x-request-id": `request-${status}` } });
}

function exactHealth() {
  return {
    status: "ok",
    features: {
      voiceEnabled: true,
      spatialAudioEnabled: true,
      roomStateRealtimeEnabled: true,
      roomAccessPolicyEnabled: true,
      hostControlsEnabled: true,
      documentsEnabled: true,
      notesEnabled: true,
      postgresEnabled: true,
      controlPlaneAuthEnabled: true
    },
    dependencies: { postgres: true, livekit: true }
  };
}

function exactTemplate() {
  return {
    templateId: "meeting-room-basic",
    currentVersion: "2.0.0",
    status: "active",
    previewUrl: "https://demo.example/public-demo-preview.webp",
    defaults: {
      roomType: "standard",
      features: { voice: true, spatialAudio: true, screenShare: true },
      settings: {
        notes: { enabled: true, defaultScope: "shared" },
        presentation: { enabled: true, surfaceId: "debug-main" }
      }
    }
  };
}

function createFakeApi(options = {}) {
  const store = {
    tenant: null,
    room: null,
    note: null,
    documents: new Map(),
    invites: new Map(),
    calls: [],
    mutationCount: 0,
    roomCreateResponseLost: options.roomCreateResponseLost === true,
    documentDeleteFailures: options.documentDeleteFailures ?? 0,
    cleanupReturns404: options.cleanupReturns404 === true,
    health: exactHealth(),
    template: exactTemplate()
  };
  const jsonBody = (request) => typeof request.body === "string" ? JSON.parse(request.body) : null;
  const fetcher = async (input, request = {}) => {
    const url = new URL(input);
    const path = url.pathname;
    const method = request.method ?? "GET";
    const body = request.body instanceof FormData ? { multipart: true } : jsonBody(request);
    store.calls.push({ method, path, body });
    if (method !== "GET") store.mutationCount += 1;

    if (method === "GET" && path === "/health") return response(store.health);
    if (method === "GET" && path === "/public-demo-preview.webp") return new Response("preview", { status: 200, headers: { "content-type": "image/webp" } });
    if (method === "GET" && path === "/api/control-plane/session") {
      return request.headers?.["x-vrata-admin-token"] === adminToken
        ? response({ actor: { actorType: "admin-token" } })
        : response({ error: "unauthorized", reason: "invalid_admin_token" }, 401);
    }
    if (method === "GET" && path === "/api/templates") return response({ items: [store.template] });
    if (method === "GET" && path === "/api/tenants") return response({ items: store.tenant ? [store.tenant] : [] });

    if (method === "POST" && path === "/api/tenants") {
      store.tenant = body;
      return response(store.tenant, 201);
    }
    if (method === "DELETE" && store.tenant && path === `/api/tenants/${store.tenant.tenantId}`) {
      store.tenant = null;
      return store.cleanupReturns404 ? response({ error: "tenant_has_dependencies_or_missing" }, 409) : response({ ok: true });
    }
    if (method === "DELETE" && path.startsWith("/api/tenants/")) return response({ error: "tenant_has_dependencies_or_missing" }, 409);

    if (method === "POST" && path === "/api/rooms") {
      store.room = {
        ...body,
        status: "active",
        templateSnapshot: {
          templateId: body.templateId, version: body.templateVersion,
          assetLock: {
            sceneReleaseId: PUBLIC_DEMO_SCENE_RELEASE,
            commitSha: PUBLIC_DEMO_SCENE_COMMIT,
            sceneManifest: { sha256: PUBLIC_DEMO_SCENE_MANIFEST_SHA256 }
          }
        },
        sessionControl: {}
      };
      if (store.roomCreateResponseLost) {
        store.roomCreateResponseLost = false;
        throw new Error("lost room response");
      }
      return response(store.room, 201);
    }
    if (method === "GET" && path.startsWith("/api/rooms/") && !path.slice("/api/rooms/".length).includes("/")) {
      return store.room && path === `/api/rooms/${store.room.roomId}` ? response(store.room) : response({ error: "room_not_found" }, 404);
    }
    if (method === "DELETE" && store.room && path === `/api/rooms/${store.room.roomId}`) {
      store.room = null;
      store.note = null;
      store.invites.clear();
      store.documents.clear();
      return store.cleanupReturns404 ? response({ error: "room_not_found" }, 404) : response({ ok: true });
    }
    if (method === "DELETE" && /^\/api\/rooms\/[^/]+$/.test(path)) return response({ error: "room_not_found" }, 404);

    const roomId = store.room?.roomId;
    if (method === "PUT" && path === `/api/rooms/${roomId}/notes/shared`) {
      store.note = { noteId: `${roomId}:shared`, roomId, scope: "shared", content: body.content, updatedAt: fixedDate.toISOString(), deletedAt: null };
      return response({ note: store.note }, 201);
    }
    if (method === "GET" && path === `/api/rooms/${roomId}/notes/shared`) {
      return response({ note: store.note ?? { noteId: `${roomId}:shared`, roomId, scope: "shared", content: "", updatedAt: null, deletedAt: null } });
    }

    if (method === "POST" && path === `/api/rooms/${roomId}/documents`) {
      const file = request.body.get("document");
      const bytes = Buffer.from(await file.arrayBuffer());
      const document = {
        documentId: `document-${store.documents.size + 1}`,
        roomId,
        tenantId: store.room.tenantId,
        filename: file.name,
        contentType: file.type,
        checksum: `sha256:${sha256(bytes)}`,
        metadata: { kind: "pdf", pageCount: 3 },
        linkedSurfaceId: null
      };
      store.documents.set(document.documentId, document);
      return response({ document }, 201);
    }
    if (method === "GET" && path === `/api/rooms/${roomId}/documents`) return response({ items: [...store.documents.values()] });
    const documentSurface = path.match(/^\/api\/rooms\/([^/]+)\/documents\/([^/]+)\/surface$/);
    if (method === "POST" && documentSurface) {
      const document = store.documents.get(documentSurface[2]);
      document.linkedSurfaceId = body.surfaceId;
      return response({ document });
    }
    const documentDelete = path.match(/^\/api\/rooms\/([^/]+)\/documents\/([^/]+)$/);
    if (method === "DELETE" && documentDelete) {
      if (store.documentDeleteFailures > 0) {
        store.documentDeleteFailures -= 1;
        return response({ error: "document_object_delete_failed", details: adminToken }, 503);
      }
      const existed = store.documents.delete(documentDelete[2]);
      return existed && !store.cleanupReturns404 ? response({ document: { documentId: documentDelete[2] } }) : response({ error: "document_not_found" }, 404);
    }

    if (method === "POST" && path === `/api/rooms/${roomId}/invites`) {
      const index = store.invites.size + 1;
      const invite = {
        inviteId: `invite-${index}`,
        roomId,
        role: body.role,
        waitingRoomEnabled: body.waitingRoomEnabled,
        createdAt: fixedDate.toISOString(),
        expiresAt: body.expiresAt,
        revokedAt: null,
        inviteLink: `https://demo.example/rooms/${roomId}?invite=private-token-${index}`
      };
      store.invites.set(invite.inviteId, invite);
      return response(invite, 201);
    }
    if (method === "GET" && path === `/api/rooms/${roomId}/invites`) {
      return response({ items: [...store.invites.values()].map(({ inviteLink: _inviteLink, ...invite }) => invite) });
    }
    const revoke = path.match(/^\/api\/rooms\/([^/]+)\/invites\/([^/]+)\/revoke$/);
    if (method === "POST" && revoke) {
      const invite = store.invites.get(revoke[2]);
      if (!invite) return response({ error: "invite_not_found" }, 404);
      if (store.cleanupReturns404) {
        store.invites.delete(revoke[2]);
        return response({ error: "invite_not_found" }, 404);
      }
      invite.revokedAt = fixedDate.toISOString();
      const { inviteLink: _inviteLink, ...safeInvite } = invite;
      return response(safeInvite);
    }
    if (method === "POST" && path === `/api/rooms/${roomId}/session-control/end`) {
      if (!store.room) return response({ error: "room_not_found" }, 404);
      if (store.cleanupReturns404) return response({ error: "room_not_found" }, 404);
      store.room.sessionControl.endedAt = fixedDate.toISOString();
      return response({ state: store.room.sessionControl });
    }
    return response({ error: "not_found" }, 404);
  };
  return { store, fetcher };
}

async function tempStateFile(t) {
  const directory = await mkdtemp(join(tmpdir(), "vrata-public-demo-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "state.json");
}

async function seedFixture(t, fakeOptions = {}, seedOptions = {}) {
  const stateFile = await tempStateFile(t);
  const api = createFakeApi(fakeOptions);
  const result = await seedPublicDemo({
    baseUrl: "https://demo.example",
    stateFile,
    adminToken,
    fetcher: api.fetcher,
    now: fixedNow,
    sleep: async () => undefined,
    ...seedOptions
  });
  return { stateFile, api, result };
}

test("CLI arguments are noninteractive, strict, and command-specific", () => {
  assert.deepEqual(parsePublicDemoArgs(["seed", "--base-url", "https://DEMO.example:443/", "--state-file", "state.json"]), {
    command: "seed",
    baseUrl: "https://demo.example",
    stateFile: join(process.cwd(), "state.json"),
    timeoutMs: 15_000,
    getRetries: 2,
    inviteTtlSeconds: PUBLIC_DEMO_INVITE_TTL_SECONDS
  });
  assert.equal(parsePublicDemoArgs(["check", "--state-file", "state.json", "--timeout-ms", "900"] ).timeoutMs, 900);
  assert.equal(parsePublicDemoArgs(["cleanup", "--state-file", "state.json", "--get-retries", "0"]).getRetries, 0);
  assert.throws(() => parsePublicDemoArgs(["seed", "--state-file", "state.json"]), (error) => error.code === "demo_invalid_arguments");
  assert.throws(() => parsePublicDemoArgs(["check", "--state-file", "state.json", "--unknown", "x"]), (error) => error.code === "demo_invalid_arguments");
  assert.throws(() => parsePublicDemoArgs(["check", "--state-file"]), (error) => error.code === "demo_invalid_arguments");
});

test("canonical origins allow HTTPS or loopback HTTP only", () => {
  assert.equal(canonicalizePublicDemoOrigin("https://Example.COM:443/"), "https://example.com");
  assert.equal(canonicalizePublicDemoOrigin("http://127.9.8.7:4000"), "http://127.9.8.7:4000");
  assert.equal(canonicalizePublicDemoOrigin("http://[::1]:4000"), "http://[::1]:4000");
  assert.equal(canonicalizePublicDemoOrigin("http://localhost:4000"), "http://localhost:4000");
  for (const value of ["http://example.com", "ftp://localhost", "https://example.com/api", "https://example.com/?token=secret", "https://user:pass@example.com"]) {
    assert.throws(() => canonicalizePublicDemoOrigin(value), (error) => error.code === "demo_invalid_arguments", value);
  }
});

test("planned state binds distinct random IDs, exact template, schema, and origin", async () => {
  const state = await createPlannedPublicDemoState({ origin: "https://demo.example", now: fixedNow });
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.kind, PUBLIC_DEMO_STATE_KIND);
  assert.equal(state.origin, "https://demo.example");
  assert.notEqual(state.runId, state.tenantId.replace("public-demo-", ""));
  assert.notEqual(state.tenantId, state.roomId);
  assert.equal(state.expected.templateId, "meeting-room-basic");
  assert.equal(state.expected.templateVersion, "2.0.0");
  assert.equal(state.resources.invites.length, 4);
  assert.equal(new Set([state.runId, state.tenantId, state.roomId, state.resources.document.plannedId, ...state.resources.invites.map((item) => item.plannedId)]).size, 8);
  assert.equal(validatePublicDemoState(state), state);
  assert.throws(() => validatePublicDemoState({ ...state, schemaVersion: 2 }), (error) => error.code === "demo_state_conflict");
  assert.throws(() => validatePublicDemoState({ ...state, origin: "https://demo.example/path" }), (error) => error.code === "demo_state_conflict");
});

test("private state uses exclusive create and mode 0600", async (t) => {
  const stateFile = await tempStateFile(t);
  const state = await createPlannedPublicDemoState({ origin: "https://demo.example", now: fixedNow });
  await exclusiveCreateJson(stateFile, state);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  await assert.rejects(() => exclusiveCreateJson(stateFile, state), (error) => error.code === "demo_state_conflict");
  await chmod(stateFile, 0o644);
  await assert.rejects(() => readPublicDemoState(stateFile), (error) => error.code === "demo_state_conflict");
});

test("redacted cleanup records omit invite links, tokens, and arbitrary token markers", async () => {
  const state = await createPlannedPublicDemoState({ origin: "https://demo.example", now: fixedNow });
  state.resources.invites[0].inviteId = "invite-1";
  state.resources.invites[0].inviteLink = "https://demo.example/rooms/demo?invite=UNIQUE_TOKEN_MARKER";
  const record = createRedactedCleanupRecord(state);
  const serialized = JSON.stringify(record);
  assert.equal(record.kind, PUBLIC_DEMO_CLEANUP_KIND);
  assert.equal(serialized.includes("inviteLink"), false);
  assert.equal(serialized.includes("UNIQUE_TOKEN_MARKER"), false);
  const redacted = JSON.stringify(redactSensitive({ authorization: "Bearer UNIQUE_TOKEN_MARKER", error: "failure UNIQUE_TOKEN_MARKER https://demo.example/path?invite=UNIQUE_TOKEN_MARKER" }, ["UNIQUE_TOKEN_MARKER"]));
  assert.equal(redacted.includes("UNIQUE_TOKEN_MARKER"), false);
  assert.equal(redacted.includes("?invite="), false);
});

test("deterministic PDF has fixed metadata, checksum, and exactly three pages", async () => {
  const first = await createPublicDemoPdf();
  const second = await createPublicDemoPdf();
  assert.equal(Buffer.compare(first, second), 0);
  assert.equal(sha256(first), "9a2eeb78a02168a53f342a1bccdee36f14e5c29b7c2f66190edfa5be0d5c89d9");
  assert.equal(sha256(first), sha256(second));
  assert.match(first.subarray(0, 8).toString("ascii"), /^%PDF-/);
  const pdf = await PDFDocument.load(first, { updateMetadata: false });
  assert.equal(pdf.getPageCount(), PUBLIC_DEMO_PDF_PAGE_COUNT);
  assert.equal(pdf.getTitle(), "VRATA public demo: goal, options, decision");
  assert.equal(pdf.getAuthor(), "VRATA contributors");
  assert.equal(pdf.getCreationDate().toISOString(), "2026-09-24T00:00:00.000Z");
  assert.equal(pdf.getModificationDate().toISOString(), "2026-09-24T00:00:00.000Z");
});

test("HTTP adapter retries bounded GETs but never blindly retries POST", async () => {
  let getCalls = 0;
  const getClient = createPublicDemoApiClient({
    origin: "https://demo.example",
    adminToken,
    getRetries: 2,
    sleep: async () => undefined,
    fetcher: async () => {
      getCalls += 1;
      if (getCalls < 3) throw new Error("temporary");
      return response({ ok: true });
    }
  });
  assert.deepEqual((await getClient.get("/safe", { step: "safe-get" })).data, { ok: true });
  assert.equal(getCalls, 3);

  let postCalls = 0;
  const postClient = createPublicDemoApiClient({
    origin: "https://demo.example",
    adminToken,
    getRetries: 5,
    fetcher: async () => {
      postCalls += 1;
      throw new Error("lost response");
    }
  });
  await assert.rejects(() => postClient.post("/unsafe", { step: "unsafe-post", body: { value: 1 } }), (error) => error.code === "demo_request_failed");
  assert.equal(postCalls, 1);

  let timeoutCalls = 0;
  const timeoutClient = createPublicDemoApiClient({
    origin: "https://demo.example",
    adminToken,
    timeoutMs: 10,
    fetcher: async () => {
      timeoutCalls += 1;
      return new Promise(() => undefined);
    }
  });
  await assert.rejects(() => timeoutClient.post("/timeout", { step: "timeout-post", body: {} }), (error) => error.code === "demo_request_timeout");
  assert.equal(timeoutCalls, 1);

  let redirectMode;
  const redirectClient = createPublicDemoApiClient({
    origin: "https://demo.example",
    adminToken,
    fetcher: async (_input, request) => {
      redirectMode = request.redirect;
      return response({ ok: true });
    }
  });
  await redirectClient.get("/safe", { step: "redirect-policy" });
  assert.equal(redirectMode, "error");
});

test("seed writes planned state before mutation and sends exact room, role, and 24h expiry payloads", async (t) => {
  const { stateFile, api, result } = await seedFixture(t);
  assert.equal(result.prepared, true);
  assert.equal(result.created, true);
  const state = await readPublicDemoState(stateFile);
  assert.equal(state.lifecycle.phase, "completed");
  assert.deepEqual(state.resources.invites.map((invite) => invite.role), ["host", "member", "member", "guest"]);
  assert.equal(state.resources.invites.every((invite) => Date.parse(invite.expiresAt) - fixedDate.getTime() === PUBLIC_DEMO_INVITE_TTL_SECONDS * 1000), true);
  const tenantCall = api.store.calls.find((call) => call.method === "POST" && call.path === "/api/tenants");
  const roomCall = api.store.calls.find((call) => call.method === "POST" && call.path === "/api/rooms");
  assert.deepEqual(tenantCall.body, { tenantId: state.tenantId, name: state.expected.tenantName });
  assert.deepEqual(roomCall.body, {
    roomId: state.roomId,
    tenantId: state.tenantId,
    templateId: "meeting-room-basic",
    templateVersion: "2.0.0",
    name: state.expected.roomName,
    roomType: "standard",
    visibility: "private",
    guestAllowed: true,
    features: { voice: true, spatialAudio: true, screenShare: true }
  });
  const inviteCalls = api.store.calls.filter((call) => call.method === "POST" && call.path.endsWith("/invites"));
  assert.deepEqual(inviteCalls.map((call) => call.body.role), ["host", "member", "member", "guest"]);
  assert.equal(new Set(inviteCalls.map((call) => call.body.expiresAt)).size, 1);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.equal((await stat(publicDemoCleanupRecordPath(stateFile))).mode & 0o777, 0o600);
  assert.equal(api.store.calls.findIndex((call) => call.method === "POST"), api.store.calls.findIndex((call) => call.path === "/api/tenants"));
});

test("seed preflight refuses inactive exact catalog before server mutation", async (t) => {
  const stateFile = await tempStateFile(t);
  const api = createFakeApi();
  api.store.template.currentVersion = "1.0.0";
  await assert.rejects(() => seedPublicDemo({ baseUrl: "https://demo.example", stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined }), (error) => error.code === "demo_catalog_not_active");
  assert.equal(api.store.mutationCount, 0);
  assert.equal((await readPublicDemoState(stateFile)).lifecycle.phase, "planned");
  assert.equal((await readPublicDemoState(publicDemoCleanupRecordPath(stateFile), { allowCleanupRecord: true })).kind, PUBLIC_DEMO_CLEANUP_KIND);
});

test("seed refuses an unavailable pinned scene preview before server mutation", async (t) => {
  const stateFile = await tempStateFile(t);
  const api = createFakeApi();
  api.store.template.previewUrl = "https://unavailable.example/preview.webp";
  const fetcher = async (url, request) => {
    if (new URL(url).hostname === "unavailable.example") return response({ error: "missing" }, 404);
    return api.fetcher(url, request);
  };
  await assert.rejects(() => seedPublicDemo({ baseUrl: "https://demo.example", stateFile, adminToken, fetcher, now: fixedNow }),
    (error) => error.code === "demo_feature_disabled" && error.step === "preflight-scene");
  assert.equal(api.store.mutationCount, 0);
});

test("completed seed rerun is read-only and preserves edited agenda, documents, and controls", async (t) => {
  const { stateFile, api, result } = await seedFixture(t);
  api.store.note.content = "User-edited decision notes";
  api.store.room.sessionControl = { lockedAt: "2026-09-24T12:30:00.000Z" };
  api.store.documents.set("user-document", {
    documentId: "user-document",
    roomId: api.store.room.roomId,
    tenantId: api.store.tenant.tenantId,
    filename: "user.pdf",
    contentType: "application/pdf",
    checksum: "sha256:user",
    metadata: { kind: "pdf", pageCount: 1 },
    linkedSurfaceId: null
  });
  const mutationsBefore = api.store.mutationCount;
  const rerun = await seedPublicDemo({ baseUrl: "https://demo.example", stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined });
  assert.equal(rerun.created, false);
  assert.equal(rerun.runId, result.runId);
  assert.equal(api.store.mutationCount, mutationsBefore);
  assert.equal(api.store.note.content, "User-edited decision notes");
  assert.equal(api.store.documents.has("user-document"), true);
  assert.equal(api.store.room.sessionControl.lockedAt, "2026-09-24T12:30:00.000Z");
});

test("check is read-only, reports prepared, and rejects unusable invites", async (t) => {
  const { stateFile, api } = await seedFixture(t);
  const mutationsBefore = api.store.mutationCount;
  const checked = await checkPublicDemo({ stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined });
  assert.equal(checked.status, "prepared");
  assert.equal(Object.hasOwn(checked, "passed"), false);
  assert.equal(api.store.mutationCount, mutationsBefore);
  api.store.invites.get("invite-2").revokedAt = fixedDate.toISOString();
  await assert.rejects(() => checkPublicDemo({ stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined }), (error) => error.code === "demo_invites_unusable");
  assert.equal(api.store.mutationCount, mutationsBefore);
});

test("completed seed and cleanup stop before mutation when ownership drifts", async (t) => {
  const { stateFile, api } = await seedFixture(t);
  await assert.rejects(() => checkPublicDemo({ stateFile, baseUrl: "https://other.example", adminToken, fetcher: api.fetcher, now: fixedNow }), (error) => error.code === "demo_state_conflict");
  api.store.room.name = "Foreign room";
  const mutationsBefore = api.store.mutationCount;
  await assert.rejects(() => checkPublicDemo({ stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined }), (error) => error.code === "demo_state_conflict");
  await assert.rejects(() => cleanupPublicDemo({ stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined }), (error) => error.code === "demo_state_conflict");
  assert.equal(api.store.mutationCount, mutationsBefore);
  assert.equal(api.store.room.name, "Foreign room");
});

test("partial state refuses seed rerun and cleanup discovers resources after a lost POST response", async (t) => {
  const stateFile = await tempStateFile(t);
  const api = createFakeApi({ roomCreateResponseLost: true });
  await assert.rejects(() => seedPublicDemo({ baseUrl: "https://demo.example", stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined }), (error) => error.code === "demo_request_failed");
  const partial = await readPublicDemoState(stateFile);
  assert.equal(partial.lifecycle.phase, "seeding");
  assert.equal(api.store.room.roomId, partial.roomId);
  const callsBefore = api.store.calls.length;
  await assert.rejects(() => seedPublicDemo({ baseUrl: "https://demo.example", stateFile, adminToken, fetcher: api.fetcher, now: fixedNow }), (error) => error.code === "demo_seed_incomplete");
  assert.equal(api.store.calls.length, callsBefore);
  const cleaned = await cleanupPublicDemo({
    stateFile,
    adminToken,
    fetcher: api.fetcher,
    now: fixedNow,
    sleep: async () => undefined,
    cleanupSettleMs: 0,
    cleanupReconcileIntervalMs: 0
  });
  assert.equal(cleaned.cleaned, true);
  assert.equal(api.store.room, null);
  assert.equal(api.store.tenant, null);
});

test("cleanup revokes invites, ends session, deletes documents, room, then tenant and retries from redacted record", async (t) => {
  const { stateFile, api } = await seedFixture(t);
  const cleanupStart = api.store.calls.length;
  const result = await cleanupPublicDemo({ stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined });
  assert.equal(result.cleaned, true);
  await assert.rejects(readFile(stateFile, "utf8"), (error) => error.code === "ENOENT");
  const record = JSON.parse(await readFile(result.cleanupRecord, "utf8"));
  assert.equal(record.lifecycle.cleanup.phase, "completed");
  assert.equal(JSON.stringify(record).includes("inviteLink"), false);
  assert.equal(JSON.stringify(record).includes("private-token"), false);
  const mutations = api.store.calls.slice(cleanupStart).filter((call) => call.method !== "GET");
  assert.deepEqual(mutations.map((call) => `${call.method} ${call.path}`), [
    ...[1, 2, 3, 4].map((index) => `POST /api/rooms/${record.roomId}/invites/invite-${index}/revoke`),
    `POST /api/rooms/${record.roomId}/session-control/end`,
    `DELETE /api/rooms/${record.roomId}/documents/document-1`,
    `DELETE /api/rooms/${record.roomId}`,
    `DELETE /api/tenants/${record.tenantId}`
  ]);

  const mutationsBeforeRetry = api.store.mutationCount;
  const retried = await cleanupPublicDemo({ stateFile: result.cleanupRecord, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined });
  assert.equal(retried.cleaned, true);
  assert.equal(api.store.mutationCount, mutationsBeforeRetry);
});

test("cleanup failure stops before room deletion and retains retryable private and redacted files", async (t) => {
  const { stateFile, api } = await seedFixture(t, { documentDeleteFailures: 1 });
  await assert.rejects(() => cleanupPublicDemo({ stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined }), (error) => {
    assert.equal(error.code, "demo_cleanup_incomplete");
    assert.equal(error.step, "cleanup-delete-document");
    assert.equal(error.reason, "demo_request_failed");
    return true;
  });
  assert.equal(Boolean(api.store.room), true);
  assert.equal(Boolean(api.store.tenant), true);
  assert.equal(api.store.documents.size, 1);
  assert.equal(await readPublicDemoState(stateFile).then(() => true), true);
  const failedRecord = await readPublicDemoState(publicDemoCleanupRecordPath(stateFile), { allowCleanupRecord: true });
  assert.equal(failedRecord.lifecycle.cleanup.phase, "failed");
  assert.equal(JSON.stringify(failedRecord).includes(adminToken), false);
  const mutationPaths = api.store.calls.filter((call) => call.method === "DELETE").map((call) => call.path);
  assert.equal(mutationPaths.some((path) => path === `/api/rooms/${failedRecord.roomId}`), false);
  assert.equal(mutationPaths.some((path) => path === `/api/tenants/${failedRecord.tenantId}`), false);

  const retried = await cleanupPublicDemo({ stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined });
  assert.equal(retried.cleaned, true);
  assert.equal(api.store.room, null);
  assert.equal(api.store.tenant, null);
});

test("cleanup treats already-gone 404 resources as successful lifecycle steps", async (t) => {
  const { stateFile, api } = await seedFixture(t);
  api.store.cleanupReturns404 = true;
  const result = await cleanupPublicDemo({ stateFile, adminToken, fetcher: api.fetcher, now: fixedNow, sleep: async () => undefined });
  assert.equal(result.cleaned, true);
  assert.equal(api.store.invites.size, 0);
  assert.equal(api.store.documents.size, 0);
  assert.equal(api.store.room, null);
  assert.equal(api.store.tenant, null);
  const record = await readPublicDemoState(result.cleanupRecord, { allowCleanupRecord: true });
  assert.equal(record.lifecycle.cleanup.phase, "completed");
  assert.equal(record.lifecycle.cleanup.revokedInviteIds.length, 4);
  assert.equal(record.lifecycle.cleanup.deletedDocumentIds.length, 1);
});

test("unknown state schema and redacted records are rejected by seed/check", async (t) => {
  const stateFile = await tempStateFile(t);
  const state = await createPlannedPublicDemoState({ origin: "https://demo.example", now: fixedNow });
  await exclusiveCreateJson(stateFile, { ...state, schemaVersion: 99 });
  await assert.rejects(() => readPublicDemoState(stateFile), (error) => error.code === "demo_state_conflict");
  await writeFile(stateFile, `${JSON.stringify(createRedactedCleanupRecord(state))}\n`, { mode: 0o600 });
  await assert.rejects(() => checkPublicDemo({ stateFile, adminToken }), (error) => error.code === "demo_state_conflict");
});

test("public demo errors expose only stable safe fields", () => {
  const error = new PublicDemoError("demo_cleanup_incomplete", "cleanup-document", {
    status: 503,
    requestId: "request-safe",
    reason: "demo_request_failed"
  });
  assert.deepEqual(error.toJSON(), {
    error: "demo_cleanup_incomplete",
    step: "cleanup-document",
    status: 503,
    requestId: "request-safe",
    reason: "demo_request_failed"
  });
  assert.equal(JSON.stringify(error.toJSON()).includes("token"), false);
});
