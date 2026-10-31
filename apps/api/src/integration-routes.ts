import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { referenceTemplateContract } from "@vrata/templates";

import { loadDemoPolicies, type DemoPolicy } from "./demo-policies.js";
import { isPortalManagedDeployment } from "./feature-flags.js";
import { json } from "./http-responses.js";
import { INTEGRATION_CONTRACT, loadIntegrationKeyring, verifyIntegrationAssertion, type IntegrationPrincipal, type IntegrationScope } from "./integration-auth.js";
import { parseBody } from "./request-body.js";
import { completeGrantRevocation } from "./grant-revocation.js";
import { createGrantCode, grantCodeHash, grantEntryUrl } from "./room-grants.js";
import { RETURN_CONTEXT_ID_PATTERN, RETURN_CONTEXT_KINDS } from "./return-targets.js";
import { resolveRoomTemplateCreate, templateInputError } from "./room-template-policy.js";
import { stableJson, templateVersionContentHash } from "./storage-room-records.js";
import type { IntegrationErrorObject, IntegrationOperationRecord, ManagedRoomAccessPatch, ManagedRoomBlockReason, ManagedRoomGrantRecord, ManagedRoomGrantRole, RoomRecord, Storage } from "./storage.js";

const TENANT_ID_PATTERN = /^pt_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_PATTERN = /^acct_[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const REFERENCE_TEMPLATE_IDS = ["meeting-room-basic", "presentation-room-basic", "personal-room-basic"];
const ROOM_KINDS = ["reference", "demo-instance", "custom", "preview"];
const MAX_ACCESS_HORIZON_MS = 10 * 366 * 24 * 60 * 60 * 1000;
const MAX_GRACE_SECONDS = 86_400;
// Clock skew allowed between the portal choosing accessUntil and the platform checking the demo lifetime.
const DEMO_LIFETIME_SKEW_MS = 60_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// A crashed request releases its key after this lease, so a retry can finish the same operation.
const OPERATION_LEASE_SECONDS = 30;

type ErrorCode = "invalid_request" | "unauthenticated" | "forbidden_scope" | "tenant_mismatch" | "room_not_found" | "idempotency_key_reused"
  | "idempotency_in_progress" | "revision_mismatch" | "template_not_allowed" | "dependency_unavailable"
  | "room_closed" | "access_expired" | "room_paused" | "grant_invalid";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden_scope: 403,
  tenant_mismatch: 403,
  room_not_found: 404,
  idempotency_key_reused: 409,
  idempotency_in_progress: 409,
  revision_mismatch: 409,
  template_not_allowed: 422,
  dependency_unavailable: 503,
  room_closed: 410,
  access_expired: 410,
  room_paused: 423,
  grant_invalid: 404
};

class IntegrationRequestError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly status = STATUS_BY_CODE[code], readonly details?: Record<string, unknown>, readonly retryable = false) {
    super(message);
  }
}

interface ExecutionResult {
  status: number;
  /** Stored with the operation and returned to every replay. */
  body: unknown;
  /** Sent to this caller only, instead of body: carries a one-time secret that is never stored. */
  firstBody?: unknown;
  revision?: number;
  error?: IntegrationErrorObject;
}

export interface IntegrationRoutesContext {
  getRequestId(request: IncomingMessage): string;
  logEvent(event: Record<string, unknown>): void;
  operationLeaseSeconds?: number;
  /** STATE_TOKEN_SECRET; grant codes are hashed with a key derived from it. */
  stateSecret?(): string;
  /** Called after a change that withdraws access, so live sessions and media end without waiting for the next tick. */
  accessChanged?(roomId: string): void;
}

function errorObject(error: IntegrationRequestError, requestId: string): IntegrationErrorObject {
  return {
    code: error.code,
    message: error.message,
    requestId,
    retryable: error.retryable,
    ...(error.retryable ? { retryAfterSeconds: 1 } : {}),
    ...(error.details ? { details: error.details } : {})
  };
}

function failure(error: IntegrationRequestError, requestId: string): ExecutionResult {
  const object = errorObject(error, requestId);
  return { status: error.status, body: { error: object }, error: object };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(body).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) throw new IntegrationRequestError("invalid_request", `Unexpected fields: ${unexpected.join(", ")}`);
}

function parseTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new IntegrationRequestError("invalid_request", `${field} must be an RFC 3339 date-time`);
  }
  const parsed = Date.parse(value);
  if (parsed > Date.now() + MAX_ACCESS_HORIZON_MS) throw new IntegrationRequestError("invalid_request", `${field} is too far in the future`);
  return new Date(parsed).toISOString();
}

function parseGraceSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_GRACE_SECONDS) {
    throw new IntegrationRequestError("invalid_request", `graceSeconds must be an integer from 0 to ${MAX_GRACE_SECONDS}`);
  }
  return value;
}

function effectiveCutoff(room: RoomRecord): string {
  return new Date(Date.parse(room.managed!.accessUntil) + room.managed!.graceSeconds * 1000).toISOString();
}

