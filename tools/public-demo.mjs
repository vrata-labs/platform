import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const PUBLIC_DEMO_SCHEMA_VERSION = 1;
export const PUBLIC_DEMO_STATE_KIND = "vrata-public-demo-state";
export const PUBLIC_DEMO_CLEANUP_KIND = "vrata-public-demo-cleanup";
export const PUBLIC_DEMO_TEMPLATE_ID = "meeting-room-basic";
export const PUBLIC_DEMO_TEMPLATE_VERSION = "2.0.0";
export const PUBLIC_DEMO_SURFACE_ID = "debug-main";
export const PUBLIC_DEMO_SCENE_RELEASE = "warm-modern-meeting-room-candidate-01@0.3.4";
export const PUBLIC_DEMO_SCENE_COMMIT = "a237ab799acbee3932846147c9f48bf1d1b4aaa8";
export const PUBLIC_DEMO_SCENE_MANIFEST_SHA256 = "35f9d9c3045308f5d36095293f1f130262003202a3cdc33c103f715f53f658f8";
export const PUBLIC_DEMO_INVITE_TTL_SECONDS = 24 * 60 * 60;
export const PUBLIC_DEMO_PDF_PAGE_COUNT = 3;

const agendaUrl = new URL("./fixtures/public-demo/agenda.md", import.meta.url);
const retryableGetStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const inviteRoles = ["host", "member", "member", "guest"];
const fixedPdfDate = new Date("2026-09-24T00:00:00.000Z");

export class PublicDemoError extends Error {
  constructor(code, step, options = {}) {
    super(code, options.cause ? { cause: options.cause } : undefined);
    this.name = "PublicDemoError";
    this.code = code;
    this.step = step;
    this.status = options.status;
    this.requestId = options.requestId;
    this.reason = options.reason;
  }

  toJSON() {
    return {
      error: this.code,
      step: this.step,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.reason ? { reason: this.reason } : {})
    };
  }
}

function demoError(code, step, options) {
  return new PublicDemoError(code, step, options);
}

function nowIso(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw demoError("demo_state_conflict", "clock", { reason: "invalid_clock" });
  return date.toISOString();
}

function safeIdentifier(value, fallback = undefined) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : fallback;
}

function safeApiReason(payload, markers = []) {
  const values = [payload?.error, payload?.reason].filter((value) => typeof value === "string");
  const candidate = values.join(":");
  if (!candidate || markers.some((marker) => marker && candidate.includes(marker))) return "http_error";
  return /^[a-z][a-z0-9_.:-]{0,159}$/.test(candidate) ? candidate : "http_error";
}

function redactString(value, markers) {
  let redacted = value;
  for (const marker of markers) {
    if (marker) redacted = redacted.split(marker).join("[REDACTED]");
  }
  redacted = redacted.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(/https?:\/\/[^\s"']+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}${url.search ? "?[REDACTED]" : ""}`;
    } catch {
      return "[REDACTED_URL]";
    }
  });
  return redacted;
}

export function redactSensitive(value, markers = []) {
  if (typeof value === "string") return redactString(value, markers);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, markers));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(authorization|cookie|secret|token|inviteLink)/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactSensitive(item, markers);
    }
  }
  return output;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(ipv4 && Number(ipv4[1]) === 127 && ipv4.slice(1).every((part) => Number(part) <= 255));
}

export function canonicalizePublicDemoOrigin(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw demoError("demo_invalid_arguments", "arguments", { reason: "invalid_base_url" });
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw demoError("demo_invalid_arguments", "arguments", { reason: "base_url_must_be_origin" });
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw demoError("demo_invalid_arguments", "arguments", { reason: "secure_or_loopback_origin_required" });
  }
  return url.origin;
}

function parsePositiveInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value ?? "")) throw demoError("demo_invalid_arguments", "arguments", { reason: `invalid_${name}` });
  const parsed = Number.parseInt(value, 10);
  if (parsed < minimum || parsed > maximum) throw demoError("demo_invalid_arguments", "arguments", { reason: `invalid_${name}` });
  return parsed;
}

export function parsePublicDemoArgs(argv) {
  const command = argv[0];
  if (!command || !["seed", "check", "cleanup"].includes(command)) {
    throw demoError("demo_invalid_arguments", "arguments", { reason: "command_required" });
  }
  const parsed = {
    command,
    baseUrl: undefined,
    stateFile: undefined,
    timeoutMs: 15_000,
    getRetries: 2,
    inviteTtlSeconds: PUBLIC_DEMO_INVITE_TTL_SECONDS
  };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw demoError("demo_invalid_arguments", "arguments", { reason: "flag_value_required" });
    }
    if (flag === "--base-url") parsed.baseUrl = canonicalizePublicDemoOrigin(value);
    else if (flag === "--state-file") parsed.stateFile = resolve(value);
    else if (flag === "--timeout-ms") parsed.timeoutMs = parsePositiveInteger(value, "timeout_ms", 100, 120_000);
    else if (flag === "--get-retries") parsed.getRetries = parsePositiveInteger(value, "get_retries", 0, 5);
    else if (flag === "--invite-ttl-seconds") parsed.inviteTtlSeconds = parsePositiveInteger(value, "invite_ttl_seconds", 60, 30 * 24 * 60 * 60);
    else throw demoError("demo_invalid_arguments", "arguments", { reason: "unknown_flag" });
  }
  if (!parsed.stateFile) throw demoError("demo_invalid_arguments", "arguments", { reason: "state_file_required" });
  if (command === "seed" && !parsed.baseUrl) throw demoError("demo_invalid_arguments", "arguments", { reason: "base_url_required" });
  return parsed;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hexRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

