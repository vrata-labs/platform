import type { PoolClient } from "pg";

const DEFAULT_AVATAR_CONFIG_JSON = '{"avatarsEnabled":true,"avatarCatalogUrl":"/assets/avatars/catalog.v1.json","avatarQualityProfile":"desktop-standard","avatarFallbackCapsulesEnabled":true,"avatarSeatsEnabled":true}' as const;
export const DEFAULT_SESSION_CONTROL_JSON = '{"hostParticipantId":null,"presenterParticipantId":null,"presenterGrantedAt":null,"presenterGrantedBy":null,"presenterRevokedAt":null,"presenterRevokedBy":null,"lockedAt":null,"lockedBy":null,"endedAt":null,"endedBy":null,"removedParticipants":{}}' as const;
export const DEFAULT_PERSONAL_STATE_JSON = '{}' as const;

// Keep the SQL text and execution order compatible with existing installations.
export async function ensurePostgresStorageSchema(client: PoolClient): Promise<void> {
  await client.query(`
      create table if not exists tenants (tenant_id text primary key, name text not null);
      create table if not exists templates (
        template_id text primary key,
        label text not null,
        asset_slots jsonb not null,
        current_version text,
        status text
      );
      create table if not exists template_versions (
        template_id text not null,
        version text not null,
        snapshot jsonb not null,
        content_hash text not null,
        created_at timestamptz not null default now(),
        constraint template_versions_pkey primary key (template_id, version),
        constraint template_versions_template_id_fkey foreign key (template_id) references templates(template_id)
      );
      create table if not exists rooms (
        room_id text primary key,
        tenant_id text not null references tenants(tenant_id),
        template_id text not null references templates(template_id),
      template_version text,
      template_snapshot jsonb,
      name text not null,
      room_type text not null default 'standard',
      owner_participant_id text,
      status text not null default 'active',
      disabled_at timestamptz,
      disabled_by text,
      visibility text not null default 'public',
      scene_bundle_url text,
      features jsonb not null,
      asset_ids jsonb not null default '[]'::jsonb,
      theme jsonb not null default '{"primaryColor":"#5fc8ff","accentColor":"#163354"}'::jsonb,
      guest_allowed boolean not null default true,
        avatar_config jsonb not null default '{"avatarsEnabled":true,"avatarCatalogUrl":"/assets/avatars/catalog.v1.json","avatarQualityProfile":"desktop-standard","avatarFallbackCapsulesEnabled":true,"avatarSeatsEnabled":true}'::jsonb,
        session_control jsonb not null default '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb,
        personal_state jsonb not null default '{}'::jsonb
       );
      alter table rooms alter column avatar_config set default '{"avatarsEnabled":true,"avatarCatalogUrl":"/assets/avatars/catalog.v1.json","avatarQualityProfile":"desktop-standard","avatarFallbackCapsulesEnabled":true,"avatarSeatsEnabled":true}'::jsonb;
      create table if not exists assets (
        asset_id text primary key,
        tenant_id text not null references tenants(tenant_id),
        kind text not null,
        url text not null,
        validation_status text not null default 'validated',
        processed_url text
      );
      create table if not exists runtime_diagnostics (
        id bigserial primary key,
        room_id text not null,
        payload jsonb not null,
        created_at timestamptz not null default now()
      );
      create table if not exists xr_telemetry (
        id bigserial primary key,
        room_id text not null,
        participant_id text not null,
        payload jsonb not null,
        created_at timestamptz not null default now()
      );
      create table if not exists scene_bundles (
        bundle_id text not null,
        storage_key text not null,
        public_url text not null,
        checksum text,
        size_bytes bigint,
        schema_version integer,
        entry_scene text,
        preview_url text,
        created_by text,
        content_type text not null,
        provider text not null,
        version text not null,
        status text not null default 'active',
        is_current boolean not null default true,
        created_at timestamptz not null default now(),
        primary key (bundle_id, version)
      );
      create table if not exists room_invites (
        invite_id text primary key,
        room_id text not null references rooms(room_id) on delete cascade,
        token_hash text not null unique,
        role text not null default 'guest',
        waiting_room_enabled boolean not null default false,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        revoked_at timestamptz,
        created_by text,
        revoked_by text
      );
      create table if not exists room_waiting_requests (
        request_id text primary key,
        room_id text not null references rooms(room_id) on delete cascade,
        invite_id text not null references room_invites(invite_id) on delete cascade,
        participant_id text not null,
        display_name text not null,
        status text not null default 'pending',
        created_at timestamptz not null default now(),
        decided_at timestamptz,
        decided_by text,
        unique (invite_id, participant_id)
      );
      create table if not exists room_notes (
        note_id text primary key,
        room_id text not null references rooms(room_id) on delete cascade,
        scope text not null,
        owner_participant_id text,
        content text not null,
        updated_at timestamptz not null default now(),
        updated_by text,
        deleted_at timestamptz,
        deleted_by text
      );
      create table if not exists room_note_versions (
        version_id text primary key,
        note_id text not null,
        room_id text not null references rooms(room_id) on delete cascade,
        scope text not null,
        owner_participant_id text,
        content text not null,
        action text not null default 'save',
        restored_from_version_id text,
        created_at timestamptz not null default now(),
        created_by text
      );
      create table if not exists room_documents (
        document_id text primary key,
        room_id text not null references rooms(room_id) on delete cascade,
        tenant_id text not null references tenants(tenant_id),
        filename text not null,
        content_type text not null,
        size_bytes bigint not null,
        storage_key text not null,
        checksum text not null,
        uploaded_by text,
        uploaded_at timestamptz not null default now(),
        deleted_at timestamptz,
        deleted_by text,
        linked_surface_id text,
        metadata jsonb not null default '{}'::jsonb
      );
    `);
  await client.query(`create index if not exists xr_telemetry_room_id_id_idx on xr_telemetry (room_id, id)`);
  await client.query(`create unique index if not exists room_notes_room_scope_owner_idx on room_notes (room_id, scope, coalesce(owner_participant_id, ''))`);
  await client.query(`create index if not exists room_note_versions_note_created_idx on room_note_versions (note_id, created_at desc)`);
  await client.query(`create index if not exists room_note_versions_room_scope_owner_idx on room_note_versions (room_id, scope, coalesce(owner_participant_id, ''), created_at desc)`);
  await client.query(`create index if not exists room_documents_room_uploaded_idx on room_documents (room_id, uploaded_at desc)`);
  await client.query(`alter table room_documents add column if not exists metadata jsonb not null default '{}'::jsonb`);
  await client.query(`alter table room_notes add column if not exists deleted_at timestamptz`);
  await client.query(`alter table room_notes add column if not exists deleted_by text`);
  await client.query(`alter table templates add column if not exists current_version text`);
  await client.query(`alter table templates add column if not exists status text`);
  await client.query(`alter table rooms add column if not exists template_version text`);
  await client.query(`alter table rooms add column if not exists template_snapshot jsonb`);
  await client.query(`
      create table if not exists template_versions (
        template_id text not null,
        version text not null,
        snapshot jsonb not null,
        content_hash text not null,
        created_at timestamptz not null default now(),
        constraint template_versions_pkey primary key (template_id, version),
        constraint template_versions_template_id_fkey foreign key (template_id) references templates(template_id)
      )
    `);
  await client.query(`alter table rooms add column if not exists scene_bundle_url text`);
  await client.query(`alter table rooms add column if not exists status text not null default 'active'`);
  await client.query(`alter table rooms add column if not exists disabled_at timestamptz`);
  await client.query(`alter table rooms add column if not exists disabled_by text`);
  await client.query(`alter table rooms add column if not exists visibility text not null default 'public'`);
  await client.query(`alter table rooms add column if not exists room_type text not null default 'standard'`);
  await client.query(`alter table rooms add column if not exists owner_participant_id text`);
  await client.query(`alter table rooms add column if not exists personal_state jsonb not null default '${DEFAULT_PERSONAL_STATE_JSON}'::jsonb`);
  await client.query(`alter table rooms alter column personal_state set default '${DEFAULT_PERSONAL_STATE_JSON}'::jsonb`);
  await client.query(`update rooms set room_type = 'standard' where room_type is null`);
  await client.query(`update rooms set personal_state = '${DEFAULT_PERSONAL_STATE_JSON}'::jsonb where personal_state is null`);
  await client.query(`update rooms set status = 'disabled' where disabled_at is not null and (status is null or status = 'active')`);
  await client.query(`update rooms set visibility = 'private' where guest_allowed = false and (visibility is null or visibility = 'public')`);
  await client.query(`alter table rooms add column if not exists avatar_config jsonb not null default '${DEFAULT_AVATAR_CONFIG_JSON}'::jsonb`);
  await client.query(`update rooms set avatar_config = '${DEFAULT_AVATAR_CONFIG_JSON}'::jsonb where avatar_config is null`);
  await client.query(`update rooms set avatar_config = '${DEFAULT_AVATAR_CONFIG_JSON}'::jsonb || avatar_config`);
  await client.query(`alter table rooms add column if not exists session_control jsonb not null default '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb`);
  await client.query(`alter table rooms alter column session_control set default '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb`);
  await client.query(`update rooms set session_control = '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb where session_control is null`);
  await client.query(`update rooms set session_control = '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb || session_control`);
  await client.query(`alter table scene_bundles add column if not exists status text not null default 'active'`);
  await client.query(`alter table scene_bundles add column if not exists is_current boolean not null default true`);
  await client.query(`alter table scene_bundles add column if not exists schema_version integer`);
  await client.query(`alter table scene_bundles add column if not exists entry_scene text`);
  await client.query(`alter table scene_bundles add column if not exists preview_url text`);
  await client.query(`alter table scene_bundles add column if not exists created_by text`);
  await client.query(`do $$ begin alter table scene_bundles drop constraint if exists scene_bundles_pkey; alter table scene_bundles add primary key (bundle_id, version); exception when duplicate_object then null; end $$;`);
}