export function serializeManagedRoom(room: RoomRecord) {
  const managed = room.managed!;
  const contract = referenceTemplateContract(room.templateSnapshot);
  if (!contract) throw new Error("managed_room_template_contract_missing");
  return {
    contract: INTEGRATION_CONTRACT,
    roomId: room.roomId,
    tenantId: room.tenantId,
    kind: managed.kind,
    template: { templateId: room.templateId, version: room.templateVersion },
    ...(managed.ownerSubject ? { ownerSubject: managed.ownerSubject } : {}),
    name: room.name,
    status: managed.status,
    visibility: room.visibility === "unlisted" ? "unlisted" : "private",
    accessUntil: managed.accessUntil,
    graceSeconds: managed.graceSeconds,
    effectiveCutoff: effectiveCutoff(room),
    revision: managed.revision,
    createdAt: managed.createdAt,
    ...(managed.closedAt ? { closedAt: managed.closedAt } : {}),
    ...(managed.demoPolicyId ? { demoPolicyId: managed.demoPolicyId } : {}),
    scene: {
      releaseId: `${room.templateId}@${room.templateVersion}`,
      contentHash: `sha256:${templateVersionContentHash(contract)}`
    }
  };
}

export function serializeIntegrationOperation(operation: IntegrationOperationRecord) {
  return {
    operationId: operation.operationId,
    idempotencyKey: operation.idempotencyKey,
    kind: operation.kind,
    state: operation.state,
    requestHash: operation.requestHash,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.state === "succeeded" && operation.resourceType && operation.resourceId ? {
      result: {
        resourceType: operation.resourceType,
        resourceId: operation.resourceId,
        ...(operation.resultRevision === null ? {} : { revision: operation.resultRevision })
      }
    } : {}),
    ...(operation.state === "failed" && operation.error ? { error: operation.error } : {})
  };
}

export function serializeManagedGrant(grant: ManagedRoomGrantRecord, entryUrl?: string) {
  return {
    grantId: grant.grantId,
    roomId: grant.roomId,
    role: grant.role,
    ...(grant.subject ? { subject: grant.subject } : {}),
    purpose: grant.purpose,
    maxUses: grant.maxUses,
    usedCount: grant.usedCount,
    expiresAt: grant.expiresAt,
    ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}),
    ...(entryUrl ? { entryUrl } : {}),
    revision: grant.revision
  };
}