export async function createPublicDemoPdf() {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle("VRATA public demo: goal, options, decision");
  pdf.setAuthor("VRATA contributors");
  pdf.setSubject("Three-page public demo agenda");
  pdf.setCreator("VRATA public-demo CLI");
  pdf.setProducer("pdf-lib 1.17.1");
  pdf.setKeywords(["VRATA", "public demo", "meeting"]);
  pdf.setCreationDate(fixedPdfDate);
  pdf.setModificationDate(fixedPdfDate);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = [
    { number: "01", title: "GOAL", body: "Agree on the outcome we need.", background: "#102A43", accent: "#62D9FF" },
    { number: "02", title: "OPTIONS", body: "Compare trade-offs and constraints.", background: "#402060", accent: "#FFCB66" },
    { number: "03", title: "DECISION", body: "Record the owner and next step.", background: "#153E35", accent: "#8FE3B5" }
  ];
  for (const item of pages) {
    const page = pdf.addPage([960, 540]);
    page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: hexRgb(item.background) });
    page.drawRectangle({ x: 64, y: 62, width: 12, height: 416, color: hexRgb(item.accent) });
    page.drawText(item.number, { x: 116, y: 338, size: 128, font: bold, color: hexRgb(item.accent) });
    page.drawText(item.title, { x: 122, y: 260, size: 56, font: bold, color: rgb(1, 1, 1) });
    page.drawText(item.body, { x: 124, y: 196, size: 27, font: regular, color: rgb(0.92, 0.95, 0.98) });
    page.drawText("VRATA PUBLIC DEMO", { x: 700, y: 80, size: 15, font: bold, color: hexRgb(item.accent) });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false }));
}

export function publicDemoCleanupRecordPath(stateFile) {
  return `${resolve(stateFile)}.cleanup.json`;
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertPrivateRegularFile(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw demoError("demo_state_conflict", "state-read", { reason: "state_file_must_be_private_regular_file" });
  }
}

async function writeHandleJson(handle, value) {
  await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await handle.sync();
}

export async function exclusiveCreateJson(filePath, value) {
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(absolute, "wx", 0o600);
    await writeHandleJson(handle, value);
    await handle.chmod(0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw demoError("demo_state_conflict", "state-create", { reason: "state_file_exists" });
    throw error;
  } finally {
    await handle?.close();
  }
  return absolute;
}

async function atomicWriteJson(filePath, value, { allowCreate = false } = {}) {
  const absolute = resolve(filePath);
  if (!allowCreate || await pathExists(absolute)) await assertPrivateRegularFile(absolute);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${nodeRandomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await writeHandleJson(handle, value);
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporary, absolute);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function expectedTenantName(runId) {
  return `VRATA Public Demo ${runId}`;
}

function expectedRoomName(runId) {
  return `VRATA Public Demo Room ${runId}`;
}

function assertUuid(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw demoError("demo_state_conflict", "state-read", { reason: `invalid_${field}` });
  }
}

function validateBaseStateFields(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== PUBLIC_DEMO_SCHEMA_VERSION) {
    throw demoError("demo_state_conflict", "state-read", { reason: "unsupported_state_schema" });
  }
  let canonicalOrigin;
  try {
    canonicalOrigin = canonicalizePublicDemoOrigin(value.origin);
  } catch {
    throw demoError("demo_state_conflict", "state-read", { reason: "invalid_state_origin" });
  }
  if (canonicalOrigin !== value.origin) {
    throw demoError("demo_state_conflict", "state-read", { reason: "noncanonical_state_origin" });
  }
  assertUuid(value.runId, "run_id");
  if (typeof value.tenantId !== "string"
    || typeof value.roomId !== "string"
    || !/^public-demo-[0-9a-f-]{36}$/i.test(value.tenantId)
    || !/^public-demo-[0-9a-f-]{36}$/i.test(value.roomId)
    || value.tenantId === value.roomId) {
    throw demoError("demo_state_conflict", "state-read", { reason: "planned_id_binding_mismatch" });
  }
  if (value.expected?.tenantName !== expectedTenantName(value.runId) || value.expected?.roomName !== expectedRoomName(value.runId)) {
    throw demoError("demo_state_conflict", "state-read", { reason: "name_binding_mismatch" });
  }
  if (value.expected?.templateId !== PUBLIC_DEMO_TEMPLATE_ID || value.expected?.templateVersion !== PUBLIC_DEMO_TEMPLATE_VERSION) {
    throw demoError("demo_state_conflict", "state-read", { reason: "template_binding_mismatch" });
  }
}

export function validatePublicDemoState(value, { allowCleanupRecord = false } = {}) {
  validateBaseStateFields(value);
  if (value.kind === PUBLIC_DEMO_CLEANUP_KIND) {
    if (!allowCleanupRecord) throw demoError("demo_state_conflict", "state-read", { reason: "private_state_required" });
    if (!Array.isArray(value.planned?.inviteIds) || value.planned.inviteIds.length !== 4) {
      throw demoError("demo_state_conflict", "state-read", { reason: "invalid_planned_invites" });
    }
    assertUuid(value.planned.documentId, "planned_document_id");
    value.planned.inviteIds.forEach((id) => assertUuid(id, "planned_invite_id"));
    if (!value.resources
      || !Array.isArray(value.resources.documentIds)
      || !Array.isArray(value.resources.inviteIds)
      || value.resources.documentIds.some((id) => !safeIdentifier(id))
      || value.resources.inviteIds.some((id) => !safeIdentifier(id))
      || !value.lifecycle?.cleanup
      || !Array.isArray(value.lifecycle.cleanup.revokedInviteIds)
      || !Array.isArray(value.lifecycle.cleanup.deletedDocumentIds)) {
      throw demoError("demo_state_conflict", "state-read", { reason: "invalid_cleanup_record" });
    }
    return value;
  }
  if (value.kind !== PUBLIC_DEMO_STATE_KIND) throw demoError("demo_state_conflict", "state-read", { reason: "unknown_state_kind" });
  if (!value.resources || !value.lifecycle || !Array.isArray(value.resources.invites) || value.resources.invites.length !== 4) {
    throw demoError("demo_state_conflict", "state-read", { reason: "invalid_private_state" });
  }
  assertUuid(value.resources.document?.plannedId, "planned_document_id");
  if (value.resources.document.documentId !== null && !safeIdentifier(value.resources.document.documentId)) {
    throw demoError("demo_state_conflict", "state-read", { reason: "invalid_document_id" });
  }
  value.resources.invites.forEach((invite, index) => {
    assertUuid(invite?.plannedId, "planned_invite_id");
    if (invite.role !== inviteRoles[index]
      || !Number.isFinite(Date.parse(invite.expiresAt))
      || (invite.inviteId !== null && !safeIdentifier(invite.inviteId))
      || (invite.inviteLink !== null && typeof invite.inviteLink !== "string")) {
      throw demoError("demo_state_conflict", "state-read", { reason: "invalid_invite_plan" });
    }
  });
  return value;
}

