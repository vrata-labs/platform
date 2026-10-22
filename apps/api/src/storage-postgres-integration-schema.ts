import type { PoolClient } from "pg";

// Additive tables of the portal integration API (platform-integration-v1). Older builds ignore them,
// and the restrictive foreign keys keep managed tenants and room ids from being deleted and reused.
export async function ensureIntegrationStorageSchema(client: PoolClient): Promise<void> {
  await client.query(`
      create table if not exists integration_tenants (
        tenant_id text primary key references tenants(tenant_id),
        managed_by text not null,
        display_name text not null,
        revision integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
  await client.query(`
      create table if not exists integration_rooms (
        room_id text primary key references rooms(room_id),
        tenant_id text not null references tenants(tenant_id),
        managed_by text not null,
        kind text not null,
        status text not null default 'active',
        access_until timestamptz not null,
        grace_seconds integer not null default 0,
        revision integer not null default 0,
        owner_subject text,
        last_operation_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
  await client.query(`
      create table if not exists integration_operations (
        operation_id text primary key,
        principal text not null,
        idempotency_key text not null,
        kind text not null,
        request_hash text not null,
        state text not null,
        resource_type text,
        resource_id text,
        result_revision integer,
        error jsonb,
        response_status integer,
        response_body jsonb,
        lease_until timestamptz not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint integration_operations_principal_key_unique unique (principal, idempotency_key)
      )
    `);
  await client.query(`
      create table if not exists integration_assertions (
        principal text not null,
        jti text not null,
        expires_at timestamptz not null,
        primary key (principal, jti)
      )
    `);
  await client.query(`create index if not exists integration_assertions_expires_idx on integration_assertions (expires_at)`);
  await client.query(`create index if not exists integration_rooms_tenant_idx on integration_rooms (tenant_id)`);
}