export function integrationRequestHash(method: string, path: string, body: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson({ method, path, body: body ?? null })).digest("hex")}`;
}

function parseRoomCreate(body: unknown, policies: ReadonlyMap<string, DemoPolicy>) {
  if (!isPlainObject(body)) throw new IntegrationRequestError("invalid_request", "Request body must be a JSON object");
  assertOnlyKeys(body, ["kind", "template", "name", "visibility", "accessUntil", "graceSeconds", "ownerSubject", "demoPolicyId", "bundleVersionId", "previewOf"]);
  if (typeof body.kind !== "string" || !ROOM_KINDS.includes(body.kind)) throw new IntegrationRequestError("invalid_request", "kind is required");
  if (body.kind !== "reference" && body.kind !== "demo-instance") throw new IntegrationRequestError("invalid_request", `kind ${body.kind} is not supported by this platform version`);
  if (body.bundleVersionId !== undefined || body.previewOf !== undefined) {
    throw new IntegrationRequestError("invalid_request", `A ${body.kind} room takes no bundleVersionId or previewOf`);
  }
  if (body.kind === "reference" && body.demoPolicyId !== undefined) throw new IntegrationRequestError("invalid_request", "A reference room takes no demoPolicyId");
  const template = body.template;
  if (!isPlainObject(template)) throw new IntegrationRequestError("invalid_request", "template is required for a reference room");
  assertOnlyKeys(template, ["templateId", "version"]);
  if (typeof template.templateId !== "string" || !REFERENCE_TEMPLATE_IDS.includes(template.templateId)) throw new IntegrationRequestError("invalid_request", "template.templateId is not a reference template");
  if (typeof template.version !== "string" || !SEMVER_PATTERN.test(template.version)) throw new IntegrationRequestError("invalid_request", "template.version must be a semantic version");
  if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 80) throw new IntegrationRequestError("invalid_request", "name must have 1 to 80 characters");
  const visibility = body.visibility ?? "private";
  if (visibility !== "private" && visibility !== "unlisted") throw new IntegrationRequestError("invalid_request", "visibility must be private or unlisted");
  if (body.accessUntil === undefined) throw new IntegrationRequestError("invalid_request", "accessUntil is required");
  const accessUntil = parseTimestamp(body.accessUntil, "accessUntil");
  const graceSeconds = body.graceSeconds === undefined ? 0 : parseGraceSeconds(body.graceSeconds);
  if (body.ownerSubject !== undefined && (typeof body.ownerSubject !== "string" || !SUBJECT_PATTERN.test(body.ownerSubject))) {
    throw new IntegrationRequestError("invalid_request", "ownerSubject must be an account subject");
  }
  const ownerSubject = body.ownerSubject as string | undefined;
  const personal = template.templateId === "personal-room-basic";
  if (personal && (!ownerSubject || visibility !== "private")) throw new IntegrationRequestError("invalid_request", "A personal room needs ownerSubject and private visibility");
  let demoPolicy: DemoPolicy | null = null;
  if (body.kind === "demo-instance") {
    if (ownerSubject !== undefined) throw new IntegrationRequestError("invalid_request", "A demo instance has no owner");
    if (visibility !== "private") throw new IntegrationRequestError("invalid_request", "A demo instance is private; guests enter only with grants");
    if (graceSeconds !== 0) throw new IntegrationRequestError("invalid_request", "A demo instance has no grace period");
    if (typeof body.demoPolicyId !== "string") throw new IntegrationRequestError("invalid_request", "demoPolicyId is required for a demo instance");
    demoPolicy = policies.get(body.demoPolicyId) ?? null;
    if (!demoPolicy) throw new IntegrationRequestError("invalid_request", "demoPolicyId is not a policy of this platform", 400, { demoPolicyId: body.demoPolicyId });
    if (!demoPolicy.templates.includes(template.templateId)) throw new IntegrationRequestError("template_not_allowed", "The demo policy does not allow this template");
  }
  return { kind: body.kind as "reference" | "demo-instance", templateId: template.templateId, version: template.version, name: body.name, visibility, accessUntil, graceSeconds, ownerSubject, personal, demoPolicy } as const;
}

function parseGrantIssue(body: unknown) {
  if (!isPlainObject(body)) throw new IntegrationRequestError("invalid_request", "Request body must be a JSON object");
  assertOnlyKeys(body, ["role", "purpose", "subject", "displayName", "maxUses", "expiresAt", "returnContext"]);
  if (!["guest", "member", "presenter", "host"].includes(body.role as string)) throw new IntegrationRequestError("invalid_request", "role must be guest, member, presenter or host");
  const role = body.role as ManagedRoomGrantRole;
  // A guest has no subject; a member, presenter or host is a portal account and enters by one visit each time.
  if (role === "guest" ? body.subject !== undefined : typeof body.subject !== "string" || !SUBJECT_PATTERN.test(body.subject)) {
    throw new IntegrationRequestError("invalid_request", role === "guest" ? "A guest grant has no subject" : "A member, presenter or host grant needs an account subject acct_<ULID>");
  }
  if (body.purpose !== "visit" && body.purpose !== "invite") {
    throw new IntegrationRequestError("invalid_request", body.purpose === "preview-review" ? "preview-review grants are not supported by this platform version" : "purpose must be visit or invite");
  }
  if (body.purpose === "invite" && role !== "guest") throw new IntegrationRequestError("invalid_request", "An invite grant is for guests; an account enters with a visit grant");
  const maxUses = body.maxUses ?? 1;
  if (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 50) throw new IntegrationRequestError("invalid_request", "maxUses must be an integer from 1 to 50");
  if (body.purpose === "visit" && maxUses !== 1) throw new IntegrationRequestError("invalid_request", "A visit grant has exactly one use");
  if (body.displayName !== undefined && (typeof body.displayName !== "string" || body.displayName.length < 1 || body.displayName.length > 40)) {
    throw new IntegrationRequestError("invalid_request", "displayName must have 1 to 40 characters");
  }
  const expiresAt = body.expiresAt === undefined ? null : parseTimestamp(body.expiresAt, "expiresAt");
  let returnContext: { kind: string; id: string; locale: string } | null = null;
  if (body.returnContext !== undefined) {
    const context = body.returnContext;
    if (!isPlainObject(context)) throw new IntegrationRequestError("invalid_request", "returnContext must be an object");
    assertOnlyKeys(context, ["kind", "id", "locale"]);
    if (!RETURN_CONTEXT_KINDS.includes(context.kind as string) || typeof context.id !== "string" || !RETURN_CONTEXT_ID_PATTERN.test(context.id)
      || (context.locale !== "ru" && context.locale !== "en")) {
      throw new IntegrationRequestError("invalid_request", "returnContext is not an allowed return target");
    }
    returnContext = { kind: context.kind as string, id: context.id, locale: context.locale };
  }
  return { role, subject: role === "guest" ? null : body.subject as string, purpose: body.purpose, maxUses, expiresAt, displayName: body.displayName as string | undefined, returnContext } as const;
}

function parseClose(body: unknown): { expectedRevision: number; reason: string | null } {
  if (!isPlainObject(body)) throw new IntegrationRequestError("invalid_request", "Request body must be a JSON object");
  assertOnlyKeys(body, ["expectedRevision", "reason"]);
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw new IntegrationRequestError("invalid_request", "expectedRevision must be a non-negative integer");
  }
  return { expectedRevision: body.expectedRevision, reason: parseReason(body.reason) };
}

function parseReason(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 200) throw new IntegrationRequestError("invalid_request", "reason must have at most 200 characters");
  return value;
}

function blockError(reason: ManagedRoomBlockReason): IntegrationRequestError {
  const message = reason === "room_closed" ? "Room is closed" : reason === "access_expired" ? "Room access has expired" : "Room is paused";
  return new IntegrationRequestError(reason, message);
}

function parseAccessUpdate(body: unknown): { expectedRevision: number; patch: ManagedRoomAccessPatch; reason?: string } {
  if (!isPlainObject(body)) throw new IntegrationRequestError("invalid_request", "Request body must be a JSON object");
  assertOnlyKeys(body, ["expectedRevision", "accessUntil", "graceSeconds", "status", "reason"]);
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw new IntegrationRequestError("invalid_request", "expectedRevision must be a non-negative integer");
  }
  if (body.accessUntil === undefined && body.graceSeconds === undefined && body.status === undefined) {
    throw new IntegrationRequestError("invalid_request", "Change accessUntil, graceSeconds or status");
  }
  if (body.status !== undefined && body.status !== "active" && body.status !== "paused") throw new IntegrationRequestError("invalid_request", "status must be active or paused");
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 200)) throw new IntegrationRequestError("invalid_request", "reason must have at most 200 characters");
  return {
    expectedRevision: body.expectedRevision,
    patch: {
      ...(body.accessUntil === undefined ? {} : { accessUntil: parseTimestamp(body.accessUntil, "accessUntil") }),
      ...(body.graceSeconds === undefined ? {} : { graceSeconds: parseGraceSeconds(body.graceSeconds) }),
      ...(body.status === undefined ? {} : { status: body.status })
    },
    ...(typeof body.reason === "string" ? { reason: body.reason } : {})
  };
}

function templateFailureCode(error: unknown): IntegrationRequestError | null {
  const known = templateInputError(error);
  if (!known) return null;
  return ["deprecated_template", "template_version_not_current", "unknown_template", "unknown_template_version"].includes(known.code)
    ? new IntegrationRequestError("template_not_allowed", `Template is not available: ${known.code}`)
    : new IntegrationRequestError("invalid_request", `Template configuration rejected: ${known.code}`);
}

export function createIntegrationRoutes(context: IntegrationRoutesContext) {
  const leaseSeconds = context.operationLeaseSeconds ?? OPERATION_LEASE_SECONDS;
  async function authenticate(request: IncomingMessage, storage: Storage, scope: IntegrationScope): Promise<IntegrationPrincipal> {
    let keyring;
    try {
      keyring = loadIntegrationKeyring();
    } catch (error) {
      context.logEvent({ service: "api", event: "integration_config_invalid", message: error instanceof Error ? error.message : "unknown" });
      throw new IntegrationRequestError("dependency_unavailable", "Integration API is not configured", 503, undefined, true);
    }
    if (keyring.size === 0) throw new IntegrationRequestError("dependency_unavailable", "Integration API is not configured", 503, undefined, true);
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && /^bearer /i.test(authorization) ? authorization.slice(7).trim() : null;
    const verified = verifyIntegrationAssertion(token, keyring);
    if (!verified.ok) throw new IntegrationRequestError("unauthenticated", "Service assertion rejected", 401, { reason: verified.reason });
    const fresh = await storage.recordIntegrationAssertion(verified.value.principal, verified.value.jti, new Date(verified.value.replayUntilSeconds * 1000).toISOString());
    if (!fresh) throw new IntegrationRequestError("unauthenticated", "Service assertion rejected", 401, { reason: "replayed_jti" });
    if (!verified.value.scopes.has(scope)) throw new IntegrationRequestError("forbidden_scope", `Scope ${scope} is required`, 403, { scope });
    return verified.value;
  }

  async function requireTenant(storage: Storage, principal: IntegrationPrincipal, tenantId: string): Promise<void> {
    const tenant = await storage.getIntegrationTenant(tenantId);
    if (!tenant || tenant.managedBy !== principal.principal) throw new IntegrationRequestError("tenant_mismatch", "Tenant is not managed by this principal");
  }

  async function requireRoom(storage: Storage, principal: IntegrationPrincipal, tenantId: string, roomId: string): Promise<RoomRecord> {
    if (!UUID_PATTERN.test(roomId)) throw new IntegrationRequestError("invalid_request", "roomId must be a UUID");
    const room = await storage.getRoom(roomId);
    if (!room?.managed || room.tenantId !== tenantId || room.managed.managedBy !== principal.principal) throw new IntegrationRequestError("room_not_found", "Room not found");
    return room;
  }

  function requireIdempotencyKey(request: IncomingMessage): string {
    const value = request.headers["idempotency-key"];
    if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) throw new IntegrationRequestError("invalid_request", "Idempotency-Key header is required");
    return value;
  }

  async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    try {
      return await parseBody<unknown>(request);
    } catch {
      throw new IntegrationRequestError("invalid_request", "Request body must be JSON of at most 64 KiB");
    }
  }

  // Runs a mutation once per (principal, Idempotency-Key): a replay returns the stored response,
  // and a retry after a crash re-enters the same operation with the same pre-assigned resource id.
  async function runOperation(
    response: ServerResponse,
    storage: Storage,
    input: { principal: IntegrationPrincipal; idempotencyKey: string; kind: string; requestHash: string; resourceType: string; resourceId: string; requestId: string },
    execute: (operation: IntegrationOperationRecord) => Promise<ExecutionResult>
  ): Promise<void> {
    const begun = await storage.beginIntegrationOperation({
      operationId: randomUUID(),
      principal: input.principal.principal,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      requestHash: input.requestHash,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      leaseSeconds
    });
    let operation = begun.operation;
    if (!begun.created) {
      if (operation.requestHash !== input.requestHash) throw new IntegrationRequestError("idempotency_key_reused", "Idempotency-Key was used with another request", 409, { operationId: operation.operationId });
      if (operation.state !== "running") {
        response.setHeader("idempotency-replayed", "true");
        return json(response, operation.responseStatus ?? 200, operation.responseBody);
      }
      const claimed = await storage.claimIntegrationOperation(operation.operationId, leaseSeconds);
      if (!claimed) throw new IntegrationRequestError("idempotency_in_progress", "Operation is in progress", 409, { operationId: operation.operationId }, true);
      operation = claimed;
    }
    let result: ExecutionResult;
    try {
      result = await execute(operation);
    } catch (error) {
      if (error instanceof IntegrationRequestError) {
        result = failure(error, input.requestId);
      } else {
        await storage.releaseIntegrationOperation(operation.operationId).catch(() => undefined);
        throw error;
      }
    }
    try {
      await storage.completeIntegrationOperation(operation.operationId, {
        state: result.error ? "failed" : "succeeded",
        resultRevision: result.revision ?? null,
        error: result.error ?? null,
        responseStatus: result.status,
        responseBody: result.body
      });
    } catch (error) {
      // The effect is committed; a retry with the same key re-enters this operation and finds it.
      await storage.releaseIntegrationOperation(operation.operationId).catch(() => undefined);
      throw error;
    }
    context.logEvent({ service: "api", event: "integration_operation", requestId: input.requestId, principal: input.principal.principal, kind: input.kind, operationId: operation.operationId, resourceId: input.resourceId, status: result.status, code: result.error?.code });
    json(response, result.status, result.firstBody ?? result.body);
  }

  async function upsertTenant(request: IncomingMessage, response: ServerResponse, storage: Storage, principal: IntegrationPrincipal, tenantId: string, requestId: string): Promise<void> {
    const idempotencyKey = requireIdempotencyKey(request);
    const body = await readJsonBody(request);
    if (!isPlainObject(body)) throw new IntegrationRequestError("invalid_request", "Request body must be a JSON object");
    assertOnlyKeys(body, ["displayName"]);
    if (typeof body.displayName !== "string" || body.displayName.length < 1 || body.displayName.length > 80) throw new IntegrationRequestError("invalid_request", "displayName must have 1 to 80 characters");
    const displayName = body.displayName;
    await runOperation(response, storage, {
      principal, idempotencyKey, kind: "tenant.upsert", requestHash: integrationRequestHash("PUT", `/integration/v1/tenants/${tenantId}`, body), resourceType: "tenant", resourceId: tenantId, requestId
    }, async () => {
      const tenant = await storage.upsertIntegrationTenant({ tenantId, managedBy: principal.principal, displayName });
      if (tenant === "tenant_mismatch") throw new IntegrationRequestError("tenant_mismatch", "Tenant exists and is not managed by this principal");
      return { status: 200, revision: tenant.revision, body: { tenantId: tenant.tenantId, managedBy: tenant.managedBy, revision: tenant.revision } };
    });
  }

  async function createRoom(request: IncomingMessage, response: ServerResponse, storage: Storage, principal: IntegrationPrincipal, tenantId: string, requestId: string): Promise<void> {
    const idempotencyKey = requireIdempotencyKey(request);
    const body = await readJsonBody(request);
    let policies: ReadonlyMap<string, DemoPolicy>;
    try {
      policies = loadDemoPolicies();
    } catch (error) {
      context.logEvent({ service: "api", event: "integration_config_invalid", message: error instanceof Error ? error.message : "unknown" });
      throw new IntegrationRequestError("dependency_unavailable", "Demo policies are not configured", 503, undefined, true);
    }
    const parsed = parseRoomCreate(body, policies);
    await requireTenant(storage, principal, tenantId);
    await runOperation(response, storage, {
      principal, idempotencyKey, kind: "room.create", requestHash: integrationRequestHash("POST", `/integration/v1/tenants/${tenantId}/rooms`, body), resourceType: "room", resourceId: randomUUID(), requestId
    }, async (operation) => {
      const roomId = operation.resourceId!;
      const created = (room: RoomRecord): ExecutionResult => ({ status: 201, revision: room.managed!.revision, body: serializeManagedRoom(room) });
      // The resource id belongs to this operation only, so an existing room means an earlier attempt committed it.
      const existing = await storage.getRoom(roomId);
      if (existing?.managed) return created(existing);
      // Checked here, not while parsing: a replay after accessUntil must still return the recorded result.
      if (Date.parse(parsed.accessUntil) <= Date.now()) throw new IntegrationRequestError("invalid_request", "accessUntil must be in the future");
      if (parsed.demoPolicy && Date.parse(parsed.accessUntil) > Date.now() + parsed.demoPolicy.absoluteLifetimeSeconds * 1000 + DEMO_LIFETIME_SKEW_MS) {
        throw new IntegrationRequestError("invalid_request", "accessUntil exceeds the demo policy lifetime", 400, { absoluteLifetimeSeconds: parsed.demoPolicy.absoluteLifetimeSeconds });
      }
      let resolved;
      try {
        resolved = await resolveRoomTemplateCreate(storage, {
          roomId,
          tenantId,
          templateId: parsed.templateId,
          templateVersion: parsed.version,
          name: parsed.name,
          roomType: parsed.personal ? "personal" : "standard",
          visibility: parsed.visibility,
          guestAllowed: !parsed.personal && parsed.visibility === "unlisted"
          // The owner is the account of ownerSubject (managed metadata), admitted by a grant: no participant id string
          // stands in for it, so the manifest and session control never show the subject.
        }, { allowUnownedPersonal: parsed.personal });
      } catch (error) {
        throw templateFailureCode(error) ?? error;
      }
      if (!referenceTemplateContract(resolved.version)) throw new IntegrationRequestError("template_not_allowed", "Template is not a reference template");
      try {
        const demo = parsed.demoPolicy;
        return created(await storage.createManagedRoom(resolved.input, {
          managedBy: principal.principal, kind: parsed.kind, accessUntil: parsed.accessUntil, graceSeconds: parsed.graceSeconds, ownerSubject: parsed.ownerSubject ?? null, operationId: operation.operationId,
          ...(demo ? { demoPolicyId: demo.policyId, maxParticipants: demo.maxParticipants, idleTimeoutSeconds: demo.idleTimeoutSeconds, features: demo.features } : {})
        }));
      } catch (error) {
        if (error instanceof Error && error.message === "managed_room_exists") {
          const raced = await storage.getRoom(roomId);
          if (raced?.managed) return created(raced);
        }
        throw templateFailureCode(error) ?? error;
      }
    });
  }

  async function updateRoomAccess(request: IncomingMessage, response: ServerResponse, storage: Storage, principal: IntegrationPrincipal, tenantId: string, roomId: string, requestId: string): Promise<void> {
    const idempotencyKey = requireIdempotencyKey(request);
    const body = await readJsonBody(request);
    const parsed = parseAccessUpdate(body);
    await requireTenant(storage, principal, tenantId);
    await requireRoom(storage, principal, tenantId, roomId);
    await runOperation(response, storage, {
      principal, idempotencyKey, kind: "room.access.update", requestHash: integrationRequestHash("PATCH", `/integration/v1/tenants/${tenantId}/rooms/${roomId}/access`, body), resourceType: "room", resourceId: roomId, requestId
    }, async (operation) => {
      const done = (room: RoomRecord): ExecutionResult => ({ status: 200, revision: room.managed!.revision, body: serializeManagedRoom(room) });
      const current = await requireRoom(storage, principal, tenantId, roomId);
      if (current.managed!.lastOperationId === operation.operationId) return done(current);
      const updated = await storage.updateManagedRoomAccess(roomId, parsed.expectedRevision, parsed.patch, operation.operationId);
      if (updated === "revision_mismatch") {
        const latest = await storage.getRoom(roomId);
        throw new IntegrationRequestError("revision_mismatch", "Room revision changed", 409, { currentRevision: latest?.managed?.revision ?? null });
      }
      if (updated === "room_closed") throw blockError("room_closed");
      if (!updated) throw new IntegrationRequestError("room_not_found", "Room not found");
      context.logEvent({ service: "api", event: "integration_room_access_updated", requestId, roomId, revision: updated.managed!.revision, reason: parsed.reason ?? null });
      context.accessChanged?.(roomId);
      return done(updated);
    });
  }

  async function closeRoom(request: IncomingMessage, response: ServerResponse, storage: Storage, principal: IntegrationPrincipal, tenantId: string, roomId: string, requestId: string): Promise<void> {
    const idempotencyKey = requireIdempotencyKey(request);
    const body = await readJsonBody(request);
    const parsed = parseClose(body);
    await requireTenant(storage, principal, tenantId);
    await requireRoom(storage, principal, tenantId, roomId);
    await runOperation(response, storage, {
      principal, idempotencyKey, kind: "room.close", requestHash: integrationRequestHash("POST", `/integration/v1/tenants/${tenantId}/rooms/${roomId}/close`, body), resourceType: "room", resourceId: roomId, requestId
    }, async (operation) => {
      // Closing is terminal and idempotent: a closed room answers with its tombstone whatever revision is sent.
      const closed = await storage.closeManagedRoom(roomId, parsed.expectedRevision, parsed.reason, operation.operationId);
      if (closed === "revision_mismatch") {
        const latest = await storage.getRoom(roomId);
        throw new IntegrationRequestError("revision_mismatch", "Room revision changed", 409, { currentRevision: latest?.managed?.revision ?? null });
      }
      if (!closed) throw new IntegrationRequestError("room_not_found", "Room not found");
      context.logEvent({ service: "api", event: "integration_room_closed", requestId, roomId, revision: closed.managed!.revision, reason: parsed.reason });
      context.accessChanged?.(roomId);
      return { status: 200, revision: closed.managed!.revision, body: serializeManagedRoom(closed) };
    });
  }

  async function issueGrant(request: IncomingMessage, response: ServerResponse, storage: Storage, principal: IntegrationPrincipal, tenantId: string, roomId: string, requestId: string): Promise<void> {
    const idempotencyKey = requireIdempotencyKey(request);
    const body = await readJsonBody(request);
    const parsed = parseGrantIssue(body);
    await requireTenant(storage, principal, tenantId);
    const room = await requireRoom(storage, principal, tenantId, roomId);
    if (room.roomType === "personal" && (parsed.role === "guest" || parsed.subject !== room.managed?.ownerSubject)) {
      throw new IntegrationRequestError("invalid_request", parsed.role === "guest" ? "A personal room admits no guests" : "A personal room admits only its owner");
    }
    const secret = context.stateSecret?.();
    const runtimeBaseUrl = process.env.RUNTIME_BASE_URL;
    if (!secret || !grantEntryUrl(runtimeBaseUrl, roomId, "probe")) {
      throw new IntegrationRequestError("dependency_unavailable", "Grant issuing is not configured", 503, undefined, true);
    }
    await runOperation(response, storage, {
      principal, idempotencyKey, kind: "grant.issue", requestHash: integrationRequestHash("POST", `/integration/v1/tenants/${tenantId}/rooms/${roomId}/grants`, body), resourceType: "grant", resourceId: randomUUID(), requestId
    }, async (operation) => {
      const grantId = operation.resourceId!;
      // The code of an earlier attempt is gone with its response; the grant comes back without it and the portal replaces it.
      const existing = await storage.getManagedRoomGrant(grantId);
      if (existing) return { status: 201, revision: existing.revision, body: serializeManagedGrant(existing) };
      const expiresAt = parsed.expiresAt ?? new Date(Date.now() + MAX_ACCESS_HORIZON_MS).toISOString();
      if (Date.parse(expiresAt) <= Date.now()) throw new IntegrationRequestError("invalid_request", "expiresAt must be in the future");
      const code = createGrantCode();
      const issued = await storage.issueManagedRoomGrant({
        grantId, roomId, role: parsed.role, subject: parsed.subject, purpose: parsed.purpose, maxUses: parsed.maxUses, expiresAt, codeHash: grantCodeHash(secret, code),
        displayName: parsed.displayName ?? null, returnContext: parsed.returnContext, operationId: operation.operationId
      });
      if (!issued) throw new IntegrationRequestError("room_not_found", "Room not found");
      if (typeof issued === "string") throw blockError(issued);
      context.logEvent({ service: "api", event: "integration_grant_issued", requestId, roomId, grantId, role: issued.role, purpose: issued.purpose, maxUses: issued.maxUses });
      return { status: 201, revision: issued.revision, body: serializeManagedGrant(issued), firstBody: serializeManagedGrant(issued, grantEntryUrl(runtimeBaseUrl, roomId, code)!) };
    });
  }

  async function revokeGrant(request: IncomingMessage, response: ServerResponse, storage: Storage, principal: IntegrationPrincipal, tenantId: string, roomId: string, grantId: string, requestId: string): Promise<void> {
    const idempotencyKey = requireIdempotencyKey(request);
    const body = await readJsonBody(request);
    if (!isPlainObject(body)) throw new IntegrationRequestError("invalid_request", "Request body must be a JSON object");
    assertOnlyKeys(body, ["reason"]);
    const reason = parseReason(body.reason);
    if (!UUID_PATTERN.test(grantId)) throw new IntegrationRequestError("invalid_request", "grantId must be a UUID");
    await requireTenant(storage, principal, tenantId);
    await requireRoom(storage, principal, tenantId, roomId);
    await runOperation(response, storage, {
      principal, idempotencyKey, kind: "grant.revoke", requestHash: integrationRequestHash("POST", `/integration/v1/tenants/${tenantId}/rooms/${roomId}/grants/${grantId}/revoke`, body), resourceType: "grant", resourceId: grantId, requestId
    }, async (operation) => {
      const grant = await storage.getManagedRoomGrant(grantId);
      if (!grant || grant.roomId !== roomId) throw new IntegrationRequestError("grant_invalid", "Grant not found");
      const revoked = (await storage.revokeManagedRoomGrant(grantId, reason, operation.operationId))!;
      // Everyone who entered with the grant loses the identity; if this stops halfway, the enforcer finishes it.
      await completeGrantRevocation(storage, revoked);
      context.logEvent({ service: "api", event: "integration_grant_revoked", requestId, roomId, grantId, reason });
      context.accessChanged?.(roomId);
      return { status: 200, revision: revoked.revision, body: serializeManagedGrant(revoked) };
    });
  }

  async function readUsage(response: ServerResponse, storage: Storage, principal: IntegrationPrincipal, tenantId: string, url: URL): Promise<void> {
    const day = url.searchParams.get("day");
    if (!day || !DAY_PATTERN.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
      throw new IntegrationRequestError("invalid_request", "day must be a date YYYY-MM-DD");
    }
    await requireTenant(storage, principal, tenantId);
    const usage = await storage.getIntegrationUsage(tenantId, day);
    return json(response, 200, { tenantId, day, participantSeconds: usage.participantSeconds, ...(usage.updatedAt ? { updatedAt: usage.updatedAt } : {}) });
  }

  async function route(request: IncomingMessage, response: ServerResponse, method: string, url: URL, storage: Storage, requestId: string): Promise<void> {
    const tenantMatch = url.pathname.match(/^\/integration\/v1\/tenants\/([^/]+)(?:\/(usage)|\/rooms(?:\/([^/]+)(?:\/(access|close|grants)(?:\/([^/]+)\/(revoke))?)?)?)?$/);
    const operationMatch = url.pathname.match(/^\/integration\/v1\/operations(?:\/([^/]+))?$/);
    if (tenantMatch) {
      const tenantId = decodeURIComponent(tenantMatch[1]!);
      const usage = tenantMatch[2] === "usage";
      const hasRooms = url.pathname.includes("/rooms");
      const roomId = tenantMatch[3] === undefined ? null : decodeURIComponent(tenantMatch[3]);
      const action = tenantMatch[4];
      const grantId = tenantMatch[5] === undefined ? null : decodeURIComponent(tenantMatch[5]);
      const operation: IntegrationScope | null = usage ? (method === "GET" ? "getUsage" : null)
        : !hasRooms ? (method === "PUT" ? "upsertTenant" : null)
          : roomId === null ? (method === "POST" ? "createRoom" : null)
            : action === "access" ? (method === "PATCH" ? "updateRoomAccess" : null)
              : action === "close" ? (method === "POST" ? "closeRoom" : null)
                : action === "grants" ? (method === "POST" ? (grantId === null ? "issueGrant" : "revokeGrant") : null)
                  : method === "GET" ? "getRoom" : null;
      if (!operation) throw new IntegrationRequestError("invalid_request", "Unsupported integration route", 404);
      const principal = await authenticate(request, storage, operation);
      if (!TENANT_ID_PATTERN.test(tenantId)) throw new IntegrationRequestError("invalid_request", "tenantId must be a portal tenant id");
      if (operation === "upsertTenant") return upsertTenant(request, response, storage, principal, tenantId, requestId);
      if (operation === "createRoom") return createRoom(request, response, storage, principal, tenantId, requestId);
      if (operation === "updateRoomAccess") return updateRoomAccess(request, response, storage, principal, tenantId, roomId!, requestId);
      if (operation === "closeRoom") return closeRoom(request, response, storage, principal, tenantId, roomId!, requestId);
      if (operation === "issueGrant") return issueGrant(request, response, storage, principal, tenantId, roomId!, requestId);
      if (operation === "revokeGrant") return revokeGrant(request, response, storage, principal, tenantId, roomId!, grantId!, requestId);
      if (operation === "getUsage") return readUsage(response, storage, principal, tenantId, url);
      await requireTenant(storage, principal, tenantId);
      return json(response, 200, serializeManagedRoom(await requireRoom(storage, principal, tenantId, roomId!)));
    }
    if (operationMatch && method === "GET") {
      const operationId = operationMatch[1] === undefined ? null : decodeURIComponent(operationMatch[1]);
      const principal = await authenticate(request, storage, operationId === null ? "findOperation" : "getOperation");
      let operation: IntegrationOperationRecord | null;
      if (operationId === null) {
        const idempotencyKey = url.searchParams.get("idempotencyKey");
        if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) throw new IntegrationRequestError("invalid_request", "idempotencyKey query parameter is required");
        operation = await storage.findIntegrationOperation(principal.principal, idempotencyKey);
      } else {
        if (!UUID_PATTERN.test(operationId)) throw new IntegrationRequestError("invalid_request", "operationId must be a UUID");
        operation = await storage.getIntegrationOperation(principal.principal, operationId);
      }
      if (!operation) throw new IntegrationRequestError("invalid_request", "Operation not found", 404);
      return json(response, 200, serializeIntegrationOperation(operation));
    }
    throw new IntegrationRequestError("invalid_request", "Unsupported integration route", 404);
  }

  // An unmatched request falls through synchronously; only a matched route starts work.
  return function routeIntegrationRequest(request: IncomingMessage, response: ServerResponse, method: string, url: URL, storage: Storage): Promise<void> | null {
    if (url.pathname !== "/integration" && !url.pathname.startsWith("/integration/")) return null;
    return (async () => {
      if (!isPortalManagedDeployment()) return json(response, 404, { error: "not_found", path: url.pathname });
      const requestId = context.getRequestId(request);
      try {
        await route(request, response, method, url, storage, requestId);
      } catch (error) {
        if (response.headersSent) throw error;
        if (error instanceof IntegrationRequestError) {
          if (error.status === 401 || error.status === 403) {
            context.logEvent({ service: "api", event: "integration_request_denied", requestId, path: url.pathname, code: error.code, reason: error.details?.reason });
          }
          return json(response, error.status, { error: errorObject(error, requestId) });
        }
        context.logEvent({ service: "api", event: "integration_request_failed", requestId, path: url.pathname, message: error instanceof Error ? error.message : "unknown" });
        return json(response, 503, { error: errorObject(new IntegrationRequestError("dependency_unavailable", "Platform could not complete the request", 503, undefined, true), requestId) });
      }
    })();
  };
}