export async function readPublicDemoState(filePath, options = {}) {
  const absolute = resolve(filePath);
  try {
    await assertPrivateRegularFile(absolute);
    const value = JSON.parse(await readFile(absolute, "utf8"));
    return validatePublicDemoState(value, options);
  } catch (error) {
    if (error instanceof PublicDemoError) throw error;
    if (error?.code === "ENOENT") throw demoError("demo_state_conflict", "state-read", { reason: "state_file_not_found" });
    throw demoError("demo_state_conflict", "state-read", { reason: "state_file_invalid", cause: error });
  }
}

function createCleanupLifecycle() {
  return {
    phase: "not-started",
    revokedInviteIds: [],
    deletedDocumentIds: [],
    sessionEnded: false,
    roomDeleted: false,
    tenantDeleted: false,
    lastFailure: null
  };
}

export async function createPlannedPublicDemoState({ origin, inviteTtlSeconds = PUBLIC_DEMO_INVITE_TTL_SECONDS, now = () => new Date(), randomUUID = nodeRandomUUID, platformSha = process.env.VRATA_DEPLOY_SHA ?? null }) {
  const canonicalOrigin = canonicalizePublicDemoOrigin(origin);
  const createdAt = nowIso(now);
  const runId = randomUUID();
  assertUuid(runId, "run_id");
  const tenantId = `public-demo-${randomUUID()}`;
  const roomId = `public-demo-${randomUUID()}`;
  const plannedDocumentId = randomUUID();
  const expiresAt = new Date(Date.parse(createdAt) + inviteTtlSeconds * 1000).toISOString();
  const pdf = await createPublicDemoPdf();
  return {
    schemaVersion: PUBLIC_DEMO_SCHEMA_VERSION,
    kind: PUBLIC_DEMO_STATE_KIND,
    origin: canonicalOrigin,
    runId,
    tenantId,
    roomId,
    createdAt,
    updatedAt: createdAt,
    platformSha: typeof platformSha === "string" && platformSha ? platformSha : null,
    expected: {
      tenantName: expectedTenantName(runId),
      roomName: expectedRoomName(runId),
      templateId: PUBLIC_DEMO_TEMPLATE_ID,
      templateVersion: PUBLIC_DEMO_TEMPLATE_VERSION,
      document: {
        filename: `vrata-public-demo-${plannedDocumentId}.pdf`,
        checksum: `sha256:${sha256(pdf)}`,
        pageCount: PUBLIC_DEMO_PDF_PAGE_COUNT,
        surfaceId: PUBLIC_DEMO_SURFACE_ID
      }
    },
    resources: {
      tenant: { status: "planned" },
      room: { status: "planned" },
      agenda: { status: "planned", checksum: null },
      document: { plannedId: plannedDocumentId, status: "planned", documentId: null },
      invites: inviteRoles.map((role) => ({ plannedId: randomUUID(), role, expiresAt, status: "planned", inviteId: null, inviteLink: null }))
    },
    lifecycle: { phase: "planned", completedSteps: [], lastFailure: null },
    cleanup: { ...createCleanupLifecycle(), discoveredInviteIds: [], discoveredDocumentIds: [] }
  };
}

export function createRedactedCleanupRecord(state) {
  validatePublicDemoState(state);
  const knownInviteIds = state.resources.invites.map((invite) => invite.inviteId).filter(Boolean);
  const knownDocumentIds = [state.resources.document.documentId].filter(Boolean);
  return {
    schemaVersion: PUBLIC_DEMO_SCHEMA_VERSION,
    kind: PUBLIC_DEMO_CLEANUP_KIND,
    origin: state.origin,
    runId: state.runId,
    tenantId: state.tenantId,
    roomId: state.roomId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    platformSha: state.platformSha,
    expected: {
      tenantName: state.expected.tenantName,
      roomName: state.expected.roomName,
      templateId: state.expected.templateId,
      templateVersion: state.expected.templateVersion
    },
    planned: {
      documentId: state.resources.document.plannedId,
      inviteIds: state.resources.invites.map((invite) => invite.plannedId)
    },
    resources: {
      tenantCreated: state.resources.tenant.status === "created",
      roomCreated: state.resources.room.status === "created",
      documentIds: [...new Set([...knownDocumentIds, ...(state.cleanup.discoveredDocumentIds ?? [])])],
      inviteIds: [...new Set([...knownInviteIds, ...(state.cleanup.discoveredInviteIds ?? [])])]
    },
    lifecycle: {
      seedPhase: state.lifecycle.phase,
      seedCompletedSteps: [...state.lifecycle.completedSteps],
      seedFailure: state.lifecycle.lastFailure,
      cleanup: {
        phase: state.cleanup.phase,
        revokedInviteIds: [...state.cleanup.revokedInviteIds],
        deletedDocumentIds: [...state.cleanup.deletedDocumentIds],
        sessionEnded: state.cleanup.sessionEnded,
        roomDeleted: state.cleanup.roomDeleted,
        tenantDeleted: state.cleanup.tenantDeleted,
        lastFailure: state.cleanup.lastFailure
      }
    }
  };
}

async function createInitialStateFiles(stateFile, state) {
  const absolute = resolve(stateFile);
  const cleanupFile = publicDemoCleanupRecordPath(absolute);
  if (await pathExists(cleanupFile)) throw demoError("demo_state_conflict", "state-create", { reason: "cleanup_record_exists" });
  await exclusiveCreateJson(absolute, state);
  try {
    await exclusiveCreateJson(cleanupFile, createRedactedCleanupRecord(state));
  } catch (error) {
    await rm(absolute, { force: true });
    throw error;
  }
  return { stateFile: absolute, cleanupFile };
}

async function persistFullState(stateFile, state) {
  validatePublicDemoState(state);
  await atomicWriteJson(stateFile, state);
  await atomicWriteJson(publicDemoCleanupRecordPath(stateFile), createRedactedCleanupRecord(state), { allowCreate: true });
}

function markSeedStep(state, step, at, mutate = () => undefined) {
  mutate();
  if (!state.lifecycle.completedSteps.includes(step)) state.lifecycle.completedSteps.push(step);
  state.lifecycle.lastFailure = null;
  state.updatedAt = at;
}

function failureRecord(error, at) {
  const normalized = error instanceof PublicDemoError ? error : demoError("demo_request_failed", "unknown", { cause: error });
  return {
    at,
    code: normalized.code,
    step: normalized.step,
    ...(normalized.status === undefined ? {} : { status: normalized.status }),
    ...(normalized.requestId ? { requestId: normalized.requestId } : {})
  };
}

