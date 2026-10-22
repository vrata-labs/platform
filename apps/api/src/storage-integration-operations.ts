import type { Pool } from "pg";

import type {
  IntegrationErrorObject,
  IntegrationOperationOutcome,
  IntegrationOperationRecord,
  IntegrationOperationStart,
  IntegrationOperationState
} from "./storage-contracts.js";
import { isoString } from "./storage-row-mappers.js";

const ASSERTION_CLEANUP_INTERVAL_MS = 60_000;

function operationKey(principal: string, value: string): string {
  return `${principal}\u0000${value}`;
}

// Single-process operation and assertion records; every method completes without yielding, so it is atomic.
export class MemoryIntegrationOperations {
  private operations = new Map<string, IntegrationOperationRecord>();
  private operationIdsByKey = new Map<string, string>();
  private assertions = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async begin(input: IntegrationOperationStart): Promise<{ created: boolean; operation: IntegrationOperationRecord }> {
    const key = operationKey(input.principal, input.idempotencyKey);
    const existingId = this.operationIdsByKey.get(key);
    if (existingId) return { created: false, operation: structuredClone(this.operations.get(existingId)!) };
    const timestamp = new Date(this.now()).toISOString();
    const operation: IntegrationOperationRecord = {
      operationId: input.operationId,
      principal: input.principal,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      requestHash: input.requestHash,
      state: "running",
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resultRevision: null,
      error: null,
      responseStatus: null,
      responseBody: null,
      leaseUntil: new Date(this.now() + input.leaseSeconds * 1000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.operations.set(operation.operationId, operation);
    this.operationIdsByKey.set(key, operation.operationId);
    return { created: true, operation: structuredClone(operation) };
  }

  async claim(operationId: string, leaseSeconds: number): Promise<IntegrationOperationRecord | null> {
    const operation = this.operations.get(operationId);
    if (!operation || operation.state !== "running" || Date.parse(operation.leaseUntil) > this.now()) return null;
    operation.leaseUntil = new Date(this.now() + leaseSeconds * 1000).toISOString();
    operation.updatedAt = new Date(this.now()).toISOString();
    return structuredClone(operation);
  }

  async complete(operationId: string, outcome: IntegrationOperationOutcome): Promise<IntegrationOperationRecord | null> {
    const operation = this.operations.get(operationId);
    if (!operation) return null;
    Object.assign(operation, {
      state: outcome.state,
      resultRevision: outcome.resultRevision ?? null,
      error: outcome.error ?? null,
      responseStatus: outcome.responseStatus,
      responseBody: structuredClone(outcome.responseBody),
      leaseUntil: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString()
    });
    return structuredClone(operation);
  }

  async release(operationId: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (operation?.state === "running") operation.leaseUntil = new Date(this.now()).toISOString();
  }

  async get(principal: string, operationId: string): Promise<IntegrationOperationRecord | null> {
    const operation = this.operations.get(operationId);
    return operation && operation.principal === principal ? structuredClone(operation) : null;
  }

  async find(principal: string, idempotencyKey: string): Promise<IntegrationOperationRecord | null> {
    const operationId = this.operationIdsByKey.get(operationKey(principal, idempotencyKey));
    return operationId ? structuredClone(this.operations.get(operationId)!) : null;
  }

  async recordAssertion(principal: string, jti: string, expiresAt: string): Promise<boolean> {
    const now = this.now();
    for (const [key, expiry] of this.assertions) {
      if (expiry <= now) this.assertions.delete(key);
    }
    const key = operationKey(principal, jti);
    if (this.assertions.has(key)) return false;
    this.assertions.set(key, Date.parse(expiresAt));
    return true;
  }
}

interface IntegrationOperationRow {
  operation_id: string;
  principal: string;
  idempotency_key: string;
  kind: string;
  request_hash: string;
  state: IntegrationOperationState;
  resource_type: string | null;
  resource_id: string | null;
  result_revision: number | null;
  error: IntegrationErrorObject | null;
  response_status: number | null;
  response_body: unknown;
  lease_until: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
}

export function mapIntegrationOperationRow(row: IntegrationOperationRow): IntegrationOperationRecord {
  return {
    operationId: row.operation_id,
    principal: row.principal,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    requestHash: row.request_hash,
    state: row.state,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resultRevision: row.result_revision,
    error: row.error,
    responseStatus: row.response_status,
    responseBody: row.response_body ?? null,
    leaseUntil: isoString(row.lease_until)!,
    createdAt: isoString(row.created_at)!,
    updatedAt: isoString(row.updated_at)!
  };
}

export class PostgresIntegrationOperations {
  private lastAssertionCleanupAt = 0;

  constructor(private readonly pool: Pool) {}

  async begin(input: IntegrationOperationStart): Promise<{ created: boolean; operation: IntegrationOperationRecord }> {
    const inserted = await this.pool.query(
      `insert into integration_operations (operation_id, principal, idempotency_key, kind, request_hash, state, resource_type, resource_id, lease_until)
       values ($1,$2,$3,$4,$5,'running',$6,$7, now() + make_interval(secs => $8))
       on conflict (principal, idempotency_key) do nothing
       returning *`,
      [input.operationId, input.principal, input.idempotencyKey, input.kind, input.requestHash, input.resourceType, input.resourceId, input.leaseSeconds]
    );
    if (inserted.rows[0]) return { created: true, operation: mapIntegrationOperationRow(inserted.rows[0]) };
    const existing = await this.find(input.principal, input.idempotencyKey);
    if (!existing) throw new Error("integration_operation_conflict_without_row");
    return { created: false, operation: existing };
  }

  async claim(operationId: string, leaseSeconds: number): Promise<IntegrationOperationRecord | null> {
    const result = await this.pool.query(
      `update integration_operations set lease_until = now() + make_interval(secs => $2), updated_at = now()
       where operation_id = $1 and state = 'running' and lease_until <= now()
       returning *`,
      [operationId, leaseSeconds]
    );
    return result.rows[0] ? mapIntegrationOperationRow(result.rows[0]) : null;
  }

  async complete(operationId: string, outcome: IntegrationOperationOutcome): Promise<IntegrationOperationRecord | null> {
    const result = await this.pool.query(
      `update integration_operations
          set state = $2, result_revision = $3, error = $4::jsonb, response_status = $5, response_body = $6::jsonb,
              lease_until = now(), updated_at = now()
        where operation_id = $1
        returning *`,
      [operationId, outcome.state, outcome.resultRevision ?? null, outcome.error ? JSON.stringify(outcome.error) : null, outcome.responseStatus, JSON.stringify(outcome.responseBody ?? null)]
    );
    return result.rows[0] ? mapIntegrationOperationRow(result.rows[0]) : null;
  }

  async release(operationId: string): Promise<void> {
    await this.pool.query(`update integration_operations set lease_until = now() where operation_id = $1 and state = 'running'`, [operationId]);
  }

  async get(principal: string, operationId: string): Promise<IntegrationOperationRecord | null> {
    const result = await this.pool.query(`select * from integration_operations where operation_id = $1 and principal = $2`, [operationId, principal]);
    return result.rows[0] ? mapIntegrationOperationRow(result.rows[0]) : null;
  }

  async find(principal: string, idempotencyKey: string): Promise<IntegrationOperationRecord | null> {
    const result = await this.pool.query(`select * from integration_operations where principal = $1 and idempotency_key = $2`, [principal, idempotencyKey]);
    return result.rows[0] ? mapIntegrationOperationRow(result.rows[0]) : null;
  }

  async recordAssertion(principal: string, jti: string, expiresAt: string): Promise<boolean> {
    if (Date.now() - this.lastAssertionCleanupAt > ASSERTION_CLEANUP_INTERVAL_MS) {
      this.lastAssertionCleanupAt = Date.now();
      await this.pool.query(`delete from integration_assertions where expires_at < now() - interval '5 minutes'`);
    }
    const result = await this.pool.query(
      `insert into integration_assertions (principal, jti, expires_at) values ($1,$2,$3) on conflict (principal, jti) do nothing`,
      [principal, jti, expiresAt]
    );
    return (result.rowCount ?? 0) === 1;
  }
}
