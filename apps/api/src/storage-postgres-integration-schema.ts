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
  // Demo instances, grants, close and media epochs (T08). A close also moves access_until to the close time,
  // so a build that does not know the closed status still treats the room as expired.
  await client.query(`
      alter table integration_rooms
        add column if not exists access_epoch uuid not null default gen_random_uuid(),
        add column if not exists closed_at timestamptz,
        add column if not exists close_reason text,
        add column if not exists demo_policy_id text,
        add column if not exists max_participants integer,
        add column if not exists idle_timeout_seconds integer,
        add column if not exists features jsonb,
        add column if not exists enforced_block text,
        add column if not exists retired_epochs uuid[] not null default '{}',
        add column if not exists rotate_requested_at timestamptz,
        add column if not exists last_activity_at timestamptz
    `);
  await client.query(`
      create table if not exists integration_grants (
        grant_id uuid primary key,
        room_id text not null references integration_rooms(room_id),
        tenant_id text not null references tenants(tenant_id),
        code_hash text not null unique,
        role text not null,
        purpose text not null,
        max_uses integer not null check (max_uses between 1 and 50),
        used_count integer not null default 0 check (used_count >= 0 and used_count <= max_uses),
        expires_at timestamptz not null,
        revoked_at timestamptz,
        revoke_reason text,
        display_name text,
        return_context jsonb,
        revision integer not null default 1,
        last_operation_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
  await client.query(`create index if not exists integration_grants_room_idx on integration_grants (room_id)`);
  // A revoke is complete once every identity of the grant is revoked and the media epoch rotation is asked for.
  await client.query(`alter table integration_grants add column if not exists revocation_completed_at timestamptz`);
  // The portal account of a member, presenter or host grant (T12); guest grants have none. Older builds ignore it.
  await client.query(`alter table integration_grants add column if not exists subject text`);
  await client.query(`create index if not exists integration_grants_subject_idx on integration_grants (room_id, subject) where subject is not null`);
  await client.query(`
      create table if not exists integration_grant_identities (
        grant_id uuid not null references integration_grants(grant_id),
        identity_id text not null,
        created_at timestamptz not null default now(),
        primary key (grant_id, identity_id)
      )
    `);
  await client.query(`
      create table if not exists integration_usage (
        tenant_id text not null references tenants(tenant_id),
        day date not null,
        participant_seconds bigint not null default 0,
        updated_at timestamptz not null default now(),
        primary key (tenant_id, day)
      )
    `);
  await client.query(`create index if not exists integration_rooms_open_idx on integration_rooms (access_until) where enforced_block is null`);
  // A closed room stays closed and expired whichever build writes it: a rollback build that does not know
  // the closed status can neither reopen it nor extend its window.
  await client.query(`
      create or replace function integration_rooms_closed_terminal() returns trigger language plpgsql as $$
      begin
        if old.status = 'closed' and (new.status is distinct from 'closed' or new.access_until > old.access_until
            or new.grace_seconds > old.grace_seconds) then
          raise exception 'managed_room_closed' using errcode = 'check_violation';
        end if;
        return new;
      end $$
    `);
  await client.query(`
      create or replace trigger integration_rooms_closed_terminal before update on integration_rooms
        for each row execute function integration_rooms_closed_terminal()
    `);
}