function requireAdminToken(adminToken) {
  if (typeof adminToken !== "string" || !adminToken.trim()) {
    throw demoError("demo_auth_failed", "configuration", { reason: "VRATA_ADMIN_TOKEN_required" });
  }
  return adminToken.trim();
}

export function createPublicDemoApiClient({ origin, adminToken, fetcher = fetch, timeoutMs = 15_000, getRetries = 2, sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)) }) {
  const canonicalOrigin = canonicalizePublicDemoOrigin(origin);
  const token = requireAdminToken(adminToken);
  async function request(method, path, options = {}) {
    if (!path.startsWith("/") || path.startsWith("//")) throw demoError("demo_request_failed", options.step ?? "request", { reason: "invalid_request_path" });
    const attempts = method === "GET" ? getRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const headers = {
        ...(options.auth === false ? {} : { "x-vrata-admin-token": token }),
        "x-request-id": `public-demo-${nodeRandomUUID()}`,
        ...(options.headers ?? {})
      };
      let body;
      if (options.form) body = options.form;
      else if (options.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.body);
      }
      let response;
      const controller = new AbortController();
      let timeoutHandle;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            const timeoutError = new Error("request_timeout");
            timeoutError.name = "TimeoutError";
            reject(timeoutError);
          }, timeoutMs);
        });
        const requestUrl = new URL(path, canonicalOrigin);
        response = await Promise.race([
          fetcher(requestUrl, { method, headers, body, signal: controller.signal, redirect: "error" }),
          timeoutPromise
        ]);
        if (response.url && new URL(response.url).origin !== canonicalOrigin) {
          throw demoError("demo_request_failed", options.step ?? "request", { reason: "cross_origin_response" });
        }
      } catch (error) {
        if (method === "GET" && attempt + 1 < attempts) {
          await sleep(50 * (attempt + 1));
          continue;
        }
        const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
        throw demoError(timeout ? "demo_request_timeout" : "demo_request_failed", options.step ?? "request", { reason: timeout ? "request_timeout" : "network_error", cause: error });
      } finally {
        clearTimeout(timeoutHandle);
      }
      if (!response.ok && retryableGetStatuses.has(response.status) && method === "GET" && attempt + 1 < attempts) {
        await response.arrayBuffer().catch(() => undefined);
        await sleep(50 * (attempt + 1));
        continue;
      }
      const requestId = safeIdentifier(response.headers.get("x-request-id"));
      let payload = null;
      const text = await response.text();
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          if (response.ok) throw demoError("demo_request_failed", options.step ?? "request", { status: response.status, requestId, reason: "invalid_json_response" });
        }
      }
      if (!response.ok && !(options.acceptStatuses ?? []).includes(response.status)) {
        throw demoError("demo_request_failed", options.step ?? "request", {
          status: response.status,
          requestId: requestId ?? safeIdentifier(payload?.requestId),
          reason: safeApiReason(payload, [token])
        });
      }
      return { status: response.status, requestId: requestId ?? safeIdentifier(payload?.requestId), data: payload };
    }
    throw demoError("demo_request_failed", options.step ?? "request", { reason: "retry_exhausted" });
  }
  return {
    get: (path, options) => request("GET", path, options),
    post: (path, options) => request("POST", path, options),
    put: (path, options) => request("PUT", path, options),
    delete: (path, options) => request("DELETE", path, options)
  };
}

function expectedTemplateCatalogEntry(entry) {
  const defaults = entry?.defaults;
  return entry?.templateId === PUBLIC_DEMO_TEMPLATE_ID
    && entry.currentVersion === PUBLIC_DEMO_TEMPLATE_VERSION
    && entry.status === "active"
    && defaults?.roomType === "standard"
    && defaults?.features?.voice === true
    && defaults?.features?.spatialAudio === true
    && defaults?.settings?.notes?.enabled === true
    && defaults?.settings?.notes?.defaultScope === "shared"
    && defaults?.settings?.presentation?.enabled === true
    && defaults?.settings?.presentation?.surfaceId === PUBLIC_DEMO_SURFACE_ID;
}

async function assertSceneAssetReachable(template, fetcher, timeoutMs) {
  let preview;
  try {
    preview = new URL(template.previewUrl);
  } catch {
    throw demoError("demo_feature_disabled", "preflight-scene", { reason: "scene_preview_url_missing" });
  }
  if (preview.username || preview.password || preview.search || preview.hash
    || (preview.protocol !== "https:" && !(preview.protocol === "http:" && isLoopbackHostname(preview.hostname)))) {
    throw demoError("demo_feature_disabled", "preflight-scene", { reason: "scene_preview_origin_invalid" });
  }
  try {
    const response = await fetcher(preview, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || (response.url && new URL(response.url).origin !== preview.origin)) {
      throw demoError("demo_feature_disabled", "preflight-scene", { status: response.status, reason: "scene_preview_unavailable" });
    }
    const content = await response.arrayBuffer();
    if (!content.byteLength) throw demoError("demo_feature_disabled", "preflight-scene", { reason: "scene_preview_empty" });
  } catch (error) {
    if (error instanceof PublicDemoError) throw error;
    throw demoError("demo_feature_disabled", "preflight-scene", { reason: "scene_preview_unavailable", cause: error });
  }
}

async function preflight(client, options = {}) {
  const health = await client.get("/health", { auth: false, step: "preflight-health" });
  const requiredFeatures = [
    "voiceEnabled",
    "spatialAudioEnabled",
    "roomStateRealtimeEnabled",
    "roomAccessPolicyEnabled",
    "hostControlsEnabled",
    "documentsEnabled",
    "notesEnabled",
    "postgresEnabled",
    "controlPlaneAuthEnabled"
  ];
  if (health.data?.status !== "ok"
    || requiredFeatures.some((name) => health.data?.features?.[name] !== true)
    || health.data?.dependencies?.postgres !== true
    || health.data?.dependencies?.livekit !== true) {
    throw demoError("demo_feature_disabled", "preflight-health", { reason: "required_demo_feature_unavailable" });
  }
  const session = await client.get("/api/control-plane/session", { step: "preflight-auth", acceptStatuses: [401, 403] });
  if (session.status === 401 || session.status === 403 || session.data?.actor?.actorType !== "admin-token") {
    throw demoError("demo_auth_failed", "preflight-auth", { status: session.status, requestId: session.requestId, reason: "admin_token_rejected" });
  }
  const catalog = await client.get("/api/templates", { step: "preflight-catalog" });
  const template = catalog.data?.items?.find((entry) => entry?.templateId === PUBLIC_DEMO_TEMPLATE_ID);
  if (!expectedTemplateCatalogEntry(template)) {
    throw demoError("demo_catalog_not_active", "preflight-catalog", { reason: `${PUBLIC_DEMO_TEMPLATE_ID}@${PUBLIC_DEMO_TEMPLATE_VERSION}_required` });
  }
  await assertSceneAssetReachable(template, options.fetcher ?? fetch, options.timeoutMs ?? 15_000);
  return template;
}

async function cleanupPreflight(client) {
  const health = await client.get("/health", { auth: false, step: "cleanup-health" });
  if (health.data?.status !== "ok") throw demoError("demo_cleanup_incomplete", "cleanup-health", { reason: "api_unavailable" });
  const session = await client.get("/api/control-plane/session", { step: "cleanup-auth", acceptStatuses: [401, 403] });
  if (session.status === 401 || session.status === 403 || session.data?.actor?.actorType !== "admin-token") {
    throw demoError("demo_auth_failed", "cleanup-auth", { status: session.status, requestId: session.requestId, reason: "admin_token_rejected" });
  }
}

function assertOriginBinding(stateOrigin, requestedBaseUrl) {
  if (requestedBaseUrl !== undefined && canonicalizePublicDemoOrigin(requestedBaseUrl) !== stateOrigin) {
    throw demoError("demo_state_conflict", "state-binding", { reason: "origin_mismatch" });
  }
}

function assertTenantOwned(tenant, state) {
  if (tenant.tenantId !== state.tenantId || tenant.name !== state.expected.tenantName) {
    throw demoError("demo_state_conflict", "ownership", { reason: "tenant_ownership_mismatch" });
  }
}

function assertRoomOwned(room, state) {
  if (room?.roomId !== state.roomId
    || room.tenantId !== state.tenantId
    || room.name !== state.expected.roomName
    || room.templateId !== PUBLIC_DEMO_TEMPLATE_ID
    || room.templateVersion !== PUBLIC_DEMO_TEMPLATE_VERSION
    || room.templateSnapshot?.templateId !== PUBLIC_DEMO_TEMPLATE_ID
    || room.templateSnapshot?.version !== PUBLIC_DEMO_TEMPLATE_VERSION
    || room.templateSnapshot?.assetLock?.sceneReleaseId !== PUBLIC_DEMO_SCENE_RELEASE
    || room.templateSnapshot?.assetLock?.commitSha !== PUBLIC_DEMO_SCENE_COMMIT
    || room.templateSnapshot?.assetLock?.sceneManifest?.sha256 !== PUBLIC_DEMO_SCENE_MANIFEST_SHA256) {
    throw demoError("demo_state_conflict", "ownership", { reason: "room_ownership_mismatch" });
  }
}

function assertPreparedRoom(room, state, step = "check-room") {
  assertRoomOwned(room, state);
  const exactFeatures = room?.features?.voice === true && room?.features?.spatialAudio === true && room?.features?.screenShare === true;
  if (room.roomType !== "standard"
    || room.status !== "active"
    || room.visibility !== "private"
    || room.guestAllowed !== true
    || !exactFeatures) {
    throw demoError("demo_state_conflict", step, { reason: "room_contract_mismatch" });
  }
}

async function readOwnership(client, state, { requirePresent = false } = {}) {
  const tenantsResponse = await client.get("/api/tenants", { step: "ownership-tenants" });
  const tenant = tenantsResponse.data?.items?.find((item) => item?.tenantId === state.tenantId) ?? null;
  const roomResponse = await client.get(`/api/rooms/${encodeURIComponent(state.roomId)}`, { step: "ownership-room", acceptStatuses: [404] });
  const room = roomResponse.status === 404 ? null : roomResponse.data;
  if (tenant) assertTenantOwned(tenant, state);
  if (room) assertRoomOwned(room, state);
  if (room && !tenant) throw demoError("demo_state_conflict", "ownership", { reason: "room_without_owned_tenant" });
  if (requirePresent && (!tenant || !room)) throw demoError("demo_state_conflict", "ownership", { reason: "demo_resources_missing" });
  return { tenant, room };
}

function assertCreateResponse(resource, expected, step) {
  for (const [key, value] of Object.entries(expected)) {
    if (resource?.[key] !== value) throw demoError("demo_state_conflict", step, { reason: `${key}_response_mismatch` });
  }
}

async function recordSeedFailure(stateFile, state, error, now) {
  try {
    state.lifecycle.lastFailure = failureRecord(error, nowIso(now));
    state.updatedAt = state.lifecycle.lastFailure.at;
    await persistFullState(stateFile, state);
  } catch {
    // Preserve the original operational error; the last successful atomic state is still retryable.
  }
}

function seedResult(state, stateFile, created) {
  return {
    status: "prepared",
    prepared: true,
    created,
    runId: state.runId,
    origin: state.origin,
    tenantId: state.tenantId,
    roomId: state.roomId,
    template: `${PUBLIC_DEMO_TEMPLATE_ID}@${PUBLIC_DEMO_TEMPLATE_VERSION}`,
    scene: PUBLIC_DEMO_SCENE_RELEASE,
    inviteCount: state.resources.invites.length,
    stateFile: resolve(stateFile),
    cleanupRecord: publicDemoCleanupRecordPath(stateFile)
  };
}

export async function seedPublicDemo(options) {
  const origin = canonicalizePublicDemoOrigin(options.baseUrl);
  const stateFile = resolve(options.stateFile);
  const token = requireAdminToken(options.adminToken);
  if (await pathExists(stateFile)) {
    const existing = await readPublicDemoState(stateFile);
    assertOriginBinding(existing.origin, origin);
    if (existing.lifecycle.phase !== "completed") throw demoError("demo_seed_incomplete", "seed-resume", { reason: "cleanup_required" });
    await checkPublicDemo({ ...options, stateFile, baseUrl: origin, adminToken: token });
    return seedResult(existing, stateFile, false);
  }

  const state = await createPlannedPublicDemoState({
    origin,
    inviteTtlSeconds: options.inviteTtlSeconds,
    now: options.now,
    randomUUID: options.randomUUID,
    platformSha: options.platformSha
  });
  await createInitialStateFiles(stateFile, state);
  const client = createPublicDemoApiClient({
    origin,
    adminToken: token,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
    getRetries: options.getRetries,
    sleep: options.sleep
  });
  const now = options.now ?? (() => new Date());
  try {
    await options.onCleanupRecord?.(createRedactedCleanupRecord(state));
    await preflight(client, options);
    markSeedStep(state, "preflight", nowIso(now));
    state.lifecycle.phase = "seeding";
    await persistFullState(stateFile, state);

    const tenantResponse = await client.post("/api/tenants", {
      step: "create-tenant",
      body: { tenantId: state.tenantId, name: state.expected.tenantName }
    });
    assertCreateResponse(tenantResponse.data, { tenantId: state.tenantId, name: state.expected.tenantName }, "create-tenant");
    markSeedStep(state, "tenant-created", nowIso(now), () => { state.resources.tenant.status = "created"; });
    await persistFullState(stateFile, state);

    const roomPayload = {
      roomId: state.roomId,
      tenantId: state.tenantId,
      templateId: PUBLIC_DEMO_TEMPLATE_ID,
      templateVersion: PUBLIC_DEMO_TEMPLATE_VERSION,
      name: state.expected.roomName,
      roomType: "standard",
      visibility: "private",
      guestAllowed: true,
      features: { voice: true, spatialAudio: true, screenShare: true }
    };
    const roomResponse = await client.post("/api/rooms", { step: "create-room", body: roomPayload });
    assertPreparedRoom(roomResponse.data, state, "create-room");
    markSeedStep(state, "room-created", nowIso(now), () => { state.resources.room.status = "created"; });
    await persistFullState(stateFile, state);

    const agenda = options.agendaText ?? await readFile(agendaUrl, "utf8");
    const noteResponse = await client.put(`/api/rooms/${encodeURIComponent(state.roomId)}/notes/shared`, {
      step: "create-agenda",
      body: { content: agenda }
    });
    if (noteResponse.data?.note?.roomId !== state.roomId || noteResponse.data?.note?.scope !== "shared") {
      throw demoError("demo_state_conflict", "create-agenda", { reason: "agenda_response_mismatch" });
    }
    markSeedStep(state, "agenda-created", nowIso(now), () => {
      state.resources.agenda.status = "created";
      state.resources.agenda.checksum = `sha256:${sha256(Buffer.from(agenda, "utf8"))}`;
    });
    await persistFullState(stateFile, state);

    const pdf = await createPublicDemoPdf();
    if (`sha256:${sha256(pdf)}` !== state.expected.document.checksum) {
      throw demoError("demo_state_conflict", "create-pdf", { reason: "deterministic_pdf_checksum_mismatch" });
    }
    const form = new FormData();
    form.append("document", new Blob([pdf], { type: "application/pdf" }), state.expected.document.filename);
    const uploadResponse = await client.post(`/api/rooms/${encodeURIComponent(state.roomId)}/documents`, {
      step: "upload-document",
      form
    });
    const document = uploadResponse.data?.document;
    assertCreateResponse(document, {
      roomId: state.roomId,
      tenantId: state.tenantId,
      filename: state.expected.document.filename,
      contentType: "application/pdf",
      checksum: state.expected.document.checksum
    }, "upload-document");
    if (!safeIdentifier(document?.documentId) || document?.metadata?.pageCount !== PUBLIC_DEMO_PDF_PAGE_COUNT || document?.metadata?.kind !== "pdf") {
      throw demoError("demo_state_conflict", "upload-document", { reason: "document_metadata_mismatch" });
    }
    markSeedStep(state, "document-uploaded", nowIso(now), () => {
      state.resources.document.status = "uploaded";
      state.resources.document.documentId = document.documentId;
    });
    await persistFullState(stateFile, state);

    const surfaceResponse = await client.post(`/api/rooms/${encodeURIComponent(state.roomId)}/documents/${encodeURIComponent(document.documentId)}/surface`, {
      step: "link-document",
      body: { surfaceId: PUBLIC_DEMO_SURFACE_ID }
    });
    if (surfaceResponse.data?.document?.documentId !== document.documentId || surfaceResponse.data?.document?.linkedSurfaceId !== PUBLIC_DEMO_SURFACE_ID) {
      throw demoError("demo_state_conflict", "link-document", { reason: "surface_binding_mismatch" });
    }
    markSeedStep(state, "document-linked", nowIso(now), () => { state.resources.document.status = "linked"; });
    await persistFullState(stateFile, state);

    for (let index = 0; index < state.resources.invites.length; index += 1) {
      const planned = state.resources.invites[index];
      const inviteResponse = await client.post(`/api/rooms/${encodeURIComponent(state.roomId)}/invites`, {
        step: `create-invite-${index + 1}`,
        body: { role: planned.role, expiresAt: planned.expiresAt, waitingRoomEnabled: false }
      });
      const invite = inviteResponse.data;
      let inviteUrl;
      try { inviteUrl = new URL(invite?.inviteLink); } catch { inviteUrl = null; }
      if (!safeIdentifier(invite?.inviteId)
        || invite.roomId !== state.roomId
        || invite.role !== planned.role
        || invite.expiresAt !== planned.expiresAt
        || invite.revokedAt
        || inviteUrl?.origin !== state.origin
        || inviteUrl?.pathname !== `/rooms/${state.roomId}`
        || !inviteUrl.searchParams.get("invite")) {
        throw demoError("demo_state_conflict", `create-invite-${index + 1}`, { reason: "invite_response_mismatch" });
      }
      markSeedStep(state, `invite-created-${index + 1}`, nowIso(now), () => {
        planned.status = "created";
        planned.inviteId = invite.inviteId;
        planned.inviteLink = invite.inviteLink;
      });
      await persistFullState(stateFile, state);
    }

    state.lifecycle.phase = "completed";
    markSeedStep(state, "seed-completed", nowIso(now));
    await persistFullState(stateFile, state);
    return seedResult(state, stateFile, true);
  } catch (error) {
    await recordSeedFailure(stateFile, state, error, now);
    throw error;
  }
}

async function validatePreparedResources(client, state, now) {
  const { room } = await readOwnership(client, state, { requirePresent: true });
  assertPreparedRoom(room, state);
  const noteResponse = await client.get(`/api/rooms/${encodeURIComponent(state.roomId)}/notes/shared`, { step: "check-agenda" });
  const note = noteResponse.data?.note;
  if (note?.roomId !== state.roomId || note.scope !== "shared" || note.updatedAt === null || note.deletedAt) {
    throw demoError("demo_state_conflict", "check-agenda", { reason: "shared_agenda_missing" });
  }

  const documentsResponse = await client.get(`/api/rooms/${encodeURIComponent(state.roomId)}/documents`, { step: "check-documents" });
  const expectedDocumentId = state.resources.document.documentId;
  const document = documentsResponse.data?.items?.find((item) => item?.documentId === expectedDocumentId);
  if (!document
    || document.roomId !== state.roomId
    || document.tenantId !== state.tenantId
    || document.filename !== state.expected.document.filename
    || document.contentType !== "application/pdf"
    || document.checksum !== state.expected.document.checksum
    || document.metadata?.kind !== "pdf"
    || document.metadata?.pageCount !== PUBLIC_DEMO_PDF_PAGE_COUNT
    || document.linkedSurfaceId !== PUBLIC_DEMO_SURFACE_ID) {
    throw demoError("demo_state_conflict", "check-documents", { reason: "demo_document_drift" });
  }

  const invitesResponse = await client.get(`/api/rooms/${encodeURIComponent(state.roomId)}/invites`, { step: "check-invites" });
  const listedInvites = invitesResponse.data?.items ?? [];
  const nowValue = now();
  const nowMs = (nowValue instanceof Date ? nowValue : new Date(nowValue)).getTime();
  for (const expected of state.resources.invites) {
    let storedLink;
    try { storedLink = new URL(expected.inviteLink); } catch { storedLink = null; }
    const invite = listedInvites.find((item) => item?.inviteId === expected.inviteId);
    if (expected.status !== "created"
      || storedLink?.origin !== state.origin
      || storedLink?.pathname !== `/rooms/${state.roomId}`
      || !storedLink.searchParams.get("invite")
      || !invite
      || invite.roomId !== state.roomId
      || invite.role !== expected.role
      || invite.expiresAt !== expected.expiresAt
      || invite.revokedAt
      || Date.parse(invite.expiresAt) <= nowMs) {
      throw demoError("demo_invites_unusable", "check-invites", { reason: "invite_missing_expired_revoked_or_drifted" });
    }
  }
  return { document, invites: listedInvites };
}

export async function checkPublicDemo(options) {
  const stateFile = resolve(options.stateFile);
  const state = await readPublicDemoState(stateFile);
  if (state.lifecycle.phase !== "completed") throw demoError("demo_seed_incomplete", "check-state", { reason: "seed_not_completed" });
  assertOriginBinding(state.origin, options.baseUrl);
  const client = createPublicDemoApiClient({
    origin: state.origin,
    adminToken: options.adminToken,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
    getRetries: options.getRetries,
    sleep: options.sleep
  });
  await preflight(client, options);
  await validatePreparedResources(client, state, options.now ?? (() => new Date()));
  return {
    status: "prepared",
    prepared: true,
    runId: state.runId,
    origin: state.origin,
    tenantId: state.tenantId,
    roomId: state.roomId,
    template: `${PUBLIC_DEMO_TEMPLATE_ID}@${PUBLIC_DEMO_TEMPLATE_VERSION}`,
    scene: PUBLIC_DEMO_SCENE_RELEASE,
    inviteCount: state.resources.invites.length,
    stateFile,
    cleanupRecord: publicDemoCleanupRecordPath(stateFile)
  };
}

function cleanupStateView(input) {
  if (input.kind === PUBLIC_DEMO_STATE_KIND) return input;
  return {
    ...input,
    resources: undefined,
    lifecycle: undefined
  };
}

function cleanupLifecycleFromRecord(record) {
  return record.lifecycle.cleanup;
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

async function persistCleanupContext(context) {
  if (context.state) {
    context.state.updatedAt = context.record.updatedAt;
    context.state.cleanup = {
      ...context.state.cleanup,
      ...context.record.lifecycle.cleanup,
      discoveredInviteIds: [...context.record.resources.inviteIds],
      discoveredDocumentIds: [...context.record.resources.documentIds]
    };
    await persistFullState(context.inputFile, context.state);
    context.record = createRedactedCleanupRecord(context.state);
  } else {
    validatePublicDemoState(context.record, { allowCleanupRecord: true });
    await atomicWriteJson(context.inputFile, context.record);
  }
}

function markCleanupFailure(context, error, at) {
  context.record.updatedAt = at;
  context.record.lifecycle.cleanup.phase = "failed";
  context.record.lifecycle.cleanup.lastFailure = failureRecord(error, at);
}

async function cleanupMutation(client, method, path, step, options = {}) {
  const result = await client[method](path, { step, acceptStatuses: [404], ...options });
  return result.status;
}

const ambiguousSeedMutationSteps = new Set([
  "create-tenant",
  "create-room",
  "create-agenda",
  "upload-document",
  "link-document",
  "create-invite-1",
  "create-invite-2",
  "create-invite-3",
  "create-invite-4"
]);

function seedFailureFromCleanupInput(input) {
  return input.kind === PUBLIC_DEMO_STATE_KIND ? input.lifecycle.lastFailure : input.lifecycle.seedFailure;
}

async function waitForAmbiguousSeedMutation(input, options) {
  const failure = seedFailureFromCleanupInput(input);
  if (!failure
    || !ambiguousSeedMutationSteps.has(failure.step)
    || !["demo_request_failed", "demo_request_timeout"].includes(failure.code)) return;
  const settleMs = options.cleanupSettleMs ?? options.timeoutMs ?? 15_000;
  if (settleMs > 0) await (options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))))(settleMs);
}

async function assertCleanupRemainsAbsent(client, state, options) {
  const attempts = options.cleanupReconcileAttempts ?? 3;
  const intervalMs = options.cleanupReconcileIntervalMs ?? 100;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ownership = await readOwnership(client, state);
    if (ownership.tenant || ownership.room) {
      throw demoError("demo_cleanup_incomplete", "cleanup-reconcile", { reason: "demo_resources_still_present" });
    }
    if (attempt + 1 < attempts && intervalMs > 0) await sleep(intervalMs);
  }
}

export async function cleanupPublicDemo(options) {
  const inputFile = resolve(options.stateFile);
  const input = await readPublicDemoState(inputFile, { allowCleanupRecord: true });
  assertOriginBinding(input.origin, options.baseUrl);
  const token = requireAdminToken(options.adminToken);
  let context;
  if (input.kind === PUBLIC_DEMO_STATE_KIND) {
    context = { inputFile, state: input, record: createRedactedCleanupRecord(input) };
  } else {
    context = { inputFile, state: null, record: structuredClone(input) };
  }
  const client = createPublicDemoApiClient({
    origin: input.origin,
    adminToken: token,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
    getRetries: options.getRetries,
    sleep: options.sleep
  });
  const now = options.now ?? (() => new Date());
  try {
    await cleanupPreflight(client);
    await waitForAmbiguousSeedMutation(input, options);
    const stateView = cleanupStateView(input);
    const ownership = await readOwnership(client, stateView);
    let invites = [];
    let documents = [];
    if (ownership.room) {
      const invitesResponse = await client.get(`/api/rooms/${encodeURIComponent(input.roomId)}/invites`, { step: "cleanup-discover-invites" });
      const documentsResponse = await client.get(`/api/rooms/${encodeURIComponent(input.roomId)}/documents`, { step: "cleanup-discover-documents" });
      invites = invitesResponse.data?.items ?? [];
      documents = documentsResponse.data?.items ?? [];
      if (invites.some((invite) => invite?.roomId !== input.roomId)
        || documents.some((document) => document?.roomId !== input.roomId || document?.tenantId !== input.tenantId)) {
        throw demoError("demo_state_conflict", "cleanup-discovery", { reason: "discovered_resource_ownership_mismatch" });
      }
      for (const invite of invites) addUnique(context.record.resources.inviteIds, invite.inviteId);
      for (const document of documents) addUnique(context.record.resources.documentIds, document.documentId);
    }
    context.record.updatedAt = nowIso(now);
    context.record.lifecycle.cleanup.phase = "cleaning";
    context.record.lifecycle.cleanup.lastFailure = null;
    await persistCleanupContext(context);

    for (const invite of invites) {
      if (!invite.revokedAt) {
        await cleanupMutation(
          client,
          "post",
          `/api/rooms/${encodeURIComponent(input.roomId)}/invites/${encodeURIComponent(invite.inviteId)}/revoke`,
          "cleanup-revoke-invite"
        );
      }
      addUnique(context.record.lifecycle.cleanup.revokedInviteIds, invite.inviteId);
      context.record.updatedAt = nowIso(now);
      await persistCleanupContext(context);
    }

    if (ownership.room) {
      await cleanupMutation(client, "post", `/api/rooms/${encodeURIComponent(input.roomId)}/session-control/end`, "cleanup-end-session");
    }
    context.record.lifecycle.cleanup.sessionEnded = true;
    context.record.updatedAt = nowIso(now);
    await persistCleanupContext(context);

    for (const document of documents) {
      await cleanupMutation(
        client,
        "delete",
        `/api/rooms/${encodeURIComponent(input.roomId)}/documents/${encodeURIComponent(document.documentId)}`,
        "cleanup-delete-document"
      );
      addUnique(context.record.lifecycle.cleanup.deletedDocumentIds, document.documentId);
      context.record.updatedAt = nowIso(now);
      await persistCleanupContext(context);
    }

    if (ownership.room) await cleanupMutation(client, "delete", `/api/rooms/${encodeURIComponent(input.roomId)}`, "cleanup-delete-room");
    context.record.lifecycle.cleanup.roomDeleted = true;
    context.record.updatedAt = nowIso(now);
    await persistCleanupContext(context);

    if (ownership.tenant) {
      const tenantDeleteStatus = await cleanupMutation(
        client,
        "delete",
        `/api/tenants/${encodeURIComponent(input.tenantId)}`,
        "cleanup-delete-tenant",
        { acceptStatuses: [409] }
      );
      if (tenantDeleteStatus === 409) {
        const afterConflict = await readOwnership(client, stateView);
        if (afterConflict.tenant) {
          throw demoError("demo_cleanup_incomplete", "cleanup-delete-tenant", { status: 409, reason: "tenant_has_dependencies" });
        }
      }
    }
    await assertCleanupRemainsAbsent(client, stateView, options);
    context.record.lifecycle.cleanup.tenantDeleted = true;
    context.record.lifecycle.cleanup.phase = "completed";
    context.record.lifecycle.cleanup.lastFailure = null;
    context.record.updatedAt = nowIso(now);
    await persistCleanupContext(context);

    let cleanupRecord = inputFile;
    if (context.state) {
      cleanupRecord = publicDemoCleanupRecordPath(inputFile);
      await rm(inputFile, { force: true });
    }
    return {
      status: "cleaned",
      cleaned: true,
      runId: input.runId,
      origin: input.origin,
      tenantId: input.tenantId,
      roomId: input.roomId,
      cleanupRecord
    };
  } catch (error) {
    const at = nowIso(now);
    markCleanupFailure(context, error, at);
    await persistCleanupContext(context).catch(() => undefined);
    if (error instanceof PublicDemoError && ["demo_state_conflict", "demo_auth_failed"].includes(error.code)) throw error;
    const normalized = error instanceof PublicDemoError ? error : demoError("demo_request_failed", "cleanup", { cause: error });
    throw demoError("demo_cleanup_incomplete", normalized.step, {
      status: normalized.status,
      requestId: normalized.requestId,
      reason: normalized.code,
      cause: normalized
    });
  }
}

function cliSummary(result) {
  const { state: _state, ...safe } = result;
  return safe;
}

export async function runPublicDemoCli(argv, env = process.env, dependencies = {}) {
  const args = parsePublicDemoArgs(argv);
  const common = {
    baseUrl: args.baseUrl,
    stateFile: args.stateFile,
    adminToken: env.VRATA_ADMIN_TOKEN,
    timeoutMs: args.timeoutMs,
    getRetries: args.getRetries,
    inviteTtlSeconds: args.inviteTtlSeconds,
    ...dependencies
  };
  if (args.command === "seed") return cliSummary(await seedPublicDemo(common));
  if (args.command === "check") return cliSummary(await checkPublicDemo(common));
  return cliSummary(await cleanupPublicDemo(common));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPublicDemoCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const normalized = error instanceof PublicDemoError ? error : demoError("demo_request_failed", "cli", { reason: "unexpected_error", cause: error });
      process.stderr.write(`${JSON.stringify(redactSensitive(normalized.toJSON(), [process.env.VRATA_ADMIN_TOKEN]))}\n`);
      process.exitCode = 1;
    });
}
